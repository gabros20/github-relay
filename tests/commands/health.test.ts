import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORPUS_SCHEMA,
  type Corpus,
  type CorpusRepo,
  loadCorpus,
  saveCorpus,
} from '../../src/cache/corpus.ts';
import { createCache } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import {
  type HealthSources,
  buildHeavyFragment,
  deriveVelocity,
  healthOptsFromArgs,
  isBotAuthor,
  medianCloseLatencyDays,
  readStarredAtSample,
  runHealth,
  topContributorShare,
} from '../../src/commands/health.ts';
import {
  type ClickhouseEventRow,
  createClickhousePlay,
} from '../../src/sources/clickhouse-play.ts';
import type { RepoResult } from '../../src/sources/gh-graphql.ts';
import { EngineError } from '../../src/types.ts';

const NOW_ISO = '2026-07-11T00:00:00Z';
const NOW = () => Date.parse(NOW_ISO);

// ── pure helpers ───────────────────────────────────────────────────────────

describe('isBotAuthor', () => {
  test('a Bot typename or a [bot]-suffixed login is a bot; a human and null are not', () => {
    expect(isBotAuthor({ __typename: 'Bot', login: 'dependabot' })).toBe(true);
    expect(isBotAuthor({ __typename: 'User', login: 'renovate[bot]' })).toBe(true);
    expect(isBotAuthor({ __typename: 'User', login: 'octocat' })).toBe(false);
    expect(isBotAuthor(null)).toBe(false);
    expect(isBotAuthor(undefined)).toBe(false);
  });
});

describe('medianCloseLatencyDays', () => {
  test('filters bot-authored issues, then takes the median latency in days', () => {
    const issues = [
      {
        createdAt: '2026-06-01T00:00:00Z',
        closedAt: '2026-06-05T00:00:00Z',
        author: { login: 'a' },
      }, // 4d
      {
        createdAt: '2026-06-01T00:00:00Z',
        closedAt: '2026-06-03T00:00:00Z',
        author: { login: 'b' },
      }, // 2d
      {
        createdAt: '2026-06-01T00:00:00Z',
        closedAt: '2026-06-07T00:00:00Z',
        author: { login: 'c' },
      }, // 6d
      // bot issue with a huge latency — must be excluded from the sample.
      {
        createdAt: '2020-01-01T00:00:00Z',
        closedAt: '2026-01-01T00:00:00Z',
        author: { __typename: 'Bot', login: 'x' },
      },
    ];
    expect(medianCloseLatencyDays(issues)).toBe(4); // median of [2,4,6]
  });

  test('an even count averages the two middle latencies', () => {
    const issues = [
      {
        createdAt: '2026-06-01T00:00:00Z',
        closedAt: '2026-06-03T00:00:00Z',
        author: { login: 'a' },
      }, // 2
      {
        createdAt: '2026-06-01T00:00:00Z',
        closedAt: '2026-06-07T00:00:00Z',
        author: { login: 'b' },
      }, // 6
    ];
    expect(medianCloseLatencyDays(issues)).toBe(4);
  });

  test('no human-closed issue with both timestamps → null (D rests on the ratio alone)', () => {
    expect(medianCloseLatencyDays([])).toBeNull();
    expect(
      medianCloseLatencyDays([
        { createdAt: '2026-06-01T00:00:00Z', closedAt: null, author: { login: 'a' } },
      ]),
    ).toBeNull();
  });
});

describe('topContributorShare', () => {
  test('top-1 commits over the sum of the returned contributors', () => {
    expect(topContributorShare([{ contributions: 90 }, { contributions: 10 }])).toBeCloseTo(0.9, 5);
  });
  test('empty / zero-total → null', () => {
    expect(topContributorShare([])).toBeNull();
    expect(topContributorShare([{ contributions: 0 }, { contributions: 0 }])).toBeNull();
  });
});

describe('deriveVelocity', () => {
  const rows = (r: Partial<ClickhouseEventRow>[]): ClickhouseEventRow[] =>
    r.map((x) => ({
      repo_name: 'a/b',
      month: '2020-01-01',
      event_type: 'WatchEvent',
      stars: 0,
      ...x,
    }));

  test('burstiness is the max-month share of lifetime WatchEvents', () => {
    const v = deriveVelocity(
      rows([
        { month: '2019-01-01', event_type: 'WatchEvent', stars: 100 },
        { month: '2020-06-01', event_type: 'WatchEvent', stars: 900 },
      ]),
      null,
    );
    expect(v?.burstiness).toBeCloseTo(0.9, 5);
    expect(v?.lifetimeStars).toBe(1000);
    expect(v?.peakStarMonth).toBe('2020-06-01');
  });

  test('viral corroboration: release + issue influx + fork growth all coincide with the burst month', () => {
    const v = deriveVelocity(
      rows([
        { month: '2019-01-01', event_type: 'WatchEvent', stars: 50 },
        { month: '2020-06-01', event_type: 'WatchEvent', stars: 950 },
        { month: '2020-06-01', event_type: 'IssuesEvent', stars: 40 },
        { month: '2019-01-01', event_type: 'IssuesEvent', stars: 1 },
        { month: '2020-06-01', event_type: 'ForkEvent', stars: 30 },
        { month: '2019-01-01', event_type: 'ForkEvent', stars: 1 },
      ]),
      '2020-06-01',
    );
    expect(v?.burstReleaseCoincides).toBe(true);
    expect(v?.burstIssueInflux).toBe(true);
    expect(v?.burstForkGrowth).toBe(true);
  });

  test('a pure star burst with no matching activity does NOT corroborate', () => {
    const v = deriveVelocity(
      rows([
        { month: '2019-01-01', event_type: 'WatchEvent', stars: 50 },
        { month: '2020-06-01', event_type: 'WatchEvent', stars: 950 },
      ]),
      null,
    );
    expect(v?.burstReleaseCoincides).toBe(false);
    expect(v?.burstIssueInflux).toBe(false);
    expect(v?.burstForkGrowth).toBe(false);
  });

  test('no WatchEvent rows → null (F stays partial, never a fabricated histogram)', () => {
    expect(deriveVelocity([], null)).toBeNull();
  });
});

describe('readStarredAtSample — three degradation shapes (CRITICAL hardening note)', () => {
  test('a genuine sample → shape ok with a span in days', () => {
    const s = readStarredAtSample({
      stargazers: {
        edges: [{ starredAt: '2026-01-01T00:00:00Z' }, { starredAt: '2026-01-11T00:00:00Z' }],
      },
    });
    expect(s.shape).toBe('ok');
    expect(s.count).toBe(2);
    expect(s.spanDays).toBe(10);
  });
  test('a null stargazers connection (200 + partial error) → null-connection, absent', () => {
    expect(readStarredAtSample({ stargazers: null }).shape).toBe('null-connection');
  });
  test('present edges with null starredAt values → null-edges, absent', () => {
    expect(readStarredAtSample({ stargazers: { edges: [{ starredAt: null }, null] } }).shape).toBe(
      'null-edges',
    );
  });
  test('the field was never requested (probe restricted) → probe-skipped', () => {
    expect(readStarredAtSample({}).shape).toBe('probe-skipped');
  });
});

describe('buildHeavyFragment', () => {
  test('includes stargazers only when the probe says the field is alive', () => {
    expect(buildHeavyFragment(NOW(), true)).toContain('stargazers(first: 100');
    expect(buildHeavyFragment(NOW(), false)).not.toContain('stargazers');
    expect(buildHeavyFragment(NOW(), false)).toContain('open90d');
    expect(buildHeavyFragment(NOW(), false)).toContain('closed90d');
  });
});

// ── runner: fakes + fixtures ─────────────────────────────────────────────────

interface FakeConfig {
  probe?: 'available' | 'restricted' | 'throw';
  heavy?: Record<string, unknown>; // fullName -> HeavyNode data (or omit → NOT_FOUND)
  clickhouse?: (names: string[]) => ClickhouseEventRow[];
  clickhouseThrow?: EngineError;
  contributors?: Record<string, { login: string; contributions: number }[]>;
  contributorsThrow?: Set<string>;
}

interface FakeHandle {
  sources: HealthSources;
  clickhouseCalls: number;
  heavyBatchSizes: number[];
  contributorPaths: string[];
}

function fakeSources(cfg: FakeConfig): FakeHandle {
  const handle: FakeHandle = {
    sources: {} as HealthSources,
    clickhouseCalls: 0,
    heavyBatchSizes: [],
    contributorPaths: [],
  };
  const rate = { cost: 1, remaining: 4999, resetAt: '2026-07-11T02:00:00Z', nodeCount: 10 };
  handle.sources = {
    ghGraphql: {
      lastRateLimit: () => rate,
      graphql: async <T = unknown>() => {
        if (cfg.probe === 'throw') throw new EngineError('FETCH_FAILED', 'probe blew up');
        if (cfg.probe === 'restricted') return { repository: { stargazers: null } } as T;
        return { repository: { stargazers: { edges: [{ starredAt: NOW_ISO }] } } } as T;
      },
      batchRepositories: async <T = unknown>(
        names: string[],
        _fragment: string,
        opts?: { batchSize?: number },
      ) => {
        handle.heavyBatchSizes.push(opts?.batchSize ?? 25);
        return names.map((name): RepoResult<T> => {
          const data = cfg.heavy?.[name];
          if (data === undefined)
            return { name, data: null, error: { code: 'NOT_FOUND', message: 'gone' } };
          return { name, data: data as T };
        });
      },
    },
    ghRest: {
      get: async (path: string) => {
        handle.contributorPaths.push(path);
        const fullName = path.slice('/repos/'.length, path.indexOf('/contributors'));
        if (cfg.contributorsThrow?.has(fullName))
          throw new EngineError('SOURCE_DOWN', 'contributors down');
        return {
          status: 200,
          headers: new Headers(),
          body: cfg.contributors?.[fullName] ?? [],
          etag: null,
        };
      },
    },
    clickhouse: {
      monthlyEvents: async (names: string[]) => {
        handle.clickhouseCalls += 1;
        if (cfg.clickhouseThrow) throw cfg.clickhouseThrow;
        return cfg.clickhouse ? cfg.clickhouse(names) : [];
      },
    },
  };
  return handle;
}

/** A heavy-fragment node with sensible defaults; override any field. */
function heavyNode(fullName: string, o: Record<string, unknown> = {}) {
  return {
    nameWithOwner: fullName,
    id: `R_${fullName}`,
    recentClosed: {
      nodes: [
        {
          createdAt: '2026-06-01T00:00:00Z',
          closedAt: '2026-06-05T00:00:00Z',
          author: { login: 'human' },
        },
      ],
    },
    open90d: { totalCount: 5 },
    closed90d: { totalCount: 15 },
    stargazers: {
      edges: [{ starredAt: '2026-06-01T00:00:00Z' }, { starredAt: '2026-07-01T00:00:00Z' }],
    },
    ...o,
  };
}

/** An enriched corpus row: A+B+E+F+L present, but C and D deliberately absent (health completes them). */
function enrichedRepo(fullName: string, o: Partial<CorpusRepo> = {}): CorpusRepo {
  return {
    full_name: fullName,
    ghid: `R_${fullName}`,
    aliases: [],
    source: 'search',
    stars: 1200,
    forks: 200,
    pushedAt: '2026-07-01T00:00:00Z',
    createdAt: '2020-01-01T00:00:00Z',
    license: 'MIT',
    topics: ['cli'],
    language: 'Go',
    description: 'a tool',
    signals: {
      commits90d: { value: 120, source: 'github-graphql', fetchedAt: NOW_ISO },
      dependentReposCount: { value: 300, source: 'ecosyste.ms', fetchedAt: NOW_ISO },
    },
    ...o,
  };
}

function writeCorpus(dir: string, repos: CorpusRepo[]): string {
  const path = join(dir, 'corpus.json');
  const corpus: Corpus = {
    schema: CORPUS_SCHEMA,
    intent: 'test',
    generatedAt: NOW_ISO,
    queries: [],
    count: repos.length,
    repos,
  };
  saveCorpus(path, corpus, NOW);
  return path;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-health-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('healthOptsFromArgs', () => {
  test('parses ids + --in', () => {
    expect(healthOptsFromArgs(parseArgs(['health', 'a/b', 'c/d', '--in', 'x.json']))).toEqual({
      in: 'x.json',
      ids: ['a/b', 'c/d'],
      quiet: false,
    });
  });
});

describe('runHealth — end-to-end coverage completion', () => {
  test('a 3-repo corpus reaches coverage 7/7, C/D/F change, ONE ClickHouse POST', async () => {
    const names = ['o/one', 'o/two', 'o/three'];
    const path = writeCorpus(
      dir,
      names.map((n) => enrichedRepo(n)),
    );
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'available',
      heavy: Object.fromEntries(names.map((n) => [n, heavyNode(n)])),
      clickhouse: (ns) =>
        ns.flatMap((n) => [
          { repo_name: n, month: '2019-01-01', event_type: 'WatchEvent', stars: 200 },
          { repo_name: n, month: '2020-06-01', event_type: 'WatchEvent', stars: 300 },
        ]),
      contributors: Object.fromEntries(
        names.map((n) => [
          n,
          [
            { login: 'a', contributions: 60 },
            { login: 'b', contributions: 40 },
          ],
        ]),
      ),
    });

    const result = await runHealth(handle.sources, cache, { in: path, ids: names }, { now: NOW });

    expect(handle.clickhouseCalls).toBe(1); // ONE POST regardless of N ids
    expect(handle.heavyBatchSizes).toEqual([10]); // ≤10 heavy batch
    expect(result.verified).toBe(3);
    expect(result.clickhouse).toBe('ok');
    for (const r of result.repos) {
      expect(r.coverage).toBe('7/7');
      expect(r.subs.C).not.toBeNull();
      expect(r.subs.D).not.toBeNull();
      expect(r.subs.F).not.toBeNull();
    }
    // Signals persisted with provenance.
    const saved = loadCorpus(path);
    const one = saved.repos.find((r) => r.full_name === 'o/one');
    expect(one?.signals.topContributorShare?.source).toBe('github-rest');
    expect(one?.signals.burstiness?.source).toBe('clickhouse-play');
    expect(one?.signals.closeLatencyDays?.source).toBe('github-graphql');
    expect(one?.signals.openIssues?.value).toBe(5); // 90d state-split overwrote lifetime
  });
});

describe('runHealth — ClickHouse degradation (design §12 risk 2)', () => {
  test('a SOURCE_DOWN ClickHouse → clickhouse:partial, F marked partial, C/D still written', async () => {
    const path = writeCorpus(dir, [enrichedRepo('o/one')]);
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'available',
      heavy: { 'o/one': heavyNode('o/one') },
      clickhouseThrow: new EngineError('SOURCE_DOWN', 'clickhouse down'),
      contributors: { 'o/one': [{ login: 'a', contributions: 100 }] },
    });
    const result = await runHealth(
      handle.sources,
      cache,
      { in: path, ids: ['o/one'] },
      { now: NOW },
    );
    expect(result.clickhouse).toBe('partial');
    expect(result.repos[0]?.fCoverage).toBe('partial');
    const saved = loadCorpus(path);
    const one = saved.repos.find((r) => r.full_name === 'o/one');
    expect(one?.signals.burstiness).toBeUndefined(); // F degraded
    expect(one?.signals.topContributorShare).toBeDefined(); // C still landed
    expect(one?.signals.closeLatencyDays).toBeDefined(); // D still landed
    expect(one?.signals.fCoverage?.value).toBe('partial');
  });
});

describe('runHealth — fake-star combo fires ONLY with engagement-zero (design §5, real scoring path)', () => {
  const burstCH = (ns: string[]): ClickhouseEventRow[] =>
    ns.flatMap((n) => [
      { repo_name: n, month: '2016-01-01', event_type: 'WatchEvent', stars: 100 },
      { repo_name: n, month: '2020-06-01', event_type: 'WatchEvent', stars: 900 }, // burstiness 0.9
    ]);
  // engagement-zero heavy node: 0 open/closed issues in 90d, no human latency sample.
  const zeroEngagementHeavy = (n: string) =>
    heavyNode(n, {
      open90d: { totalCount: 0 },
      closed90d: { totalCount: 0 },
      recentClosed: { nodes: [] },
    });

  test('burst + engagement-zero + >500 stars + >6mo age → possible-fake-stars', async () => {
    const path = writeCorpus(dir, [
      enrichedRepo('o/fake', { stars: 800, createdAt: '2016-01-01T00:00:00Z', signals: {} }),
    ]);
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'restricted',
      heavy: { 'o/fake': zeroEngagementHeavy('o/fake') },
      clickhouse: burstCH,
      contributors: { 'o/fake': [] },
    });
    const result = await runHealth(
      handle.sources,
      cache,
      { in: path, ids: ['o/fake'] },
      { now: NOW },
    );
    expect(result.repos[0]?.flags).toContain('possible-fake-stars');
  });

  test('the SAME burst with real engagement (mentionableUsers) → star-burst flag, NO penalty flag', async () => {
    const path = writeCorpus(dir, [
      enrichedRepo('o/viral', {
        stars: 800,
        createdAt: '2016-01-01T00:00:00Z',
        signals: { mentionableUsers: { value: 50, source: 'github-graphql', fetchedAt: NOW_ISO } },
      }),
    ]);
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'restricted',
      heavy: { 'o/viral': zeroEngagementHeavy('o/viral') },
      clickhouse: burstCH,
      contributors: { 'o/viral': [{ login: 'a', contributions: 100 }] },
    });
    const result = await runHealth(
      handle.sources,
      cache,
      { in: path, ids: ['o/viral'] },
      { now: NOW },
    );
    expect(result.repos[0]?.flags).toContain('star-burst');
    expect(result.repos[0]?.flags).not.toContain('possible-fake-stars');
  });
});

describe('runHealth — starredAt three-shape degradation is recorded per repo', () => {
  test('probe available but a repo returns a null connection → shape null-connection', async () => {
    const path = writeCorpus(dir, [enrichedRepo('o/one')]);
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'available',
      heavy: { 'o/one': heavyNode('o/one', { stargazers: null }) },
      clickhouse: (ns) =>
        ns.map((n) => ({
          repo_name: n,
          month: '2020-01-01',
          event_type: 'WatchEvent',
          stars: 100,
        })),
      contributors: { 'o/one': [{ login: 'a', contributions: 100 }] },
    });
    const result = await runHealth(
      handle.sources,
      cache,
      { in: path, ids: ['o/one'] },
      { now: NOW },
    );
    expect(result.repos[0]?.starredAt).toBe('null-connection');
    expect(result.starredAtProbe).toBe('available');
  });

  test('a restricted probe skips the field entirely → probe-skipped, no stargazers requested', async () => {
    const path = writeCorpus(dir, [enrichedRepo('o/one')]);
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'restricted',
      heavy: { 'o/one': heavyNode('o/one', { stargazers: undefined }) },
      clickhouse: (ns) =>
        ns.map((n) => ({
          repo_name: n,
          month: '2020-01-01',
          event_type: 'WatchEvent',
          stars: 100,
        })),
      contributors: { 'o/one': [{ login: 'a', contributions: 100 }] },
    });
    const result = await runHealth(
      handle.sources,
      cache,
      { in: path, ids: ['o/one'] },
      { now: NOW },
    );
    expect(result.starredAtProbe).toBe('restricted');
    expect(result.repos[0]?.starredAt).toBe('probe-skipped');
  });
});

describe('runHealth — renamed repos get partial-renamed velocity, no false fake-star (design §9/§12 risk 9)', () => {
  test('a renamed row skips burstiness and is marked partial-renamed', async () => {
    const path = writeCorpus(dir, [enrichedRepo('o/new', { renamed: true, aliases: ['o/old'] })]);
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'restricted',
      heavy: { 'o/new': heavyNode('o/new') },
      clickhouse: (ns) =>
        ns.flatMap((n) => [
          { repo_name: n, month: '2016-01-01', event_type: 'WatchEvent', stars: 10 },
          { repo_name: n, month: '2020-06-01', event_type: 'WatchEvent', stars: 990 },
        ]),
      contributors: { 'o/new': [{ login: 'a', contributions: 100 }] },
    });
    const result = await runHealth(
      handle.sources,
      cache,
      { in: path, ids: ['o/new'] },
      { now: NOW },
    );
    expect(result.repos[0]?.fCoverage).toBe('partial-renamed');
    expect(result.repos[0]?.flags).toContain('velocity-partial');
    const saved = loadCorpus(path);
    expect(saved.repos[0]?.signals.burstiness).toBeUndefined();
    expect(result.repos[0]?.flags).not.toContain('possible-fake-stars');
  });
});

describe('runHealth — SQL safety + input contracts', () => {
  test('a hostile repo name in the corpus throws INVALID_INPUT before the query is ever POSTed', async () => {
    const hostile = "evil/repo'); DROP TABLE github_events;--";
    const path = writeCorpus(dir, [enrichedRepo(hostile)]);
    const cache = createCache(dir);
    // The REAL ClickHouse adapter is the injection guard — buildMonthlyEventsQuery
    // rejects the name before any fetch. This fetch throws if it is ever called,
    // proving the hostile name never reaches the network.
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      throw new Error('the query must never be POSTed');
    }) as unknown as typeof fetch;
    const handle = fakeSources({ probe: 'restricted', heavy: { [hostile]: heavyNode(hostile) } });
    handle.sources.clickhouse = createClickhousePlay({ fetchImpl });

    const err = (await runHealth(
      handle.sources,
      cache,
      { in: path, ids: [hostile] },
      { now: NOW },
    ).catch((e) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(fetched).toBe(false);
  });

  test('missing --in → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    const handle = fakeSources({});
    const err = (await runHealth(handle.sources, cache, { ids: [] }, { now: NOW }).catch(
      (e) => e,
    )) as EngineError;
    expect(err.code).toBe('INVALID_INPUT');
  });

  test('an unknown id → recorded in failed[] as NOT_FOUND, never a throw', async () => {
    const path = writeCorpus(dir, [enrichedRepo('o/real')]);
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'restricted',
      heavy: { 'o/real': heavyNode('o/real') },
      clickhouse: (ns) =>
        ns.map((n) => ({
          repo_name: n,
          month: '2020-01-01',
          event_type: 'WatchEvent',
          stars: 100,
        })),
      contributors: { 'o/real': [{ login: 'a', contributions: 100 }] },
    });
    const result = await runHealth(
      handle.sources,
      cache,
      { in: path, ids: ['o/real', 'o/ghost'] },
      { now: NOW },
    );
    expect(result.failed.some((f) => f.id === 'o/ghost' && f.code === 'NOT_FOUND')).toBe(true);
    expect(result.verified).toBe(1);
  });
});

describe('runHealth — contributors degrade per-repo, serialized (never aborts the batch)', () => {
  test('one repo whose /contributors is down still lets the others complete', async () => {
    const names = ['o/ok', 'o/down'];
    const path = writeCorpus(
      dir,
      names.map((n) => enrichedRepo(n)),
    );
    const cache = createCache(dir);
    const handle = fakeSources({
      probe: 'restricted',
      heavy: Object.fromEntries(names.map((n) => [n, heavyNode(n)])),
      clickhouse: (ns) =>
        ns.map((n) => ({
          repo_name: n,
          month: '2020-01-01',
          event_type: 'WatchEvent',
          stars: 100,
        })),
      contributors: { 'o/ok': [{ login: 'a', contributions: 100 }] },
      contributorsThrow: new Set(['o/down']),
    });
    const result = await runHealth(handle.sources, cache, { in: path, ids: names }, { now: NOW });
    expect(result.verified).toBe(2);
    expect(handle.contributorPaths).toHaveLength(2); // serialized, one per id
    const saved = loadCorpus(path);
    expect(
      saved.repos.find((r) => r.full_name === 'o/ok')?.signals.topContributorShare,
    ).toBeDefined();
    expect(
      saved.repos.find((r) => r.full_name === 'o/down')?.signals.topContributorShare,
    ).toBeUndefined();
  });
});
