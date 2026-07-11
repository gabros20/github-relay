import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROFILE,
  PROFILES,
  PROFILE_NAMES,
  effectiveProfile,
  parseWeights,
  resolveProfile,
} from '../../src/score/profiles.ts';
import { EngineError } from '../../src/types.ts';

function weightOf(name: keyof typeof PROFILES, key: string): number | undefined {
  return PROFILES[name].components.find((c) => c.key === key)?.weight;
}

describe('profile weights — exact design §5 letter', () => {
  // The invariant guard (design §5 erratum 2026-07-11): every SHIPPED profile
  // totals exactly 100. This is what would have caught the original dissect=95.
  test('every built-in profile sums to exactly 100', () => {
    for (const name of PROFILE_NAMES) {
      const sum = PROFILES[name].components.reduce((s, c) => s + c.weight, 0);
      expect(sum, `${name} weights must sum to 100`).toBe(100);
    }
  });

  test('build-on: A25 B20 C15 D10 E10 F10 L10, summing to 100', () => {
    expect(weightOf('build-on', 'A')).toBe(25);
    expect(weightOf('build-on', 'B')).toBe(20);
    expect(weightOf('build-on', 'C')).toBe(15);
    expect(weightOf('build-on', 'D')).toBe(10);
    expect(weightOf('build-on', 'E')).toBe(10);
    expect(weightOf('build-on', 'F')).toBe(10);
    expect(weightOf('build-on', 'L')).toBe(10);
    const sum = PROFILES['build-on'].components.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBe(100);
  });

  // Erratum 2026-07-11 (design §5): the original panel text listed Structure15,
  // summing to 95; the controller corrected Structure to 20 so dissect totals
  // 100 (Structure, the dissect-only group, absorbs the gap). Scoring still
  // renormalizes by present-component weight, so the total is immaterial to
  // ordering regardless.
  test('dissect: E40 Structure20 A5 B10 C10 D5 F10 L0, summing to 100', () => {
    expect(weightOf('dissect', 'E')).toBe(40);
    expect(weightOf('dissect', 'Structure')).toBe(20);
    expect(weightOf('dissect', 'A')).toBe(5);
    expect(weightOf('dissect', 'B')).toBe(10);
    expect(weightOf('dissect', 'C')).toBe(10);
    expect(weightOf('dissect', 'D')).toBe(5);
    expect(weightOf('dissect', 'F')).toBe(10);
    expect(weightOf('dissect', 'L')).toBe(0);
    const sum = PROFILES.dissect.components.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBe(100);
  });

  test('ideas: Recency30 F25 E20 Novelty15 BC10 L0, summing to 100', () => {
    expect(weightOf('ideas', 'Recency')).toBe(30);
    expect(weightOf('ideas', 'F')).toBe(25);
    expect(weightOf('ideas', 'E')).toBe(20);
    expect(weightOf('ideas', 'Novelty')).toBe(15);
    expect(weightOf('ideas', 'BC')).toBe(10);
    expect(weightOf('ideas', 'L')).toBe(0);
    const sum = PROFILES.ideas.components.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBe(100);
  });
});

describe('resolveProfile', () => {
  test('undefined → the default (build-on)', () => {
    expect(resolveProfile(undefined).name).toBe(DEFAULT_PROFILE);
  });
  test('an unknown name is INVALID_INPUT', () => {
    expect(() => resolveProfile('bogus')).toThrow(EngineError);
  });
});

describe('parseWeights validation', () => {
  test('a well-formed override that sums to 100 parses', () => {
    const comps = parseWeights('A=50,B=30,C=20');
    expect(comps).toEqual([
      { key: 'A', weight: 50 },
      { key: 'B', weight: 30 },
      { key: 'C', weight: 20 },
    ]);
  });

  test('sum ≠ 100 (outside tolerance) → INVALID_INPUT', () => {
    expect(() => parseWeights('A=50,B=30')).toThrow(/sum to 100/);
  });

  test('an unknown group key → INVALID_INPUT', () => {
    expect(() => parseWeights('A=50,Z=50')).toThrow(/unknown group/);
  });

  test('a non-numeric weight → INVALID_INPUT', () => {
    expect(() => parseWeights('A=lots,B=100')).toThrow(EngineError);
  });

  test('a duplicated key → INVALID_INPUT', () => {
    expect(() => parseWeights('A=50,A=50')).toThrow(/more than once/);
  });

  test('within ±0.5 tolerance is accepted (rounding slack)', () => {
    expect(() => parseWeights('A=33.3,B=33.3,C=33.4')).not.toThrow();
  });
});

describe('effectiveProfile', () => {
  test('no --weights → the named profile unchanged', () => {
    expect(effectiveProfile('dissect', undefined)).toBe(PROFILES.dissect);
  });
  test('--weights replaces the component set but keeps a traceable name', () => {
    const p = effectiveProfile('build-on', 'A=100');
    expect(p.name).toContain('build-on');
    expect(p.components).toEqual([{ key: 'A', weight: 100 }]);
  });
});
