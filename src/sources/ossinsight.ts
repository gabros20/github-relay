// The ONLY module that speaks OSS Insight's trending-repos endpoint (design
// §2, §4, §12 risk 2) — a free, no-SLA goodwill service backing the
// `search --source trending` discovery lane. A manual live probe during
// development (documented in the task-12 report) found: a single
// unauthenticated GET with NO handshake/session needed; the response is a
// generic SQL-endpoint envelope `{type:'sql_endpoint', data:{columns[],
// rows[]}}` where EVERY numeric field comes back as a STRING (same
// UInt64-as-string convention `clickhouse-play.ts` already coerces); an
// invalid `period` value 500s (not 400s) with `{message}` — irrelevant here
// since `period` is validated against a closed enum by the CALLER
// (`commands/search.ts`) before it ever reaches this URL, per the
// adapters-don't-interpret split the rest of `sources/*` follows. Its
// `x-ratelimit-*` headers ARE the real 600/hr/IP pool (confirmed live):
// `x-ratelimit-remaining`/`x-ratelimit-limit` over the hourly window, and
// `x-ratelimit-reset` is a SECONDS-UNTIL-reset countdown (not an epoch,
// unlike GitHub's) — converted here to an absolute `resetAt` at call time so
// it composes with the rest of the budget module's RateWindow shape.
import { EngineError } from '../types.ts';
import { discardBody } from './http.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

const ENDPOINT = 'https://api.ossinsight.io/v1/trends/repos/';
const USER_AGENT = 'github-relay (mailto:t.gabor880312@gmail.com)';

/** The API's own period enum — `commands/search.ts` maps the CLI's `24h|week|month` onto these. */
export type TrendingPeriod = 'past_24_hours' | 'past_week' | 'past_month';

export interface TrendingRow {
  repo_name: string;
  primary_language: string;
  description: string;
  stars: number;
  forks: number;
  total_score: number;
}

export interface TrendingRateWindow {
  remaining: number;
  resetAt: string;
}

export interface TrendingPage {
  rows: TrendingRow[];
  /** From live `x-ratelimit-*` response headers — absent when the response didn't carry them (never a trusted constant). */
  rateWindow?: TrendingRateWindow;
}

export interface OssInsight {
  trending(period: TrendingPeriod, language?: string): Promise<TrendingPage>;
}

export type OssInsightDeps = Partial<Seams>;

interface SqlEndpointRow {
  repo_name?: string;
  primary_language?: string;
  description?: string;
  stars?: string | number;
  forks?: string | number;
  total_score?: string | number;
}

interface SqlEndpointBody {
  type?: string;
  data?: { rows?: unknown };
}

/** SQL-endpoint numeric fields arrive as strings (empty string for SQL NULL) — coerce, never NaN. */
function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

function parseRows(body: unknown): TrendingRow[] {
  const rows = (body as SqlEndpointBody)?.data?.rows;
  if (!Array.isArray(rows)) {
    throw new EngineError('FETCH_FAILED', 'OSS Insight returned an unexpected JSON shape');
  }
  const out: TrendingRow[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as SqlEndpointRow;
    if (!r.repo_name) continue;
    out.push({
      repo_name: r.repo_name,
      primary_language: r.primary_language ?? '',
      description: r.description ?? '',
      stars: toNumber(r.stars),
      forks: toNumber(r.forks),
      total_score: toNumber(r.total_score),
    });
  }
  return out;
}

/** `resetAt` is derived from a live seconds-until-reset countdown, not an epoch — needs `now`. */
function rateWindowFrom(headers: Headers, nowMs: number): TrendingRateWindow | undefined {
  const remaining = headers.get('x-ratelimit-remaining');
  const resetSeconds = headers.get('x-ratelimit-reset');
  if (remaining === null || resetSeconds === null) return undefined;
  const remainingN = Number(remaining);
  const resetSecondsN = Number(resetSeconds);
  if (!Number.isFinite(remainingN) || !Number.isFinite(resetSecondsN)) return undefined;
  return { remaining: remainingN, resetAt: new Date(nowMs + resetSecondsN * 1000).toISOString() };
}

export function createOssInsight(deps: OssInsightDeps = {}): OssInsight {
  const { fetchImpl, now } = withSeamDefaults(deps);

  async function trending(period: TrendingPeriod, language?: string): Promise<TrendingPage> {
    const url = new URL(ENDPOINT);
    url.searchParams.set('period', period);
    if (language) url.searchParams.set('language', language);

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
      throw new EngineError(
        'SOURCE_DOWN',
        `OSS Insight unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (res.status >= 500) {
      await discardBody(res);
      throw new EngineError('SOURCE_DOWN', `OSS Insight is down (${res.status})`, res.status);
    }
    if (!res.ok) {
      await discardBody(res);
      throw new EngineError(
        'FETCH_FAILED',
        `OSS Insight failed with status ${res.status}`,
        res.status,
      );
    }

    const rateWindow = rateWindowFrom(res.headers, now());
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new EngineError('FETCH_FAILED', 'OSS Insight returned a malformed response body');
    }
    const page: TrendingPage = { rows: parseRows(body) };
    if (rateWindow) page.rateWindow = rateWindow;
    return page;
  }

  return { trending };
}
