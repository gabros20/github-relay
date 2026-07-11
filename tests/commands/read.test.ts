import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import { type ReadSources, readOptsFromArgs, runRead } from '../../src/commands/read.ts';
import { EngineError } from '../../src/types.ts';

const SHA = 'a'.repeat(40);
const BLOB_SHA = 'b'.repeat(40);
const BLOB_SHA2 = 'c'.repeat(40);

interface RouteResult {
  status: number;
  body: unknown;
  etag?: string | null;
}

function fakeGhRest(
  routes: Record<string, (opts: { etag?: string; raw?: boolean }) => RouteResult>,
): { ghRest: ReadSources['ghRest']; calls: string[] } {
  const calls: string[] = [];
  const ghRest: ReadSources['ghRest'] = {
    get: async (path, opts = {}) => {
      calls.push(path);
      const route = routes[path];
      if (!route) throw new EngineError('NOT_FOUND', `unmapped fetch: ${path}`);
      const r = route(opts);
      if (r.status >= 400) {
        throw new EngineError(
          r.status === 404 ? 'NOT_FOUND' : 'FETCH_FAILED',
          `status ${r.status}`,
          r.status,
        );
      }
      return {
        status: r.status,
        headers: new Headers({ 'x-ratelimit-remaining': '100', 'x-ratelimit-reset': '2000000000' }),
        body: r.body,
        etag: r.etag ?? null,
      };
    },
  };
  return { ghRest, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-read-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readOptsFromArgs', () => {
  test('first positional is repo, the rest are paths; --ref/--max-chars parsed', () => {
    const parsed = parseArgs(['read', 'o/r', 'a.ts', 'b.ts', '--ref', 'main', '--max-chars', '10']);
    expect(readOptsFromArgs(parsed)).toEqual({
      repo: 'o/r',
      paths: ['a.ts', 'b.ts'],
      ref: 'main',
      maxChars: '10',
    });
  });
});

describe('runRead — cached tree', () => {
  function withCachedTree() {
    const cache = createCache(dir);
    cache.trees.put(SHA, [
      { path: 'src/index.ts', sha: BLOB_SHA, size: 20 },
      { path: 'src/utils.ts', sha: BLOB_SHA2, size: 30 },
    ]);
    return cache;
  }

  test('resolves HEAD, fetches an uncached blob via git/blobs, and caches it', async () => {
    const cache = withCachedTree();
    const { ghRest, calls } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/blobs/${BLOB_SHA}`]: () => ({ status: 200, body: 'export {}' }),
    });
    const result = await runRead({ ghRest }, cache, { repo: 'o/r', paths: ['src/index.ts'] });
    expect(calls).toEqual(['/repos/o/r/commits/HEAD', `/repos/o/r/git/blobs/${BLOB_SHA}`]);
    expect(result.results).toEqual([
      { path: 'src/index.ts', ok: true, content: 'export {}', cached: false, sha: BLOB_SHA },
    ]);
    expect(cache.blobs.get(BLOB_SHA)).toBe('export {}');
  });

  test('a blob already in the content-addressed cache is served with zero network', async () => {
    const cache = withCachedTree();
    cache.blobs.put(BLOB_SHA, 'export {}');
    const { ghRest, calls } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
    });
    const result = await runRead({ ghRest }, cache, { repo: 'o/r', paths: ['src/index.ts'] });
    expect(calls).toEqual(['/repos/o/r/commits/HEAD']); // no git/blobs fetch
    expect(result.results[0]).toEqual({
      path: 'src/index.ts',
      ok: true,
      content: 'export {}',
      cached: true,
      sha: BLOB_SHA,
    });
  });

  test('a missing path is expected-absence: ok:true, content:null, with nearest suggestions', async () => {
    const cache = withCachedTree();
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
    });
    const result = await runRead({ ghRest }, cache, { repo: 'o/r', paths: ['src/indx.ts'] });
    const entry = result.results[0];
    expect(entry?.ok).toBe(true);
    expect(entry?.content).toBeNull();
    expect(entry?.reason).toBe('not in tree');
    expect(entry?.nearest).toContain('src/index.ts');
    expect(entry?.nearest?.length).toBeLessThanOrEqual(5);
  });

  test('multiple paths are fetched strictly serialized, in request order', async () => {
    const cache = withCachedTree();
    const { ghRest, calls } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/blobs/${BLOB_SHA}`]: () => ({ status: 200, body: 'a' }),
      [`/repos/o/r/git/blobs/${BLOB_SHA2}`]: () => ({ status: 200, body: 'b' }),
    });
    const result = await runRead({ ghRest }, cache, {
      repo: 'o/r',
      paths: ['src/index.ts', 'src/utils.ts'],
    });
    expect(calls).toEqual([
      '/repos/o/r/commits/HEAD',
      `/repos/o/r/git/blobs/${BLOB_SHA}`,
      `/repos/o/r/git/blobs/${BLOB_SHA2}`,
    ]);
    expect(result.results).toHaveLength(2);
  });

  test('--max-chars truncates content and marks truncated:true', async () => {
    const cache = withCachedTree();
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/blobs/${BLOB_SHA}`]: () => ({ status: 200, body: '0123456789abcdef' }),
    });
    const result = await runRead({ ghRest }, cache, {
      repo: 'o/r',
      paths: ['src/index.ts'],
      maxChars: '5',
    });
    expect(result.results[0]?.content).toBe('01234');
    expect(result.results[0]?.truncated).toBe(true);
  });

  test('--ref as a bare 40-hex sha skips ref resolution entirely', async () => {
    const cache = createCache(dir);
    cache.trees.put(SHA, [{ path: 'a.ts', sha: BLOB_SHA, size: 1 }]);
    const { ghRest, calls } = fakeGhRest({
      [`/repos/o/r/git/blobs/${BLOB_SHA}`]: () => ({ status: 200, body: 'x' }),
    });
    await runRead({ ghRest }, cache, { repo: 'o/r', paths: ['a.ts'], ref: SHA });
    expect(calls).toEqual([`/repos/o/r/git/blobs/${BLOB_SHA}`]);
  });
});

describe('runRead — no cached tree', () => {
  test('falls back to contents/{path} pinned to the resolved sha, decodes base64, and caches the blob', async () => {
    const cache = createCache(dir);
    const b64 = Buffer.from('hello world').toString('base64');
    const { ghRest, calls } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/contents/README.md?ref=${SHA}`]: () => ({
        status: 200,
        body: { content: b64, encoding: 'base64', sha: BLOB_SHA, type: 'file' },
      }),
    });
    const result = await runRead({ ghRest }, cache, { repo: 'o/r', paths: ['README.md'] });
    expect(calls).toEqual(['/repos/o/r/commits/HEAD', `/repos/o/r/contents/README.md?ref=${SHA}`]);
    expect(result.results[0]).toEqual({
      path: 'README.md',
      ok: true,
      content: 'hello world',
      cached: false,
      sha: BLOB_SHA,
    });
    expect(cache.blobs.get(BLOB_SHA)).toBe('hello world');
  });

  test('a NOT_FOUND contents fetch is expected-absence, not a hard error', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/contents/missing.ts?ref=${SHA}`]: () => ({ status: 404, body: null }),
    });
    const result = await runRead({ ghRest }, cache, { repo: 'o/r', paths: ['missing.ts'] });
    expect(result.results[0]).toEqual({
      path: 'missing.ts',
      ok: true,
      content: null,
      reason: 'not in tree',
      nearest: [],
    });
  });

  test('a directory path is a hard error, aborting the whole command', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      // GitHub's real contents endpoint returns a bare ARRAY of entries for a
      // directory, not an object with type:'dir'.
      [`/repos/o/r/contents/src?ref=${SHA}`]: () => ({
        status: 200,
        body: [{ name: 'index.ts', type: 'file' }],
      }),
    });
    const err = (await runRead({ ghRest }, cache, { repo: 'o/r', paths: ['src'] }).catch(
      (e) => e,
    )) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('directory');
  });
});

describe('runRead — multi-path exit rule', () => {
  test('one hard error among many paths aborts the whole command (never a partial success)', async () => {
    const cache = createCache(dir);
    cache.trees.put(SHA, [{ path: 'a.ts', sha: BLOB_SHA, size: 1 }]);
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/blobs/${BLOB_SHA}`]: () => ({ status: 500, body: null }),
    });
    await expect(
      runRead({ ghRest }, cache, { repo: 'o/r', paths: ['a.ts'] }),
    ).rejects.toBeInstanceOf(EngineError);
  });
});

describe('runRead — input validation', () => {
  test('rejects zero paths', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeGhRest({});
    await expect(runRead({ ghRest }, cache, { repo: 'o/r', paths: [] })).rejects.toBeInstanceOf(
      EngineError,
    );
  });
});
