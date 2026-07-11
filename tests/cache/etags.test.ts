import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCachedBody, getEtag, pruneEtags, setEtag } from '../../src/cache/etags.ts';

let dir: string;
let etagsFile: string;
let blobsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-etags-'));
  etagsFile = join(dir, 'etags.json');
  blobsDir = join(dir, 'blobs');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('etags — get/set', () => {
  test('getEtag is undefined before any set', () => {
    expect(getEtag(etagsFile, 'https://api.github.com/repos/a/b')).toBeUndefined();
  });

  test('setEtag records etag + bodyHash + cachedAt, honoring the injected now()', () => {
    const url = 'https://api.github.com/repos/a/b';
    const now = () => Date.parse('2026-07-10T00:00:00.000Z');
    const record = setEtag(etagsFile, blobsDir, url, 'W/"abc"', '{"full_name":"a/b"}', now);

    expect(record.etag).toBe('W/"abc"');
    expect(record.cachedAt).toBe('2026-07-10T00:00:00.000Z');
    expect(typeof record.bodyHash).toBe('string');
    expect(record.bodyHash.length).toBeGreaterThan(0);
    expect(getEtag(etagsFile, url)).toEqual(record);
  });

  test('a 304 can serve the cached body via getCachedBody(bodyHash)', () => {
    const url = 'https://api.github.com/repos/a/b';
    const body = '{"full_name":"a/b","stars":42}';
    const record = setEtag(etagsFile, blobsDir, url, 'W/"abc"', body);
    expect(getCachedBody(blobsDir, record.bodyHash)).toBe(body);
  });

  test('different URLs are tracked independently', () => {
    setEtag(etagsFile, blobsDir, 'https://api.github.com/repos/a/b', 'W/"1"', 'body-a');
    setEtag(etagsFile, blobsDir, 'https://api.github.com/repos/c/d', 'W/"2"', 'body-c');
    expect(getEtag(etagsFile, 'https://api.github.com/repos/a/b')?.etag).toBe('W/"1"');
    expect(getEtag(etagsFile, 'https://api.github.com/repos/c/d')?.etag).toBe('W/"2"');
  });

  test('re-setting the same URL with a new body updates etag/bodyHash and keeps the old body cached', () => {
    const url = 'https://api.github.com/repos/a/b';
    const first = setEtag(etagsFile, blobsDir, url, 'W/"1"', 'body-v1');
    const second = setEtag(etagsFile, blobsDir, url, 'W/"2"', 'body-v2');
    expect(second.bodyHash).not.toBe(first.bodyHash);
    expect(getEtag(etagsFile, url)).toEqual(second);
    expect(getCachedBody(blobsDir, first.bodyHash)).toBe('body-v1');
    expect(getCachedBody(blobsDir, second.bodyHash)).toBe('body-v2');
  });
});

describe('etags — prune by age', () => {
  test('honors the injected now(): drops entries older than maxAgeMs, keeps fresh ones', () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-07-01T00:00:00.000Z');
    setEtag(etagsFile, blobsDir, 'https://api.github.com/old', 'W/"1"', 'old-body', () => t0);
    const t9 = t0 + 9 * day;
    setEtag(etagsFile, blobsDir, 'https://api.github.com/fresh', 'W/"2"', 'fresh-body', () => t9);

    const later = () => t0 + 10 * day;
    const { pruned } = pruneEtags(etagsFile, 5 * day, later);

    expect(pruned).toBe(1);
    expect(getEtag(etagsFile, 'https://api.github.com/old')).toBeUndefined();
    expect(getEtag(etagsFile, 'https://api.github.com/fresh')).toBeDefined();
  });

  test('prune on an empty file removes nothing and never throws', () => {
    expect(pruneEtags(etagsFile, 1000).pruned).toBe(0);
  });
});

describe('etags — never throws on a corrupt store file', () => {
  test('getEtag falls back to undefined when etags.json is corrupt', () => {
    writeFileSync(etagsFile, '{ not json');
    expect(getEtag(etagsFile, 'https://api.github.com/repos/a/b')).toBeUndefined();
  });
});
