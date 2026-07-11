// Envelope/exit-code contract tests for the three commands wired in task 4
// (search/batch/hydrate): ok → 0, INVALID_INPUT → 1, and a name outside the
// registry still → UNKNOWN_COMMAND / 2. Registered-but-not-yet-implemented
// commands (enrich, rank, ...) keep their own coverage in cli.run.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '../src/cache/index.ts';
import { run } from '../src/cli.ts';
import type { RepoResult } from '../src/sources/gh-graphql.ts';
import type { Sources } from '../src/sources/index.ts';
import type { Envelope } from '../src/types.ts';

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

/** Unused adapters (ghRest/ecosystems/depsdev) are stubbed as `unknown` — search/batch/hydrate never call them, so a real shape isn't needed. */
function fakeSources(): Sources {
  return {
    ghGraphql: {
      graphql: async <T>() => ({ search: { repositoryCount: 1, nodes: [fixtureNode()] } }) as T,
      lastRateLimit: () => ({
        cost: 1,
        remaining: 4999,
        resetAt: '2026-07-10T01:00:00Z',
        nodeCount: 1,
      }),
      batchRepositories: async <T>(names: string[]) =>
        names.map((name) => ({
          name,
          data: fixtureNode({ nameWithOwner: name }),
        })) as unknown as RepoResult<T>[],
    },
    ghRest: {} as unknown as Sources['ghRest'],
    ecosystems: {} as unknown as Sources['ecosystems'],
    depsdev: {} as unknown as Sources['depsdev'],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-cli-dispatch-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('dispatch — plan (task 9)', () => {
  test('a valid offline plan → ok:true, exit 0, zero network', async () => {
    const { stdout, exitCode } = await run(
      ['plan', 'topic:markdown', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('plan');
  });

  test('no slices and no stdin → INVALID_INPUT, exit 1', async () => {
    const { stdout, exitCode } = await run(
      ['plan', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  test('plan reads slices from stdin via `-`', async () => {
    const { stdout, exitCode } = await run(
      ['plan', '-', '--compact'],
      fakeSources(),
      'topic:markdown\n',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
  });

  test('--probe drives a real search call and spends a point', async () => {
    const sources = fakeSources();
    sources.ghGraphql = {
      ...sources.ghGraphql,
      graphql: async <T>() => ({ search: { repositoryCount: 5 } }) as T,
    };
    const { stdout, exitCode } = await run(
      ['plan', 'topic:markdown', '--probe', '--compact'],
      sources,
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<{ pointsSpent: number }>;
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success');
    expect(envelope.data.pointsSpent).toBe(1);
  });
});

describe('dispatch — search', () => {
  test('a valid search → ok:true, exit 0', async () => {
    const { stdout, exitCode } = await run(
      ['search', 'markdown', 'editor', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('search');
  });

  test('an empty query → INVALID_INPUT, exit 1', async () => {
    const { stdout, exitCode } = await run(
      ['search', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('dispatch — batch', () => {
  test('a valid --dry-run batch → ok:true, exit 0, zero network', async () => {
    const file = join(dir, 'queries.txt');
    writeFileSync(file, 'topic:markdown\n');
    const { stdout, exitCode } = await run(
      ['batch', '--file', file, '--dry-run', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
  });

  test('missing --file → INVALID_INPUT, exit 1', async () => {
    const { stdout, exitCode } = await run(
      ['batch', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('dispatch — hydrate', () => {
  test('a valid hydrate → ok:true, exit 0', async () => {
    const { stdout, exitCode } = await run(
      ['hydrate', 'octocat/hello-world', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
  });

  test('a malformed id → INVALID_INPUT, exit 1', async () => {
    const { stdout, exitCode } = await run(
      ['hydrate', 'not-a-valid-id', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  test('hydrate reads ids from stdin via `-`', async () => {
    const { stdout, exitCode } = await run(
      ['hydrate', '-', '--compact'],
      fakeSources(),
      'octocat/hello-world\n',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
  });
});

describe('dispatch — a name outside the registry is still UNKNOWN_COMMAND / exit 2', () => {
  test('nonsense command', async () => {
    const { exitCode } = await run(['nonsense'], fakeSources(), '', createCache(dir));
    expect(exitCode).toBe(2);
  });
});

describe('dispatch — enrich (task 5)', () => {
  test('missing --in → INVALID_INPUT, exit 1, zero network', async () => {
    const { stdout, exitCode } = await run(
      ['enrich', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('dispatch — rank (task 5, offline)', () => {
  test('ranking a written corpus → ok:true, exit 0', async () => {
    const out = join(dir, 'corpus.json');
    const cache = createCache(dir);
    await run(
      ['search', 'markdown', 'editor', '--out', out, '--compact'],
      fakeSources(),
      '',
      cache,
    );

    const { stdout, exitCode } = await run(['rank', out, '--compact'], fakeSources(), '', cache);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('rank');
  });

  test('no corpus path → INVALID_INPUT, exit 1', async () => {
    const { stdout, exitCode } = await run(
      ['rank', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

const SHA = 'a'.repeat(40);

/** A minimal fake ghRest good enough for skim/read/digest dispatch-contract checks (no real network). */
function fakeGhRestForExtraction(): Sources['ghRest'] {
  return {
    get: async (path: string) => {
      if (path === '/rate_limit') {
        return {
          status: 200,
          headers: new Headers(),
          body: {
            resources: {
              core: { limit: 5000, remaining: 4999, reset: 2000000000 },
              search: { limit: 30, remaining: 30, reset: 2000000000 },
              graphql: { limit: 5000, remaining: 4999, reset: 2000000000 },
            },
          },
          etag: null,
        };
      }
      if (path.includes('/commits/')) {
        return {
          status: 200,
          headers: new Headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '2000000000' }),
          body: { sha: SHA },
          etag: '"c1"',
        };
      }
      if (path.includes('/git/trees/')) {
        return {
          status: 200,
          headers: new Headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '2000000000' }),
          body: {
            truncated: false,
            tree: [{ path: 'README.md', type: 'blob', sha: 'b'.repeat(40), size: 5 }],
          },
          etag: '"t1"',
        };
      }
      if (path.includes('/readme')) {
        return {
          status: 200,
          headers: new Headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '2000000000' }),
          body: '# hi',
          etag: '"r1"',
        };
      }
      if (path.includes('/contents/')) {
        return {
          status: 200,
          headers: new Headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '2000000000' }),
          body: {
            content: Buffer.from('# hi').toString('base64'),
            encoding: 'base64',
            sha: 'b'.repeat(40),
            type: 'file',
          },
          etag: null,
        };
      }
      throw new Error(`unmapped fetch in dispatch test: ${path}`);
    },
    tarballUrl: async () => 'https://codeload.github.com/o/r/tar',
    downloadTarball: async () => {
      throw new Error('digest dispatch tests use INVALID_INPUT before any tarball fetch');
    },
  } as unknown as Sources['ghRest'];
}

describe('dispatch — skim (task 6)', () => {
  test('a valid skim → ok:true, exit 0', async () => {
    const sources = fakeSources();
    sources.ghRest = fakeGhRestForExtraction();
    const { stdout, exitCode } = await run(
      ['skim', 'o/r', '--compact'],
      sources,
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('skim');
  });

  test('a repo without a slash → INVALID_INPUT, exit 1', async () => {
    const sources = fakeSources();
    sources.ghRest = fakeGhRestForExtraction();
    const { stdout, exitCode } = await run(
      ['skim', 'not-a-repo', '--compact'],
      sources,
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('dispatch — read (task 6)', () => {
  test('a valid read → ok:true, exit 0', async () => {
    const sources = fakeSources();
    sources.ghRest = fakeGhRestForExtraction();
    const { stdout, exitCode } = await run(
      ['read', 'o/r', 'README.md', '--compact'],
      sources,
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('read');
  });

  test('zero paths → INVALID_INPUT, exit 1', async () => {
    const sources = fakeSources();
    sources.ghRest = fakeGhRestForExtraction();
    const { stdout, exitCode } = await run(
      ['read', 'o/r', '--compact'],
      sources,
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('dispatch — digest (task 6)', () => {
  test('a repo without a slash → INVALID_INPUT, exit 1, zero network', async () => {
    const sources = fakeSources();
    sources.ghRest = fakeGhRestForExtraction();
    const { stdout, exitCode } = await run(
      ['digest', 'not-a-repo', '--compact'],
      sources,
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('dispatch — budget (task 7)', () => {
  test('a valid budget call → ok:true, exit 0', async () => {
    const sources = fakeSources();
    sources.ghRest = fakeGhRestForExtraction();
    const { stdout, exitCode } = await run(['budget', '--compact'], sources, '', createCache(dir));
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('budget');
  });

  test('an unsupported --forecast command → INVALID_INPUT, exit 1', async () => {
    const sources = fakeSources();
    sources.ghRest = fakeGhRestForExtraction();
    const { stdout, exitCode } = await run(
      ['budget', '--forecast', 'health:1', '--compact'],
      sources,
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('dispatch — doctor (task 7)', () => {
  test('doctor always exits 0 with ok:true, even when every underlying check fails', async () => {
    const sources: Sources = {
      ghGraphql: {
        graphql: async () => {
          throw new Error('graphql down');
        },
        lastRateLimit: () => null,
        batchRepositories: async () => [],
      },
      ghRest: {
        get: async () => {
          throw new Error('rest down');
        },
        tarballUrl: async () => {
          throw new Error('n/a');
        },
        downloadTarball: async () => {
          throw new Error('n/a');
        },
      },
      ecosystems: {
        repo: async () => {
          throw new Error('down');
        },
        bulkLookupPackages: async () => [],
      },
      depsdev: {
        project: async () => {
          throw new Error('down');
        },
        projectPackageVersions: async () => {
          throw new Error('down');
        },
        dependents: async () => {
          throw new Error('down');
        },
      },
    };
    const { stdout, exitCode } = await run(['doctor', '--compact'], sources, '', createCache(dir));
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<{ healthy: boolean }>;
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success');
    expect(envelope.data.healthy).toBe(false);
  });

  test('doctor --offline exits 0 with ok:true, touching zero network', async () => {
    const sources = fakeSources();
    sources.ghRest = fakeGhRestForExtraction();
    const { stdout, exitCode } = await run(
      ['doctor', '--offline', '--compact'],
      sources,
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('doctor');
  });
});

describe('dispatch — cache (task 7)', () => {
  test('cache stats → ok:true, exit 0, zero network', async () => {
    const { stdout, exitCode } = await run(
      ['cache', 'stats', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('cache');
  });

  test('cache clear without --confirm → CONFIRMATION_REQUIRED, exit 1', async () => {
    // Prime the root with the ownership marker (fix wave 1) — a real prior
    // cache-layer write, as any normal ghrelay session would have made —
    // so the CONFIRMATION_REQUIRED gate, not the ownership guard, is what
    // this test is exercising.
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'x');
    const { stdout, exitCode } = await run(
      ['cache', 'clear', '--compact'],
      fakeSources(),
      '',
      cache,
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('an unknown cache subcommand → INVALID_INPUT, exit 1', async () => {
    const { stdout, exitCode } = await run(
      ['cache', 'nope', '--compact'],
      fakeSources(),
      '',
      createCache(dir),
    );
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('acceptance — corpus round-trips through search --out then batch --out (merge, not clobber)', () => {
  test('a repo written by search survives a later batch --out to the same file, plus the batch repo joins it', async () => {
    const out = join(dir, 'corpus.json');
    const cache = createCache(dir);

    await run(
      ['search', 'markdown', 'editor', '--out', out, '--compact'],
      fakeSources(),
      '',
      cache,
    );

    const file = join(dir, 'queries.txt');
    writeFileSync(file, 'topic:markdown\n');
    // fakeSources() always returns the same fixture full_name, so give the batch
    // run a distinct ghGraphql that yields a DIFFERENT repo — otherwise this test
    // can't distinguish "merged" from "clobbered".
    const batchSources = fakeSources();
    batchSources.ghGraphql = {
      ...batchSources.ghGraphql,
      graphql: async <T>() =>
        ({
          search: {
            repositoryCount: 1,
            nodes: [fixtureNode({ nameWithOwner: 'octocat/from-batch', id: 'R_kgDOA2' })],
          },
        }) as T,
    };
    await run(
      ['batch', '--file', file, '--out', out, '--delay', '0', '--compact'],
      batchSources,
      '',
      cache,
    );

    const corpus = JSON.parse(readFileSync(out, 'utf-8')) as { repos: { full_name: string }[] };
    expect(corpus.repos.map((r) => r.full_name).sort()).toEqual([
      'octocat/Hello-World',
      'octocat/from-batch',
    ]);
  });
});
