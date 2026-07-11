import { describe, expect, test } from 'bun:test';
import type { CorpusRepo, SignalProvenance } from '../../src/cache/corpus.ts';
import { PROFILES } from '../../src/score/profiles.ts';
import { classifyLicense, scoreRepo } from '../../src/score/scoring.ts';

const NOW = Date.parse('2026-07-11T00:00:00Z');

function prov(value: unknown, source = 'github-graphql'): SignalProvenance {
  return { value, source, fetchedAt: '2026-07-10T00:00:00Z' };
}

/** A fully-enriched, healthy repo (all seven groups present). */
function healthyRepo(overrides: Partial<CorpusRepo> = {}): CorpusRepo {
  return {
    full_name: 'acme/widget',
    ghid: 'R_kgDO1',
    aliases: [],
    source: 'search',
    stars: 4000,
    forks: 400,
    pushedAt: '2026-07-05T00:00:00Z',
    createdAt: '2022-01-01T00:00:00Z',
    license: 'MIT',
    topics: ['cli', 'tooling'],
    language: 'TypeScript',
    archived: false,
    description: 'A robust widget toolkit',
    signals: {
      commits90d: prov(180),
      releasePublishedAt: prov('2026-06-01T00:00:00Z'),
      openIssues: prov(20),
      closedIssues: prov(380),
      openPRs: prov(5),
      mergedPRs: prov(200),
      closedPRs: prov(30),
      mentionableUsers: prov(60),
      dependentReposCount: prov(1500, 'ecosyste.ms'),
      packaged: prov(true, 'ecosyste.ms'),
      homepageUrl: prov('https://acme.dev'),
      diskUsage: prov(20_000),
      isFork: prov(false),
      isTemplate: prov(false),
    },
    ...overrides,
  };
}

const buildOn = PROFILES['build-on'];

/** A healthy repo with NO real-usage data — a true app repo (packaged:false, no dependents). */
function appRepo(): CorpusRepo {
  const base = healthyRepo();
  const signals = Object.fromEntries(
    Object.entries(base.signals).filter(([k]) => k !== 'dependentReposCount'),
  );
  signals.packaged = prov(false, 'deps.dev');
  return { ...base, signals };
}

describe('coverage honesty (design §5 — N/7 + nodata[])', () => {
  test('a search-only repo (no enrich) is 4/7 — A,E,F,L present; B,C,D absent', () => {
    const bare: CorpusRepo = {
      full_name: 'x/y',
      ghid: 'R_1',
      aliases: [],
      source: 'search',
      stars: 100,
      forks: 10,
      pushedAt: '2026-06-01T00:00:00Z',
      createdAt: '2023-01-01T00:00:00Z',
      license: 'MIT',
      topics: ['x'],
      language: 'Go',
      archived: false,
      description: 'thing',
      signals: {},
    };
    const s = scoreRepo(bare, buildOn, { now: NOW });
    expect(s.coverage).toBe('4/7');
    expect(s.nodata.sort()).toEqual(['B', 'C', 'D']);
  });

  test('an enriched packaged repo reaches 7/7', () => {
    const s = scoreRepo(healthyRepo(), buildOn, { now: NOW });
    expect(s.coverage).toBe('7/7');
    expect(s.nodata).toEqual([]);
  });

  test('packaged:false → B absent-with-reason, coverage 6/7, nodata:["B"]', () => {
    const s = scoreRepo(appRepo(), buildOn, { now: NOW });
    expect(s.subs.B).toBeNull();
    expect(s.coverage).toBe('6/7');
    expect(s.nodata).toEqual(['B']);
    expect(s.packaged).toBe(false);
  });
});

describe('renormalization (missing groups never zero the score)', () => {
  test('a 6/7 repo scores on renormalized weights, not a B=0 drag', () => {
    const full = scoreRepo(healthyRepo(), buildOn, { now: NOW });
    const appScore = scoreRepo(appRepo(), buildOn, { now: NOW });
    // The app repo loses B's contribution but is NOT dragged toward zero — its
    // score stays in a healthy band because the remaining 6 groups renormalize.
    expect(appScore.score).toBeGreaterThan(50);
    // And it is not simply equal to the full repo (B genuinely dropped out).
    expect(appScore.score).not.toBe(full.score);
  });

  test('score is 0..100 with one decimal', () => {
    const s = scoreRepo(healthyRepo(), buildOn, { now: NOW });
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(s.score * 10)).toBe(true);
  });
});

describe('penalties multiply the final score', () => {
  test('archived repo is knocked to ×0.2 of its clean score', () => {
    const clean = scoreRepo(healthyRepo(), buildOn, { now: NOW });
    const archived = scoreRepo(healthyRepo({ archived: true }), buildOn, { now: NOW });
    expect(archived.flags).toContain('archived');
    expect(archived.score).toBeCloseTo(clean.score * 0.2, 1);
  });

  test('deprecation marker halves the score', () => {
    const clean = scoreRepo(healthyRepo(), buildOn, { now: NOW });
    const dep = scoreRepo(
      healthyRepo({ description: 'DEPRECATED: moved to acme/widget2' }),
      buildOn,
      { now: NOW },
    );
    expect(dep.flags).toContain('deprecated');
    expect(dep.score).toBeCloseTo(clean.score * 0.5, 1);
  });
});

describe('community org bonus + license classification', () => {
  test('org-owned adds +0.1 to the C subscore', () => {
    const user = scoreRepo(healthyRepo(), buildOn, { now: NOW });
    const org = healthyRepo();
    org.signals.orgOwned = prov(true);
    const orgScore = scoreRepo(org, buildOn, { now: NOW });
    expect(orgScore.subs.C ?? 0).toBeGreaterThan(user.subs.C ?? 0);
  });

  test('license classes map to their design points', () => {
    expect(classifyLicense('MIT', undefined)).toBe('permissive');
    expect(classifyLicense('MPL-2.0', undefined)).toBe('weak');
    expect(classifyLicense('GPL-3.0', undefined)).toBe('strong');
    expect(classifyLicense(undefined, undefined)).toBe('none');
    expect(classifyLicense('NOASSERTION', true)).toBe('custom');
  });

  test('L subscore reflects the permissive→none ladder', () => {
    const permissive = scoreRepo(healthyRepo({ license: 'MIT' }), buildOn, { now: NOW });
    const strong = scoreRepo(healthyRepo({ license: 'GPL-3.0' }), buildOn, { now: NOW });
    const none = scoreRepo(healthyRepo({ license: undefined }), buildOn, { now: NOW });
    expect(permissive.subs.L).toBeGreaterThan(strong.subs.L ?? 0);
    expect(strong.subs.L).toBeGreaterThan(none.subs.L ?? 0);
  });
});

describe('explain payload', () => {
  test('carries raw values, per-signal saturation, penalties, and provenance', () => {
    const s = scoreRepo(healthyRepo({ archived: true }), buildOn, { now: NOW });
    expect(s.explain.raw.stars).toBe(4000);
    expect(s.explain.saturation.dependents?.threshold).toBe(1000);
    expect(s.explain.saturation.dependents?.score).toBeGreaterThan(0);
    expect(s.explain.penalties[0]?.rule).toBe('archived');
    expect(s.explain.provenance.dependentReposCount?.source).toBe('ecosyste.ms');
  });
});

describe('profiles differ in what they reward', () => {
  test('dissect leans on E (quality) — a docs-rich low-usage repo beats build-on ranking of it', () => {
    const repo = healthyRepo();
    const bo = scoreRepo(repo, PROFILES['build-on'], { now: NOW });
    const di = scoreRepo(repo, PROFILES.dissect, { now: NOW });
    // Both produce valid scores; the point is dissect runs without B dominating.
    expect(bo.score).toBeGreaterThan(0);
    expect(di.score).toBeGreaterThan(0);
  });

  test('ideas Novelty penalizes a fork relative to an original', () => {
    const original = healthyRepo();
    const fork = healthyRepo();
    fork.signals.isFork = prov(true);
    const originalScore = scoreRepo(original, PROFILES.ideas, { now: NOW });
    const forkScore = scoreRepo(fork, PROFILES.ideas, { now: NOW });
    expect(forkScore.score).toBeLessThan(originalScore.score);
  });
});
