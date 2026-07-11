import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache, loadCorpus } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import { type BatchOpts, batchOptsFromArgs, runBatch } from '../../src/commands/batch.ts';
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
  handler: (query: string, vars?: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const calls: { query: string; vars?: Record<string, unknown> }[] = [];
  return {
    calls,
    graphql: async <T>(query: string, vars?: Record<string, unknown>) => {
      calls.push({ query, vars });
      return (await handler(query, vars)) as T;
    },
    lastRateLimit: () => ({
      cost: 1,
      remaining: 4999,
      resetAt: '2026-07-10T01:00:00Z',
      nodeCount: 1,
    }),
  };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-batch-'));
  file = join(dir, 'queries.txt');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runBatch — validation (no network)', () => {
  test('missing --file → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(
      runBatch({ ghGraphql: fakeGhGraphql(() => ({})) }, cache, { out: join(dir, 'c.json') }),
    ).rejects.toThrow(EngineError);
  });

  test('missing --out on a real (non-dry-run) run → INVALID_INPUT', async () => {
    writeFileSync(file, 'topic:markdown\n');
    const cache = createCache(dir);
    await expect(
      runBatch({ ghGraphql: fakeGhGraphql(() => ({})) }, cache, { file }),
    ).rejects.toThrow(EngineError);
  });

  test('unreadable --file → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    await expect(
      runBatch({ ghGraphql: fakeGhGraphql(() => ({})) }, cache, {
        file: join(dir, 'missing.txt'),
        out: join(dir, 'c.json'),
      }),
    ).rejects.toThrow(EngineError);
  });

  test('a file with only comments/blanks → INVALID_INPUT', async () => {
    writeFileSync(file, '# just a comment\n\n   \n');
    const cache = createCache(dir);
    await expect(
      runBatch({ ghGraphql: fakeGhGraphql(() => ({})) }, cache, { file, out: join(dir, 'c.json') }),
    ).rejects.toThrow(EngineError);
  });

  test('comments and blank lines are skipped, real queries kept', async () => {
    writeFileSync(file, '# comment\ntopic:markdown\n\n  topic:notes  \n# trailing comment\n');
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 0, nodes: [] } }));
    const cache = createCache(dir);
    const result = await runBatch({ ghGraphql }, cache, {
      file,
      out: join(dir, 'c.json'),
      delay: '0',
    });
    expect(result.queries).toBe(2);
    expect(ghGraphql.calls.map((c) => c.vars?.q)).toEqual(['topic:markdown', 'topic:notes']);
  });

  test('CRLF-terminated query lines are trimmed cleanly, not left with a trailing \\r', async () => {
    writeFileSync(file, 'topic:markdown\r\ntopic:notes\r\n');
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 0, nodes: [] } }));
    const cache = createCache(dir);
    const result = await runBatch({ ghGraphql }, cache, {
      file,
      out: join(dir, 'c.json'),
      delay: '0',
    });
    expect(result.queries).toBe(2);
    expect(ghGraphql.calls.map((c) => c.vars?.q)).toEqual(['topic:markdown', 'topic:notes']);
  });
});

describe('runBatch — --dry-run (zero network)', () => {
  test('validates every query offline; a query over 256 chars → QUERY_TOO_COMPLEX per query', async () => {
    const longQuery = `topic:${'x'.repeat(260)}`;
    writeFileSync(file, `topic:markdown\n${longQuery}\n`);
    const ghGraphql = fakeGhGraphql(() => {
      throw new Error('must not be called in --dry-run');
    });
    const cache = createCache(dir);
    const result = await runBatch({ ghGraphql }, cache, { file, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(ghGraphql.calls).toHaveLength(0);
    expect(result.perQuery[0]?.error).toBeUndefined();
    expect(result.perQuery[1]?.error?.code).toBe('QUERY_TOO_COMPLEX');
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.totalUnique).toBe(0);
    expect(result.out).toBeUndefined();
  });

  test('a query with more than 5 AND/OR/NOT operators → QUERY_TOO_COMPLEX', async () => {
    const query = 'a AND b AND c AND d AND e AND f AND g';
    writeFileSync(file, `${query}\n`);
    const cache = createCache(dir);
    const result = await runBatch({ ghGraphql: fakeGhGraphql(() => ({})) }, cache, {
      file,
      dryRun: true,
    });
    expect(result.perQuery[0]?.error?.code).toBe('QUERY_TOO_COMPLEX');
  });

  test('--dry-run ignores --out entirely (no file written, no out in result)', async () => {
    writeFileSync(file, 'topic:markdown\n');
    const out = join(dir, 'c.json');
    const cache = createCache(dir);
    const result = await runBatch({ ghGraphql: fakeGhGraphql(() => ({})) }, cache, {
      file,
      out,
      dryRun: true,
    });
    expect(result.out).toBeUndefined();
    expect(() => loadCorpus(out)).toThrow();
  });
});

describe('runBatch — strict serialization + delay', () => {
  test('queries run strictly serialized with the default 2000ms delay, never after the last', async () => {
    writeFileSync(file, 'q1\nq2\nq3\n');
    const order: string[] = [];
    const ghGraphql = fakeGhGraphql((_q, vars) => {
      order.push(vars?.q as string);
      return { search: { repositoryCount: 0, nodes: [] } };
    });
    const { waits, sleep } = recordingSleep();
    const cache = createCache(dir);
    await runBatch({ ghGraphql }, cache, { file, out: join(dir, 'c.json') }, { sleep });
    expect(order).toEqual(['q1', 'q2', 'q3']);
    // Two sleeps between three queries, never a trailing one after the last.
    expect(waits).toEqual([2000, 2000]);
  });

  test('--delay overrides the default', async () => {
    writeFileSync(file, 'q1\nq2\n');
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 0, nodes: [] } }));
    const { waits, sleep } = recordingSleep();
    const cache = createCache(dir);
    await runBatch(
      { ghGraphql },
      cache,
      { file, out: join(dir, 'c.json'), delay: '500' },
      { sleep },
    );
    expect(waits).toEqual([500]);
  });

  test('a RATE_LIMITED retryAfterMs REPLACES the delay before the next query', async () => {
    writeFileSync(file, 'q1\nq2\n');
    let call = 0;
    const ghGraphql = fakeGhGraphql(() => {
      call++;
      if (call === 1) throw new EngineError('RATE_LIMITED', 'limited', 403, 9000);
      return { search: { repositoryCount: 0, nodes: [] } };
    });
    const { waits, sleep } = recordingSleep();
    const cache = createCache(dir);
    await runBatch({ ghGraphql }, cache, { file, out: join(dir, 'c.json') }, { sleep });
    expect(waits).toEqual([9000]);
  });

  test('a RATE_LIMITED error with no retryAfterMs falls back to the ordinary delay, never undefined/NaN', async () => {
    writeFileSync(file, 'q1\nq2\n');
    let call = 0;
    const ghGraphql = fakeGhGraphql(() => {
      call++;
      // No 4th (retryAfterMs) constructor arg — EngineError leaves retryAfterMs undefined.
      if (call === 1) throw new EngineError('RATE_LIMITED', 'limited');
      return { search: { repositoryCount: 0, nodes: [] } };
    });
    const { waits, sleep } = recordingSleep();
    const cache = createCache(dir);
    await runBatch(
      { ghGraphql },
      cache,
      { file, out: join(dir, 'c.json'), delay: '1234' },
      { sleep },
    );
    expect(waits).toEqual([1234]);
  });
});

describe('runBatch — continue-on-error + perQuery ledger', () => {
  test('a failing query is recorded and the loop proceeds; failed queries do not poison totalUnique', async () => {
    writeFileSync(file, 'good\nbad\n');
    let call = 0;
    const ghGraphql = fakeGhGraphql(() => {
      call++;
      if (call === 2) throw new EngineError('FETCH_FAILED', 'boom');
      return { search: { repositoryCount: 1, nodes: [fixtureNode()] } };
    });
    const cache = createCache(dir);
    const result = await runBatch(
      { ghGraphql },
      cache,
      { file, out: join(dir, 'c.json'), delay: '0' },
      {},
    );
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.perQuery[1]?.error?.code).toBe('FETCH_FAILED');
    expect(result.totalUnique).toBe(1);
  });
});

describe('runBatch — cross-query dedupe + corpus merge (real cache, temp dir)', () => {
  test('the same repo returned by two queries counts once in totalUnique and in the corpus', async () => {
    writeFileSync(file, 'q1\nq2\n');
    const ghGraphql = fakeGhGraphql(() => ({
      search: { repositoryCount: 1, nodes: [fixtureNode()] },
    }));
    const out = join(dir, 'corpus.json');
    const cache = createCache(dir);
    const result = await runBatch({ ghGraphql }, cache, { file, out, delay: '0' });
    expect(result.totalUnique).toBe(1);
    const corpus = loadCorpus(out);
    expect(corpus.repos).toHaveLength(1);
  });

  test('--out merges into an existing corpus rather than clobbering it (incremental top-up)', async () => {
    const out = join(dir, 'corpus.json');
    writeFileSync(file, 'q1\n');
    const cache = createCache(dir);

    const ghGraphqlA = fakeGhGraphql(() => ({
      search: {
        repositoryCount: 1,
        nodes: [fixtureNode({ nameWithOwner: 'octocat/repo-a', id: 'R_kgDOA1' })],
      },
    }));
    await runBatch({ ghGraphql: ghGraphqlA }, cache, { file, out, delay: '0' });

    writeFileSync(file, 'q2\n');
    const ghGraphqlB = fakeGhGraphql(() => ({
      search: {
        repositoryCount: 1,
        nodes: [fixtureNode({ nameWithOwner: 'octocat/repo-b', id: 'R_kgDOA2' })],
      },
    }));
    await runBatch({ ghGraphql: ghGraphqlB }, cache, { file, out, delay: '0' });

    const corpus = loadCorpus(out);
    expect(corpus.repos.map((r) => r.full_name).sort()).toEqual([
      'octocat/repo-a',
      'octocat/repo-b',
    ]);
  });
});

describe('runBatch — budget update', () => {
  test('updates the graphqlPoints pool after queries run', async () => {
    writeFileSync(file, 'q1\n');
    const ghGraphql = fakeGhGraphql(() => ({ search: { repositoryCount: 0, nodes: [] } }));
    const cache = createCache(dir);
    await runBatch({ ghGraphql }, cache, { file, out: join(dir, 'c.json'), delay: '0' });
    expect(cache.budget.load().graphqlPoints?.remaining).toBe(4999);
  });
});

describe('batchOptsFromArgs', () => {
  test('maps parsed CLI flags onto BatchOpts', () => {
    const parsed = parseArgs([
      'batch',
      '--file',
      'queries.txt',
      '--out',
      'corpus.json',
      '--delay',
      '500',
      '--dry-run',
    ]);
    const opts: BatchOpts = batchOptsFromArgs(parsed);
    expect(opts.file).toBe('queries.txt');
    expect(opts.out).toBe('corpus.json');
    expect(opts.delay).toBe('500');
    expect(opts.dryRun).toBe(true);
  });
});
