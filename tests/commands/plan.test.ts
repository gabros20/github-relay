import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import { runBatch } from '../../src/commands/batch.ts';
import { type PlanOpts, planOptsFromArgs, runPlan } from '../../src/commands/plan.ts';
import { EngineError } from '../../src/types.ts';

function fakeGhGraphql(handler: (q: string) => number) {
  const calls: string[] = [];
  return {
    calls,
    graphql: async <T>(_query: string, vars?: Record<string, unknown>) => {
      const q = (vars?.q as string) ?? '';
      calls.push(q);
      return { search: { repositoryCount: handler(q) } } as T;
    },
    lastRateLimit: () => ({
      cost: 1,
      remaining: 4999,
      resetAt: '2026-07-10T01:00:00Z',
      nodeCount: 1,
    }),
  };
}

/** Keyed by exact `q` variable text: a number returns that repositoryCount, an EngineError throws it — lets a fixture rig a specific probe (e.g. "shard 3 of 5") to fail while its siblings succeed. */
function fakeGhGraphqlKeyed(items: Record<string, number | EngineError>) {
  const calls: string[] = [];
  return {
    calls,
    graphql: async <T>(_query: string, vars?: Record<string, unknown>) => {
      const q = (vars?.q as string) ?? '';
      calls.push(q);
      const item = items[q];
      if (item === undefined) throw new Error(`unexpected probe query: '${q}'`);
      if (item instanceof EngineError) throw item;
      return { search: { repositoryCount: item } } as T;
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-plan-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runPlan — validation (no network)', () => {
  test('no slices and no stdin → INVALID_INPUT', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => 0);
    await expect(runPlan({ ghGraphql }, cache, { slices: [] }, '')).rejects.toThrow(EngineError);
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('an invalid --shard value → INVALID_INPUT, zero network', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => 0);
    await expect(
      runPlan({ ghGraphql }, cache, { slices: ['topic:x'], shard: 'forks' }, ''),
    ).rejects.toThrow(EngineError);
    expect(ghGraphql.calls).toHaveLength(0);
  });
});

describe('runPlan — default / --dry (offline only, zero network)', () => {
  test('a valid slice → ok:true, no count/shards, zero network', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => {
      throw new Error('must not be called offline');
    });
    const result = await runPlan({ ghGraphql }, cache, { slices: ['topic:markdown'] }, '');
    expect(result.slices).toEqual([{ slice: 'topic:markdown', ok: true }]);
    expect(result.queries).toEqual(['topic:markdown']);
    expect(result.estimatedPoints).toBe(1);
    expect(result.pointsSpent).toBe(0);
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('--dry behaves identically to the flagless default', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => {
      throw new Error('must not be called offline');
    });
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:markdown'], dry: true },
      '',
    );
    expect(result.slices).toEqual([{ slice: 'topic:markdown', ok: true }]);
    expect(result.pointsSpent).toBe(0);
  });

  test('a query over 256 chars → QUERY_TOO_COMPLEX per slice, others still validated', async () => {
    const cache = createCache(dir);
    const longSlice = `topic:${'x'.repeat(260)}`;
    const ghGraphql = fakeGhGraphql(() => {
      throw new Error('must not be called offline');
    });
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:markdown', longSlice] },
      '',
    );
    expect(result.slices[0]).toEqual({ slice: 'topic:markdown', ok: true });
    expect(result.slices[1]?.ok).toBe(false);
    expect(result.slices[1]?.error?.code).toBe('QUERY_TOO_COMPLEX');
    expect(result.queries).toEqual(['topic:markdown']);
    expect(result.estimatedPoints).toBe(1);
  });

  test('a slice with more than 5 AND/OR/NOT operators → QUERY_TOO_COMPLEX', async () => {
    const cache = createCache(dir);
    const slice = 'a AND b AND c AND d AND e AND f AND g';
    const ghGraphql = fakeGhGraphql(() => 0);
    const result = await runPlan({ ghGraphql }, cache, { slices: [slice] }, '');
    expect(result.slices[0]?.error?.code).toBe('QUERY_TOO_COMPLEX');
  });

  test('`-` reads newline-separated slices from stdin, comments/blanks skipped', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => {
      throw new Error('must not be called offline');
    });
    const stdin = '# a comment\ntopic:markdown\n\n  topic:notes  \n';
    const result = await runPlan({ ghGraphql }, cache, { slices: ['-'] }, stdin);
    expect(result.slices.map((s) => s.slice)).toEqual(['topic:markdown', 'topic:notes']);
  });

  test('positionals and `-` combine', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => 0);
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:markdown', '-'] },
      'topic:notes\n',
    );
    expect(result.slices.map((s) => s.slice)).toEqual(['topic:markdown', 'topic:notes']);
  });
});

describe('runPlan — --probe, a slice under the cap', () => {
  test('one probe, count set, no shards, budget updated', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => 42);
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:markdown'], probe: true },
      '',
      { sleep: recordingSleep().sleep },
    );
    expect(result.slices).toEqual([{ slice: 'topic:markdown', ok: true, count: 42 }]);
    expect(result.queries).toEqual(['topic:markdown']);
    expect(result.estimatedPoints).toBe(1);
    expect(result.pointsSpent).toBe(1);
    expect(cache.budget.load().graphqlPoints?.remaining).toBe(4999);
  });

  test('a query still failing offline validation is never probed', async () => {
    const cache = createCache(dir);
    const longSlice = `topic:${'x'.repeat(260)}`;
    const ghGraphql = fakeGhGraphql(() => {
      throw new Error('must not probe an invalid slice');
    });
    const result = await runPlan({ ghGraphql }, cache, { slices: [longSlice], probe: true }, '');
    expect(result.slices[0]?.ok).toBe(false);
    expect(ghGraphql.calls).toHaveLength(0);
  });
});

describe('runPlan — --probe serialization + 500ms delay', () => {
  test('probes run strictly serialized, 500ms apart, never after the last', async () => {
    const cache = createCache(dir);
    const order: string[] = [];
    const ghGraphql = fakeGhGraphql((q) => {
      order.push(q);
      return 1;
    });
    const { waits, sleep } = recordingSleep();
    await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:a', 'topic:b', 'topic:c'], probe: true },
      '',
      { sleep },
    );
    expect(order).toEqual(['topic:a', 'topic:b', 'topic:c']);
    expect(waits).toEqual([500, 500]);
  });
});

describe('runPlan — --probe, iterative re-probe convergence (hand-computed tree)', () => {
  // slice "topic:x", default --shard stars. Hand-derived from splitStarsWindow's
  // geometric-mean bisection (see plan.ts): level0 [0,Inf) -> mid 707 ->
  // "stars:0..707" / "stars:>=708"; the first still needs a second split ->
  // mid 27 -> "stars:0..27" / "stars:28..707".
  const COUNTS: Record<string, number> = {
    'topic:x': 5000,
    'topic:x stars:0..707': 1600,
    'topic:x stars:>=708': 900,
    'topic:x stars:0..27': 400,
    'topic:x stars:28..707': 700,
  };

  test('recurses into a shard that is still over the cap after one split', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((q) => {
      const count = COUNTS[q];
      if (count === undefined) throw new Error(`unexpected probe query: '${q}'`);
      return count;
    });
    const { sleep } = recordingSleep();
    const result = await runPlan({ ghGraphql }, cache, { slices: ['topic:x'], probe: true }, '', {
      sleep,
    });

    expect(result.slices).toHaveLength(1);
    const slice = result.slices[0];
    expect(slice?.ok).toBe(true);
    expect(slice?.count).toBeUndefined();
    expect(slice?.shards).toEqual([
      { query: 'topic:x stars:0..27', count: 400 },
      { query: 'topic:x stars:28..707', count: 700 },
      { query: 'topic:x stars:>=708', count: 900 },
    ]);
    expect(slice?.shards?.every((s) => (s.count ?? 0) <= 1000)).toBe(true);
    expect(result.queries).toEqual([
      'topic:x stars:0..27',
      'topic:x stars:28..707',
      'topic:x stars:>=708',
    ]);
    expect(result.estimatedPoints).toBe(3);
    // 5 probes total: topic:x, stars:0..707, stars:0..27, stars:28..707, stars:>=708.
    expect(result.pointsSpent).toBe(5);
  });
});

describe('runPlan — --probe, existing stars: qualifier is narrowed, never duplicated', () => {
  test('a slice with stars:10..1000000 shards within that range, one stars: token per shard', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql((q) => (q === 'topic:x stars:10..1000000' ? 5000 : 500));
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:x stars:10..1000000'], probe: true },
      '',
      { sleep: recordingSleep().sleep },
    );
    const shards = result.slices[0]?.shards ?? [];
    expect(shards).toEqual([
      { query: 'topic:x stars:10..3162', count: 500 },
      { query: 'topic:x stars:3163..1000000', count: 500 },
    ]);
    for (const s of shards) {
      const starsOccurrences = (s.query.match(/stars:/g) ?? []).length;
      expect(starsOccurrences).toBe(1);
      const token = s.query.split('stars:')[1] as string;
      const [lo, hi] = token.split('..').map(Number);
      expect(lo).toBeGreaterThanOrEqual(10);
      expect(hi).toBeLessThanOrEqual(1000000);
    }
  });
});

describe('runPlan — --probe, depth cap + leftover reporting (never silently dropped)', () => {
  test('a slice that never converges is capped at depth 5 and every leaf carries a hint', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => 9999); // pathological: always over cap
    // maxProbes raised well above the 63 this tree needs (depth cap 5 -> 63
    // probes) so THIS test exercises the depth cap specifically, not the
    // separate --max-probes governor (see its own describe block below).
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:never-converges'], probe: true, maxProbes: '100' },
      '',
      { sleep: recordingSleep().sleep },
    );
    const shards = result.slices[0]?.shards ?? [];
    // depth cap 5 -> 2^5 = 32 leaves, all still over cap, all hinted.
    expect(shards).toHaveLength(32);
    for (const s of shards) {
      expect(s.count).toBe(9999);
      expect(s.hint).toBeDefined();
      expect(s.hint).toContain('narrow');
    }
    // every leftover query still lands in the flat batch-ready list.
    expect(result.queries).toHaveLength(32);
    expect(result.estimatedPoints).toBe(32);
    // 1+2+4+8+16+32 = 63 probes across the whole tree.
    expect(result.pointsSpent).toBe(63);
  });
});

describe('runPlan — --probe, total probe-point budget (--max-probes, fix wave 1 IMP 1)', () => {
  test('an invalid --max-probes value → INVALID_INPUT, zero network', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => 0);
    await expect(
      runPlan({ ghGraphql }, cache, { slices: ['topic:x'], probe: true, maxProbes: '0' }, ''),
    ).rejects.toThrow(EngineError);
    await expect(
      runPlan({ ghGraphql }, cache, { slices: ['topic:x'], probe: true, maxProbes: 'nope' }, ''),
    ).rejects.toThrow(EngineError);
    expect(ghGraphql.calls).toHaveLength(0);
  });

  test('default is 30: the 31st independent slice is budget-exhausted, first 30 are probed', async () => {
    const cache = createCache(dir);
    const slices = Array.from({ length: 31 }, (_, i) => `topic:s${i}`);
    const ghGraphql = fakeGhGraphql(() => 5); // every slice fits under the cap alone
    const result = await runPlan({ ghGraphql }, cache, { slices, probe: true }, '', {
      sleep: recordingSleep().sleep,
    });
    expect(ghGraphql.calls).toHaveLength(30);
    expect(result.pointsSpent).toBe(30);
    for (let i = 0; i < 30; i++) {
      expect(result.slices[i]).toEqual({ slice: `topic:s${i}`, ok: true, count: 5 });
    }
    const last = result.slices[30];
    expect(last?.ok).toBe(true);
    expect(last?.shards).toEqual([
      {
        query: 'topic:s30',
        hint: 'probe budget exhausted at 30 points; re-run with --max-probes or narrow slices',
      },
    ]);
    // never dropped — the unprobed slice's query still lands in the batch-ready list.
    expect(result.queries).toContain('topic:s30');
    expect(result.queries).toHaveLength(31);
  });

  test('--max-probes N overrides the default, stopping between independent slices at exactly N', async () => {
    const cache = createCache(dir);
    const slices = ['topic:a', 'topic:b', 'topic:c', 'topic:d', 'topic:e'];
    const ghGraphql = fakeGhGraphql(() => 1);
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices, probe: true, maxProbes: '3' },
      '',
      { sleep: recordingSleep().sleep },
    );
    expect(ghGraphql.calls).toHaveLength(3);
    expect(result.pointsSpent).toBe(3);
    expect(result.slices.slice(0, 3).every((s) => s.count === 1)).toBe(true);
    for (const s of result.slices.slice(3)) {
      expect(s.shards?.[0]?.hint).toContain('probe budget exhausted at 3 points');
      expect(s.shards?.[0]?.count).toBeUndefined();
    }
  });

  test('the governor also stops mid-recursion; the unprobed remainder is hinted, never dropped', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphql(() => 9999); // pathological: never converges
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:never-converges'], probe: true, maxProbes: '5' },
      '',
      { sleep: recordingSleep().sleep },
    );
    // the governor is checked BEFORE every probe, so it can only ever spend
    // exactly the budget, never more, however deep the recursion goes.
    expect(ghGraphql.calls).toHaveLength(5);
    expect(result.pointsSpent).toBe(5);
    const shards = result.slices[0]?.shards ?? [];
    expect(shards.length).toBeGreaterThan(0);
    for (const s of shards) {
      if (s.count === undefined) {
        expect(s.hint).toContain('probe budget exhausted at 5 points');
      }
    }
    // still fully accounted for in the batch-ready list, whatever the tree shape.
    expect(result.queries).toHaveLength(shards.length);
    expect(result.estimatedPoints).toBe(shards.length);
  });
});

describe('runPlan — --probe, per-probe failure isolation (fix wave 1 IMP 2)', () => {
  test('a mid-recursion probe failure isolates to its own leaf; completed siblings/ancestors survive', async () => {
    const cache = createCache(dir);
    // Reuses the exact hand-computed tree from the convergence test above,
    // but the 3rd of 5 probes ("topic:x stars:0..27") now fails instead of
    // returning a count — proving the paid-for top-level probe (5000) and
    // the completed sibling/other branches are NOT discarded (the pre-fix
    // bug: one try/catch around the whole recursion threw all of it away).
    const ghGraphql = fakeGhGraphqlKeyed({
      'topic:x': 5000,
      'topic:x stars:0..707': 1600,
      'topic:x stars:0..27': new EngineError('RATE_LIMITED', 'secondary limit', 403, 9000),
      'topic:x stars:28..707': 700,
      'topic:x stars:>=708': 900,
    });
    const result = await runPlan({ ghGraphql }, cache, { slices: ['topic:x'], probe: true }, '', {
      sleep: recordingSleep().sleep,
    });

    expect(ghGraphql.calls).toHaveLength(5); // all 5 attempted, even past the failure
    expect(result.pointsSpent).toBe(4); // the one failed probe never spent a point

    const slice = result.slices[0];
    expect(slice?.ok).toBe(true);
    expect(slice?.shards).toEqual([
      {
        query: 'topic:x stars:0..27',
        hint: expect.stringContaining('RATE_LIMITED') as unknown as string,
        error: { code: 'RATE_LIMITED', message: 'secondary limit', retryAfterMs: 9000 },
      },
      { query: 'topic:x stars:28..707', count: 700 },
      { query: 'topic:x stars:>=708', count: 900 },
    ]);
    expect(slice?.failures).toEqual([
      {
        query: 'topic:x stars:0..27',
        code: 'RATE_LIMITED',
        message: 'secondary limit',
        retryAfterMs: 9000,
      },
    ]);
    expect(result.queries).toEqual([
      'topic:x stars:0..27',
      'topic:x stars:28..707',
      'topic:x stars:>=708',
    ]);
  });

  test('a RATE_LIMITED retryAfterMs replaces the delay before the next probe', async () => {
    const cache = createCache(dir);
    const ghGraphql = fakeGhGraphqlKeyed({
      'topic:a': 1,
      'topic:b': new EngineError('RATE_LIMITED', 'limited', 403, 9000),
      'topic:c': 1,
    });
    const { waits, sleep } = recordingSleep();
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:a', 'topic:b', 'topic:c'], probe: true },
      '',
      { sleep },
    );
    // 500ms before topic:b (topic:a succeeded normally), then topic:b's own
    // retryAfterMs (9000) REPLACES the default 500ms before topic:c —
    // mirroring batch.ts's RATE_LIMITED handling exactly.
    expect(waits).toEqual([500, 9000]);
    expect(result.slices[0]).toEqual({ slice: 'topic:a', ok: true, count: 1 });
    expect(result.slices[2]).toEqual({ slice: 'topic:c', ok: true, count: 1 });
    expect(result.slices[1]?.failures).toEqual([
      { query: 'topic:b', code: 'RATE_LIMITED', message: 'limited', retryAfterMs: 9000 },
    ]);
  });
});

describe('runPlan — --probe, both dimensions exhausted', () => {
  test('a slice with single-value stars: and created: qualifiers cannot be sharded further', async () => {
    const cache = createCache(dir);
    const slice = 'topic:z stars:100 created:2024-01-05';
    const ghGraphql = fakeGhGraphql(() => 5000);
    const result = await runPlan({ ghGraphql }, cache, { slices: [slice], probe: true }, '', {
      sleep: recordingSleep().sleep,
    });
    const sliceResult = result.slices[0];
    expect(sliceResult?.ok).toBe(true);
    expect(sliceResult?.shards).toEqual([
      {
        query: slice,
        count: 5000,
        hint: expect.stringContaining('both stars: and created:') as unknown as string,
      },
    ]);
    // still surfaced in the batch-ready list, not dropped.
    expect(result.queries).toEqual([slice]);
    expect(ghGraphql.calls).toHaveLength(1); // only the one probe — no split was attempted.
  });
});

describe('runPlan — --probe, --shard created (yearly then monthly)', () => {
  test('an unbounded created: window splits on a yearly boundary', async () => {
    const cache = createCache(dir);
    const now = Date.UTC(2026, 6, 10); // 2026-07-10
    const COUNTS: Record<string, number> = {
      'topic:y': 5000,
      'topic:y created:2008-01-01..2016-12-31': 500,
      'topic:y created:2017-01-01..2026-07-10': 500,
    };
    const ghGraphql = fakeGhGraphql((q) => {
      const count = COUNTS[q];
      if (count === undefined) throw new Error(`unexpected probe query: '${q}'`);
      return count;
    });
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:y'], probe: true, shard: 'created' },
      '',
      { sleep: recordingSleep().sleep, now: () => now },
    );
    expect(result.slices[0]?.shards).toEqual([
      { query: 'topic:y created:2008-01-01..2016-12-31', count: 500 },
      { query: 'topic:y created:2017-01-01..2026-07-10', count: 500 },
    ]);
  });

  test('a sub-year created: window splits on a monthly boundary', async () => {
    const cache = createCache(dir);
    const slice = 'topic:y created:2024-01-01..2024-06-01';
    const COUNTS: Record<string, number> = {
      [slice]: 5000,
      'topic:y created:2024-01-01..2024-02-29': 500,
      'topic:y created:2024-03-01..2024-06-01': 500,
    };
    const ghGraphql = fakeGhGraphql((q) => {
      const count = COUNTS[q];
      if (count === undefined) throw new Error(`unexpected probe query: '${q}'`);
      return count;
    });
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: [slice], probe: true, shard: 'created' },
      '',
      { sleep: recordingSleep().sleep },
    );
    expect(result.slices[0]?.shards).toEqual([
      { query: 'topic:y created:2024-01-01..2024-02-29', count: 500 },
      { query: 'topic:y created:2024-03-01..2024-06-01', count: 500 },
    ]);
  });
});

describe('runPlan — --out writes a batch-compatible queries.txt', () => {
  test('one query per line, a # header comment, batch --dry-run parses it cleanly', async () => {
    const cache = createCache(dir);
    const out = join(dir, 'queries.txt');
    const ghGraphql = fakeGhGraphql(() => 0);
    const result = await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:markdown', 'topic:notes'], out },
      '',
    );
    expect(result.out).toBe(out);
    const contents = readFileSync(out, 'utf-8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines[0]?.startsWith('#')).toBe(true);
    expect(lines.slice(1)).toEqual(['topic:markdown', 'topic:notes']);
  });

  test('acceptance: plan --out then batch --file --dry-run is all-ok, zero network', async () => {
    const cache = createCache(dir);
    const out = join(dir, 'queries.txt');
    const ghGraphql = fakeGhGraphql(() => 0);
    await runPlan(
      { ghGraphql },
      cache,
      { slices: ['topic:markdown stars:>10', 'topic:notes created:>2020-01-01'], out },
      '',
    );
    const batchResult = await runBatch({ ghGraphql: fakeGhGraphql(() => 0) }, cache, {
      file: out,
      dryRun: true,
    });
    expect(batchResult.dryRun).toBe(true);
    expect(batchResult.failed).toBe(0);
    expect(batchResult.succeeded).toBe(2);
  });
});

describe('planOptsFromArgs', () => {
  test('maps positionals, --dry, --probe, --shard, --max-probes, --out', () => {
    const parsed = parseArgs([
      'plan',
      'topic:markdown',
      '-',
      '--dry',
      '--probe',
      '--shard',
      'created',
      '--max-probes',
      '10',
      '--out',
      'queries.txt',
    ]);
    const opts: PlanOpts = planOptsFromArgs(parsed);
    expect(opts.slices).toEqual(['topic:markdown', '-']);
    expect(opts.dry).toBe(true);
    expect(opts.probe).toBe(true);
    expect(opts.shard).toBe('created');
    expect(opts.maxProbes).toBe('10');
    expect(opts.out).toBe('queries.txt');
  });

  test('defaults: no flags, empty slices', () => {
    const parsed = parseArgs(['plan']);
    const opts = planOptsFromArgs(parsed);
    expect(opts.slices).toEqual([]);
    expect(opts.dry).toBe(false);
    expect(opts.probe).toBe(false);
    expect(opts.shard).toBeUndefined();
    expect(opts.maxProbes).toBeUndefined();
    expect(opts.out).toBeUndefined();
  });
});
