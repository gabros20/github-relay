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

function happySources(): DoctorSources {
  return {
    ghRest: {
      get: async () => ({ status: 200, headers: headersWith(), body: {}, etag: null }),
    },
    ghGraphql: { graphql: async <T = unknown>() => ({}) as T },
    ecosystems: { repo: async () => ({}) },
    depsdev: { project: async () => ({}) },
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
      'cacheDir',
      'git',
      'starredAt',
    ]);
    expect(result.summary).toBe('7/7 checks ok');
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
    expect(result.checks.every((c) => c.ok === false)).toBe(true);
    expect(result.summary).toBe('0/7 checks ok');
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
    expect(result.checks).toHaveLength(7);
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
    };
    const result = await runDoctor(sources, cache, { offline: true }, happyDeps());
    const byName = new Map(result.checks.map((c) => [c.name, c]));
    expect(byName.get('graphql')?.skipped).toBe(true);
    expect(byName.get('graphql')?.ok).toBe(true);
    expect(byName.get('ecosystems')?.skipped).toBe(true);
    expect(byName.get('depsdev')?.skipped).toBe(true);
    expect(byName.get('starredAt')?.skipped).toBe(true);
    expect(byName.get('token')?.skipped).toBeUndefined();
    expect(byName.get('token')?.ok).toBe(true);
    expect(byName.get('token')?.detail).toBe('token present');
    expect(byName.get('cacheDir')?.ok).toBe(true);
    expect(byName.get('git')?.ok).toBe(true);
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
