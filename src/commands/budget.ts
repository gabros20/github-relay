// `budget` — pool visibility (design §3 item 12, §8): report every pool in
// `budget.json` exactly as last recorded, refreshed by ONE free `GET
// /rate_limit` call (costs no quota — GitHub explicitly exempts this endpoint)
// so core/search/graphql windows are live rather than stale on every
// invocation. `--forecast` answers "can I afford this plan now" against a
// small, explicitly-scoped per-command cost model (design §4 table) — never a
// trusted constant for the POOLS themselves, only for the marginal cost of
// each command, which the design table documents.
import type { Budget, Cache, RateWindow } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import type { GhRest } from '../sources/gh-rest.ts';
import { EngineError } from '../types.ts';

export interface BudgetOpts {
  forecast?: string;
}

export interface BudgetSources {
  ghRest: Pick<GhRest, 'get'>;
}

type ForecastPool = 'graphqlPoints' | 'restCore';

/** Marginal cost per unit ("one run of this command"), design §4 table — as documented in the task-7 brief. `health` isn't wired until task 11, so it's deliberately absent (falls through to the "unsupported" branch). */
const FORECAST_COST_MODEL: Record<string, { pool: ForecastPool; perUnit: number }> = {
  search: { pool: 'graphqlPoints', perUnit: 1 }, // 1pt/page
  enrich: { pool: 'graphqlPoints', perUnit: 2 }, // ~2pt per <=50-repo batch; third-party leg is zero GH quota
  skim: { pool: 'restCore', perUnit: 2 }, // 2 REST core calls
  digest: { pool: 'restCore', perUnit: 1 }, // 1 tarball request
};

export interface ForecastPoolProjection {
  /** Last-known remaining count, or null when this pool has never been observed. */
  remaining: number | null;
  /** remaining - forecast spend, or null when remaining is unknown (can't assert affordability). */
  projected: number | null;
}

export interface ForecastResult {
  affordable: boolean;
  pools: Partial<Record<ForecastPool, ForecastPoolProjection>>;
}

export interface BudgetResult {
  pools: Budget;
  forecast?: ForecastResult;
}

export function budgetOptsFromArgs(parsed: ParsedArgs): BudgetOpts {
  return { forecast: parsed.flags.forecast?.[0] };
}

interface RateLimitResource {
  remaining?: number;
  reset?: number;
}

interface RateLimitBody {
  resources?: {
    core?: RateLimitResource;
    search?: RateLimitResource;
    graphql?: RateLimitResource;
  };
}

function toWindow(r: RateLimitResource): RateWindow | undefined {
  if (typeof r.remaining !== 'number' || typeof r.reset !== 'number') return undefined;
  return { remaining: r.remaining, resetAt: new Date(r.reset * 1000).toISOString() };
}

/**
 * The one free live refresh: `GET /rate_limit` costs no quota, so every
 * `budget` invocation can afford to call it and persist what it says —
 * never a trusted constant, only the last live header/body snapshot (design
 * §8). `graphqlPoints.lastCost` isn't part of this endpoint's shape, so the
 * previously-recorded value (if any) is carried forward rather than wiped.
 */
async function refreshFromRateLimit(sources: BudgetSources, cache: Cache): Promise<void> {
  const res = await sources.ghRest.get('/rate_limit');
  const resources = (res.body as RateLimitBody).resources ?? {};

  const core = resources.core && toWindow(resources.core);
  if (core) cache.budget.updatePool('restCore', core);

  const search = resources.search && toWindow(resources.search);
  if (search) cache.budget.updatePool('restSearch', search);

  const graphql = resources.graphql && toWindow(resources.graphql);
  if (graphql) {
    const lastCost = cache.budget.load().graphqlPoints?.lastCost ?? 0;
    cache.budget.updatePool('graphqlPoints', { ...graphql, lastCost });
  }
}

interface ForecastEntry {
  command: string;
  count: number;
}

function parseForecastSpec(raw: string): ForecastEntry[] {
  return raw.split(',').map((part) => {
    const [commandRaw, countRaw] = part.split(':');
    const command = commandRaw?.trim();
    if (!command || countRaw === undefined) {
      throw new EngineError(
        'INVALID_INPUT',
        `--forecast entry '${part}' must look like 'command:count'`,
      );
    }
    const count = Number(countRaw.trim());
    if (!Number.isInteger(count) || count < 0) {
      throw new EngineError(
        'INVALID_INPUT',
        `--forecast count for '${command}' must be a non-negative integer (got '${countRaw}')`,
      );
    }
    if (!(command in FORECAST_COST_MODEL)) {
      throw new EngineError(
        'INVALID_INPUT',
        `--forecast does not support '${command}' (supported: ${Object.keys(FORECAST_COST_MODEL).join(', ')})`,
      );
    }
    return { command, count };
  });
}

function computeForecast(raw: string, pools: Budget): ForecastResult {
  const entries = parseForecastSpec(raw);
  const spend: Record<ForecastPool, number> = { graphqlPoints: 0, restCore: 0 };
  for (const { command, count } of entries) {
    const model = FORECAST_COST_MODEL[command];
    if (model) spend[model.pool] += model.perUnit * count;
  }

  let affordable = true;
  const projected: ForecastResult['pools'] = {};
  for (const pool of ['graphqlPoints', 'restCore'] as const) {
    if (spend[pool] === 0) continue;
    const remaining = pools[pool]?.remaining ?? null;
    if (remaining === null) {
      // Never observed live — can't claim affordability either way; report
      // it as unknown rather than fabricating a number (design §8 honesty).
      projected[pool] = { remaining: null, projected: null };
      continue;
    }
    const after = remaining - spend[pool];
    projected[pool] = { remaining, projected: after };
    if (after < 0) affordable = false;
  }
  return { affordable, pools: projected };
}

export async function runBudget(
  sources: BudgetSources,
  cache: Cache,
  opts: BudgetOpts,
): Promise<BudgetResult> {
  await refreshFromRateLimit(sources, cache);
  const pools = cache.budget.load();

  const result: BudgetResult = { pools };
  if (opts.forecast !== undefined) result.forecast = computeForecast(opts.forecast, pools);
  return result;
}
