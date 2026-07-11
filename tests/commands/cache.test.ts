import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '../../src/cache/index.ts';
import { MARKER_FILENAME, hasMarker } from '../../src/cache/marker.ts';
import { parseArgs } from '../../src/cli.ts';
import {
  type CacheClearResult,
  type CacheGcResult,
  type CacheStatsResult,
  cacheOptsFromArgs,
  runCache,
} from '../../src/commands/cache.ts';
import { EngineError } from '../../src/types.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-cache-cmd-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cacheOptsFromArgs', () => {
  test('parses subcommand, --older-than, --confirm', () => {
    const parsed = parseArgs(['cache', 'gc', '--older-than', '12h', '--confirm']);
    expect(cacheOptsFromArgs(parsed)).toEqual({
      subcommand: 'gc',
      olderThan: '12h',
      confirm: true,
    });
  });

  test('defaults confirm to false, olderThan to undefined', () => {
    expect(cacheOptsFromArgs(parseArgs(['cache', 'stats']))).toEqual({
      subcommand: 'stats',
      olderThan: undefined,
      confirm: false,
    });
  });
});

describe('runCache — unknown subcommand', () => {
  test('anything other than stats|clear|gc is INVALID_INPUT', () => {
    const cache = createCache(dir);
    expect(() => runCache(cache, { subcommand: 'wat' })).toThrow(EngineError);
    expect(() => runCache(cache, {})).toThrow(EngineError);
  });
});

describe('runCache — cache-root ownership guard (fix wave 1: GHRELAY_CACHE_DIR misconfiguration)', () => {
  test('clear against an unmarked, unrecognizable root refuses with INVALID_INPUT and touches nothing', () => {
    const cache = createCache(dir);
    writeFileSync(join(dir, 'unrelated.txt'), 'not ours');
    let thrown: unknown;
    try {
      runCache(cache, { subcommand: 'clear', confirm: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EngineError);
    expect((thrown as EngineError).code).toBe('INVALID_INPUT');
    expect(existsSync(join(dir, 'unrelated.txt'))).toBe(true);
    expect(hasMarker(dir)).toBe(false);
  });

  test('gc against an unmarked, unrecognizable root refuses with INVALID_INPUT', () => {
    const cache = createCache(dir);
    expect(() => runCache(cache, { subcommand: 'gc' })).toThrow(EngineError);
    try {
      runCache(cache, { subcommand: 'gc' });
    } catch (e) {
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
  });

  test('the reviewer repro: GHRELAY_CACHE_DIR pointed at a real, unrelated directory with folders named blobs/trees/corpora — clear --confirm must NOT delete their contents', () => {
    const cache = createCache(dir);
    const blobsLike = join(dir, 'blobs');
    const treesLike = join(dir, 'trees');
    const corporaLike = join(dir, 'corpora');
    for (const d of [blobsLike, treesLike, corporaLike]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(blobsLike, 'family-photo.png'), 'binary-ish');
    writeFileSync(join(treesLike, 'genealogy.txt'), 'grandpa');
    writeFileSync(join(corporaLike, 'quarterly-report.md'), '# Q3 numbers');

    let thrown: unknown;
    try {
      runCache(cache, { subcommand: 'clear', confirm: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EngineError);
    expect((thrown as EngineError).code).toBe('INVALID_INPUT');
    expect(existsSync(join(blobsLike, 'family-photo.png'))).toBe(true);
    expect(existsSync(join(treesLike, 'genealogy.txt'))).toBe(true);
    expect(existsSync(join(corporaLike, 'quarterly-report.md'))).toBe(true);
  });

  test('clear against a marked root (a real prior cache-layer write) succeeds normally', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'x');
    const result = runCache(cache, { subcommand: 'clear', confirm: true }) as CacheClearResult;
    expect(result.cleared).toContain('blobs');
  });

  test('gc against a marked root succeeds normally', () => {
    const cache = createCache(dir);
    cache.etags.set('https://api.github.com/x', '"e1"', 'body');
    const result = runCache(cache, { subcommand: 'gc' }) as CacheGcResult;
    expect(result.etagsPruned).toBe(0);
  });

  test('one-time adoption: a pre-marker-era root (has our budget.json shape but no marker file) is recognized and clear/gc proceed, stamping the marker', () => {
    const cache = createCache(dir);
    // Simulate a root populated by a github-relay version that predates this
    // guard: our own budget.json shape exists, but no .ghrelay marker yet —
    // NOT written through cache.budget (which would already stamp it).
    writeFileSync(cache.paths.budgetFile, '{"learnedCeilings":{}}');
    expect(hasMarker(dir)).toBe(false);

    const result = runCache(cache, { subcommand: 'gc' }) as CacheGcResult;
    expect(result.etagsPruned).toBe(0);
    expect(hasMarker(dir)).toBe(true); // adopted
  });

  test('stats never refuses and never adopts/writes the marker for a markerless root — it stays read-only', () => {
    const cache = createCache(dir);
    writeFileSync(join(dir, 'unrelated.txt'), 'not ours');
    expect(() => runCache(cache, { subcommand: 'stats' })).not.toThrow();
    expect(hasMarker(dir)).toBe(false);
  });

  test('the marker file itself never shows up in blobs/etags/trees/tarballs stats counts', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'x'); // also stamps MARKER_FILENAME at the root, not inside blobsDir
    expect(existsSync(join(dir, MARKER_FILENAME))).toBe(true);
    const stats = runCache(cache, { subcommand: 'stats' }) as CacheStatsResult;
    expect(stats.blobs.count).toBe(1);
  });
});

describe('runCache stats', () => {
  test('reports counts + bytes per store on an empty cache', () => {
    const cache = createCache(dir);
    const result = runCache(cache, { subcommand: 'stats' }) as CacheStatsResult;
    expect(result.root).toBe(dir);
    expect(result.etags).toEqual({ count: 0, bytes: 0 });
    expect(result.blobs).toEqual({ count: 0, bytes: 0 });
    expect(result.trees).toEqual({ count: 0, bytes: 0 });
    expect(result.tarballs).toEqual({ count: 0, bytes: 0 });
  });

  test('counts populated stores, and blobs counts BOTH 40-hex git blobs and 64-hex etag bodies together', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'git blob content');
    cache.blobs.put('b'.repeat(64), 'etag body content');
    cache.etags.set('https://api.github.com/x', '"e1"', 'etag body content');
    cache.trees.put('c'.repeat(40), [{ path: 'a.ts', sha: 'd'.repeat(40), size: 10 }]);
    const tarPath = join(cache.paths.tarballsDir, 'snap.tar.gz');
    cache.tarballs.put('e'.repeat(40), tarPath); // creates tarballsDir (the registry write)
    writeFileSync(tarPath, 'fake tarball');

    const result = runCache(cache, { subcommand: 'stats' }) as CacheStatsResult;
    // blobs.put('a'.repeat(40)) + the SAME body via etags.set() (etags.set
    // itself calls putBlob under a 64-hex hash) — both land as separate files.
    expect(result.blobs.count).toBeGreaterThanOrEqual(2);
    expect(result.etags.count).toBe(1);
    expect(result.trees.count).toBe(1);
    expect(result.tarballs.count).toBe(1); // index.json is excluded from the count
  });

  test('excludes the tarballs registry file (index.json) from the tarball count', () => {
    const cache = createCache(dir);
    const tarPath = join(cache.paths.tarballsDir, 'snap2.tar.gz');
    cache.tarballs.put('f'.repeat(40), tarPath);
    writeFileSync(tarPath, 'x');
    const result = runCache(cache, { subcommand: 'stats' }) as CacheStatsResult;
    expect(result.tarballs.count).toBe(1);
  });

  test('corpora stats are reported only when this Cache is bound to the true default root', () => {
    const cache = createCache(dir);
    const withOverride = runCache(
      cache,
      { subcommand: 'stats' },
      {
        resolveDefaultRoot: () => '/some/other/default',
      },
    ) as CacheStatsResult;
    expect(withOverride.corpora).toBeUndefined();

    const withMatchingDefault = runCache(
      cache,
      { subcommand: 'stats' },
      {
        resolveDefaultRoot: () => dir,
      },
    ) as CacheStatsResult;
    expect(withMatchingDefault.corpora).toEqual({ count: 0, bytes: 0 });
  });
});

describe('runCache clear', () => {
  test('without --confirm throws CONFIRMATION_REQUIRED, and touches nothing', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'x');
    let thrown: unknown;
    try {
      runCache(cache, { subcommand: 'clear' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EngineError);
    expect((thrown as EngineError).code).toBe('CONFIRMATION_REQUIRED');
    expect(cache.blobs.has('a'.repeat(40))).toBe(true);
  });

  test('--confirm wipes etags/blobs/trees/tarballs/corpora but spares budget.json', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'x');
    cache.etags.set('https://api.github.com/x', '"e1"', 'body');
    cache.trees.put('c'.repeat(40), []);
    cache.tarballs.put('e'.repeat(40), join(dir, 'snap.tar.gz'));
    writeFileSync(join(dir, 'snap.tar.gz'), 'x');
    cache.budget.updatePool('restCore', { remaining: 100, resetAt: '2026-01-01T00:00:00Z' });

    const result = runCache(cache, { subcommand: 'clear', confirm: true }) as CacheClearResult;
    expect(result.cleared.sort()).toEqual(
      ['blobs', 'corpora', 'etags', 'tarballs', 'trees'].sort(),
    );

    expect(cache.blobs.has('a'.repeat(40))).toBe(false);
    expect(cache.etags.get('https://api.github.com/x')).toBeUndefined();
    expect(cache.trees.has('c'.repeat(40))).toBe(false);
    expect(cache.tarballs.has('e'.repeat(40))).toBe(false);
    // budget survives — it's session rate-limit state, not a content cache.
    expect(cache.budget.load().restCore?.remaining).toBe(100);
  });

  test('never touches an arbitrary --out corpus.json living outside the cache root', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'x'); // stamps the ownership marker (fix wave 1) so clear is allowed
    const outsideCorpus = join(dir, '..', 'somewhere-else-corpus.json');
    writeFileSync(outsideCorpus, '{"schema":"github-relay/corpus@1"}');
    try {
      runCache(cache, { subcommand: 'clear', confirm: true });
      expect(existsSync(outsideCorpus)).toBe(true);
      expect(readFileSync(outsideCorpus, 'utf8')).toContain('corpus@1');
    } finally {
      rmSync(outsideCorpus, { force: true });
    }
  });
});

describe('runCache gc', () => {
  test('--older-than accepts 30d/12h/90m forms', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'x'); // stamps the ownership marker (fix wave 1) so gc is allowed
    expect(() => runCache(cache, { subcommand: 'gc', olderThan: '30d' })).not.toThrow();
    expect(() => runCache(cache, { subcommand: 'gc', olderThan: '12h' })).not.toThrow();
    expect(() => runCache(cache, { subcommand: 'gc', olderThan: '90m' })).not.toThrow();
  });

  test('garbage --older-than is INVALID_INPUT (on a marked root, so the duration parse is what actually fires)', () => {
    const cache = createCache(dir);
    cache.blobs.put('a'.repeat(40), 'x');
    expect(() => runCache(cache, { subcommand: 'gc', olderThan: 'soon' })).toThrow(EngineError);
    expect(() => runCache(cache, { subcommand: 'gc', olderThan: '30' })).toThrow(EngineError);
  });

  test('prunes stale etags via the existing pruneEtags helper', () => {
    const cache = createCache(dir);
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-06-01T00:00:00Z');
    cache.etags.set('https://api.github.com/old', '"e1"', 'old body', () => t0);
    cache.etags.set('https://api.github.com/fresh', '"e2"', 'fresh body', () => t0 + 29 * day);

    const later = () => t0 + 40 * day;
    const result = runCache(
      cache,
      { subcommand: 'gc', olderThan: '30d' },
      { now: later },
    ) as CacheGcResult;

    expect(result.etagsPruned).toBe(1);
    expect(cache.etags.get('https://api.github.com/old')).toBeUndefined();
    expect(cache.etags.get('https://api.github.com/fresh')).toBeDefined();
  });

  test('gc tarball step delegates to the existing gcTarballs helper', () => {
    const cache = createCache(dir);
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-06-01T00:00:00Z');
    const tarPath = join(dir, 'old.tar.gz');
    writeFileSync(tarPath, 'x');
    cache.tarballs.put('a'.repeat(40), tarPath, () => t0);

    const later = () => t0 + 40 * day;
    const result = runCache(
      cache,
      { subcommand: 'gc', olderThan: '30d' },
      { now: later },
    ) as CacheGcResult;
    expect(result.tarballsRemoved).toEqual(['a'.repeat(40)]);
    expect(cache.tarballs.has('a'.repeat(40))).toBe(false);
  });

  test('removes an orphaned 64-hex etag body (its etags.json entry aged out) but spares a still-referenced one and every 40-hex git blob', () => {
    const cache = createCache(dir);
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-06-01T00:00:00Z');

    // Stale etag -> its body becomes orphaned once the entry is pruned.
    const staleRecord = cache.etags.set(
      'https://api.github.com/stale',
      '"e1"',
      'stale body',
      () => t0,
    );
    // Fresh etag -> its body stays referenced.
    const freshRecord = cache.etags.set(
      'https://api.github.com/fresh',
      '"e2"',
      'fresh body',
      () => t0 + 29 * day,
    );
    // A genuine git blob (40-hex) living alongside — must never be touched.
    const gitBlobSha = 'a'.repeat(40);
    cache.blobs.put(gitBlobSha, 'git blob content');

    const later = () => t0 + 40 * day;
    const result = runCache(
      cache,
      { subcommand: 'gc', olderThan: '30d' },
      { now: later },
    ) as CacheGcResult;

    expect(result.orphanedBlobsRemoved).toEqual([staleRecord.bodyHash]);
    expect(cache.blobs.has(staleRecord.bodyHash)).toBe(false);
    expect(cache.blobs.has(freshRecord.bodyHash)).toBe(true);
    expect(cache.blobs.has(gitBlobSha)).toBe(true);
  });

  test('defaults --older-than to 30d when omitted', () => {
    const cache = createCache(dir);
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-06-01T00:00:00Z');
    cache.etags.set('https://api.github.com/x', '"e1"', 'body', () => t0);

    const withinDefault = runCache(
      cache,
      { subcommand: 'gc' },
      { now: () => t0 + 29 * day },
    ) as CacheGcResult;
    expect(withinDefault.etagsPruned).toBe(0);

    const pastDefault = runCache(
      cache,
      { subcommand: 'gc' },
      { now: () => t0 + 31 * day },
    ) as CacheGcResult;
    expect(pastDefault.etagsPruned).toBe(1);
  });
});
