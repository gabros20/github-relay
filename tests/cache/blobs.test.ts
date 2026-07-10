import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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

describe('blobs — content-addressed store', () => {
  test('has() is false before put, true after', () => {
    const sha = 'abc123';
    expect(hasBlob(dir, sha)).toBe(false);
    putBlob(dir, sha, 'hello world');
    expect(hasBlob(dir, sha)).toBe(true);
  });

  test('get() returns undefined before put, the content after', () => {
    const sha = 'abc123';
    expect(getBlob(dir, sha)).toBeUndefined();
    putBlob(dir, sha, 'hello world');
    expect(getBlob(dir, sha)).toBe('hello world');
  });

  test('put is idempotent for identical content', () => {
    const sha = 'abc123';
    putBlob(dir, sha, 'same content');
    expect(() => putBlob(dir, sha, 'same content')).not.toThrow();
    expect(getBlob(dir, sha)).toBe('same content');
  });

  test('put with mismatched content under an existing sha throws INVALID_INPUT loudly', () => {
    const sha = 'abc123';
    putBlob(dir, sha, 'original content');
    expect(() => putBlob(dir, sha, 'different content')).toThrow(EngineError);
    try {
      putBlob(dir, sha, 'different content');
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
    // the original content must survive the rejected write
    expect(getBlob(dir, sha)).toBe('original content');
  });
});
