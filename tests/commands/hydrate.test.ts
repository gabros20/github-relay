import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache, loadCorpus } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import { type HydrateOpts, hydrateOptsFromArgs, runHydrate } from '../../src/commands/hydrate.ts';
import type { RepoResult } from '../../src/sources/gh-graphql.ts';
import { EngineError } from '../../src/types.ts';

function fixtureNode(overrides: Record<string, unknown> = {}) {
  return {
    nameWithOwner: 'octocat/Hello-World',
    id: 'R_kgDOA1',
    stargazerCount: 1500,
    forkCount: 12,
    pushedAt: '2026-07-01T00:00:00Z',
    createdAt: '2020-01-01T00:00:00Z',
    licenseInfo: { spdxId: 'MIT' },
    repositoryTopics: { nodes: [] },
    primaryLanguage: { name: 'Swift' },
    isArchived: false,
    description: 'A test repo',
    url: 'https://github.com/octocat/Hello-World',
    ...overrides,
  };
}

function fakeGhGraphql(
  handler: (names: string[], fragment: string) => RepoResult<unknown>[],
  /** task 12: simulate a bisected effective size, via onEffectiveSize, lower than the requested batch. */
  effectiveSize?: number,
) {
  const calls: { names: string[]; fragment: string; batchSize?: number }[] = [];
  return {
    calls,
    graphql: async () => {
      throw new Error('hydrate should call batchRepositories, not graphql directly');
    },
    lastRateLimit: () => ({
      cost: 1,
      remaining: 4998,
      resetAt: '2026-07-10T02:00:00Z',
      nodeCount: 1,
    }),
    batchRepositories: async <T>(
      names: string[],
      fragment: string,
      opts?: { batchSize?: number; onEffectiveSize?: (size: number) => void },
    ) => {
      calls.push({ names, fragment, batchSize: opts?.batchSize });
      if (effectiveSize !== undefined) opts?.onEffectiveSize?.(effectiveSize);
      return handler(names, fragment) as RepoResult<T>[];
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-hydrate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runHydrate — validation (no network)', () => {
  test('no ids and no stdin → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => []);
    await expect(runHydrate({ ghGraphql }, cache, { ids: [] }, '')).rejects.toThrow(EngineError);
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('a malformed id names the offending token, zero network', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => []);
    let error: EngineError | undefined;
    try {
      await runHydrate(
        { ghGraphql },
        cache,
        { ids: ['octocat/hello-world', 'not-a-valid-id'] },
        '',
      );
    } catch (e) {
      error = e as EngineError;
    }
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.message).toContain('not-a-valid-id');
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('a shape with two slashes is also rejected', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => []);
    await expect(
      runHydrate({ ghGraphql }, cache, { ids: ['owner/repo/extra'] }, ''),
    ).rejects.toThrow(EngineError);
  });
});

describe('runHydrate — stdin path (`-`)', () => {
  test('a `-` positional reads newline-separated ids from stdin, blank lines skipped', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    const stdin = 'octocat/repo-a\n\noctocat/repo-b\n  \n';
    const result = await runHydrate({ ghGraphql }, cache, { ids: ['-'] }, stdin);
    expect(result.requested).toBe(2);
    expect(ghGraphql.calls[0]?.names).toEqual(['octocat/repo-a', 'octocat/repo-b']);
  });

  test('positionals and `-` can combine', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    const result = await runHydrate(
      { ghGraphql },
      cache,
      { ids: ['octocat/repo-a', '-'] },
      'octocat/repo-b\n',
    );
    expect(result.requested).toBe(2);
  });
});

describe('runHydrate — dedupe', () => {
  test('case-insensitive duplicate ids collapse to one request', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    const result = await runHydrate(
      { ghGraphql },
      cache,
      { ids: ['octocat/Hello-World', 'OCTOCAT/hello-world'] },
      '',
    );
    expect(result.requested).toBe(1);
    expect(ghGraphql.calls[0]?.names).toEqual(['octocat/Hello-World']);
  });
});

describe('runHydrate — batch size + fragment', () => {
  test('calls batchRepositories with the pre-enrich fragment at 50/batch', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    await runHydrate({ ghGraphql }, cache, { ids: ['octocat/hello-world'] }, '');
    expect(ghGraphql.calls[0]?.batchSize).toBe(50);
    expect(ghGraphql.calls[0]?.fragment).toContain('nameWithOwner');
  });
});

describe('runHydrate — learned GraphQL batch ceilings (task 12, fix wave 2: per-fragment classes)', () => {
  test('a bisected effective size below the requested batch persists a tighter pre-enrich ceiling', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(
      (names) => names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
      12, // simulated bisection landed below hydrate's static default of 50
    );
    await runHydrate({ ghGraphql }, cache, { ids: ['octocat/hello-world'] }, '');
    expect(cache.budget.load().learnedCeilings['pre-enrich']).toMatchObject({ size: 12 });
  });

  test('a subsequent hydrate starts from the learned ceiling instead of the static 50 default', async () => {
    const cache = createCache(dir);
    cache.budget.updateLearnedCeiling('pre-enrich', {
      size: 12,
      observedAt: new Date().toISOString(),
    });
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    await runHydrate({ ghGraphql }, cache, { ids: ['octocat/hello-world'] }, '');
    expect(ghGraphql.calls[0]?.batchSize).toBe(12);
  });

  test("an enrich-light ceiling never throttles hydrate's pre-enrich fragment (fix wave 2 IMP 2)", async () => {
    const cache = createCache(dir);
    cache.budget.updateLearnedCeiling('enrich-light', {
      size: 8,
      observedAt: new Date().toISOString(),
    });
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    await runHydrate({ ghGraphql }, cache, { ids: ['octocat/hello-world'] }, '');
    expect(ghGraphql.calls[0]?.batchSize).toBe(50); // hydrate's own static default, untouched
  });
});

describe('runHydrate — per-item failure isolation', () => {
  test('a per-name error is reported in failed[], does not fail the whole batch', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name, i) =>
        i === 0
          ? { name, data: fixtureNode({ nameWithOwner: name }) }
          : { name, data: null, error: { code: 'NOT_FOUND' as const, message: 'no such repo' } },
      ),
    );
    const result = await runHydrate(
      { ghGraphql },
      cache,
      { ids: ['octocat/exists', 'octocat/missing'] },
      '',
    );
    expect(result.hydrated).toBe(1);
    expect(result.failed).toEqual([
      { id: 'octocat/missing', code: 'NOT_FOUND', message: 'no such repo' },
    ]);
  });

  test('a null result with no error still surfaces as a failure, not a silent drop', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) => names.map((name) => ({ name, data: null })));
    const result = await runHydrate({ ghGraphql }, cache, { ids: ['octocat/ghost'] }, '');
    expect(result.hydrated).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe('octocat/ghost');
  });
});

describe('runHydrate — corpus merge, source:"agent"', () => {
  test('--out merges hydrated repos into the corpus tagged source:"agent"', async () => {
    const out = join(dir, 'corpus.json');
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    const result = await runHydrate(
      { ghGraphql },
      cache,
      { ids: ['octocat/hello-world'], out },
      '',
    );
    expect(result.out).toBe(out);
    const corpus = loadCorpus(out);
    expect(corpus.repos).toHaveLength(1);
    expect(corpus.repos[0]?.source).toBe('agent');
  });

  test('without --out, stdout carries compact rows instead', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    const result = await runHydrate({ ghGraphql }, cache, { ids: ['octocat/hello-world'] }, '');
    expect(result.out).toBeUndefined();
    expect(result.repos).toHaveLength(1);
    expect(result.repos?.[0]?.full_name).toBe('octocat/hello-world');
  });
});

describe('runHydrate — budget update', () => {
  test('updates the graphqlPoints pool after batchRepositories', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((names) =>
      names.map((name) => ({ name, data: fixtureNode({ nameWithOwner: name }) })),
    );
    await runHydrate({ ghGraphql }, cache, { ids: ['octocat/hello-world'] }, '');
    expect(cache.budget.load().graphqlPoints?.remaining).toBe(4998);
  });
});

describe('hydrateOptsFromArgs', () => {
  test('maps positionals + --out', () => {
    const parsed = parseArgs(['hydrate', 'octocat/hello-world', '-', '--out', 'corpus.json']);
    const opts: HydrateOpts = hydrateOptsFromArgs(parsed);
    expect(opts.ids).toEqual(['octocat/hello-world', '-']);
    expect(opts.out).toBe('corpus.json');
  });
});
