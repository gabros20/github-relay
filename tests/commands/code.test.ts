import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache, loadCorpus } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import {
  type CodeOpts,
  breakerPhase,
  codeOptsFromArgs,
  isBreakerCountable,
  looksLikeNaturalLanguage,
  runCode,
} from '../../src/commands/code.ts';
import type { GrepAppHit } from '../../src/sources/grep-app.ts';
import { EngineError } from '../../src/types.ts';

async function expectEngineError(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (e) {
    return e as EngineError;
  }
  throw new Error('expected the promise to reject');
}

function baseOpts(overrides: Partial<CodeOpts> = {}): CodeOpts {
  return { pattern: 'useState(', lang: [], ...overrides };
}

function hit(overrides: Partial<GrepAppHit> = {}): GrepAppHit {
  return {
    repo: 'octocat/Hello-World',
    path: 'src/index.ts',
    line: 10,
    snippet: 'const x = useState(0);',
    lang: 'TypeScript',
    license: 'MIT',
    url: 'https://github.com/octocat/Hello-World/blob/main/src/index.ts',
    ...overrides,
  };
}

function fakeGrepApp(handler: (params: unknown) => GrepAppHit[] | Promise<GrepAppHit[]>) {
  const calls: unknown[] = [];
  return {
    calls,
    search: async (params: unknown) => {
      calls.push(params);
      return handler(params);
    },
  };
}

function throwingGrepApp(err: EngineError) {
  const calls: unknown[] = [];
  return {
    calls,
    search: async (params: unknown) => {
      calls.push(params);
      throw err;
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-code-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── codeOptsFromArgs ────────────────────────────────────────────────────

describe('codeOptsFromArgs', () => {
  test('joins positionals as the pattern and lifts lang/repo/path/limit/out flags', () => {
    const parsed = parseArgs([
      'code',
      '--lang',
      'TypeScript',
      '--lang',
      'TSX',
      '--repo',
      'facebook/react',
      '--path',
      'src/',
      '--limit',
      '10',
      '--out',
      'corpus.json',
      '--',
      'useState(',
    ]);
    expect(codeOptsFromArgs(parsed)).toEqual({
      pattern: 'useState(',
      lang: ['TypeScript', 'TSX'],
      repo: 'facebook/react',
      path: 'src/',
      limit: '10',
      out: 'corpus.json',
    });
  });

  test('defaults lang to an empty array and leaves repo/path/limit/out undefined', () => {
    expect(codeOptsFromArgs(parseArgs(['code', 'useState(']))).toEqual({
      pattern: 'useState(',
      lang: [],
      repo: undefined,
      path: undefined,
      limit: undefined,
      out: undefined,
    });
  });
});

// ── NL heuristic (task-10 acceptance: ≥4 positive + ≥4 negative, tested both sides) ──

describe('looksLikeNaturalLanguage', () => {
  const nlCases = [
    'how to parse markdown files',
    'what is the best way to test',
    'explain how async functions work please',
    'find me a good react hook library',
    'one two three four five',
  ];
  for (const phrase of nlCases) {
    test(`'${phrase}' is rejected as natural language`, () => {
      expect(looksLikeNaturalLanguage(phrase)).toBe(true);
    });
  }

  const codeCases = [
    'useState(',
    "import React from 'react'",
    'async function',
    '(?s)try {.*await',
    'getServerSession',
    'export default function App', // exactly 4 words — boundary, not > 4
  ];
  for (const pattern of codeCases) {
    test(`'${pattern}' is accepted as a code token/pattern`, () => {
      expect(looksLikeNaturalLanguage(pattern)).toBe(false);
    });
  }
});

// ── pattern validation ──────────────────────────────────────────────────

describe('runCode — pattern validation (no network)', () => {
  test('an empty pattern → INVALID_INPUT, zero search calls', async () => {
    const cache = createCache(dir);
    const grepApp = fakeGrepApp(() => []);
    await expect(runCode({ grepApp }, cache, baseOpts({ pattern: '' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(grepApp.calls).toHaveLength(0);
  });

  test('natural-language input → INVALID_INPUT with the steering hint, zero search calls', async () => {
    const cache = createCache(dir);
    const grepApp = fakeGrepApp(() => []);
    const err = await expectEngineError(
      runCode({ grepApp }, cache, baseOpts({ pattern: 'how to parse markdown files' })),
    );
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(grepApp.calls).toHaveLength(0);
  });

  test('an out-of-range --limit → INVALID_INPUT, zero search calls', async () => {
    const cache = createCache(dir);
    const grepApp = fakeGrepApp(() => []);
    await expect(runCode({ grepApp }, cache, baseOpts({ limit: '0' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(runCode({ grepApp }, cache, baseOpts({ limit: '101' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(runCode({ grepApp }, cache, baseOpts({ limit: 'nope' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(grepApp.calls).toHaveLength(0);
  });
});

// ── filter mapping ──────────────────────────────────────────────────────

describe('runCode — filter mapping', () => {
  test('forwards pattern/lang/repo/path to grepApp.search verbatim', async () => {
    const cache = createCache(dir);
    const grepApp = fakeGrepApp(() => [hit()]);
    await runCode(
      { grepApp },
      cache,
      baseOpts({
        pattern: 'useState(',
        lang: ['TypeScript'],
        repo: 'facebook/react',
        path: 'src/',
      }),
    );
    expect(grepApp.calls).toEqual([
      { query: 'useState(', lang: ['TypeScript'], repo: 'facebook/react', path: 'src/' },
    ]);
  });

  test('an empty lang array is forwarded as undefined, not []', async () => {
    const cache = createCache(dir);
    const grepApp = fakeGrepApp(() => [hit()]);
    await runCode({ grepApp }, cache, baseOpts());
    expect(grepApp.calls).toEqual([
      { query: 'useState(', lang: undefined, repo: undefined, path: undefined },
    ]);
  });
});

// ── output rows + truncation/limit ──────────────────────────────────────

describe('runCode — output rows (no --out)', () => {
  test('emits compact hit rows plus a sorted, deduped distinct-repos footer', async () => {
    const cache = createCache(dir);
    const grepApp = fakeGrepApp(() => [
      hit({ repo: 'b/two', path: 'x.py', line: 1 }),
      hit({ repo: 'a/one', path: 'y.ts', line: 2 }),
      hit({ repo: 'a/one', path: 'z.ts', line: 3 }),
    ]);
    const result = await runCode({ grepApp }, cache, baseOpts());
    expect(result.count).toBe(3);
    expect(result.repos).toEqual(['a/one', 'b/two']);
    expect(result.hits).toEqual([
      {
        repo: 'b/two',
        path: 'x.py',
        line: 1,
        snippet: hit().snippet,
        lang: 'TypeScript',
        license: 'MIT',
      },
      {
        repo: 'a/one',
        path: 'y.ts',
        line: 2,
        snippet: hit().snippet,
        lang: 'TypeScript',
        license: 'MIT',
      },
      {
        repo: 'a/one',
        path: 'z.ts',
        line: 3,
        snippet: hit().snippet,
        lang: 'TypeScript',
        license: 'MIT',
      },
    ]);
  });

  test('--limit truncates the hits (and derived repos) to the first N', async () => {
    const cache = createCache(dir);
    const grepApp = fakeGrepApp(() => [
      hit({ repo: 'a/one' }),
      hit({ repo: 'b/two' }),
      hit({ repo: 'c/three' }),
    ]);
    const result = await runCode({ grepApp }, cache, baseOpts({ limit: '2' }));
    expect(result.count).toBe(2);
    expect(result.repos).toEqual(['a/one', 'b/two']);
  });

  test('default limit is 20 when --limit is omitted', async () => {
    const cache = createCache(dir);
    const hits = Array.from({ length: 30 }, (_, i) => hit({ repo: `r/${i}`, line: i }));
    const grepApp = fakeGrepApp(() => hits);
    const result = await runCode({ grepApp }, cache, baseOpts());
    expect(result.count).toBe(20);
  });
});

// ── corpus merge (--out) ─────────────────────────────────────────────────

describe('runCode — corpus merge (--out)', () => {
  test('merges one minimal source:"code" row per distinct repo, license carried when present', async () => {
    const cache = createCache(dir);
    const out = join(dir, 'corpus.json');
    const grepApp = fakeGrepApp(() => [
      hit({ repo: 'a/one', license: 'MIT' }),
      hit({ repo: 'a/one', license: 'MIT', line: 2 }),
      hit({ repo: 'b/two', license: undefined }),
    ]);
    const result = await runCode({ grepApp }, cache, baseOpts({ out }));

    expect(result.out).toBe(out);
    expect(result.merged).toBe(2);
    expect(result.hits).toBeUndefined();

    const corpus = loadCorpus(out);
    expect(corpus.repos).toHaveLength(2);
    const byName = new Map(corpus.repos.map((r) => [r.full_name, r]));
    expect(byName.get('a/one')).toMatchObject({
      full_name: 'a/one',
      ghid: '',
      source: 'code',
    });
    expect(byName.get('a/one')?.license).toBe('MIT');
    expect(byName.get('b/two')?.license).toBeUndefined();
  });

  test('merging a code hit onto an existing real-ghid row preserves the real ghid', async () => {
    const cache = createCache(dir);
    const out = join(dir, 'corpus.json');
    const seedFetch = fakeGrepApp(() => []);
    // Seed the corpus with a real-ghid row via a direct write, then merge a
    // code-lane hit for the same repo on top.
    const { saveCorpus, createCorpus } = await import('../../src/cache/corpus.ts');
    const seed = createCorpus('seed');
    seed.repos.push({
      full_name: 'octocat/Hello-World',
      ghid: 'R_kgDOA1',
      aliases: [],
      source: 'search',
      signals: {},
      stars: 500,
    });
    saveCorpus(out, seed);
    void seedFetch;

    const grepApp = fakeGrepApp(() => [hit({ repo: 'octocat/Hello-World' })]);
    await runCode({ grepApp }, cache, baseOpts({ out }));

    const corpus = loadCorpus(out);
    const row = corpus.repos.find((r) => r.full_name === 'octocat/Hello-World');
    expect(row?.ghid).toBe('R_kgDOA1');
    expect(row?.source).toBe('code');
    expect(row?.stars).toBe(500); // preserved — code lane never supplies it
  });
});

// ── circuit breaker ──────────────────────────────────────────────────────

describe('breakerPhase / isBreakerCountable (pure)', () => {
  test('closed breaker is always phase "closed"', () => {
    expect(breakerPhase({ breakerState: 'closed', consecutiveFailures: 0 }, 1000)).toBe('closed');
  });

  test('open breaker before retryAt is "blocked"', () => {
    const breaker = {
      breakerState: 'open' as const,
      consecutiveFailures: 2,
      retryAt: new Date(2000).toISOString(),
    };
    expect(breakerPhase(breaker, 1000)).toBe('blocked');
  });

  test('open breaker at/after retryAt is "probe"', () => {
    const breaker = {
      breakerState: 'open' as const,
      consecutiveFailures: 2,
      retryAt: new Date(2000).toISOString(),
    };
    expect(breakerPhase(breaker, 2000)).toBe('probe');
    expect(breakerPhase(breaker, 3000)).toBe('probe');
  });

  test('only RATE_LIMITED and SOURCE_DOWN count toward the breaker', () => {
    expect(isBreakerCountable('RATE_LIMITED')).toBe(true);
    expect(isBreakerCountable('SOURCE_DOWN')).toBe(true);
    expect(isBreakerCountable('INVALID_INPUT')).toBe(false);
    expect(isBreakerCountable('FETCH_FAILED')).toBe(false);
  });
});

describe('runCode — circuit breaker integration', () => {
  test('a single failure stays closed but records the consecutive-failure count', async () => {
    const cache = createCache(dir);
    const grepApp = throwingGrepApp(new EngineError('SOURCE_DOWN', 'grep.app is down (502)'));
    await expect(runCode({ grepApp }, cache, baseOpts())).rejects.toMatchObject({
      code: 'SOURCE_DOWN',
    });
    expect(cache.budget.load().grepApp).toEqual({
      breakerState: 'closed',
      consecutiveFailures: 1,
    });
  });

  test('a second consecutive failure opens the breaker with a retryAt cooldown', async () => {
    const cache = createCache(dir);
    const now = () => Date.parse('2026-07-11T00:00:00.000Z');
    const grepApp = throwingGrepApp(new EngineError('RATE_LIMITED', 'grep.app rate limit (429)'));
    await runCode({ grepApp }, cache, baseOpts(), { now }).catch(() => {});
    await runCode({ grepApp }, cache, baseOpts(), { now }).catch(() => {});

    const breaker = cache.budget.load().grepApp;
    expect(breaker?.breakerState).toBe('open');
    expect(breaker?.consecutiveFailures).toBe(2);
    expect(breaker?.retryAt).toBe('2026-07-11T00:05:00.000Z');
  });

  test('an open breaker within its cooldown short-circuits to SOURCE_DOWN with retryAfterMs, WITHOUT a network call', async () => {
    const cache = createCache(dir);
    cache.budget.updateGrepAppBreaker({
      breakerState: 'open',
      consecutiveFailures: 2,
      retryAt: '2026-07-11T00:05:00.000Z',
    });
    const grepApp = fakeGrepApp(() => [hit()]);
    const now = () => Date.parse('2026-07-11T00:01:00.000Z');

    const err = await expectEngineError(runCode({ grepApp }, cache, baseOpts(), { now }));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('SOURCE_DOWN');
    expect(err.retryAfterMs).toBe(4 * 60 * 1000);
    expect(grepApp.calls).toHaveLength(0); // no network call — recorded per acceptance criteria
  });

  test('a half-open probe (cooldown elapsed) that SUCCEEDS closes the breaker and resets the counter', async () => {
    const cache = createCache(dir);
    cache.budget.updateGrepAppBreaker({
      breakerState: 'open',
      consecutiveFailures: 2,
      retryAt: '2026-07-11T00:05:00.000Z',
    });
    const grepApp = fakeGrepApp(() => [hit()]);
    const now = () => Date.parse('2026-07-11T00:05:00.000Z');

    const result = await runCode({ grepApp }, cache, baseOpts(), { now });
    expect(result.count).toBe(1);
    expect(grepApp.calls).toHaveLength(1); // the probe DID make exactly one network call
    expect(cache.budget.load().grepApp).toEqual({
      breakerState: 'closed',
      consecutiveFailures: 0,
    });
  });

  test('a half-open probe that FAILS reopens the breaker with a fresh cooldown', async () => {
    const cache = createCache(dir);
    cache.budget.updateGrepAppBreaker({
      breakerState: 'open',
      consecutiveFailures: 2,
      retryAt: '2026-07-11T00:05:00.000Z',
    });
    const grepApp = throwingGrepApp(new EngineError('SOURCE_DOWN', 'grep.app is down (503)'));
    const now = () => Date.parse('2026-07-11T00:05:00.000Z');

    await runCode({ grepApp }, cache, baseOpts(), { now }).catch(() => {});
    const breaker = cache.budget.load().grepApp;
    expect(breaker?.breakerState).toBe('open');
    expect(breaker?.consecutiveFailures).toBe(3);
    expect(breaker?.retryAt).toBe('2026-07-11T00:10:00.000Z');
  });

  test('a non-countable error (INVALID_INPUT from a bad regex) never touches the breaker', async () => {
    const cache = createCache(dir);
    const grepApp = throwingGrepApp(new EngineError('INVALID_INPUT', 'grep.app: bad regex'));
    await runCode({ grepApp }, cache, baseOpts()).catch(() => {});
    expect(cache.budget.load().grepApp).toBeUndefined();
  });

  test('breaker state survives across process boundaries: two independent createCache instances on the same temp root agree', async () => {
    const cacheA = createCache(dir);
    const now = () => Date.parse('2026-07-11T00:00:00.000Z');
    const failing = throwingGrepApp(new EngineError('SOURCE_DOWN', 'grep.app is down (502)'));
    await runCode({ grepApp: failing }, cacheA, baseOpts(), { now }).catch(() => {});
    await runCode({ grepApp: failing }, cacheA, baseOpts(), { now }).catch(() => {});
    expect(cacheA.budget.load().grepApp?.breakerState).toBe('open');

    // A brand-new Cache object, same root dir — simulates a fresh CLI process.
    const cacheB = createCache(dir);
    const stillWithinCooldown = () => Date.parse('2026-07-11T00:01:00.000Z');
    const grepAppB = fakeGrepApp(() => [hit()]);
    const err = await expectEngineError(
      runCode({ grepApp: grepAppB }, cacheB, baseOpts(), { now: stillWithinCooldown }),
    );
    expect(err.code).toBe('SOURCE_DOWN');
    expect(grepAppB.calls).toHaveLength(0);
  });
});
