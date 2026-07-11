import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import { type BudgetSources, budgetOptsFromArgs, runBudget } from '../../src/commands/budget.ts';
import { EngineError } from '../../src/types.ts';

function rateLimitBody(overrides: Record<string, unknown> = {}) {
  return {
    resources: {
      core: { limit: 5000, remaining: 4321, reset: 2000000000 },
      search: { limit: 30, remaining: 25, reset: 2000000100 },
      graphql: { limit: 5000, remaining: 4900, reset: 2000000200 },
      ...overrides,
    },
  };
}

function fakeGhRest(body: unknown, calls: string[] = []): BudgetSources['ghRest'] {
  return {
    get: async (path: string) => {
      calls.push(path);
      return { status: 200, headers: new Headers(), body, etag: null };
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-budget-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('budgetOptsFromArgs', () => {
  test('parses --forecast', () => {
    const parsed = parseArgs(['budget', '--forecast', 'enrich:2,skim:8,digest:3']);
    expect(budgetOptsFromArgs(parsed)).toEqual({ forecast: 'enrich:2,skim:8,digest:3' });
  });

  test('forecast is undefined when absent', () => {
    const parsed = parseArgs(['budget']);
    expect(budgetOptsFromArgs(parsed).forecast).toBeUndefined();
  });
});

describe('runBudget — zero-cost default + the one free /rate_limit call', () => {
  test('makes exactly one GET /rate_limit call and persists restCore/restSearch/graphqlPoints', async () => {
    const cache = createCache(dir);
    const calls: string[] = [];
    const ghRest = fakeGhRest(rateLimitBody(), calls);

    const result = await runBudget({ ghRest }, cache, {});

    expect(calls).toEqual(['/rate_limit']);
    expect(result.pools.restCore).toEqual({
      remaining: 4321,
      resetAt: new Date(2000000000 * 1000).toISOString(),
    });
    expect(result.pools.restSearch).toEqual({
      remaining: 25,
      resetAt: new Date(2000000100 * 1000).toISOString(),
    });
    expect(result.pools.graphqlPoints?.remaining).toBe(4900);
    expect(result.pools.graphqlPoints?.lastCost).toBe(0);
  });

  test('carries forward a previously-recorded graphqlPoints.lastCost instead of wiping it', async () => {
    const cache = createCache(dir);
    cache.budget.updatePool('graphqlPoints', {
      remaining: 100,
      resetAt: '2026-01-01T00:00:00Z',
      lastCost: 7,
    });
    const ghRest = fakeGhRest(rateLimitBody());

    const result = await runBudget({ ghRest }, cache, {});
    expect(result.pools.graphqlPoints?.lastCost).toBe(7);
    expect(result.pools.graphqlPoints?.remaining).toBe(4900);
  });

  test('reports pools already on disk (learnedCeilings, ecosystems) that /rate_limit never touches', async () => {
    const cache = createCache(dir);
    cache.budget.updatePool('ecosystems', { remaining: 14000, resetAt: '2026-01-01T00:00:00Z' });
    cache.budget.updateLearnedCeiling('light', 20);
    const ghRest = fakeGhRest(rateLimitBody());

    const result = await runBudget({ ghRest }, cache, {});
    expect(result.pools.ecosystems?.remaining).toBe(14000);
    expect(result.pools.learnedCeilings).toEqual({ light: 20 });
  });

  test('a failing /rate_limit call propagates (budget has no always-ok:true contract — that is doctor only)', async () => {
    const cache = createCache(dir);
    const ghRest: BudgetSources['ghRest'] = {
      get: async () => {
        throw new EngineError('AUTH_FAILED', 'no token');
      },
    };
    await expect(runBudget({ ghRest }, cache, {})).rejects.toBeInstanceOf(EngineError);
  });
});

describe('runBudget — --forecast', () => {
  test('affordable:true when every touched pool has enough headroom', async () => {
    const cache = createCache(dir);
    const ghRest = fakeGhRest(
      rateLimitBody({
        core: { limit: 5000, remaining: 100, reset: 2000000000 },
        graphql: { limit: 5000, remaining: 50, reset: 2000000000 },
      }),
    );
    const result = await runBudget({ ghRest }, cache, { forecast: 'enrich:2,skim:8,digest:3' });
    // enrich:2 -> 2*2=4 graphqlPoints; skim:8 -> 8*2=16 restCore; digest:3 -> 3*1=3 restCore => 19 restCore
    expect(result.forecast?.pools.graphqlPoints).toEqual({ remaining: 50, projected: 46 });
    expect(result.forecast?.pools.restCore).toEqual({ remaining: 100, projected: 81 });
    expect(result.forecast?.affordable).toBe(true);
  });

  test('affordable:false when a touched pool would go negative', async () => {
    const cache = createCache(dir);
    const ghRest = fakeGhRest(
      rateLimitBody({ core: { limit: 5000, remaining: 5, reset: 2000000000 } }),
    );
    const result = await runBudget({ ghRest }, cache, { forecast: 'skim:8' }); // 16 restCore needed, only 5 remaining
    expect(result.forecast?.affordable).toBe(false);
    expect(result.forecast?.pools.restCore).toEqual({ remaining: 5, projected: -11 });
  });

  test('a pool never observed live reports remaining/projected as null rather than fabricating a number', async () => {
    const cache = createCache(dir);
    // graphql resource entirely absent from this /rate_limit fixture.
    const ghRest = fakeGhRest({ resources: { core: { remaining: 100, reset: 2000000000 } } });
    const result = await runBudget({ ghRest }, cache, { forecast: 'enrich:1' });
    expect(result.forecast?.pools.graphqlPoints).toEqual({ remaining: null, projected: null });
  });

  test('an unknown command in --forecast is INVALID_INPUT (health lands task 11)', async () => {
    const cache = createCache(dir);
    const ghRest = fakeGhRest(rateLimitBody());
    await expect(runBudget({ ghRest }, cache, { forecast: 'health:2' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  test('a malformed forecast entry is INVALID_INPUT', async () => {
    const cache = createCache(dir);
    const ghRest = fakeGhRest(rateLimitBody());
    await expect(runBudget({ ghRest }, cache, { forecast: 'enrich' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  test('a negative or non-integer count is INVALID_INPUT', async () => {
    const cache = createCache(dir);
    const ghRest = fakeGhRest(rateLimitBody());
    await expect(runBudget({ ghRest }, cache, { forecast: 'skim:-1' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(runBudget({ ghRest }, cache, { forecast: 'skim:1.5' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
