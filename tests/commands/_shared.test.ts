import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorpus } from '../../src/cache/corpus.ts';
import { CORPUS_SCHEMA, createCache, saveCorpus } from '../../src/cache/index.ts';
import {
  type RawRepoNode,
  compactRow,
  learnedCeilingRecorder,
  loadCorpusOrEmpty,
  normalizeRepoNode,
  searchRepositories,
  startingBatchSize,
  updateBudgetFromGraphql,
  updateBudgetFromOssInsight,
  updateBudgetFromRestHeaders,
} from '../../src/commands/_shared.ts';
import { createGhGraphql } from '../../src/sources/gh-graphql.ts';

function fixtureNode(overrides: Partial<RawRepoNode> = {}): RawRepoNode {
  return {
    nameWithOwner: 'octocat/Hello-World',
    id: 'R_kgDOA1',
    databaseId: 1,
    stargazerCount: 1500,
    forkCount: 12,
    pushedAt: '2026-07-01T00:00:00Z',
    createdAt: '2020-01-01T00:00:00Z',
    licenseInfo: { spdxId: 'MIT' },
    repositoryTopics: { nodes: [{ topic: { name: 'markdown' } }, { topic: { name: 'macos' } }] },
    primaryLanguage: { name: 'Swift' },
    isArchived: false,
    description: 'A test repo',
    url: 'https://github.com/octocat/Hello-World',
    ...overrides,
  };
}

describe('normalizeRepoNode', () => {
  test('maps every pre-enrich field onto CorpusRepo, signals empty', () => {
    const repo = normalizeRepoNode(fixtureNode(), 'search');
    expect(repo).toEqual({
      full_name: 'octocat/Hello-World',
      ghid: 'R_kgDOA1',
      aliases: [],
      source: 'search',
      signals: {},
      stars: 1500,
      forks: 12,
      pushedAt: '2026-07-01T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z',
      license: 'MIT',
      topics: ['markdown', 'macos'],
      language: 'Swift',
      archived: false,
      description: 'A test repo',
    });
  });

  test('missing licenseInfo / primaryLanguage degrade to undefined/null, not a throw', () => {
    const repo = normalizeRepoNode(
      fixtureNode({ licenseInfo: null, primaryLanguage: null, repositoryTopics: null }),
      'agent',
    );
    expect(repo.license).toBeUndefined();
    expect(repo.language).toBeNull();
    expect(repo.topics).toEqual([]);
  });

  test('a node missing nameWithOwner/id degrades to empty strings rather than throwing', () => {
    const repo = normalizeRepoNode({}, 'search');
    expect(repo.full_name).toBe('');
    expect(repo.ghid).toBe('');
  });
});

describe('compactRow', () => {
  test('projects the display fields plus the passed-through url', () => {
    const repo = normalizeRepoNode(fixtureNode(), 'search');
    const row = compactRow(repo, 'https://github.com/octocat/Hello-World');
    expect(row).toEqual({
      full_name: 'octocat/Hello-World',
      ghid: 'R_kgDOA1',
      stars: 1500,
      forks: 12,
      pushedAt: '2026-07-01T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z',
      license: 'MIT',
      topics: ['markdown', 'macos'],
      language: 'Swift',
      archived: false,
      description: 'A test repo',
      url: 'https://github.com/octocat/Hello-World',
    });
  });
});

describe('searchRepositories', () => {
  test('sends {q, first} variables and returns repositoryCount + filtered nodes', async () => {
    let seenQuery = '';
    let seenVars: unknown;
    const ghGraphql = {
      graphql: async <T>(query: string, variables?: Record<string, unknown>) => {
        seenQuery = query;
        seenVars = variables;
        return {
          search: { repositoryCount: 2, nodes: [fixtureNode(), null] },
        } as unknown as T;
      },
    };
    const page = await searchRepositories(ghGraphql, 'topic:markdown', 30);
    expect(seenQuery).toContain('search(type: REPOSITORY, query: $q, first: $first)');
    expect(seenVars).toEqual({ q: 'topic:markdown', first: 30 });
    expect(page.repositoryCount).toBe(2);
    // The null node (an edge case the fixture forces) is filtered out, not passed through.
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]?.nameWithOwner).toBe('octocat/Hello-World');
  });
});

describe('updateBudgetFromGraphql', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghrelay-shared-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes the last rateLimit block into the graphqlPoints pool', () => {
    const cache = createCache(dir);
    const ghGraphql = {
      lastRateLimit: () => ({
        cost: 1,
        remaining: 4999,
        resetAt: '2026-07-10T01:00:00Z',
        nodeCount: 1,
      }),
    };
    updateBudgetFromGraphql(cache, ghGraphql);
    const budget = cache.budget.load();
    expect(budget.graphqlPoints).toEqual({
      remaining: 4999,
      resetAt: '2026-07-10T01:00:00Z',
      lastCost: 1,
    });
  });

  test('a null lastRateLimit (no call made yet) is a no-op, not a crash', () => {
    const cache = createCache(dir);
    updateBudgetFromGraphql(cache, { lastRateLimit: () => null });
    expect(cache.budget.load().graphqlPoints).toBeUndefined();
  });
});

describe('updateBudgetFromRestHeaders', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghrelay-shared-rest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes x-ratelimit-remaining/-reset into the given pool, reset converted to ISO', () => {
    const cache = createCache(dir);
    const headers = new Headers({
      'x-ratelimit-remaining': '27',
      'x-ratelimit-reset': '1752105600',
    });
    updateBudgetFromRestHeaders(cache, 'restSearch', headers);
    expect(cache.budget.load().restSearch).toEqual({
      remaining: 27,
      resetAt: new Date(1752105600 * 1000).toISOString(),
    });
  });

  test('headers without x-ratelimit-* are a no-op, not a crash', () => {
    const cache = createCache(dir);
    updateBudgetFromRestHeaders(cache, 'restSearch', new Headers());
    expect(cache.budget.load().restSearch).toBeUndefined();
  });
});

describe('updateBudgetFromOssInsight', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghrelay-shared-ossinsight-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a live rate window is persisted verbatim', () => {
    const cache = createCache(dir);
    updateBudgetFromOssInsight(cache, { remaining: 598, resetAt: '2026-07-11T14:00:00.000Z' });
    expect(cache.budget.load().ossinsight).toEqual({
      remaining: 598,
      resetAt: '2026-07-11T14:00:00.000Z',
    });
  });

  test('no headers + nothing observed yet seeds from the documented 600/hr ceiling', () => {
    const cache = createCache(dir);
    const now = () => Date.parse('2026-07-11T13:10:00Z');
    updateBudgetFromOssInsight(cache, undefined, now);
    expect(cache.budget.load().ossinsight).toEqual({
      remaining: 599,
      resetAt: new Date(Date.parse('2026-07-11T13:10:00Z') + 60 * 60 * 1000).toISOString(),
    });
  });

  test('no headers + a live prior window decrements locally by one, resetAt unchanged', () => {
    const cache = createCache(dir);
    const now = () => Date.parse('2026-07-11T13:10:00Z');
    cache.budget.updatePool('ossinsight', {
      remaining: 500,
      resetAt: new Date(Date.parse('2026-07-11T13:10:00Z') + 30 * 60 * 1000).toISOString(),
    });
    updateBudgetFromOssInsight(cache, undefined, now);
    expect(cache.budget.load().ossinsight).toEqual({
      remaining: 499,
      resetAt: new Date(Date.parse('2026-07-11T13:10:00Z') + 30 * 60 * 1000).toISOString(),
    });
  });

  test('no headers + a prior window that already reset re-seeds fresh, never goes negative', () => {
    const cache = createCache(dir);
    const now = () => Date.parse('2026-07-11T13:10:00Z');
    cache.budget.updatePool('ossinsight', {
      remaining: 0,
      resetAt: new Date(Date.parse('2026-07-11T12:00:00Z')).toISOString(), // already past
    });
    updateBudgetFromOssInsight(cache, undefined, now);
    expect(cache.budget.load().ossinsight).toEqual({
      remaining: 599,
      resetAt: new Date(Date.parse('2026-07-11T13:10:00Z') + 60 * 60 * 1000).toISOString(),
    });
  });

  test('a real header snapshot always overrides local counting on the next call', () => {
    const cache = createCache(dir);
    const now = () => Date.parse('2026-07-11T13:10:00Z');
    updateBudgetFromOssInsight(cache, undefined, now); // seeds 599 locally
    updateBudgetFromOssInsight(cache, { remaining: 42, resetAt: '2026-07-11T14:00:00.000Z' }, now);
    expect(cache.budget.load().ossinsight).toEqual({
      remaining: 42,
      resetAt: '2026-07-11T14:00:00.000Z',
    });
  });
});

describe('startingBatchSize — learned GraphQL batch ceilings (fix wave 2: floor, expiry, per-fragment classes)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghrelay-shared-ceiling-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const now = () => Date.parse('2026-07-11T00:00:00.000Z');

  test('nothing learned yet → the static default', () => {
    const cache = createCache(dir);
    expect(startingBatchSize(cache, 'enrich-light', 25)).toBe(25);
  });

  test('a fresh learned ceiling below the static default wins', () => {
    const cache = createCache(dir);
    cache.budget.updateLearnedCeiling('enrich-light', {
      size: 12,
      observedAt: new Date(now() - 60_000).toISOString(), // 1 minute ago
    });
    expect(startingBatchSize(cache, 'enrich-light', 25, now)).toBe(12);
  });

  test("a learned ceiling never exceeds the CALLER's own static default, even if the stored value is higher", () => {
    const cache = createCache(dir);
    cache.budget.updateLearnedCeiling('pre-enrich', {
      size: 40, // e.g. hydrate's own default, higher than enrich's
      observedAt: new Date(now() - 60_000).toISOString(),
    });
    expect(startingBatchSize(cache, 'pre-enrich', 25, now)).toBe(25);
  });

  test('floors at 1 even against a corrupt/negative stored value', () => {
    const cache = createCache(dir);
    cache.budget.updateLearnedCeiling('heavy', {
      size: -5,
      observedAt: new Date(now() - 60_000).toISOString(),
    });
    expect(startingBatchSize(cache, 'heavy', 10, now)).toBe(1);
  });

  test('fragment classes are independent — a heavy ceiling never affects enrich-light or pre-enrich', () => {
    const cache = createCache(dir);
    cache.budget.updateLearnedCeiling('heavy', {
      size: 3,
      observedAt: new Date(now() - 60_000).toISOString(),
    });
    expect(startingBatchSize(cache, 'enrich-light', 25, now)).toBe(25);
    expect(startingBatchSize(cache, 'pre-enrich', 50, now)).toBe(50);
  });

  // ── fix wave 2 IMP 1: expiry ──────────────────────────────────────────
  test('a ceiling observed 8 days ago is stale — starts back at the static default', () => {
    const cache = createCache(dir);
    const eightDaysAgo = now() - 8 * 24 * 60 * 60 * 1000;
    cache.budget.updateLearnedCeiling('enrich-light', {
      size: 12,
      observedAt: new Date(eightDaysAgo).toISOString(),
    });
    expect(startingBatchSize(cache, 'enrich-light', 25, now)).toBe(25);
  });

  test('a ceiling observed 6 days ago is still fresh', () => {
    const cache = createCache(dir);
    const sixDaysAgo = now() - 6 * 24 * 60 * 60 * 1000;
    cache.budget.updateLearnedCeiling('enrich-light', {
      size: 12,
      observedAt: new Date(sixDaysAgo).toISOString(),
    });
    expect(startingBatchSize(cache, 'enrich-light', 25, now)).toBe(12);
  });

  // ── fix wave 2 IMP 1: bare-number migration ───────────────────────────
  test('a legacy bare-number entry (pre-fix-wave-2 shape, no timestamp) is always treated as stale', () => {
    const cache = createCache(dir);
    cache.budget.save({ learnedCeilings: { 'enrich-light': 12 } });
    expect(startingBatchSize(cache, 'enrich-light', 25, now)).toBe(25);
  });

  // ── fix wave 2 IMP 2: per-fragment classes, not a shared weight bucket ─
  test("cross-class isolation: enrich's ceiling never throttles hydrate's pre-enrich default", () => {
    const cache = createCache(dir);
    cache.budget.updateLearnedCeiling('enrich-light', {
      size: 12,
      observedAt: new Date(now() - 60_000).toISOString(),
    });
    expect(startingBatchSize(cache, 'pre-enrich', 50, now)).toBe(50);
  });
});

describe('learnedCeilingRecorder (fix wave 2: floor, expiry-aware tightening, per-fragment classes)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghrelay-shared-recorder-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const now = () => Date.parse('2026-07-11T00:00:00.000Z');

  test('a chunk succeeding at the full requested size teaches nothing (no write)', () => {
    const cache = createCache(dir);
    const record = learnedCeilingRecorder(cache, 'enrich-light', 25, now);
    record(25);
    expect(cache.budget.load().learnedCeilings['enrich-light']).toBeUndefined();
  });

  test('a chunk that succeeded smaller than requested (bisection) persists it, with a fresh observedAt', () => {
    const cache = createCache(dir);
    const record = learnedCeilingRecorder(cache, 'enrich-light', 25, now);
    record(12);
    expect(cache.budget.load().learnedCeilings['enrich-light']).toEqual({
      size: 12,
      observedAt: new Date(now()).toISOString(),
    });
  });

  test('persists the MINIMUM observed across multiple calls, never grows back up', () => {
    const cache = createCache(dir);
    const record = learnedCeilingRecorder(cache, 'enrich-light', 25, now);
    record(12);
    record(20); // larger than the current 12 — must not overwrite upward
    expect(cache.budget.load().learnedCeilings['enrich-light']).toMatchObject({ size: 12 });
    record(6); // smaller — tightens further
    expect(cache.budget.load().learnedCeilings['enrich-light']).toMatchObject({ size: 6 });
  });

  // ── fix wave 2 IMP 1: persisted floor of 5 ─────────────────────────────
  test('a size-1 success is persisted floored at 5, never below', () => {
    const cache = createCache(dir);
    const record = learnedCeilingRecorder(cache, 'enrich-light', 25, now);
    record(1);
    expect(cache.budget.load().learnedCeilings['enrich-light']).toMatchObject({ size: 5 });
  });

  test('an observation of exactly the floor persists exactly the floor', () => {
    const cache = createCache(dir);
    learnedCeilingRecorder(cache, 'enrich-light', 25, now)(5);
    expect(cache.budget.load().learnedCeilings['enrich-light']).toMatchObject({ size: 5 });
  });

  // ── fix wave 2 IMP 1: a stale/legacy current entry doesn't constrain a fresh observation ─
  test('a stale current ceiling is ignored as a floor — a fresh, LARGER observation still overwrites it', () => {
    const cache = createCache(dir);
    const staleTime = now() - 8 * 24 * 60 * 60 * 1000;
    cache.budget.updateLearnedCeiling('enrich-light', {
      size: 5,
      observedAt: new Date(staleTime).toISOString(),
    });
    // A fresh bisection observes 20 (still < the 25 requested this run) — since
    // the stale 5 doesn't count as "current", this is simply the new minimum.
    learnedCeilingRecorder(cache, 'enrich-light', 25, now)(20);
    expect(cache.budget.load().learnedCeilings['enrich-light']).toMatchObject({ size: 20 });
  });

  test('a legacy bare-number current entry is ignored as a floor the same way', () => {
    const cache = createCache(dir);
    cache.budget.save({ learnedCeilings: { 'enrich-light': 5 } });
    learnedCeilingRecorder(cache, 'enrich-light', 25, now)(20);
    expect(cache.budget.load().learnedCeilings['enrich-light']).toMatchObject({ size: 20 });
  });

  test('fragment classes write to independent keys', () => {
    const cache = createCache(dir);
    learnedCeilingRecorder(cache, 'enrich-light', 25, now)(12);
    learnedCeilingRecorder(cache, 'heavy', 10, now)(6);
    const ceilings = cache.budget.load().learnedCeilings;
    expect(ceilings).toEqual({
      'enrich-light': { size: 12, observedAt: new Date(now()).toISOString() },
      heavy: { size: 6, observedAt: new Date(now()).toISOString() },
    });
  });

  test('round-trips across two independent createCache instances on the same root', () => {
    const cacheA = createCache(dir);
    learnedCeilingRecorder(cacheA, 'enrich-light', 25, now)(12);
    const cacheB = createCache(dir);
    expect(startingBatchSize(cacheB, 'enrich-light', 25, now)).toBe(12);
  });
});

describe('learnedCeilingRecorder + startingBatchSize — wired to the REAL gh-graphql adapter (task 12 fix wave 1)', () => {
  // These exercise the actual batchRepositories chunking/bisection interaction
  // (real createGhGraphql, a fake fetch, no simulated onEffectiveSize calls) —
  // the layer the fix-wave-1 bug actually lived in, not a hand-invoked callback.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghrelay-shared-realadapter-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const getToken = async () => 'test-token';

  function aliasCountOf(body: unknown): number {
    return (String(body ?? '').match(/repository\(/g) ?? []).length;
  }

  function fetchImplAlwaysSucceeds(): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      const aliasCount = aliasCountOf(init?.body);
      const data: Record<string, unknown> = { rateLimit: {} };
      for (let i = 0; i < aliasCount; i++) data[`r${i}`] = { i };
      return Response.json({ data });
    }) as unknown as typeof fetch;
  }

  function fetchImplBisectsAbove(threshold: number): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      const aliasCount = aliasCountOf(init?.body);
      if (aliasCount > threshold) return new Response('gateway', { status: 502 });
      const data: Record<string, unknown> = { rateLimit: {} };
      for (let i = 0; i < aliasCount; i++) data[`r${i}`] = { i };
      return Response.json({ data });
    }) as unknown as typeof fetch;
  }

  test('a clean 27-repo run through the real adapter (no failures) never persists a ceiling', async () => {
    const cache = createCache(dir);
    const gh = createGhGraphql({ fetchImpl: fetchImplAlwaysSucceeds(), getToken });
    const names = Array.from({ length: 27 }, (_, i) => `o/repo${i}`);
    const batchSize = startingBatchSize(cache, 'enrich-light', 25);
    expect(batchSize).toBe(25); // nothing learned yet
    await gh.batchRepositories(names, 'x', {
      batchSize,
      onEffectiveSize: learnedCeilingRecorder(cache, 'enrich-light', batchSize),
    });
    expect(cache.budget.load().learnedCeilings['enrich-light']).toBeUndefined();
  });

  test('a genuinely bisected run persists ceiling 12; a subsequent run (fresh createCache, same root) starts its FIRST call already at 12', async () => {
    const cacheA = createCache(dir);
    const names = Array.from({ length: 24 }, (_, i) => `o/repo${i}`);
    const ghA = createGhGraphql({ fetchImpl: fetchImplBisectsAbove(12), getToken });
    const batchSizeA = startingBatchSize(cacheA, 'enrich-light', 24);
    expect(batchSizeA).toBe(24);
    await ghA.batchRepositories(names, 'x', {
      batchSize: batchSizeA,
      onEffectiveSize: learnedCeilingRecorder(cacheA, 'enrich-light', batchSizeA),
    });
    expect(cacheA.budget.load().learnedCeilings['enrich-light']).toMatchObject({ size: 12 });

    // A fresh createCache instance on the SAME root — proves the ceiling
    // round-trips through the file, not just an in-process object.
    const cacheB = createCache(dir);
    const batchSizeB = startingBatchSize(cacheB, 'enrich-light', 24);
    expect(batchSizeB).toBe(12);

    const callSizes: number[] = [];
    const trackingFetch: typeof fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      callSizes.push(aliasCountOf(init?.body));
      return fetchImplBisectsAbove(12)(url, init);
    }) as unknown as typeof fetch;
    const ghB = createGhGraphql({ fetchImpl: trackingFetch, getToken });
    await ghB.batchRepositories(names, 'x', {
      batchSize: batchSizeB,
      onEffectiveSize: learnedCeilingRecorder(cacheB, 'enrich-light', batchSizeB),
    });
    // Already at the learned ceiling: two natural 12-name chunks, both succeed
    // directly — no bisection needed this run (3 calls → 2).
    expect(callSizes).toEqual([12, 12]);
    // Nothing new was learned (no bisection fired), so the persisted ceiling
    // is untouched — proves the fix doesn't just avoid COLLAPSING it, it also
    // leaves an already-correct value alone.
    expect(cacheB.budget.load().learnedCeilings['enrich-light']).toMatchObject({ size: 12 });
  });
});

describe('loadCorpusOrEmpty', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghrelay-shared-corpus-'));
    path = join(dir, 'corpus.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a missing file becomes a fresh empty corpus tagged with the given intent', () => {
    const now = () => Date.parse('2026-07-10T00:00:00Z');
    const corpus = loadCorpusOrEmpty(path, 'markdown editors', now);
    expect(corpus).toEqual({
      schema: CORPUS_SCHEMA,
      intent: 'markdown editors',
      generatedAt: '2026-07-10T00:00:00.000Z',
      queries: [],
      count: 0,
      repos: [],
    });
  });

  test('an existing valid corpus loads through untouched', () => {
    const existing = createCorpus('intent', ['q1']);
    saveCorpus(path, existing);
    const loaded = loadCorpusOrEmpty(path, 'ignored intent');
    expect(loaded.intent).toBe('intent');
    expect(loaded.queries).toEqual(['q1']);
  });

  test('a corrupt (non-JSON) file still fails loud (INVALID_INPUT), not silently swallowed', () => {
    writeFileSync(path, 'not json');
    expect(() => loadCorpusOrEmpty(path, 'intent')).toThrow();
  });
});
