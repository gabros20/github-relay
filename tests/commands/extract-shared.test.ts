import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '../../src/cache/index.ts';
import { parseOwnerRepo, resolveRefSha } from '../../src/commands/extract-shared.ts';
import type { GhRest } from '../../src/sources/gh-rest.ts';
import { EngineError } from '../../src/types.ts';

describe('parseOwnerRepo', () => {
  test('splits a valid owner/repo', () => {
    expect(parseOwnerRepo('facebook/react')).toEqual({ owner: 'facebook', repo: 'react' });
  });
  test('rejects missing input', () => {
    expect(() => parseOwnerRepo(undefined)).toThrow(EngineError);
  });
  test('rejects a bare name with no slash', () => {
    expect(() => parseOwnerRepo('react')).toThrow(EngineError);
  });
  test('rejects extra path segments', () => {
    expect(() => parseOwnerRepo('facebook/react/extra')).toThrow(EngineError);
  });
});

function fakeGhRest(
  handler: (path: string, opts: { etag?: string }) => {
    status: number;
    body: unknown;
    etag: string | null;
  },
): { ghRest: Pick<GhRest, 'get'>; calls: string[] } {
  const calls: string[] = [];
  const ghRest: Pick<GhRest, 'get'> = {
    get: async (path, opts = {}) => {
      calls.push(path);
      const r = handler(path, opts);
      return { status: r.status, headers: new Headers(), body: r.body, etag: r.etag };
    },
  };
  return { ghRest, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-extract-shared-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function freshCache() {
  return createCache(dir);
}

describe('resolveRefSha', () => {
  test('resolves HEAD by default via commits/HEAD and ETag-caches the result', async () => {
    const cache = freshCache();
    const { ghRest, calls } = fakeGhRest(() => ({
      status: 200,
      body: { sha: 'a'.repeat(40) },
      etag: '"v1"',
    }));
    const result = await resolveRefSha(ghRest, cache, 'o', 'r');
    expect(result.sha).toBe('a'.repeat(40));
    expect(result.cached).toBe(false);
    expect(calls).toEqual(['/repos/o/r/commits/HEAD']);
  });

  test('resolves a non-HEAD ref against commits/{ref}', async () => {
    const cache = freshCache();
    const { ghRest, calls } = fakeGhRest(() => ({
      status: 200,
      body: { sha: 'b'.repeat(40) },
      etag: '"v1"',
    }));
    const result = await resolveRefSha(ghRest, cache, 'o', 'r', 'v1.2.3');
    expect(result.sha).toBe('b'.repeat(40));
    expect(calls).toEqual(['/repos/o/r/commits/v1.2.3']);
  });

  test('a second call with an unchanged ref gets a 304 and reuses the cached sha (zero-quota revalidation)', async () => {
    const cache = freshCache();
    let hits = 0;
    const { ghRest, calls } = fakeGhRest((_path, opts) => {
      hits++;
      if (opts.etag === '"v1"') return { status: 304, body: null, etag: '"v1"' };
      return { status: 200, body: { sha: 'c'.repeat(40) }, etag: '"v1"' };
    });
    const first = await resolveRefSha(ghRest, cache, 'o', 'r');
    expect(first.sha).toBe('c'.repeat(40));
    expect(first.cached).toBe(false);

    const second = await resolveRefSha(ghRest, cache, 'o', 'r');
    expect(second.sha).toBe('c'.repeat(40));
    expect(second.cached).toBe(true);
    expect(hits).toBe(2);
    expect(calls).toEqual(['/repos/o/r/commits/HEAD', '/repos/o/r/commits/HEAD']);
  });

  test('a 200 response with no sha field fails loud', async () => {
    const cache = freshCache();
    const { ghRest } = fakeGhRest(() => ({ status: 200, body: {}, etag: null }));
    await expect(resolveRefSha(ghRest, cache, 'o', 'r')).rejects.toBeInstanceOf(EngineError);
  });

  test('a 304 with no prior cached body fails loud rather than fabricating a sha', async () => {
    const cache = freshCache();
    const { ghRest } = fakeGhRest(() => ({ status: 304, body: null, etag: '"v1"' }));
    await expect(resolveRefSha(ghRest, cache, 'o', 'r')).rejects.toBeInstanceOf(EngineError);
  });
});
