import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache, loadCorpus } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import { type SearchOpts, runSearch, searchOptsFromArgs } from '../../src/commands/search.ts';
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

function fakeGhRest(handler: (path: string) => unknown) {
  const calls: string[] = [];
  return {
    calls,
    get: async (path: string) => {
      calls.push(path);
      return { status: 200, headers: new Headers(), etag: null, body: handler(path) };
    },
    tarballUrl: async () => {
      throw new Error('not used');
    },
    downloadTarball: async () => {
      throw new Error('not used');
    },
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
    await expect(
      runSearch({ ghGraphql, ghRest: fakeGhRest(() => ({})) }, cache, baseOpts({ query: '' })),
    ).rejects.toThrow(EngineError);
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('bad --stars range → INVALID_INPUT before any network call', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 0, nodes: [] } }));
    await expect(
      runSearch(
        { ghGraphql, ghRest: fakeGhRest(() => ({})) },
        cache,
        baseOpts({ stars: 'not-a-range' }),
      ),
    ).rejects.toThrow(EngineError);
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('bad --created range → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(
      runSearch(
        { ghGraphql: fakeGhGraphql(() => ({})), ghRest: fakeGhRest(() => ({})) },
        cache,
        baseOpts({ created: 'yesterday' }),
      ),
    ).rejects.toThrow(EngineError);
  });

  test('bad --sort value → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(
      runSearch(
        { ghGraphql: fakeGhGraphql(() => ({})), ghRest: fakeGhRest(() => ({})) },
        cache,
        baseOpts({ sort: 'popularity' }),
      ),
    ).rejects.toThrow(EngineError);
  });

  test('--limit out of range (0, 101, non-numeric) → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    for (const limit of ['0', '101', 'abc', '-5']) {
      await expect(
        runSearch(
          { ghGraphql: fakeGhGraphql(() => ({})), ghRest: fakeGhRest(() => ({})) },
          cache,
          baseOpts({ limit }),
        ),
      ).rejects.toThrow(EngineError);
    }
  });

  test('unknown --source → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(
      runSearch(
        { ghGraphql: fakeGhGraphql(() => ({})), ghRest: fakeGhRest(() => ({})) },
        cache,
        baseOpts({ source: 'bing' }),
      ),
    ).rejects.toThrow(EngineError);
  });

  test('--source trending fails loud, zero network, names task 12', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 0, nodes: [] } }));
    const ghRest = fakeGhRest(() => ({}));
    let error: EngineError | undefined;
    try {
      await runSearch({ ghGraphql, ghRest }, cache, baseOpts({ source: 'trending' }));
    } catch (e) {
      error = e as EngineError;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.message).toContain('task 12');
    expect(ghGraphql.calls).toHaveLength(0);
    expect(ghRest.calls).toHaveLength(0);
  });
});

describe('runSearch — query-string construction', () => {
  test('language/topic/stars/created/pushed/sort flags encode into the query string', async () => {
    const ghGraphql = fakeGhGraphql(() => ({
      search: { repositoryCount: 1, nodes: [fixtureSearchNode()] },
    }));
    const cache = createCache(dir);
    await runSearch(
      { ghGraphql, ghRest: fakeGhRest(() => ({})) },
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
    await runSearch({ ghGraphql, ghRest: fakeGhRest(() => ({})) }, cache, baseOpts());
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
    const result = await runSearch(
      { ghGraphql, ghRest: fakeGhRest(() => ({})) },
      cache,
      baseOpts({ limit: '30' }),
    );
    expect(result.warning?.code).toBe('RESULT_CAP');
    expect(result.warning?.hint).toContain('stars:');
  });

  test('repositoryCount > 1000 but the page is NOT full → no warning (not actually capped)', async () => {
    const ghGraphql = fakeGhGraphql(() => ({
      search: { repositoryCount: 5000, nodes: [fixtureSearchNode()] },
    }));
    const cache = createCache(dir);
    const result = await runSearch(
      { ghGraphql, ghRest: fakeGhRest(() => ({})) },
      cache,
      baseOpts({ limit: '30' }),
    );
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
    const result = await runSearch(
      { ghGraphql: fakeGhGraphql(() => ({})), ghRest },
      cache,
      baseOpts({ source: 'rest' }),
    );
    expect(result.count).toBe(1);
    expect(result.repos?.[0]).toMatchObject({
      full_name: 'octocat/Hello-World',
      ghid: 'R_kgDOA1',
      stars: 1500,
      license: 'MIT',
      url: 'https://github.com/octocat/Hello-World',
    });
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
    const resultA = await runSearch(
      { ghGraphql: ghGraphqlA, ghRest: fakeGhRest(() => ({})) },
      cache,
      baseOpts({ out }),
    );
    expect(resultA.merged).toBe(1);
    expect(resultA.out).toBe(out);

    const ghGraphqlB = fakeGhGraphql(() => ({
      search: {
        repositoryCount: 1,
        nodes: [fixtureSearchNode({ nameWithOwner: 'octocat/repo-b', id: 'R_kgDOA2' })],
      },
    }));
    const resultB = await runSearch(
      { ghGraphql: ghGraphqlB, ghRest: fakeGhRest(() => ({})) },
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
    const result = await runSearch(
      { ghGraphql, ghRest: fakeGhRest(() => ({})) },
      cache,
      baseOpts(),
    );
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
      { ghGraphql, ghRest: fakeGhRest(() => ({})) },
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
    await runSearch({ ghGraphql, ghRest: fakeGhRest(() => ({})) }, cache, baseOpts());
    expect(cache.budget.load().graphqlPoints).toEqual({
      remaining: 4999,
      resetAt: '2026-07-10T01:00:00Z',
      lastCost: 1,
    });
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
});
