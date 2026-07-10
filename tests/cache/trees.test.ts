import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TreeEntry, getTree, hasTree, putTree } from '../../src/cache/trees.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-trees-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entries: TreeEntry[] = [
  { path: 'src/index.ts', sha: 'aaa', size: 120 },
  { path: 'README.md', sha: 'bbb', size: 40 },
];

describe('trees — keyed by commit SHA', () => {
  test('has()/get() are empty before put', () => {
    expect(hasTree(dir, 'deadbeef')).toBe(false);
    expect(getTree(dir, 'deadbeef')).toBeUndefined();
  });

  test('put then get round-trips the full inventory', () => {
    putTree(dir, 'deadbeef', entries);
    expect(hasTree(dir, 'deadbeef')).toBe(true);
    expect(getTree(dir, 'deadbeef')).toEqual(entries);
  });

  test('different commit SHAs are stored independently', () => {
    putTree(dir, 'sha-one', entries);
    putTree(dir, 'sha-two', []);
    expect(getTree(dir, 'sha-one')).toEqual(entries);
    expect(getTree(dir, 'sha-two')).toEqual([]);
  });

  test('a corrupt tree file never throws — get() falls back to undefined', () => {
    writeFileSync(join(dir, 'corrupt.json'), '{ not json');
    expect(getTree(dir, 'corrupt')).toBeUndefined();
  });
});
