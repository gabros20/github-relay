import { describe, expect, test } from 'bun:test';
import { err, ok, toJson } from '../src/output.ts';

describe('ok', () => {
  test('produces the exact {ok:true,command,data} shape', () => {
    expect(ok('search', { hits: 3 })).toEqual({ ok: true, command: 'search', data: { hits: 3 } });
  });
});

describe('err', () => {
  test('minimal call omits hint/status/retryAfterMs entirely (not undefined-valued keys)', () => {
    const e = err('search', 'INVALID_INPUT', 'bad query');
    expect(e).toEqual({
      ok: false,
      command: 'search',
      error: { code: 'INVALID_INPUT', message: 'bad query' },
    });
    expect('hint' in e.error).toBe(false);
    expect('status' in e.error).toBe(false);
    expect('retryAfterMs' in e.error).toBe(false);
  });

  test('full call carries hint, status, and retryAfterMs', () => {
    const e = err(
      'enrich',
      'RATE_LIMITED',
      'slow down',
      "read retryAfterMs, don't guess",
      429,
      5000,
    );
    expect(e).toEqual({
      ok: false,
      command: 'enrich',
      error: {
        code: 'RATE_LIMITED',
        message: 'slow down',
        hint: "read retryAfterMs, don't guess",
        status: 429,
        retryAfterMs: 5000,
      },
    });
  });
});

describe('toJson', () => {
  const envelope = ok('rank', { top: ['a', 'b'] });

  test('defaults to 2-space pretty printing', () => {
    expect(toJson(envelope)).toBe(JSON.stringify(envelope, null, 2));
    expect(toJson(envelope)).toContain('\n  ');
  });

  test('compact:true prints single-line JSON with no indentation', () => {
    const out = toJson(envelope, true);
    expect(out).toBe(JSON.stringify(envelope));
    expect(out).not.toContain('\n');
  });
});
