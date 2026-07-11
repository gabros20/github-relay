import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorpus, loadCorpus, saveCorpus } from '../../src/cache/corpus.ts';
import { createCache } from '../../src/cache/index.ts';
import { hasMarker } from '../../src/cache/marker.ts';

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
    const sha = 'a'.repeat(40);
    const cache = createCache(dir);
    expect(cache.blobs.has(sha)).toBe(false);
    cache.blobs.put(sha, 'content');
    expect(cache.blobs.has(sha)).toBe(true);
    expect(cache.blobs.get(sha)).toBe('content');
  });

  test('trees: put/get round-trip', () => {
    const commitSha = 'b'.repeat(40);
    const cache = createCache(dir);
    cache.trees.put(commitSha, [{ path: 'a.ts', sha: 'c'.repeat(40), size: 10 }]);
    expect(cache.trees.get(commitSha)).toEqual([{ path: 'a.ts', sha: 'c'.repeat(40), size: 10 }]);
  });

  test('tarballs: put/get/has round-trip', () => {
    const commitSha = 'd'.repeat(40);
    const cache = createCache(dir);
    cache.tarballs.put(commitSha, '/tmp/somefile.tar.gz', () => 1000);
    expect(cache.tarballs.has(commitSha)).toBe(true);
    expect(cache.tarballs.get(commitSha)?.path).toBe('/tmp/somefile.tar.gz');
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

describe('createCache — every store write stamps the ownership marker (fix wave 1)', () => {
  test('a fresh root has no marker before any store write', () => {
    createCache(dir);
    expect(hasMarker(dir)).toBe(false);
  });

  test('blobs.put stamps the marker', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'content');
    expect(hasMarker(dir)).toBe(true);
  });

  test('trees.put stamps the marker', () => {
    const cache = createCache(dir);
    cache.trees.put('b'.repeat(40), []);
    expect(hasMarker(dir)).toBe(true);
  });

  test('tarballs.put stamps the marker', () => {
    const cache = createCache(dir);
    cache.tarballs.put('c'.repeat(40), '/tmp/x.tar.gz');
    expect(hasMarker(dir)).toBe(true);
  });

  test('budget.updatePool stamps the marker', () => {
    const cache = createCache(dir);
    cache.budget.updatePool('restCore', { remaining: 1, resetAt: '2026-01-01T00:00:00Z' });
    expect(hasMarker(dir)).toBe(true);
  });

  test('budget.save stamps the marker', () => {
    const cache = createCache(dir);
    cache.budget.save({ learnedCeilings: {} });
    expect(hasMarker(dir)).toBe(true);
  });

  test('budget.updateLearnedCeiling stamps the marker', () => {
    const cache = createCache(dir);
    cache.budget.updateLearnedCeiling('heavy', {
      size: 25,
      observedAt: '2026-07-11T00:00:00.000Z',
    });
    expect(hasMarker(dir)).toBe(true);
  });

  test('budget.updateGrepAppBreaker stamps the marker', () => {
    const cache = createCache(dir);
    cache.budget.updateGrepAppBreaker({ breakerState: 'closed', consecutiveFailures: 0 });
    expect(hasMarker(dir)).toBe(true);
  });

  test('etags.set stamps the marker', () => {
    const cache = createCache(dir);
    cache.etags.set('https://api.github.com/x', 'W/"1"', 'body');
    expect(hasMarker(dir)).toBe(true);
  });

  test('a read-only call (get/has/load) never stamps the marker on its own', () => {
    const cache = createCache(dir);
    cache.blobs.has('a'.repeat(40));
    cache.blobs.get('a'.repeat(40));
    cache.budget.load();
    cache.etags.get('https://api.github.com/x');
    expect(hasMarker(dir)).toBe(false);
  });
});
