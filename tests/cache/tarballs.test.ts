import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcTarballs, getTarball, hasTarball, putTarball } from '../../src/cache/tarballs.ts';
import { EngineError } from '../../src/types.ts';

let dir: string;
let tarballFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-tarballs-'));
  tarballFile = join(dir, 'snapshot.tar.gz');
  writeFileSync(tarballFile, 'fake tarball bytes');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const COMMIT = 'd'.repeat(40);
const COMMIT_ONE = '1'.repeat(40);
const COMMIT_TWO = '2'.repeat(40);
const COMMIT_OLD = 'a'.repeat(40);
const COMMIT_FRESH = 'b'.repeat(40);

describe('tarballs — path registry keyed by commit SHA', () => {
  test('has()/get() are empty before put', () => {
    expect(hasTarball(dir, COMMIT)).toBe(false);
    expect(getTarball(dir, COMMIT)).toBeUndefined();
  });

  test('put registers the file path + cachedAt; get/has see it', () => {
    const now = () => Date.parse('2026-07-10T00:00:00.000Z');
    putTarball(dir, COMMIT, tarballFile, now);
    expect(hasTarball(dir, COMMIT)).toBe(true);
    expect(getTarball(dir, COMMIT)).toEqual({
      path: tarballFile,
      cachedAt: '2026-07-10T00:00:00.000Z',
    });
  });

  test('is keyed by commit SHA, never an archive checksum', () => {
    putTarball(dir, COMMIT_ONE, tarballFile);
    putTarball(dir, COMMIT_TWO, tarballFile);
    expect(getTarball(dir, COMMIT_ONE)?.path).toBe(tarballFile);
    expect(getTarball(dir, COMMIT_TWO)?.path).toBe(tarballFile);
  });
});

describe('tarballs — gc by age', () => {
  test('honors the injected now(): drops entries older than maxAgeMs, keeps fresh ones', () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-07-01T00:00:00.000Z');
    putTarball(dir, COMMIT_OLD, tarballFile, () => t0);

    const freshFile = join(dir, 'fresh.tar.gz');
    writeFileSync(freshFile, 'fresh bytes');
    const t9 = t0 + 9 * day;
    putTarball(dir, COMMIT_FRESH, freshFile, () => t9);

    const later = () => t0 + 10 * day;
    const { removed } = gcTarballs(dir, 5 * day, later);

    expect(removed).toEqual([COMMIT_OLD]);
    expect(hasTarball(dir, COMMIT_OLD)).toBe(false);
    expect(hasTarball(dir, COMMIT_FRESH)).toBe(true);
  });

  test('best-effort unlinks the referenced file on disk', () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-07-01T00:00:00.000Z');
    putTarball(dir, COMMIT_OLD, tarballFile, () => t0);
    expect(existsSync(tarballFile)).toBe(true);

    gcTarballs(dir, 0, () => t0 + day);
    expect(existsSync(tarballFile)).toBe(false);
  });

  test('gc on an empty registry removes nothing', () => {
    expect(gcTarballs(dir, 1000).removed).toEqual([]);
  });
});

describe('tarballs — key validation (fix wave 2, Important 3)', () => {
  test('a path-traversal commit sha is rejected by put and nothing is registered', () => {
    expect(() => putTarball(dir, '../../evil', tarballFile)).toThrow(EngineError);
    try {
      putTarball(dir, '../../evil', tarballFile);
    } catch (e) {
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
    expect(hasTarball(dir, '../../evil')).toBe(false);
  });

  test('a valid 40-hex and 64-hex commit sha still work', () => {
    const sha40 = 'e'.repeat(40);
    putTarball(dir, sha40, tarballFile);
    expect(hasTarball(dir, sha40)).toBe(true);

    const sha64 = 'f'.repeat(64);
    putTarball(dir, sha64, tarballFile);
    expect(hasTarball(dir, sha64)).toBe(true);
  });
});
