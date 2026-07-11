import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Corpus,
  type CorpusRepo,
  createCorpus,
  loadCorpus,
  saveCorpus,
} from '../../src/cache/corpus.ts';
import { createCache } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import {
  type EnrichSources,
  buildEnrichFragment,
  enrichOptsFromArgs,
  resolveBGroup,
  runEnrich,
} from '../../src/commands/enrich.ts';
import type { RepoResult } from '../../src/sources/gh-graphql.ts';
import { EngineError } from '../../src/types.ts';

const NOW = () => Date.parse('2026-07-11T00:00:00Z');

function enrichNode(fullName: string, overrides: Record<string, unknown> = {}) {
  return {
    nameWithOwner: fullName,
    id: `R_${fullName}`,
    stargazerCount: 2000,
    forkCount: 200,
    pushedAt: '2026-07-01T00:00:00Z',
    createdAt: '2022-01-01T00:00:00Z',
    isArchived: false,
    isFork: false,
    isTemplate: false,
    diskUsage: 15_000,
    homepageUrl: 'https://x.dev',
    description: 'a repo',
    licenseInfo: { spdxId: 'MIT', pseudoLicense: false },
    repositoryTopics: { nodes: [{ topic: { name: 'cli' } }] },
    primaryLanguage: { name: 'Go' },
    owner: { __typename: 'Organization' },
    watchers: { totalCount: 50 },
    mentionableUsers: { totalCount: 40 },
    fundingLinks: [{ platform: 'GITHUB' }],
    defaultBranchRef: { target: { history: { totalCount: 120 } } },
    openIssues: { totalCount: 15 },
    closedIssues: { totalCount: 285 },
    openPRs: { totalCount: 3 },
    mergedPRs: { totalCount: 150 },
    closedPRs: { totalCount: 20 },
    latestRelease: { publishedAt: '2026-06-01T00:00:00Z' },
    ...overrides,
  };
}

interface FakeConfig {
  graphql?: (names: string[]) => RepoResult<unknown>[];
  ecosystems?: (fullName: string) => unknown; // may throw
  packageVersions?: (owner: string, repo: string) => unknown; // may throw
  dependents?: (pkg: { system: string; name: string }, version: string) => unknown; // may throw
}

function fakeSources(cfg: FakeConfig) {
  const calls: string[] = [];
  const rate = { cost: 2, remaining: 4990, resetAt: '2026-07-11T02:00:00Z', nodeCount: 25 };
  const sources: EnrichSources = {
    ghGraphql: {
      lastRateLimit: () => rate,
      batchRepositories: async <T>(names: string[]) => {
        calls.push(`graphql:${names.join(',')}`);
        const handler =
          cfg.graphql ?? ((n: string[]) => n.map((name) => ({ name, data: enrichNode(name) })));
        return handler(names) as RepoResult<T>[];
      },
    },
    ecosystems: {
      repo: async (fullName: string) => {
        calls.push(`ecosystems:${fullName}`);
        if (!cfg.ecosystems) throw new EngineError('NOT_FOUND', 'not indexed');
        return cfg.ecosystems(fullName);
      },
    },
    depsdev: {
      projectPackageVersions: async (owner: string, repo: string) => {
        calls.push(`depsdev.pv:${owner}/${repo}`);
        if (!cfg.packageVersions) throw new EngineError('NOT_FOUND', 'no packages');
        return cfg.packageVersions(owner, repo);
      },
      dependents: async (pkg: { system: string; name: string }, version: string) => {
        calls.push(`depsdev.dep:${pkg.name}@${version}`);
        if (!cfg.dependents) throw new EngineError('NOT_FOUND', 'none');
        return cfg.dependents(pkg, version);
      },
    },
  };
  return { sources, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-enrich-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCorpus(repos: CorpusRepo[]): string {
  const path = join(dir, 'corpus.json');
  const corpus: Corpus = { ...createCorpus('test intent', [], NOW), repos, count: repos.length };
  saveCorpus(path, corpus, NOW);
  return path;
}

function bareRepo(fullName: string, overrides: Partial<CorpusRepo> = {}): CorpusRepo {
  return {
    full_name: fullName,
    ghid: `R_${fullName}`,
    aliases: [],
    source: 'search',
    stars: 2000,
    forks: 200,
    pushedAt: '2026-06-01T00:00:00Z',
    createdAt: '2022-01-01T00:00:00Z',
    license: 'MIT',
    topics: [],
    language: 'Go',
    archived: false,
    description: 'a repo',
    signals: {},
    ...overrides,
  };
}

describe('buildEnrichFragment', () => {
  test('includes the C-lite + maintenance signals and NEVER releases.totalCount', () => {
    const f = buildEnrichFragment(NOW());
    expect(f).toContain('mentionableUsers');
    expect(f).toContain('history(since:');
    expect(f).toContain('latestRelease');
    expect(f).toContain('pseudoLicense');
    expect(f).not.toContain('releases(');
    expect(f).not.toContain('releases {');
  });
});

describe('enrich — validation', () => {
  test('missing --in → INVALID_INPUT, zero network', async () => {
    const { sources, calls } = fakeSources({});
    const cache = createCache(dir);
    await expect(runEnrich(sources, cache, { ids: [] }, { now: NOW })).rejects.toThrow(EngineError);
    expect(calls).toHaveLength(0);
  });
});

describe('enrich — GraphQL stage writes signals with provenance', () => {
  test('writes commit/issue/community signals into the corpus', async () => {
    const path = writeCorpus([bareRepo('acme/widget')]);
    const { sources } = fakeSources({});
    const cache = createCache(dir);
    const result = await runEnrich(sources, cache, { in: path, ids: [] }, { now: NOW });
    expect(result.enriched).toBe(1);
    const repo = loadCorpus(path).repos[0];
    expect(repo?.signals.commits90d?.value).toBe(120);
    expect(repo?.signals.commits90d?.source).toBe('github-graphql');
    expect(repo?.signals.mentionableUsers?.value).toBe(40);
    expect(repo?.signals.closedIssues?.value).toBe(285);
    expect(repo?.signals.orgOwned?.value).toBe(true);
    expect(repo?.signals.isFork?.value).toBe(false);
    expect(repo?.signals.pseudoLicense?.value).toBe(false);
  });

  test('budget graphqlPoints pool updated + pointsSpent summed from observed cost', async () => {
    const path = writeCorpus([bareRepo('acme/widget')]);
    const { sources } = fakeSources({});
    const cache = createCache(dir);
    const result = await runEnrich(sources, cache, { in: path, ids: [] }, { now: NOW });
    expect(result.pointsSpent).toBe(2);
    expect(cache.budget.load().graphqlPoints?.remaining).toBe(4990);
  });
});

describe('enrich — B-group fallback chain (fake sources)', () => {
  test('ecosyste.ms answers → dependentReposCount, source ecosyste.ms, no deps.dev call', async () => {
    const path = writeCorpus([bareRepo('acme/widget')]);
    const { sources, calls } = fakeSources({
      ecosystems: () => ({
        dependent_repos_count: 1500,
        downloads: 90000,
        last_synced_at: '2026-07-01T00:00:00Z',
      }),
    });
    const cache = createCache(dir);
    await runEnrich(sources, cache, { in: path, ids: [] }, { now: NOW });
    const repo = loadCorpus(path).repos[0];
    expect(repo?.signals.dependentReposCount?.value).toBe(1500);
    expect(repo?.signals.dependentReposCount?.source).toBe('ecosyste.ms');
    expect(repo?.signals.dataAge?.value).toBe(10);
    expect(calls.some((c) => c.startsWith('depsdev'))).toBe(false);
  });

  test('ecosyste.ms SOURCE_DOWN → deps.dev used, dependents recorded with deps.dev provenance', async () => {
    const path = writeCorpus([bareRepo('acme/widget')]);
    const { sources, calls } = fakeSources({
      ecosystems: () => {
        throw new EngineError('SOURCE_DOWN', 'ecosyste.ms down');
      },
      packageVersions: () => ({
        versions: [
          { versionKey: { system: 'npm', name: 'widget', version: '1.0.0' } },
          { versionKey: { system: 'npm', name: 'widget', version: '1.1.0' } },
        ],
      }),
      dependents: (_pkg, version) => ({ dependentCount: version === '1.1.0' ? 800 : 500 }),
    });
    const cache = createCache(dir);
    await runEnrich(sources, cache, { in: path, ids: [] }, { now: NOW });
    const repo = loadCorpus(path).repos[0];
    expect(repo?.signals.dependents?.value).toBe(800); // max over recent versions
    expect(repo?.signals.dependents?.source).toBe('deps.dev');
    expect(repo?.signals.packaged?.value).toBe(true);
    expect(calls).toContain('ecosystems:acme/widget');
    expect(calls.some((c) => c.startsWith('depsdev.pv'))).toBe(true);
  });

  test('no packages anywhere → packaged:false (B absent-with-reason)', async () => {
    const path = writeCorpus([bareRepo('acme/app')]);
    const { sources } = fakeSources({
      ecosystems: () => {
        throw new EngineError('NOT_FOUND', 'not indexed');
      },
      packageVersions: () => {
        throw new EngineError('NOT_FOUND', 'no packages');
      },
    });
    const cache = createCache(dir);
    await runEnrich(sources, cache, { in: path, ids: [] }, { now: NOW });
    const repo = loadCorpus(path).repos[0];
    expect(repo?.signals.packaged?.value).toBe(false);
    expect(repo?.signals.dependents).toBeUndefined();
    expect(repo?.signals.dependentReposCount).toBeUndefined();
  });

  test('both rungs SOURCE_DOWN → visible bSourceDown marker, no fabricated usage', async () => {
    const bSignals = await resolveBGroup(
      fakeSources({
        ecosystems: () => {
          throw new EngineError('SOURCE_DOWN', 'down');
        },
        packageVersions: () => {
          throw new EngineError('SOURCE_DOWN', 'down');
        },
      }).sources,
      'acme/app',
      NOW(),
      '2026-07-11T00:00:00Z',
    );
    expect(bSignals.bSourceDown?.value).toBe(true);
    expect(bSignals.dependents).toBeUndefined();
    expect(bSignals.packaged).toBeUndefined();
  });

  test('--skip-deps runs the GraphQL stage only, no B calls', async () => {
    const path = writeCorpus([bareRepo('acme/widget')]);
    const { sources, calls } = fakeSources({
      ecosystems: () => ({ dependent_repos_count: 1500 }),
    });
    const cache = createCache(dir);
    await runEnrich(sources, cache, { in: path, ids: [], skipDeps: true }, { now: NOW });
    const repo = loadCorpus(path).repos[0];
    expect(repo?.signals.dependentReposCount).toBeUndefined();
    expect(calls.some((c) => c.startsWith('ecosystems'))).toBe(false);
  });
});

describe('enrich — selection', () => {
  test('--top N enriches only the N highest-star unenriched rows', async () => {
    const repos = [
      bareRepo('acme/low', { stars: 10 }),
      bareRepo('acme/high', { stars: 9000 }),
      bareRepo('acme/mid', { stars: 500 }),
    ];
    const path = writeCorpus(repos);
    const { sources, calls } = fakeSources({});
    const cache = createCache(dir);
    const result = await runEnrich(sources, cache, { in: path, ids: [], top: '1' }, { now: NOW });
    expect(result.enriched).toBe(1);
    expect(result.skipped).toBe(2);
    expect(calls[0]).toBe('graphql:acme/high');
  });

  test('positional ids restrict enrichment to those repos', async () => {
    const path = writeCorpus([bareRepo('acme/a'), bareRepo('acme/b')]);
    const { sources, calls } = fakeSources({});
    const cache = createCache(dir);
    await runEnrich(sources, cache, { in: path, ids: ['acme/b'] }, { now: NOW });
    expect(calls[0]).toBe('graphql:acme/b');
  });

  test('--stale-ok skips rows whose signals are fresher than 7 days', async () => {
    const fresh = bareRepo('acme/fresh', {
      signals: {
        commits90d: { value: 1, source: 'github-graphql', fetchedAt: '2026-07-10T00:00:00Z' },
      },
    });
    const stale = bareRepo('acme/stale', {
      signals: {
        commits90d: { value: 1, source: 'github-graphql', fetchedAt: '2026-01-01T00:00:00Z' },
      },
    });
    const path = writeCorpus([fresh, stale]);
    const { sources, calls } = fakeSources({});
    const cache = createCache(dir);
    const result = await runEnrich(
      sources,
      cache,
      { in: path, ids: [], staleOk: true },
      { now: NOW },
    );
    expect(result.enriched).toBe(1);
    expect(calls[0]).toBe('graphql:acme/stale');
  });
});

describe('enrich — per-repo GraphQL failure isolation', () => {
  test('a null/errored repo is reported in failed[], others still enrich', async () => {
    const path = writeCorpus([bareRepo('acme/ok'), bareRepo('acme/gone')]);
    const { sources } = fakeSources({
      graphql: (names) =>
        names.map((name) =>
          name === 'acme/gone'
            ? { name, data: null, error: { code: 'NOT_FOUND' as const, message: 'gone' } }
            : { name, data: enrichNode(name) },
        ),
    });
    const cache = createCache(dir);
    const result = await runEnrich(sources, cache, { in: path, ids: [] }, { now: NOW });
    expect(result.enriched).toBe(1);
    expect(result.failed).toEqual([{ id: 'acme/gone', code: 'NOT_FOUND', message: 'gone' }]);
  });
});

describe('enrichOptsFromArgs', () => {
  test('maps --in, ids, --top, --skip-deps, --stale-ok', () => {
    const parsed = parseArgs([
      'enrich',
      '--in',
      'c.json',
      'o/r',
      '--top',
      '50',
      '--skip-deps',
      '--stale-ok',
    ]);
    const opts = enrichOptsFromArgs(parsed);
    expect(opts.in).toBe('c.json');
    expect(opts.ids).toEqual(['o/r']);
    expect(opts.top).toBe('50');
    expect(opts.skipDeps).toBe(true);
    expect(opts.staleOk).toBe(true);
  });
});
