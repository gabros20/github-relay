import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TreeEntry, getTree, hasTree, putTree } from '../../src/cache/trees.ts';
import { EngineError } from '../../src/types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-trees-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entries: TreeEntry[] = [
  { path: 'src/index.ts', sha: 'a'.repeat(40), size: 120 },
  { path: 'README.md', sha: 'b'.repeat(40), size: 40 },
];

const COMMIT = 'c'.repeat(40);
const COMMIT_ONE = '1'.repeat(40);
const COMMIT_TWO = '2'.repeat(40);

describe('trees — keyed by commit SHA', () => {
  test('has()/get() are empty before put', () => {
    expect(hasTree(dir, COMMIT)).toBe(false);
    expect(getTree(dir, COMMIT)).toBeUndefined();
  });

  test('put then get round-trips the full inventory', () => {
    putTree(dir, COMMIT, entries);
    expect(hasTree(dir, COMMIT)).toBe(true);
    expect(getTree(dir, COMMIT)).toEqual(entries);
  });

  test('different commit SHAs are stored independently', () => {
    putTree(dir, COMMIT_ONE, entries);
    putTree(dir, COMMIT_TWO, []);
    expect(getTree(dir, COMMIT_ONE)).toEqual(entries);
    expect(getTree(dir, COMMIT_TWO)).toEqual([]);
  });

  test('a corrupt tree file never throws — get() falls back to undefined', () => {
    writeFileSync(join(dir, `${COMMIT}.json`), '{ not json');
    expect(getTree(dir, COMMIT)).toBeUndefined();
  });
});

describe('trees — key validation (fix wave 2, Important 3)', () => {
  test('a path-traversal commit sha is rejected and nothing is written outside the store', () => {
    expect(() => putTree(dir, '../../evil', entries)).toThrow(EngineError);
    try {
      putTree(dir, '../../evil', entries);
    } catch (e) {
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
  });

  test('has()/get() also reject a non-hex commit sha', () => {
    expect(() => hasTree(dir, '../../evil')).toThrow(EngineError);
    expect(() => getTree(dir, '../../evil')).toThrow(EngineError);
  });

  test('a valid 40-hex and 64-hex commit sha still work', () => {
    const sha40 = 'e'.repeat(40);
    putTree(dir, sha40, entries);
    expect(getTree(dir, sha40)).toEqual(entries);

    const sha64 = 'f'.repeat(64);
    putTree(dir, sha64, entries);
    expect(getTree(dir, sha64)).toEqual(entries);
  });
});
