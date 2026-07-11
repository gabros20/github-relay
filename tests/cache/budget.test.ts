import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});

describe('updateLearnedCeiling — fragmentWeight → batchSize', () => {
  test('adds a ceiling without disturbing other pools', () => {
    updatePool(file, 'graphqlPoints', {
      remaining: 5000,
      resetAt: '2026-07-10T01:00:00.000Z',
      lastCost: 1,
    });
    updateLearnedCeiling(file, 'heavy', 10);
    const budget = loadBudget(file);
    expect(budget.learnedCeilings).toEqual({ heavy: 10 });
    expect(budget.graphqlPoints?.remaining).toBe(5000);
  });

  test('multiple fragment weights accumulate; re-learning overwrites just that key', () => {
    updateLearnedCeiling(file, 'light', 25);
    updateLearnedCeiling(file, 'heavy', 10);
    updateLearnedCeiling(file, 'heavy', 8);
    expect(loadBudget(file).learnedCeilings).toEqual({ light: 25, heavy: 8 });
  });
});

describe('saveBudget', () => {
  test('is a plain atomic write usable directly', () => {
    saveBudget(file, { learnedCeilings: { light: 25 } });
    expect(loadBudget(file)).toEqual({ learnedCeilings: { light: 25 } });
  });
});
