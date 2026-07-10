import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcTarballs, getTarball, hasTarball, putTarball } from '../../src/cache/tarballs.ts';

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

describe('tarballs — path registry keyed by commit SHA', () => {
  test('has()/get() are empty before put', () => {
    expect(hasTarball(dir, 'deadbeef')).toBe(false);
    expect(getTarball(dir, 'deadbeef')).toBeUndefined();
  });

  test('put registers the file path + cachedAt; get/has see it', () => {
    const now = () => Date.parse('2026-07-10T00:00:00.000Z');
    putTarball(dir, 'deadbeef', tarballFile, now);
    expect(hasTarball(dir, 'deadbeef')).toBe(true);
    expect(getTarball(dir, 'deadbeef')).toEqual({
      path: tarballFile,
      cachedAt: '2026-07-10T00:00:00.000Z',
    });
  });

  test('is keyed by commit SHA, never an archive checksum', () => {
    putTarball(dir, 'commit-sha-1', tarballFile);
    putTarball(dir, 'commit-sha-2', tarballFile);
    expect(getTarball(dir, 'commit-sha-1')?.path).toBe(tarballFile);
    expect(getTarball(dir, 'commit-sha-2')?.path).toBe(tarballFile);
  });
});

describe('tarballs — gc by age', () => {
  test('honors the injected now(): drops entries older than maxAgeMs, keeps fresh ones', () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-07-01T00:00:00.000Z');
    putTarball(dir, 'old', tarballFile, () => t0);

    const freshFile = join(dir, 'fresh.tar.gz');
    writeFileSync(freshFile, 'fresh bytes');
    const t9 = t0 + 9 * day;
    putTarball(dir, 'fresh', freshFile, () => t9);

    const later = () => t0 + 10 * day;
    const { removed } = gcTarballs(dir, 5 * day, later);

    expect(removed).toEqual(['old']);
    expect(hasTarball(dir, 'old')).toBe(false);
    expect(hasTarball(dir, 'fresh')).toBe(true);
  });

  test('best-effort unlinks the referenced file on disk', () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-07-01T00:00:00.000Z');
    putTarball(dir, 'old', tarballFile, () => t0);
    expect(existsSync(tarballFile)).toBe(true);

    gcTarballs(dir, 0, () => t0 + day);
    expect(existsSync(tarballFile)).toBe(false);
  });

  test('gc on an empty registry removes nothing', () => {
    expect(gcTarballs(dir, 1000).removed).toEqual([]);
  });
});
