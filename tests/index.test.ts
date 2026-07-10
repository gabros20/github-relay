import { describe, expect, test } from 'bun:test';
import * as lib from '../src/index.ts';

describe('library exports', () => {
  test('exposes the envelope, registry, and cli surface', () => {
    expect(typeof lib.ok).toBe('function');
    expect(typeof lib.err).toBe('function');
    expect(typeof lib.toJson).toBe('function');
    expect(typeof lib.progressReporter).toBe('function');
    expect(typeof lib.run).toBe('function');
    expect(typeof lib.parseArgs).toBe('function');
    expect(typeof lib.dispatch).toBe('function');
    expect(Array.isArray(lib.COMMANDS)).toBe(true);
    expect(lib.COMMANDS.length).toBe(14);
    expect(typeof lib.EngineError).toBe('function');
  });
});
