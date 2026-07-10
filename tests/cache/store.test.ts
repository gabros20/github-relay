import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, readFileIfExists, save, writeFileAtomic } from '../../src/cache/store.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('load — never throws', () => {
  test('missing file returns the fallback', () => {
    expect(load(join(dir, 'nope.json'), { x: 1 })).toEqual({ x: 1 });
  });

  test('corrupt JSON returns the fallback', () => {
    writeFileAtomic(join(dir, 'bad.json'), '{ not json');
    expect(load(join(dir, 'bad.json'), { x: 1 })).toEqual({ x: 1 });
  });

  test('valid JSON round-trips through save/load', () => {
    const path = join(dir, 'nested', 'data.json');
    save(path, { a: [1, 2, 3] });
    expect(load(path, null)).toEqual({ a: [1, 2, 3] });
  });
});

describe('save — atomic + auto-create', () => {
  test('creates nested directories that do not exist yet', () => {
    const path = join(dir, 'a', 'b', 'c.json');
    save(path, { ok: true });
    expect(load(path, null)).toEqual({ ok: true });
  });

  test('leaves no temp files behind after a successful write', () => {
    const path = join(dir, 'file.json');
    save(path, { ok: true });
    const names = readdirSync(dir);
    expect(names).toEqual(['file.json']);
  });
});

describe('writeFileAtomic / readFileIfExists — raw content', () => {
  test('round-trips raw text that is not JSON', () => {
    const path = join(dir, 'raw.txt');
    writeFileAtomic(path, '# not json at all');
    expect(readFileIfExists(path)).toBe('# not json at all');
  });

  test('readFileIfExists returns undefined for a missing file', () => {
    expect(readFileIfExists(join(dir, 'missing.txt'))).toBeUndefined();
  });

  test('leaves no temp files behind after a raw write', () => {
    const path = join(dir, 'raw.txt');
    writeFileAtomic(path, 'hello');
    expect(readdirSync(dir)).toEqual(['raw.txt']);
  });
});
