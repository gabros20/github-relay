import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCachePaths, resolveCacheRoot } from '../../src/cache/paths.ts';

const ORIGINAL_ENV = process.env.GHRELAY_CACHE_DIR;

beforeEach(() => {
  process.env.GHRELAY_CACHE_DIR = undefined;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) process.env.GHRELAY_CACHE_DIR = undefined;
  else process.env.GHRELAY_CACHE_DIR = ORIGINAL_ENV;
});

describe('resolveCacheRoot', () => {
  test('defaults to ~/.ghrelay', () => {
    expect(resolveCacheRoot()).toBe(join(homedir(), '.ghrelay'));
  });

  test('GHRELAY_CACHE_DIR env var overrides the default', () => {
    process.env.GHRELAY_CACHE_DIR = '/tmp/env-override';
    expect(resolveCacheRoot()).toBe('/tmp/env-override');
  });

  test('an explicit override wins over the env var', () => {
    process.env.GHRELAY_CACHE_DIR = '/tmp/env-override';
    expect(resolveCacheRoot('/tmp/explicit')).toBe('/tmp/explicit');
  });
});

describe('resolveCachePaths', () => {
  test('derives every subpath from the resolved root', () => {
    const paths = resolveCachePaths('/tmp/ghrelay-root');
    expect(paths.root).toBe('/tmp/ghrelay-root');
    expect(paths.etagsFile).toBe('/tmp/ghrelay-root/etags.json');
    expect(paths.blobsDir).toBe('/tmp/ghrelay-root/blobs');
    expect(paths.treesDir).toBe('/tmp/ghrelay-root/trees');
    expect(paths.tarballsDir).toBe('/tmp/ghrelay-root/tarballs');
    expect(paths.budgetFile).toBe('/tmp/ghrelay-root/budget.json');
    expect(paths.corporaDir).toBe('/tmp/ghrelay-root/corpora');
  });
});
