// Local budget/quota snapshot (design §8, §4, §12): every pool state is
// exactly what the last live header snapshot said, plus when — never a
// trusted constant. Adapters (later tasks) call the update helpers with
// values pulled straight off `x-ratelimit-*` / embedded `rateLimit{}`
// headers; nothing here invents a number.
import { load, save } from './store.ts';

export interface RateWindow {
  remaining: number;
  resetAt: string;
}

export interface GraphqlPoints extends RateWindow {
  lastCost: number;
}

export interface GrepAppBreaker {
  breakerState: 'closed' | 'open' | 'half-open';
  /** Consecutive 429/5xx/network failures since the last success (task 10: 2 trips the breaker open). */
  consecutiveFailures: number;
  /** ISO timestamp — when an open breaker becomes eligible for its next half-open probe. Absent while closed. */
  retryAt?: string;
}

export interface Budget {
  graphqlPoints?: GraphqlPoints;
  restCore?: RateWindow;
  restSearch?: RateWindow;
  ecosystems?: RateWindow;
  ossinsight?: RateWindow;
  grepApp?: GrepAppBreaker;
  /** fragmentWeight → the largest batch size observed to succeed. */
  learnedCeilings: Record<string, number>;
}

const EMPTY_BUDGET: Budget = { learnedCeilings: {} };

/** Never throws; missing/corrupt files come back as an empty budget. */
export function loadBudget(path: string): Budget {
  const loaded = load<Budget>(path, EMPTY_BUDGET);
  return { ...loaded, learnedCeilings: loaded.learnedCeilings ?? {} };
}

export function saveBudget(path: string, budget: Budget): void {
  save(path, budget);
}

export type SimplePool = 'graphqlPoints' | 'restCore' | 'restSearch' | 'ecosystems' | 'ossinsight';

export function updatePool(
  path: string,
  pool: SimplePool,
  state: RateWindow | GraphqlPoints,
): Budget {
  const budget = loadBudget(path);
  const next: Budget = { ...budget, [pool]: state };
  saveBudget(path, next);
  return next;
}

/**
 * `state` may be a plain replacement value (unchanged behavior) OR a reducer
 * `(prev) => next` — the reducer form loads the CURRENT persisted value at
 * write time rather than trusting a value the caller captured earlier, which
 * matters whenever anything (e.g. a network call) happened between "read"
 * and "write": two callers computing "previous + 1" from the same
 * caller-captured snapshot collapse two real updates into one (fix wave 1,
 * task 10 IMP 1 — the code command's circuit breaker hit exactly this).
 * `prev` is `undefined` when no breaker state has ever been persisted.
 */
export function updateGrepAppBreaker(
  path: string,
  state: GrepAppBreaker | ((prev: GrepAppBreaker | undefined) => GrepAppBreaker),
): Budget {
  const budget = loadBudget(path);
  const grepApp = typeof state === 'function' ? state(budget.grepApp) : state;
  const next: Budget = { ...budget, grepApp };
  saveBudget(path, next);
  return next;
}

export function updateLearnedCeiling(
  path: string,
  fragmentWeight: string,
  batchSize: number,
): Budget {
  const budget = loadBudget(path);
  const next: Budget = {
    ...budget,
    learnedCeilings: { ...budget.learnedCeilings, [fragmentWeight]: batchSize },
  };
  saveBudget(path, next);
  return next;
}
