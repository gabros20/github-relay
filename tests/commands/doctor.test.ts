import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import {
  type DoctorDeps,
  type DoctorSources,
  doctorOptsFromArgs,
  runDoctor,
} from '../../src/commands/doctor.ts';
import { EngineError } from '../../src/types.ts';

function headersWith(expiration?: string): Headers {
  const h = new Headers();
  if (expiration) h.set('github-authentication-token-expiration', expiration);
  return h;
}

// The starredAt probe is now data-inspecting (task 11), so the happy GraphQL
// fake must return a real starredAt sample, not a bare {}. The other graphql
// check ignores the return value, so one shape serves both.
const STARRED_AT_OK = {
  repository: { stargazers: { edges: [{ starredAt: '2020-01-01T00:00:00Z' }] } },
};

function happySources(): DoctorSources {
  return {
    ghRest: {
      get: async () => ({ status: 200, headers: headersWith(), body: {}, etag: null }),
    },
    ghGraphql: { graphql: async <T = unknown>() => STARRED_AT_OK as T },
    ecosystems: { repo: async () => ({}) },
    depsdev: { project: async () => ({}) },
    grepApp: { search: async () => [] },
    clickhouse: { monthlyEvents: async () => [] },
  };
}

const happyDeps = (): DoctorDeps => ({
  exec: async () => ({ stdout: 'git version 2.44.0', exitCode: 0 }),
  resolveToken: async () => 'gh_test_token',
  now: () => Date.parse('2026-07-11T00:00:00Z'),
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-doctor-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('doctorOptsFromArgs', () => {
  test('parses --offline', () => {
    expect(doctorOptsFromArgs(parseArgs(['doctor', '--offline']))).toEqual({ offline: true });
  });
  test('defaults offline to false', () => {
    expect(doctorOptsFromArgs(parseArgs(['doctor']))).toEqual({ offline: false });
  });
});

describe('runDoctor — always ok:true (the x-relay DNA contract)', () => {
  test('every check succeeding → healthy:true, ok checks throughout', async () => {
    const cache = createCache(dir);
    const result = await runDoctor(happySources(), cache, {}, happyDeps());
    expect(result.healthy).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      'token',
      'graphql',
      'ecosystems',
      'depsdev',
      'clickhouse',
      'grepApp',
      'cacheDir',
      'git',
      'starredAt',
      'grepAppBreaker',
    ]);
    expect(result.summary).toBe('10/10 checks ok');
  });

  test('EVERY check failing still returns ok:true at the envelope level — healthy:false, never throws', async () => {
    const failingSources: DoctorSources = {
      ghRest: {
        get: async () => {
          throw new EngineError('AUTH_FAILED', 'bad token');
        },
      },
      ghGraphql: {
        graphql: async () => {
          throw new EngineError('SOURCE_DOWN', 'graphql down');
        },
      },
      ecosystems: {
        repo: async () => {
          throw new EngineError('SOURCE_DOWN', 'ecosyste.ms down');
        },
      },
      depsdev: {
        project: async () => {
          throw new EngineError('SOURCE_DOWN', 'deps.dev down');
        },
      },
      grepApp: {
        search: async () => {
          throw new EngineError('SOURCE_DOWN', 'grep.app down');
        },
      },
      clickhouse: {
        monthlyEvents: async () => {
          throw new EngineError('SOURCE_DOWN', 'clickhouse down');
        },
      },
    };
    const deps: DoctorDeps = {
      exec: async () => ({ stdout: '', exitCode: 1 }),
      resolveToken: async () => {
        throw new EngineError('AUTH_FAILED', 'no token');
      },
      // Point the cache root at a file (not a dir) so the writability probe fails too.
    };
    // Force the cacheDir check to fail by pointing the cache root at a path
    // that can never be created (a file already occupies a parent segment).
    const blockerFile = join(dir, 'blocker');
    await Bun.write(blockerFile, 'x');
    const brokenCache = createCache(join(blockerFile, 'nested'));

    const result = await runDoctor(failingSources, brokenCache, {}, deps);
    expect(result.healthy).toBe(false);
    // grepAppBreaker is a purely local, always-succeeds informational row
    // (design: reading persisted breaker state back is never itself a
    // failure — the "failing check = data" contract, same as everything
    // else in doctor) — every OTHER check genuinely fails here.
    const other = result.checks.filter((c) => c.name !== 'grepAppBreaker');
    expect(other.every((c) => c.ok === false)).toBe(true);
    expect(result.checks.find((c) => c.name === 'grepAppBreaker')?.ok).toBe(true);
    expect(result.summary).toBe('1/10 checks ok');
  });

  test('a single failing check does not abort the rest — later checks still run and can pass', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    sources.ghGraphql = {
      graphql: async () => {
        throw new EngineError('SOURCE_DOWN', 'graphql down');
      },
    };
    const result = await runDoctor(sources, cache, {}, happyDeps());
    const byName = new Map(result.checks.map((c) => [c.name, c]));
    expect(byName.get('graphql')?.ok).toBe(false);
    expect(byName.get('starredAt')?.ok).toBe(false); // also graphql-based
    expect(byName.get('ecosystems')?.ok).toBe(true);
    expect(byName.get('cacheDir')?.ok).toBe(true);
    expect(byName.get('git')?.ok).toBe(true);
    expect(result.healthy).toBe(false);
  });
});

describe('runDoctor — per-check timeout', () => {
  test('a never-resolving check is marked failed by the race; the run still completes', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    sources.ghGraphql = { graphql: () => new Promise(() => {}) }; // never resolves
    const result = await runDoctor(sources, cache, {}, { ...happyDeps(), timeoutMs: 20 });
    const byName = new Map(result.checks.map((c) => [c.name, c]));
    expect(byName.get('graphql')?.ok).toBe(false);
    expect(byName.get('graphql')?.detail).toContain('timed out');
    // Every other check still ran to completion.
    expect(result.checks).toHaveLength(10);
  });
});

describe('runDoctor — --offline', () => {
  test('skips network checks (marked skipped, not failed) but still checks cacheDir/git/token-presence', async () => {
    const cache = createCache(dir);
    // Sources with network calls that would throw if ever invoked, proving
    // offline mode never touches them.
    const sources: DoctorSources = {
      ghRest: {
        get: async () => {
          throw new Error('must not be called offline');
        },
      },
      ghGraphql: {
        graphql: async () => {
          throw new Error('must not be called offline');
        },
      },
      ecosystems: {
        repo: async () => {
          throw new Error('must not be called offline');
        },
      },
      depsdev: {
        project: async () => {
          throw new Error('must not be called offline');
        },
      },
      grepApp: {
        search: async () => {
          throw new Error('must not be called offline');
        },
      },
      clickhouse: {
        monthlyEvents: async () => {
          throw new Error('must not be called offline');
        },
      },
    };
    const result = await runDoctor(sources, cache, { offline: true }, happyDeps());
    const byName = new Map(result.checks.map((c) => [c.name, c]));
    expect(byName.get('graphql')?.skipped).toBe(true);
    expect(byName.get('graphql')?.ok).toBe(true);
    expect(byName.get('ecosystems')?.skipped).toBe(true);
    expect(byName.get('depsdev')?.skipped).toBe(true);
    expect(byName.get('clickhouse')?.skipped).toBe(true);
    expect(byName.get('grepApp')?.skipped).toBe(true);
    expect(byName.get('starredAt')?.skipped).toBe(true);
    expect(byName.get('token')?.skipped).toBeUndefined();
    expect(byName.get('token')?.ok).toBe(true);
    expect(byName.get('token')?.detail).toBe('token present');
    expect(byName.get('cacheDir')?.ok).toBe(true);
    expect(byName.get('git')?.ok).toBe(true);
    // grepAppBreaker is local (reads cache.budget), not a network check — it
    // still runs, and still passes, even --offline.
    expect(byName.get('grepAppBreaker')?.skipped).toBeUndefined();
    expect(byName.get('grepAppBreaker')?.ok).toBe(true);
    expect(result.healthy).toBe(true);
  });

  test('--offline token presence check still fails loud when no token resolves at all', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    const deps: DoctorDeps = {
      ...happyDeps(),
      resolveToken: async () => {
        throw new EngineError('AUTH_FAILED', 'no GitHub token found');
      },
    };
    const result = await runDoctor(sources, cache, { offline: true }, deps);
    const token = result.checks.find((c) => c.name === 'token');
    expect(token?.ok).toBe(false);
    expect(token?.detail).toContain('no GitHub token found');
    expect(result.healthy).toBe(false);
  });
});

describe('runDoctor — token expiry warning surfaces (PLAN Decisions §4)', () => {
  test('a token expiring within 7 days shows the warning as the check detail, still ok:true', async () => {
    const cache = createCache(dir);
    const now = Date.parse('2026-07-11T00:00:00Z');
    const soon = `${new Date(now + 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19)} UTC`;
    const sources: DoctorSources = {
      ...happySources(),
      ghRest: {
        get: async () => ({
          status: 200,
          headers: headersWith(soon),
          body: {},
          etag: null,
        }),
      },
    };
    const result = await runDoctor(sources, cache, {}, { ...happyDeps(), now: () => now });
    const token = result.checks.find((c) => c.name === 'token');
    expect(token?.ok).toBe(true);
    expect(token?.detail).toContain('expires in');
  });

  test('a non-expiring token (no header) reports "token valid"', async () => {
    const cache = createCache(dir);
    const result = await runDoctor(happySources(), cache, {}, happyDeps());
    const token = result.checks.find((c) => c.name === 'token');
    expect(token?.detail).toBe('token valid');
  });
});

describe('runDoctor — third-party reachability semantics', () => {
  test('a NOT_FOUND from ecosystems/depsdev still counts as reachable (the service answered)', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    sources.ecosystems = {
      repo: async () => {
        throw new EngineError('NOT_FOUND', 'no such repo');
      },
    };
    sources.depsdev = {
      project: async () => {
        throw new EngineError('NOT_FOUND', 'no such project');
      },
    };
    const result = await runDoctor(sources, cache, {}, happyDeps());
    const byName = new Map(result.checks.map((c) => [c.name, c]));
    expect(byName.get('ecosystems')?.ok).toBe(true);
    expect(byName.get('depsdev')?.ok).toBe(true);
    expect(result.healthy).toBe(true);
  });

  test('SOURCE_DOWN from ecosystems/depsdev fails the check (the service is actually down)', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    sources.ecosystems = {
      repo: async () => {
        throw new EngineError('SOURCE_DOWN', 'ecosyste.ms unreachable');
      },
    };
    const result = await runDoctor(sources, cache, {}, happyDeps());
    const ecosystems = result.checks.find((c) => c.name === 'ecosystems');
    expect(ecosystems?.ok).toBe(false);
    expect(ecosystems?.detail).toContain('unreachable');
  });

  test('ClickHouse reachable (zero rows still counts) passes; SOURCE_DOWN fails only it', async () => {
    const cache = createCache(dir);
    const okSources = happySources();
    expect(
      (await runDoctor(okSources, cache, {}, happyDeps())).checks.find(
        (c) => c.name === 'clickhouse',
      )?.ok,
    ).toBe(true);
    const downSources = happySources();
    downSources.clickhouse = {
      monthlyEvents: async () => {
        throw new EngineError('SOURCE_DOWN', 'ClickHouse playground unreachable');
      },
    };
    const result = await runDoctor(downSources, cache, {}, happyDeps());
    const ch = result.checks.find((c) => c.name === 'clickhouse');
    expect(ch?.ok).toBe(false);
    expect(ch?.detail).toContain('unreachable');
    expect(result.checks.filter((c) => c.name !== 'clickhouse').every((c) => c.ok)).toBe(true);
  });

  test('grep.app reachable (zero hits still counts) passes the check', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    sources.grepApp = { search: async () => [] };
    const result = await runDoctor(sources, cache, {}, happyDeps());
    expect(result.checks.find((c) => c.name === 'grepApp')?.ok).toBe(true);
  });

  test('grep.app SOURCE_DOWN fails only the grepApp check', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    sources.grepApp = {
      search: async () => {
        throw new EngineError('SOURCE_DOWN', 'grep.app unreachable');
      },
    };
    const result = await runDoctor(sources, cache, {}, happyDeps());
    const grepApp = result.checks.find((c) => c.name === 'grepApp');
    expect(grepApp?.ok).toBe(false);
    expect(grepApp?.detail).toContain('unreachable');
    expect(result.healthy).toBe(false);
    const other = result.checks.filter((c) => c.name !== 'grepApp');
    expect(other.every((c) => c.ok)).toBe(true);
  });
});

describe('runDoctor — grepAppBreaker (local, always runs, informational)', () => {
  test('no breaker state persisted yet reports "closed (never tripped)"', async () => {
    const cache = createCache(dir);
    const result = await runDoctor(happySources(), cache, {}, happyDeps());
    const row = result.checks.find((c) => c.name === 'grepAppBreaker');
    expect(row?.ok).toBe(true);
    expect(row?.detail).toBe('closed (never tripped)');
  });

  test('an open breaker with a retryAt is reported verbatim, still ok:true', async () => {
    const cache = createCache(dir);
    cache.budget.updateGrepAppBreaker({
      breakerState: 'open',
      consecutiveFailures: 2,
      retryAt: '2026-07-11T00:05:00.000Z',
    });
    const result = await runDoctor(happySources(), cache, {}, happyDeps());
    const row = result.checks.find((c) => c.name === 'grepAppBreaker');
    expect(row?.ok).toBe(true);
    expect(row?.detail).toBe('open (2 consecutive failures, retry at 2026-07-11T00:05:00.000Z)');
  });

  test('reading breaker state back is not itself a network check — it still runs and passes --offline', async () => {
    const cache = createCache(dir);
    cache.budget.updateGrepAppBreaker({ breakerState: 'closed', consecutiveFailures: 1 });
    const result = await runDoctor(happySources(), cache, { offline: true }, happyDeps());
    const row = result.checks.find((c) => c.name === 'grepAppBreaker');
    expect(row?.skipped).toBeUndefined();
    expect(row?.detail).toBe('closed (1 consecutive failures)');
  });
});

describe('runDoctor — hardened starredAt probe (task 11: the partial-error/null shape)', () => {
  test('a 200 with a null stargazers connection reads as restricted, not available', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    sources.ghGraphql = {
      graphql: async <T = unknown>() => ({ repository: { stargazers: null } }) as T,
    };
    const result = await runDoctor(sources, cache, {}, happyDeps());
    const starredAt = result.checks.find((c) => c.name === 'starredAt');
    expect(starredAt?.ok).toBe(false);
    expect(starredAt?.detail).toContain('restricted');
  });

  test('present edges carrying null starredAt values also read as restricted', async () => {
    const cache = createCache(dir);
    const sources = happySources();
    sources.ghGraphql = {
      graphql: async <T = unknown>() =>
        ({ repository: { stargazers: { edges: [{ starredAt: null }] } } }) as T,
    };
    const result = await runDoctor(sources, cache, {}, happyDeps());
    expect(result.checks.find((c) => c.name === 'starredAt')?.ok).toBe(false);
  });
});

describe('runDoctor — git binary presence', () => {
  test('a missing git binary (nonzero exit) fails only the git check', async () => {
    const cache = createCache(dir);
    const deps: DoctorDeps = { ...happyDeps(), exec: async () => ({ stdout: '', exitCode: 127 }) };
    const result = await runDoctor(happySources(), cache, {}, deps);
    const git = result.checks.find((c) => c.name === 'git');
    expect(git?.ok).toBe(false);
    expect(result.healthy).toBe(false);
    const other = result.checks.filter((c) => c.name !== 'git');
    expect(other.every((c) => c.ok)).toBe(true);
  });
});

describe('runDoctor — a timed-out git check kills its child (task 8b fix wave 2)', () => {
  // Pre-fix, doctor's timeout raced the exec promise but never cancelled the
  // underlying work — a hung `git` process kept running after the timeout
  // was already reported. This fakes a hung exec that only ever settles on
  // abort, and asserts the check's own AbortSignal is actually the one that
  // gets aborted when the timeout fires.
  test('the git check timing out aborts the AbortSignal passed to exec', async () => {
    const cache = createCache(dir);
    let capturedSignal: AbortSignal | undefined;
    const deps: DoctorDeps = {
      ...happyDeps(),
      timeoutMs: 20,
      exec: (_cmd, opts) =>
        new Promise((_resolve, reject) => {
          capturedSignal = opts?.signal;
          opts?.signal?.addEventListener('abort', () => reject(new Error('killed on abort')));
          // Deliberately never resolves on its own — simulates a hung `git` process.
        }),
    };
    const result = await runDoctor(happySources(), cache, {}, deps);
    const git = result.checks.find((c) => c.name === 'git');
    expect(git?.ok).toBe(false);
    expect(git?.detail).toContain('timed out');
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
