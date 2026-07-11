import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorpus } from '../../src/cache/corpus.ts';
import { CORPUS_SCHEMA, createCache, saveCorpus } from '../../src/cache/index.ts';
import {
  type RawRepoNode,
  compactRow,
  loadCorpusOrEmpty,
  normalizeRepoNode,
  searchRepositories,
  updateBudgetFromGraphql,
  updateBudgetFromRestHeaders,
} from '../../src/commands/_shared.ts';

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
