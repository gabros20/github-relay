import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache, loadCorpus } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import {
  type SearchOpts,
  type SearchSources,
  runSearch,
  searchOptsFromArgs,
} from '../../src/commands/search.ts';
import type { TrendingPeriod, TrendingRow } from '../../src/sources/ossinsight.ts';
import { EngineError } from '../../src/types.ts';

function baseOpts(overrides: Partial<SearchOpts> = {}): SearchOpts {
  return { query: 'markdown editor', language: [], topic: [], ...overrides };
}

function fixtureSearchNode(overrides: Record<string, unknown> = {}) {
  return {
    nameWithOwner: 'octocat/Hello-World',
    id: 'R_kgDOA1',
    databaseId: 1,
    stargazerCount: 1500,
    forkCount: 12,
    pushedAt: '2026-07-01T00:00:00Z',
    createdAt: '2020-01-01T00:00:00Z',
    licenseInfo: { spdxId: 'MIT' },
    repositoryTopics: { nodes: [{ topic: { name: 'markdown' } }] },
    primaryLanguage: { name: 'Swift' },
    isArchived: false,
    description: 'A test repo',
    url: 'https://github.com/octocat/Hello-World',
    ...overrides,
  };
}

function fakeGhGraphql(handler: (query: string, vars?: Record<string, unknown>) => unknown) {
  const calls: { query: string; vars?: Record<string, unknown> }[] = [];
  return {
    calls,
    graphql: async <T>(query: string, vars?: Record<string, unknown>) => {
      calls.push({ query, vars });
      return handler(query, vars) as T;
    },
    lastRateLimit: () => ({
      cost: 1,
      remaining: 4999,
      resetAt: '2026-07-10T01:00:00Z',
      nodeCount: 1,
    }),
  };
}

function fakeGhRest(handler: (path: string) => unknown, headers: Headers = new Headers()) {
  const calls: string[] = [];
  return {
    calls,
    get: async (path: string) => {
      calls.push(path);
      return { status: 200, headers, etag: null, body: handler(path) };
    },
    tarballUrl: async () => {
      throw new Error('not used');
    },
    downloadTarball: async () => {
      throw new Error('not used');
    },
  };
}

/** Throws if a test that has nothing to do with trending accidentally reaches the adapter. */
function unusedOssInsight(): SearchSources['ossinsight'] {
  return {
    trending: async () => {
      throw new Error('ossinsight should not be called for this test');
    },
  };
}

function fakeOssInsight(
  handler: (period: TrendingPeriod, language: string | undefined) => TrendingRow[],
  rateWindow?: { remaining: number; resetAt: string },
) {
  const calls: { period: TrendingPeriod; language: string | undefined }[] = [];
  return {
    calls,
    trending: async (period: TrendingPeriod, language?: string) => {
      calls.push({ period, language });
      const page: { rows: TrendingRow[]; rateWindow?: { remaining: number; resetAt: string } } = {
        rows: handler(period, language),
      };
      if (rateWindow) page.rateWindow = rateWindow;
      return page;
    },
  };
}

/** Fills in `ossinsight` with a throwing fake unless the caller overrides it — every non-trending test uses this. */
function sources(overrides: Partial<SearchSources> = {}): SearchSources {
  return {
    ghGraphql: overrides.ghGraphql ?? fakeGhGraphql(() => ({})),
    ghRest: overrides.ghRest ?? fakeGhRest(() => ({})),
    ossinsight: overrides.ossinsight ?? unusedOssInsight(),
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-search-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runSearch — validation (no network)', () => {
  test('an empty query and no filter flags → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 0, nodes: [] } }));
    await expect(runSearch(sources({ ghGraphql }), cache, baseOpts({ query: '' }))).rejects.toThrow(
      EngineError,
    );
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('bad --stars range → INVALID_INPUT before any network call', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 0, nodes: [] } }));
    await expect(
      runSearch(sources({ ghGraphql }), cache, baseOpts({ stars: 'not-a-range' })),
    ).rejects.toThrow(EngineError);
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('bad --created range → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(runSearch(sources(), cache, baseOpts({ created: 'yesterday' }))).rejects.toThrow(
      EngineError,
    );
  });

  test('bad --sort value → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(runSearch(sources(), cache, baseOpts({ sort: 'popularity' }))).rejects.toThrow(
      EngineError,
    );
  });

  test('bad --period value → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(runSearch(sources(), cache, baseOpts({ period: 'yesterday' }))).rejects.toThrow(
      EngineError,
    );
  });

  test('--period without --source trending → INVALID_INPUT, zero network calls', async () => {
    const cache = createCache(dir);
    const src = sources();
    await expect(runSearch(src, cache, baseOpts({ period: 'week' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      runSearch(src, cache, baseOpts({ period: 'week', source: 'rest' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('--limit out of range (0, 101, non-numeric) → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    for (const limit of ['0', '101', 'abc', '-5']) {
      await expect(runSearch(sources(), cache, baseOpts({ limit }))).rejects.toThrow(EngineError);
    }
  });

  test('unknown --source → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(runSearch(sources(), cache, baseOpts({ source: 'bing' }))).rejects.toThrow(
      EngineError,
    );
  });
});

describe('runSearch — query-string construction', () => {
  test('language/topic/stars/created/pushed/sort flags encode into the query string', async () => {
    const ghGraphql = fakeGhGraphql(() => ({
      search: { repositoryCount: 1, nodes: [fixtureSearchNode()] },
    }));
    const cache = createCache(dir);
    await runSearch(
      sources({ ghGraphql }),
      cache,
      baseOpts({
        query: 'markdown editor',
        language: ['swift'],
        topic: ['macos', 'markdown'],
        stars: '>50',
        created: '>2020-01-01',
        pushed: '>2025-01-01',
        sort: 'stars',
      }),
    );
    const q = ghGraphql.calls[0]?.vars?.q as string;
    expect(q).toBe(
      'markdown editor language:swift topic:macos topic:markdown stars:>50 created:>2020-01-01 pushed:>2025-01-01 sort:stars',
    );
  });

  test('--limit defaults to 30 and is passed as `first`', async () => {
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 1, nodes: [] } }));
    const cache = createCache(dir);
    await runSearch(sources({ ghGraphql }), cache, baseOpts());
    expect(ghGraphql.calls[0]?.vars?.first).toBe(30);
  });
});

describe('runSearch — RESULT_CAP warning', () => {
  test('repositoryCount > 1000 with a full page attaches a RESULT_CAP warning with a shard hint', async () => {
    const nodes = Array.from({ length: 30 }, (_, i) =>
      fixtureSearchNode({ nameWithOwner: `octocat/repo${i}`, stargazerCount: i * 10 }),
    );
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 5000, nodes } }));
    const cache = createCache(dir);
    const result = await runSearch(sources({ ghGraphql }), cache, baseOpts({ limit: '30' }));
    expect(result.warning?.code).toBe('RESULT_CAP');
    expect(result.warning?.hint).toContain('stars:');
  });

  test('repositoryCount > 1000 but the page is NOT full → no warning (not actually capped)', async () => {
    const ghGraphql = fakeGhGraphql(() => ({
      search: { repositoryCount: 5000, nodes: [fixtureSearchNode()] },
    }));
    const cache = createCache(dir);
    const result = await runSearch(sources({ ghGraphql }), cache, baseOpts({ limit: '30' }));
    expect(result.warning).toBeUndefined();
  });
});

describe('runSearch — --source rest fallback', () => {
  test('maps REST search/repositories items onto the same output shape', async () => {
    const ghRest = fakeGhRest((path) => {
      expect(path).toContain('/search/repositories?q=');
      return {
        total_count: 1,
        items: [
          {
            full_name: 'octocat/Hello-World',
            node_id: 'R_kgDOA1',
            stargazers_count: 1500,
            forks_count: 12,
            pushed_at: '2026-07-01T00:00:00Z',
            created_at: '2020-01-01T00:00:00Z',
            license: { spdx_id: 'MIT' },
            topics: ['markdown'],
            language: 'Swift',
            archived: false,
            description: 'A test repo',
            html_url: 'https://github.com/octocat/Hello-World',
          },
        ],
      };
    });
    const cache = createCache(dir);
    const result = await runSearch(sources({ ghRest }), cache, baseOpts({ source: 'rest' }));
    expect(result.count).toBe(1);
    expect(result.repos?.[0]).toMatchObject({
      full_name: 'octocat/Hello-World',
      ghid: 'R_kgDOA1',
      stars: 1500,
      license: 'MIT',
      url: 'https://github.com/octocat/Hello-World',
    });
  });

  test('updates the restSearch budget pool from x-ratelimit-* response headers', async () => {
    const headers = new Headers({
      'x-ratelimit-remaining': '27',
      'x-ratelimit-reset': '1752105600',
    });
    const ghRest = fakeGhRest(() => ({ total_count: 0, items: [] }), headers);
    const cache = createCache(dir);
    await runSearch(sources({ ghRest }), cache, baseOpts({ source: 'rest' }));
    expect(cache.budget.load().restSearch).toEqual({
      remaining: 27,
      resetAt: new Date(1752105600 * 1000).toISOString(),
    });
  });

  test('missing x-ratelimit-* headers is a no-op, not a crash', async () => {
    const ghRest = fakeGhRest(() => ({ total_count: 0, items: [] }));
    const cache = createCache(dir);
    await runSearch(sources({ ghRest }), cache, baseOpts({ source: 'rest' }));
    expect(cache.budget.load().restSearch).toBeUndefined();
  });
});

describe('runSearch — --out merges into the corpus', () => {
  test('writes a corpus and reports {query, count, merged, out}; a second search merges, not clobbers', async () => {
    const out = join(dir, 'corpus.json');
    const cache = createCache(dir);
    const ghGraphqlA = fakeGhGraphql(() => ({
      search: {
        repositoryCount: 1,
        nodes: [fixtureSearchNode({ nameWithOwner: 'octocat/repo-a', id: 'R_kgDOA1' })],
      },
    }));
    const resultA = await runSearch(sources({ ghGraphql: ghGraphqlA }), cache, baseOpts({ out }));
    expect(resultA.merged).toBe(1);
    expect(resultA.out).toBe(out);

    const ghGraphqlB = fakeGhGraphql(() => ({
      search: {
        repositoryCount: 1,
        nodes: [fixtureSearchNode({ nameWithOwner: 'octocat/repo-b', id: 'R_kgDOA2' })],
      },
    }));
    const resultB = await runSearch(
      sources({ ghGraphql: ghGraphqlB }),
      cache,
      baseOpts({ query: 'another query', out }),
    );
    expect(resultB.merged).toBe(2);

    const corpus = loadCorpus(out);
    expect(corpus.repos.map((r) => r.full_name).sort()).toEqual([
      'octocat/repo-a',
      'octocat/repo-b',
    ]);
  });

  test('without --out, stdout carries compact rows instead', async () => {
    const ghGraphql = fakeGhGraphql(() => ({
      search: { repositoryCount: 1, nodes: [fixtureSearchNode()] },
    }));
    const cache = createCache(dir);
    const result = await runSearch(sources({ ghGraphql }), cache, baseOpts());
    expect(result.out).toBeUndefined();
    expect(result.repos).toHaveLength(1);
    expect(result.repos?.[0]?.full_name).toBe('octocat/Hello-World');
  });

  test('--fields narrows the compact rows to the requested keys', async () => {
    const ghGraphql = fakeGhGraphql(() => ({
      search: { repositoryCount: 1, nodes: [fixtureSearchNode()] },
    }));
    const cache = createCache(dir);
    const result = await runSearch(
      sources({ ghGraphql }),
      cache,
      baseOpts({ fields: 'full_name,stars' }),
    );
    expect(result.repos?.[0]).toEqual({ full_name: 'octocat/Hello-World', stars: 1500 });
  });
});

describe('runSearch — budget update', () => {
  test('updates the graphqlPoints pool from lastRateLimit() after a gh-source call', async () => {
    const ghGraphql = fakeGhGraphql(() => ({
      search: { repositoryCount: 1, nodes: [fixtureSearchNode()] },
    }));
    const cache = createCache(dir);
    await runSearch(sources({ ghGraphql }), cache, baseOpts());
    expect(cache.budget.load().graphqlPoints).toEqual({
      remaining: 4999,
      resetAt: '2026-07-10T01:00:00Z',
      lastCost: 1,
    });
  });
});

// ── --source trending (task 12) ─────────────────────────────────────────────

function trendingRow(overrides: Partial<TrendingRow> = {}): TrendingRow {
  return {
    repo_name: 'facebook/react',
    primary_language: 'JavaScript',
    description: 'A library',
    stars: 150,
    forks: 20,
    total_score: 220.19,
    ...overrides,
  };
}

describe('runSearch — --source trending validation (no network)', () => {
  test('GH-only qualifier flags (topic/stars/created/pushed/sort) → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    for (const overrides of [
      { topic: ['macos'] },
      { stars: '>50' },
      { created: '>2020-01-01' },
      { pushed: '>2020-01-01' },
      { sort: 'stars' },
    ]) {
      await expect(
        runSearch(sources(), cache, baseOpts({ source: 'trending', ...overrides })),
      ).rejects.toThrow(EngineError);
    }
  });

  test('more than one --language → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(
      runSearch(sources(), cache, baseOpts({ source: 'trending', language: ['Rust', 'Go'] })),
    ).rejects.toThrow(EngineError);
  });

  test('an empty query with no --language is fine — trending lists sitewide, no query is required', async () => {
    const cache = createCache(dir);
    const ossinsight = fakeOssInsight(() => []);
    const result = await runSearch(
      sources({ ossinsight }),
      cache,
      baseOpts({ query: '', source: 'trending' }),
    );
    expect(result.count).toBe(0);
  });
});

describe('runSearch — --source trending mapping + defaults', () => {
  test('default --period is week; language passthrough is forwarded to the adapter', async () => {
    const cache = createCache(dir);
    const ossinsight = fakeOssInsight(() => [trendingRow()]);
    await runSearch(
      sources({ ossinsight }),
      cache,
      baseOpts({ source: 'trending', language: ['Rust'] }),
    );
    expect(ossinsight.calls).toEqual([{ period: 'past_week', language: 'Rust' }]);
  });

  test("--period 24h|week|month map onto OSS Insight's own period values", async () => {
    const cache = createCache(dir);
    const cases: [string, TrendingPeriod][] = [
      ['24h', 'past_24_hours'],
      ['week', 'past_week'],
      ['month', 'past_month'],
    ];
    for (const [cliValue, apiValue] of cases) {
      const ossinsight = fakeOssInsight(() => []);
      await runSearch(
        sources({ ossinsight }),
        cache,
        baseOpts({ source: 'trending', period: cliValue }),
      );
      expect(ossinsight.calls[0]?.period).toBe(apiValue);
    }
  });

  test('maps trending rows onto the corpus shape, tagged source:"trending"', async () => {
    const cache = createCache(dir);
    const ossinsight = fakeOssInsight(() => [
      trendingRow({ repo_name: 'facebook/react', stars: 150, forks: 20 }),
    ]);
    const result = await runSearch(
      sources({ ossinsight }),
      cache,
      baseOpts({ source: 'trending' }),
    );
    expect(result.count).toBe(1);
    expect(result.repos?.[0]).toMatchObject({
      full_name: 'facebook/react',
      ghid: '',
      stars: 150,
      forks: 20,
      language: 'JavaScript',
      description: 'A library',
      url: 'https://github.com/facebook/react',
    });
  });

  test('--limit truncates the trending rows client-side (OSS Insight has no server-side limit)', async () => {
    const cache = createCache(dir);
    const rows = Array.from({ length: 10 }, (_, i) => trendingRow({ repo_name: `owner/repo${i}` }));
    const ossinsight = fakeOssInsight(() => rows);
    const result = await runSearch(
      sources({ ossinsight }),
      cache,
      baseOpts({ source: 'trending', limit: '3' }),
    );
    expect(result.count).toBe(3);
  });
});

describe('runSearch — --source trending --out merges the corpus', () => {
  test('writes source:"trending" rows into the corpus (fresh-wins merge, like every other lane)', async () => {
    const out = join(dir, 'corpus.json');
    const cache = createCache(dir);
    const ossinsight = fakeOssInsight(() => [trendingRow({ repo_name: 'facebook/react' })]);
    const result = await runSearch(
      sources({ ossinsight }),
      cache,
      baseOpts({ source: 'trending', out }),
    );
    expect(result.merged).toBe(1);
    expect(result.out).toBe(out);
    const corpus = loadCorpus(out);
    expect(corpus.repos).toHaveLength(1);
    expect(corpus.repos[0]?.source).toBe('trending');
    expect(corpus.repos[0]?.full_name).toBe('facebook/react');
  });
});

describe('runSearch — --source trending pool counting', () => {
  test('a live rate window from the adapter is persisted into the ossinsight pool', async () => {
    const cache = createCache(dir);
    const ossinsight = fakeOssInsight(() => [], {
      remaining: 598,
      resetAt: '2026-07-11T14:00:00.000Z',
    });
    await runSearch(sources({ ossinsight }), cache, baseOpts({ source: 'trending' }));
    expect(cache.budget.load().ossinsight).toEqual({
      remaining: 598,
      resetAt: '2026-07-11T14:00:00.000Z',
    });
  });

  test('no rate window from the adapter still counts the call locally', async () => {
    const cache = createCache(dir);
    const now = () => Date.parse('2026-07-11T13:10:00Z');
    const ossinsight = fakeOssInsight(() => []); // no rateWindow
    await runSearch(sources({ ossinsight }), cache, baseOpts({ source: 'trending' }), { now });
    expect(cache.budget.load().ossinsight?.remaining).toBe(599);
  });
});

describe('searchOptsFromArgs', () => {
  test('maps parsed CLI flags onto SearchOpts', () => {
    const parsed = parseArgs([
      'search',
      'markdown',
      'editor',
      '--language',
      'swift',
      '--topic',
      'macos',
      '--stars',
      '>50',
      '--limit',
      '10',
      '--out',
      'corpus.json',
    ]);
    const opts = searchOptsFromArgs(parsed);
    expect(opts.query).toBe('markdown editor');
    expect(opts.language).toEqual(['swift']);
    expect(opts.topic).toEqual(['macos']);
    expect(opts.stars).toBe('>50');
    expect(opts.limit).toBe('10');
    expect(opts.out).toBe('corpus.json');
  });

  test('maps --source trending + --period', () => {
    const parsed = parseArgs(['search', '--source', 'trending', '--period', '24h']);
    const opts = searchOptsFromArgs(parsed);
    expect(opts.source).toBe('trending');
    expect(opts.period).toBe('24h');
  });
});
