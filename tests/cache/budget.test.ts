import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrepAppBreaker } from '../../src/cache/budget.ts';
import {
  loadBudget,
  saveBudget,
  updateGrepAppBreaker,
  updateLearnedCeiling,
  updatePool,
} from '../../src/cache/budget.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-budget-'));
  file = join(dir, 'budget.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadBudget — never throws', () => {
  test('missing file returns an empty budget with an empty learnedCeilings map', () => {
    expect(loadBudget(file)).toEqual({ learnedCeilings: {} });
  });

  test('corrupt file falls back to an empty budget', () => {
    writeFileSync(file, '{ not json');
    expect(loadBudget(file)).toEqual({ learnedCeilings: {} });
  });
});

describe('updatePool — writes what headers said + when, never a trusted constant', () => {
  test('updatePool(graphqlPoints) round-trips remaining/resetAt/lastCost', () => {
    updatePool(file, 'graphqlPoints', {
      remaining: 4950,
      resetAt: '2026-07-10T01:00:00.000Z',
      lastCost: 2,
    });
    expect(loadBudget(file).graphqlPoints).toEqual({
      remaining: 4950,
      resetAt: '2026-07-10T01:00:00.000Z',
      lastCost: 2,
    });
  });

  test('updating one pool does not disturb another already-set pool', () => {
    updatePool(file, 'restCore', { remaining: 4990, resetAt: '2026-07-10T01:00:00.000Z' });
    updatePool(file, 'ecosystems', { remaining: 14000, resetAt: '2026-07-10T02:00:00.000Z' });
    const budget = loadBudget(file);
    expect(budget.restCore).toEqual({ remaining: 4990, resetAt: '2026-07-10T01:00:00.000Z' });
    expect(budget.ecosystems).toEqual({ remaining: 14000, resetAt: '2026-07-10T02:00:00.000Z' });
  });

  test('a later update to the same pool overwrites the previous snapshot', () => {
    updatePool(file, 'restSearch', { remaining: 30, resetAt: '2026-07-10T00:01:00.000Z' });
    updatePool(file, 'restSearch', { remaining: 28, resetAt: '2026-07-10T00:01:00.000Z' });
    expect(loadBudget(file).restSearch).toEqual({
      remaining: 28,
      resetAt: '2026-07-10T00:01:00.000Z',
    });
  });
});

describe('updateGrepAppBreaker', () => {
  test('records the circuit-breaker state', () => {
    updateGrepAppBreaker(file, { breakerState: 'open', consecutiveFailures: 2 });
    expect(loadBudget(file).grepApp).toEqual({ breakerState: 'open', consecutiveFailures: 2 });
  });

  test('round-trips the optional retryAt cooldown timestamp', () => {
    updateGrepAppBreaker(file, {
      breakerState: 'open',
      consecutiveFailures: 2,
      retryAt: '2026-07-11T00:05:00.000Z',
    });
    expect(loadBudget(file).grepApp).toEqual({
      breakerState: 'open',
      consecutiveFailures: 2,
      retryAt: '2026-07-11T00:05:00.000Z',
    });
  });

  test('a later update overwrites the previous breaker snapshot wholesale', () => {
    updateGrepAppBreaker(file, {
      breakerState: 'open',
      consecutiveFailures: 2,
      retryAt: '2026-07-11T00:05:00.000Z',
    });
    updateGrepAppBreaker(file, { breakerState: 'closed', consecutiveFailures: 0 });
    expect(loadBudget(file).grepApp).toEqual({ breakerState: 'closed', consecutiveFailures: 0 });
  });

  // Fix wave 1, IMP 1: a plain replacement state computed from a snapshot
  // captured before some earlier async work (e.g. a network call) is exactly
  // how two concurrent callers can each independently compute
  // "previous + 1" from the SAME stale previous value and collapse two real
  // failures into one recorded failure. A reducer form that loads fresh at
  // write time closes that gap at the store level.
  describe('reducer form — loads fresh at write time', () => {
    test('a function updater receives the CURRENT persisted value, not a caller-captured snapshot', () => {
      updateGrepAppBreaker(file, { breakerState: 'closed', consecutiveFailures: 1 });
      updateGrepAppBreaker(file, (prev) => ({
        breakerState: 'closed',
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      }));
      expect(loadBudget(file).grepApp).toEqual({ breakerState: 'closed', consecutiveFailures: 2 });
    });

    test('a function updater sees undefined when no breaker state has ever been persisted', () => {
      const seen: (GrepAppBreaker | undefined)[] = [];
      updateGrepAppBreaker(file, (prev) => {
        seen.push(prev);
        return {
          breakerState: 'closed',
          consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        };
      });
      expect(seen).toEqual([undefined]);
      expect(loadBudget(file).grepApp).toEqual({ breakerState: 'closed', consecutiveFailures: 1 });
    });

    test('two sequential reducer calls each build on what the previous one actually wrote', () => {
      const bump = () =>
        updateGrepAppBreaker(file, (prev) => ({
          breakerState: 'closed',
          consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        }));
      bump();
      bump();
      bump();
      expect(loadBudget(file).grepApp).toEqual({ breakerState: 'closed', consecutiveFailures: 3 });
    });

    test('a plain-object updater still works exactly as before (backward compatible)', () => {
      updateGrepAppBreaker(file, { breakerState: 'open', consecutiveFailures: 5 });
      expect(loadBudget(file).grepApp).toEqual({ breakerState: 'open', consecutiveFailures: 5 });
    });
  });
});

describe('updateLearnedCeiling — fragmentWeight → {size, observedAt}', () => {
  test('adds a ceiling without disturbing other pools', () => {
    updatePool(file, 'graphqlPoints', {
      remaining: 5000,
      resetAt: '2026-07-10T01:00:00.000Z',
      lastCost: 1,
    });
    updateLearnedCeiling(file, 'heavy', { size: 10, observedAt: '2026-07-11T00:00:00.000Z' });
    const budget = loadBudget(file);
    expect(budget.learnedCeilings).toEqual({
      heavy: { size: 10, observedAt: '2026-07-11T00:00:00.000Z' },
    });
    expect(budget.graphqlPoints?.remaining).toBe(5000);
  });

  test('multiple fragment weights accumulate; re-learning overwrites just that key', () => {
    updateLearnedCeiling(file, 'enrich-light', {
      size: 25,
      observedAt: '2026-07-11T00:00:00.000Z',
    });
    updateLearnedCeiling(file, 'heavy', { size: 10, observedAt: '2026-07-11T00:00:00.000Z' });
    updateLearnedCeiling(file, 'heavy', { size: 8, observedAt: '2026-07-11T00:01:00.000Z' });
    expect(loadBudget(file).learnedCeilings).toEqual({
      'enrich-light': { size: 25, observedAt: '2026-07-11T00:00:00.000Z' },
      heavy: { size: 8, observedAt: '2026-07-11T00:01:00.000Z' },
    });
  });
});

describe('saveBudget', () => {
  test('is a plain atomic write usable directly', () => {
    saveBudget(file, {
      learnedCeilings: { heavy: { size: 10, observedAt: '2026-07-11T00:00:00.000Z' } },
    });
    expect(loadBudget(file)).toEqual({
      learnedCeilings: { heavy: { size: 10, observedAt: '2026-07-11T00:00:00.000Z' } },
    });
  });

  // The store itself stays shape-agnostic: a legacy pre-fix-wave-2 bare
  // number round-trips verbatim. Migration/staleness handling is owned
  // entirely by commands/_shared.ts's `freshCeiling`, not the store layer.
  test('a legacy bare-number learnedCeilings entry round-trips untouched', () => {
    saveBudget(file, { learnedCeilings: { light: 25 } });
    expect(loadBudget(file)).toEqual({ learnedCeilings: { light: 25 } });
  });
});
