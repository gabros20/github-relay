import { describe, expect, test } from 'bun:test';
import { type FlagInputs, evaluateFlags } from '../../src/score/flags.ts';

const clean: FlagInputs = {
  archived: false,
  description: 'A well-maintained library',
  stars: 1000,
  forks: 120,
  ageDays: 400,
};

describe('objective penalties (multiplicative + trail)', () => {
  test('archived → ×0.2 penalty and flag', () => {
    const r = evaluateFlags({ ...clean, archived: true });
    expect(r.flags).toContain('archived');
    expect(r.penaltyProduct).toBeCloseTo(0.2, 12);
    expect(r.penalties).toEqual([
      { rule: 'archived', factor: 0.2, reason: 'repository is archived' },
    ]);
  });

  test('disabled is treated like archived', () => {
    const r = evaluateFlags({ ...clean, disabled: true });
    expect(r.flags).toContain('archived');
    expect(r.penaltyProduct).toBeCloseTo(0.2, 12);
  });

  test('deprecation marker in description → ×0.5 penalty and flag', () => {
    const r = evaluateFlags({ ...clean, description: 'DEPRECATED — use foo instead' });
    expect(r.flags).toContain('deprecated');
    expect(r.penaltyProduct).toBeCloseTo(0.5, 12);
  });

  test('deprecation marker in README head also fires', () => {
    const r = evaluateFlags({ ...clean, readmeText: 'This project is no longer maintained.' });
    expect(r.flags).toContain('deprecated');
  });

  test('penalties stack multiplicatively (archived + deprecated → 0.1)', () => {
    const r = evaluateFlags({ ...clean, archived: true, description: 'deprecated' });
    expect(r.penaltyProduct).toBeCloseTo(0.1, 12);
    expect(r.penalties).toHaveLength(2);
  });

  test('a clean repo has no penalties (product 1)', () => {
    const r = evaluateFlags(clean);
    expect(r.penalties).toHaveLength(0);
    expect(r.penaltyProduct).toBe(1);
  });
});

describe('star-burst: flag never punishes alone (design §1 ledger row 4)', () => {
  test('burstiness > 0.5 alone → star-burst flag, NO penalty', () => {
    const r = evaluateFlags({ ...clean, burstiness: 0.8 });
    expect(r.flags).toContain('star-burst');
    expect(r.penaltyProduct).toBe(1);
  });

  test('the corroborated fake-star combo → possible-fake-stars + ×0.5', () => {
    const r = evaluateFlags({
      ...clean,
      stars: 5000,
      forks: 30,
      ageDays: 400,
      burstiness: 0.8,
      engagementSum: 0,
    });
    expect(r.flags).toContain('possible-fake-stars');
    expect(r.penaltyProduct).toBeCloseTo(0.5, 12);
  });

  test('burst on a repo WITH engagement is not the combo — flag only', () => {
    const r = evaluateFlags({
      ...clean,
      stars: 5000,
      burstiness: 0.8,
      engagementSum: 50,
    });
    expect(r.flags).toContain('star-burst');
    expect(r.flags).not.toContain('possible-fake-stars');
    expect(r.penaltyProduct).toBe(1);
  });

  test('burst under 6 months old cannot be the fake-star combo', () => {
    const r = evaluateFlags({
      ...clean,
      stars: 5000,
      burstiness: 0.8,
      engagementSum: 0,
      ageDays: 100,
    });
    expect(r.flags).not.toContain('possible-fake-stars');
    expect(r.penaltyProduct).toBe(1);
  });

  test('viral-corroborated burst downgrades to likely-viral, no penalty', () => {
    const r = evaluateFlags({
      ...clean,
      stars: 5000,
      burstiness: 0.8,
      engagementSum: 0,
      ageDays: 400,
      burstReleaseCoincides: true,
      burstIssueInflux: true,
      burstForkGrowth: true,
    });
    expect(r.flags).toContain('likely-viral');
    expect(r.flags).not.toContain('possible-fake-stars');
    expect(r.penaltyProduct).toBe(1);
  });

  test('absent burstiness signal → the burst rules simply cannot fire', () => {
    const r = evaluateFlags({ ...clean, engagementSum: 0, stars: 5000 });
    expect(r.flags).not.toContain('star-burst');
    expect(r.flags).not.toContain('possible-fake-stars');
  });
});

describe('flag-only heuristics', () => {
  test('forks/stars below 0.005 → ratio-anomaly (no penalty)', () => {
    const r = evaluateFlags({ ...clean, stars: 5000, forks: 2 });
    expect(r.flags).toContain('ratio-anomaly');
    expect(r.penaltyProduct).toBe(1);
  });

  test('forks/stars above 0.5 → ratio-anomaly', () => {
    const r = evaluateFlags({ ...clean, stars: 1000, forks: 900 });
    expect(r.flags).toContain('ratio-anomaly');
  });

  test('a healthy ratio does not flag', () => {
    const r = evaluateFlags({ ...clean, stars: 1000, forks: 100 });
    expect(r.flags).not.toContain('ratio-anomaly');
  });

  test('stars=0 cannot produce a ratio anomaly (no division)', () => {
    const r = evaluateFlags({ ...clean, stars: 0, forks: 0 });
    expect(r.flags).not.toContain('ratio-anomaly');
  });

  test('age < 30d with > 500 stars → too-new-for-stars', () => {
    const r = evaluateFlags({ ...clean, ageDays: 10, stars: 5000, forks: 500 });
    expect(r.flags).toContain('too-new-for-stars');
    expect(r.penaltyProduct).toBe(1);
  });

  test('top contributor share > 0.8 → single-maintainer', () => {
    const r = evaluateFlags({ ...clean, topContributorShare: 0.95 });
    expect(r.flags).toContain('single-maintainer');
  });

  test('renamed → velocity-partial', () => {
    const r = evaluateFlags({ ...clean, renamed: true });
    expect(r.flags).toContain('velocity-partial');
  });
});
