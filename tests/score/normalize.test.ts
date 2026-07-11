import { describe, expect, test } from 'bun:test';
import {
  clamp01,
  daysSince,
  meanPresent,
  pike,
  recencyFromDays,
} from '../../src/score/normalize.ts';

describe('pike log-saturation', () => {
  test('S=0 → 0 (no evidence)', () => {
    expect(pike(0, 100)).toBe(0);
  });

  test('S=T → exactly 1 (fully saturated at the threshold)', () => {
    expect(pike(100, 100)).toBeCloseTo(1, 12);
    expect(pike(1000, 1000)).toBeCloseTo(1, 12);
  });

  test('S >> T stays at 1, never overshoots', () => {
    expect(pike(100_000, 100)).toBeCloseTo(1, 12);
  });

  test('monotonic below the threshold: more signal, higher score, all in (0,1)', () => {
    const a = pike(10, 1000);
    const b = pike(100, 1000);
    const c = pike(500, 1000);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(1);
  });

  test('negative signal clamps to 0', () => {
    expect(pike(-5, 100)).toBe(0);
  });

  test('max(S,T)=0 (both zero) is defined as 0, not NaN', () => {
    expect(pike(0, 0)).toBe(0);
  });
});

describe('recencyFromDays (inverted saturation)', () => {
  test('days=0 → ~1 (just pushed)', () => {
    expect(recencyFromDays(0, 365)).toBeCloseTo(1, 12);
  });

  test('days=T → 0 (at the staleness threshold)', () => {
    expect(recencyFromDays(365, 365)).toBeCloseTo(0, 12);
  });

  test('days > T stays at 0, never negative', () => {
    expect(recencyFromDays(2000, 365)).toBe(0);
  });

  test('monotonic decay between fresh and stale', () => {
    const fresh = recencyFromDays(30, 365);
    const mid = recencyFromDays(180, 365);
    const stale = recencyFromDays(300, 365);
    expect(fresh).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(stale);
  });
});

describe('daysSince', () => {
  const now = Date.parse('2026-07-11T00:00:00Z');
  test('counts whole days back', () => {
    expect(daysSince('2026-07-01T00:00:00Z', now)).toBeCloseTo(10, 6);
  });
  test('future date reads as 0, never negative', () => {
    expect(daysSince('2026-08-01T00:00:00Z', now)).toBe(0);
  });
  test('null / undefined / unparseable → null', () => {
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince(undefined, now)).toBeNull();
    expect(daysSince('not-a-date', now)).toBeNull();
  });
});

describe('meanPresent', () => {
  test('averages only the finite entries', () => {
    expect(meanPresent([1, null, 0])).toBeCloseTo(0.5, 12);
  });
  test('all absent → null (a fully-missing group)', () => {
    expect(meanPresent([null, undefined])).toBeNull();
    expect(meanPresent([])).toBeNull();
  });
  test('ignores NaN/Infinity', () => {
    expect(meanPresent([Number.NaN, Number.POSITIVE_INFINITY, 1])).toBe(1);
  });
});

describe('clamp01', () => {
  test('clamps both ends and passes NaN → 0', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
