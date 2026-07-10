import { describe, expect, test } from 'bun:test';
import { EngineError } from '../src/types.ts';

describe('EngineError', () => {
  test('carries code + message, status/retryAfterMs default undefined', () => {
    const e = new EngineError('RATE_LIMITED', 'too many requests');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('EngineError');
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.message).toBe('too many requests');
    expect(e.status).toBeUndefined();
    expect(e.retryAfterMs).toBeUndefined();
  });

  test('carries optional status + retryAfterMs when provided', () => {
    const e = new EngineError('RATE_LIMITED', 'slow down', 429, 5000);
    expect(e.status).toBe(429);
    expect(e.retryAfterMs).toBe(5000);
  });
});
