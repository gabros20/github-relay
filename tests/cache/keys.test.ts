import { describe, expect, test } from 'bun:test';
import { assertHexKey } from '../../src/cache/keys.ts';
import { EngineError } from '../../src/types.ts';

describe('assertHexKey — content-addressing key validation (fix wave 2, Important 3)', () => {
  test('accepts a valid 40-hex key (git SHA-1)', () => {
    expect(() => assertHexKey('a'.repeat(40))).not.toThrow();
  });

  test('accepts a valid 64-hex key (sha256, shared with etag bodies)', () => {
    expect(() => assertHexKey('b'.repeat(64))).not.toThrow();
  });

  test('rejects a path-traversal payload', () => {
    expect(() => assertHexKey('../../evil')).toThrow(EngineError);
    try {
      assertHexKey('../../evil');
    } catch (e) {
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
  });

  test('rejects uppercase hex, wrong length, and non-hex characters', () => {
    expect(() => assertHexKey('A'.repeat(40))).toThrow(EngineError);
    expect(() => assertHexKey('a'.repeat(39))).toThrow(EngineError);
    expect(() => assertHexKey('g'.repeat(40))).toThrow(EngineError);
  });

  test('rejects an empty string and a bare slash', () => {
    expect(() => assertHexKey('')).toThrow(EngineError);
    expect(() => assertHexKey('/')).toThrow(EngineError);
  });
});
