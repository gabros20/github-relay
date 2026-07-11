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

type ForecastPool = 'graphqlPoints' | 'restCore' | 'ossinsight';
const FORECAST_POOLS: readonly ForecastPool[] = ['graphqlPoints', 'restCore', 'ossinsight'];

/**
 * Marginal cost per unit ("one run of this command"), design §4 table — as
 * documented in the task-7 brief (task 12 completed coverage to every
 * registered command, task 11's health entry verified unchanged). Each
 * command maps to per-pool per-unit costs; most touch a single pool, but
 * `health` spends across BOTH GraphQL and REST core in one run, so the model
 * is a per-pool map rather than a single pool. ClickHouse's one POST isn't a
 * forecastable pool (no rate-limit headers exist for it) and grep.app has no
 * numeric quota at all (a breaker, not a rate window) — both stay outside the
 * affordability math (design §4: no-SLA goodwill services, never binding
 * quota constraints). A command with an empty `{}` entry is explicitly FREE
 * — accepted by `--forecast` and simply contributing zero spend, never
 * INVALID_INPUT — so every one of the 14 registered commands is covered.
 * `trending` is `search --source trending`'s own entry (not a registry
 * command in its own right) since it spends a materially different pool
 * (ossinsight) than plain `search` (graphqlPoints) — letting a caller
 * forecast the two lanes separately.
 */
export const FORECAST_COST_MODEL: Record<string, Partial<Record<ForecastPool, number>>> = {
  plan: {}, // free by default; --probe's point spend is variable and its own --max-probes-capped budget, not a fixed per-unit cost
  search: { graphqlPoints: 1 }, // 1pt/page (the default GraphQL lane)
  trending: { ossinsight: 1 }, // search --source trending: 1 OSS Insight GET per call
  batch: { graphqlPoints: 1 }, // one search-shaped GraphQL call per query line
  hydrate: { graphqlPoints: 1 }, // ~1pt per <=50-id aliased batch
  code: {}, // free — grep.app has no forecastable quota pool (breaker state, not a rate window)
  enrich: { graphqlPoints: 2 }, // ~2pt per <=50-repo batch; third-party leg is zero GH quota
  rank: {}, // free — offline, zero network
  // GATE-3 forensics on a ~10-id finalist batch (design §4 table): 1 probe +
  // 1 heavy batch ≈ 2 GraphQL pts, ~10 /contributors = 10 REST core, 1 CH POST.
  health: { graphqlPoints: 2, restCore: 10 },
  skim: { restCore: 2 }, // 2 REST core calls
  read: { restCore: 1 }, // lower bound: 1 REST call per uncached file — actual cost scales with path count/cache hits
  digest: { restCore: 1 }, // 1 tarball request
  budget: {}, // free — its own /rate_limit refresh is explicitly quota-exempt
  doctor: {}, // free
  cache: {}, // free, local
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
  const spend: Record<ForecastPool, number> = { graphqlPoints: 0, restCore: 0, ossinsight: 0 };
  for (const { command, count } of entries) {
    const model = FORECAST_COST_MODEL[command];
    if (!model) continue;
    for (const pool of FORECAST_POOLS) {
      const perUnit = model[pool];
      if (perUnit) spend[pool] += perUnit * count;
    }
  }

  let affordable = true;
  const projected: ForecastResult['pools'] = {};
  for (const pool of FORECAST_POOLS) {
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
