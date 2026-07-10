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

export function updateGrepAppBreaker(path: string, state: GrepAppBreaker): Budget {
  const budget = loadBudget(path);
  const next: Budget = { ...budget, grepApp: state };
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
