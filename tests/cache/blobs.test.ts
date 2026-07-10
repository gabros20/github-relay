import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBlob, hasBlob, putBlob } from '../../src/cache/blobs.ts';
import { EngineError } from '../../src/types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-blobs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SHA = 'a'.repeat(40);

describe('blobs — content-addressed store', () => {
  test('has() is false before put, true after', () => {
    expect(hasBlob(dir, SHA)).toBe(false);
    putBlob(dir, SHA, 'hello world');
    expect(hasBlob(dir, SHA)).toBe(true);
  });

  test('get() returns undefined before put, the content after', () => {
    expect(getBlob(dir, SHA)).toBeUndefined();
    putBlob(dir, SHA, 'hello world');
    expect(getBlob(dir, SHA)).toBe('hello world');
  });

  test('put is idempotent for identical content', () => {
    putBlob(dir, SHA, 'same content');
    expect(() => putBlob(dir, SHA, 'same content')).not.toThrow();
    expect(getBlob(dir, SHA)).toBe('same content');
  });

  test('put with mismatched content under an existing sha throws INVALID_INPUT loudly', () => {
    putBlob(dir, SHA, 'original content');
    expect(() => putBlob(dir, SHA, 'different content')).toThrow(EngineError);
    try {
      putBlob(dir, SHA, 'different content');
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
    // the original content must survive the rejected write
    expect(getBlob(dir, SHA)).toBe('original content');
  });
});

describe('blobs — key validation (fix wave 2, Important 3)', () => {
  test('a path-traversal sha is rejected by put and nothing is written outside the store', () => {
    expect(() => putBlob(dir, '../../evil', 'pwned')).toThrow(EngineError);
    try {
      putBlob(dir, '../../evil', 'pwned');
    } catch (e) {
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
    expect(existsSync(join(dir, '..', '..', 'evil'))).toBe(false);
  });

  test('has()/get() also reject a non-hex key rather than reading outside the store', () => {
    expect(() => hasBlob(dir, '../../etc/passwd')).toThrow(EngineError);
    expect(() => getBlob(dir, '../../etc/passwd')).toThrow(EngineError);
  });

  test('a valid 40-hex sha still works', () => {
    const sha = 'c'.repeat(40);
    putBlob(dir, sha, 'content');
    expect(getBlob(dir, sha)).toBe('content');
  });

  test('a valid 64-hex sha (sha256, shared with etag bodies) still works', () => {
    const sha = 'd'.repeat(64);
    putBlob(dir, sha, 'content');
    expect(getBlob(dir, sha)).toBe('content');
  });
});
