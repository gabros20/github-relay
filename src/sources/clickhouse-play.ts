// The ONLY module that speaks the ClickHouse playground (design §2, §4, §12
// risk 2) — a free, no-SLA goodwill service that hosts the `github_events` GH
// Archive dataset. It is the F-group's PRIMARY velocity source: ONE
// unauthenticated SQL POST batch-scores lifetime monthly event histograms
// (WatchEvent = a star, plus IssuesEvent/ForkEvent for the viral-corroboration
// check) for the entire finalist set at once. A single hard client timeout
// (10s) or any upstream failure degrades to SOURCE_DOWN so F visibly falls
// back to ratio checks + `f_coverage:"partial"` (never silently). The adapter
// is a pure single-shot transport; burstiness/velocity derivation lives in
// `commands/health.ts` (same adapters-don't-interpret split as the rest of
// sources/*). SQL-injection is closed by CONSTRUCTION: repo names are validated
// against a strict owner/repo charset before they can ever reach the query, so
// a hostile corpus name throws INVALID_INPUT rather than being interpolated.
import { EngineError } from '../types.ts';
import { discardBody } from './http.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

const ENDPOINT = 'https://play.clickhouse.com/?user=play&default_format=JSON';
const USER_AGENT = 'github-relay (mailto:t.gabor880312@gmail.com)';
const DEFAULT_TIMEOUT_MS = 10_000; // design §2/§12: a hard 10s client timeout, then SOURCE_DOWN
const EVENT_TYPES = ['WatchEvent', 'IssuesEvent', 'ForkEvent'] as const;

/**
 * The GH Archive event types this adapter measures per month. WatchEvent is a
 * star (GitHub's API renamed "watch" to "star" but the event kept its name);
 * IssuesEvent + ForkEvent feed the burst viral-corroboration check (design §5).
 */
export type ClickhouseEventType = (typeof EVENT_TYPES)[number];

/** One (repo, month, event_type) bucket. `stars` is the count for that bucket (named for the WatchEvent case, reused verbatim for the others). */
export interface ClickhouseEventRow {
  repo_name: string;
  /** Month bucket as `YYYY-MM-DD` (first of month), straight from `toStartOfMonth`. */
  month: string;
  event_type: string;
  stars: number;
}

export interface ClickhousePlay {
  /** Lifetime monthly WatchEvent/IssuesEvent/ForkEvent counts for the whole id set in ONE POST. */
  monthlyEvents(repoNames: string[]): Promise<ClickhouseEventRow[]>;
}

export type ClickhousePlayDeps = Partial<Seams> & {
  /** Hard client-side timeout for the single POST (default 10s → SOURCE_DOWN). */
  timeoutMs?: number;
};

// ── SQL safety: strict owner/repo charset (design §2 deliverable 1) ──────────
// owner: GitHub logins are alphanumeric with single hyphens; repo: alphanumeric
// plus `.`, `_`, `-`. This charset admits zero SQL metacharacters (no quote,
// backslash, whitespace, parenthesis, semicolon, comment marker), so a name
// that matches can never break out of the single-quoted literal it's placed in.
const SAFE_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const MAX_REPO_NAME_LENGTH = 200;

/** Exported for direct testing: is this a well-formed, injection-safe owner/repo id? */
export function isSafeRepoName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_REPO_NAME_LENGTH && SAFE_REPO_RE.test(name);
}

/**
 * Build the one monthly-histogram query for the whole id set. EVERY name is
 * validated first — a single unsafe name throws INVALID_INPUT (our-bug-loud,
 * never a degradable SOURCE_DOWN) so hostile input fails before any network
 * call, not after being interpolated. Exported as a pure function so the
 * escaping/validation is unit-testable without a fetch.
 */
export function buildMonthlyEventsQuery(repoNames: string[]): string {
  const quoted = repoNames.map((name) => {
    if (!isSafeRepoName(name)) {
      throw new EngineError(
        'INVALID_INPUT',
        `unsafe repo name for ClickHouse query: ${JSON.stringify(name)}`,
      );
    }
    // Belt-and-suspenders: the charset already forbids `'`, but double any that
    // somehow appeared so the literal is safe even if SAFE_REPO_RE ever loosens.
    return `'${name.replace(/'/g, "''")}'`;
  });
  const eventList = EVENT_TYPES.map((e) => `'${e}'`).join(', ');
  return [
    'SELECT repo_name, toStartOfMonth(created_at) AS month, event_type, count() AS cnt',
    'FROM github_events',
    `WHERE event_type IN (${eventList}) AND repo_name IN (${quoted.join(', ')})`,
    'GROUP BY repo_name, month, event_type',
    'ORDER BY repo_name, month, event_type',
  ].join(' ');
}

// ── transport ────────────────────────────────────────────────────────────────

interface ClickhouseJsonBody {
  data?: unknown;
}

/** ClickHouse JSON renders UInt64 counts as strings — coerce, keeping 0 and rejecting NaN. */
function toCount(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

function parseRows(body: unknown): ClickhouseEventRow[] {
  const data = (body as ClickhouseJsonBody)?.data;
  if (!Array.isArray(data)) {
    throw new EngineError(
      'FETCH_FAILED',
      'ClickHouse playground returned an unexpected JSON shape',
    );
  }
  const rows: ClickhouseEventRow[] = [];
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const repo_name = typeof rec.repo_name === 'string' ? rec.repo_name : '';
    const month = typeof rec.month === 'string' ? rec.month : '';
    const event_type = typeof rec.event_type === 'string' ? rec.event_type : '';
    if (!repo_name || !month || !event_type) continue;
    rows.push({ repo_name, month, event_type, stars: toCount(rec.cnt) });
  }
  return rows;
}

export function createClickhousePlay(deps: ClickhousePlayDeps = {}): ClickhousePlay {
  const { fetchImpl } = withSeamDefaults(deps);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(sql: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
        body: sql,
        signal: controller.signal,
      });
    } catch (e) {
      // A timeout abort lands here too — both a genuine network failure and a
      // hit against the hard 10s ceiling degrade F identically (SOURCE_DOWN).
      throw new EngineError(
        'SOURCE_DOWN',
        `ClickHouse playground unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 500) {
      await discardBody(res);
      throw new EngineError(
        'SOURCE_DOWN',
        `ClickHouse playground is down (${res.status})`,
        res.status,
      );
    }
    if (!res.ok) {
      await discardBody(res);
      throw new EngineError(
        'FETCH_FAILED',
        `ClickHouse playground failed with status ${res.status}`,
        res.status,
      );
    }
    try {
      return await res.json();
    } catch {
      throw new EngineError(
        'FETCH_FAILED',
        'ClickHouse playground returned a malformed response body',
      );
    }
  }

  async function monthlyEvents(repoNames: string[]): Promise<ClickhouseEventRow[]> {
    if (repoNames.length === 0) return [];
    const sql = buildMonthlyEventsQuery(repoNames); // validates every name first
    return parseRows(await post(sql));
  }

  return { monthlyEvents };
}
