import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorpus, loadCorpus, saveCorpus } from '../../src/cache/corpus.ts';
import { createCache } from '../../src/cache/index.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-cache-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createCache — root resolution', () => {
  test('an explicit rootOverride wins over GHRELAY_CACHE_DIR', () => {
    process.env.GHRELAY_CACHE_DIR = join(dir, 'env-dir');
    const cache = createCache(join(dir, 'explicit-dir'));
    expect(cache.paths.root).toBe(join(dir, 'explicit-dir'));
    process.env.GHRELAY_CACHE_DIR = undefined;
  });

  test('never touches a real ~/.ghrelay — every subpath lives under the tmp root', () => {
    const cache = createCache(dir);
    expect(cache.paths.blobsDir.startsWith(dir)).toBe(true);
    expect(cache.paths.treesDir.startsWith(dir)).toBe(true);
    expect(cache.paths.tarballsDir.startsWith(dir)).toBe(true);
    expect(cache.paths.budgetFile.startsWith(dir)).toBe(true);
    expect(cache.paths.etagsFile.startsWith(dir)).toBe(true);
  });
});

describe('createCache — wires every store to the resolved root', () => {
  test('blobs: put/get/has round-trip under the resolved root', () => {
    const cache = createCache(dir);
    expect(cache.blobs.has('sha1')).toBe(false);
    cache.blobs.put('sha1', 'content');
    expect(cache.blobs.has('sha1')).toBe(true);
    expect(cache.blobs.get('sha1')).toBe('content');
  });

  test('trees: put/get round-trip', () => {
    const cache = createCache(dir);
    cache.trees.put('commit1', [{ path: 'a.ts', sha: 's1', size: 10 }]);
    expect(cache.trees.get('commit1')).toEqual([{ path: 'a.ts', sha: 's1', size: 10 }]);
  });

  test('tarballs: put/get/has round-trip', () => {
    const cache = createCache(dir);
    cache.tarballs.put('commit1', '/tmp/somefile.tar.gz', () => 1000);
    expect(cache.tarballs.has('commit1')).toBe(true);
    expect(cache.tarballs.get('commit1')?.path).toBe('/tmp/somefile.tar.gz');
  });

  test('budget: updatePool + load round-trip', () => {
    const cache = createCache(dir);
    cache.budget.updatePool('restCore', { remaining: 100, resetAt: '2026-07-10T00:00:00.000Z' });
    expect(cache.budget.load().restCore?.remaining).toBe(100);
  });

  test('budget: updatePool accepts graphqlPoints with lastCost through the facade', () => {
    const cache = createCache(dir);
    cache.budget.updatePool('graphqlPoints', {
      remaining: 4950,
      resetAt: '2026-07-10T01:00:00.000Z',
      lastCost: 2,
    });
    expect(cache.budget.load().graphqlPoints).toEqual({
      remaining: 4950,
      resetAt: '2026-07-10T01:00:00.000Z',
      lastCost: 2,
    });
  });

  test('etags: set/get + body retrieval round-trip', () => {
    const cache = createCache(dir);
    const record = cache.etags.set('https://api.github.com/x', 'W/"1"', 'body-text');
    expect(cache.etags.get('https://api.github.com/x')).toEqual(record);
    expect(cache.etags.getBody(record.bodyHash)).toBe('body-text');
  });

  test('corpus functions take explicit paths, independent of the cache root', () => {
    const corpusPath = join(dir, 'anywhere', 'my-corpus.json');
    saveCorpus(corpusPath, createCorpus('intent'));
    expect(loadCorpus(corpusPath).intent).toBe('intent');
  });
});
