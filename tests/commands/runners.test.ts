import { describe, expect, test } from 'bun:test';
import { guard } from '../../src/commands/runners.ts';
import { EngineError } from '../../src/types.ts';

describe('guard', () => {
  test('resolves to an ok envelope when fn succeeds', async () => {
    const envelope = await guard('search', async () => ({ hits: 3 }));
    expect(envelope).toEqual({ ok: true, command: 'search', data: { hits: 3 } });
  });

  test('RATE_LIMITED → hint tells the caller to read retryAfterMs, and passes it through', async () => {
    const envelope = await guard('enrich', async () => {
      throw new EngineError('RATE_LIMITED', 'secondary limit hit', 403, 30000);
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('RATE_LIMITED');
    expect(envelope.error.status).toBe(403);
    expect(envelope.error.retryAfterMs).toBe(30000);
    expect(envelope.error.hint).toContain('retryAfterMs');
  });

  test('AUTH_FAILED → hint recommends a zero-permission fine-grained PAT', async () => {
    const envelope = await guard('search', async () => {
      throw new EngineError('AUTH_FAILED', 'no token');
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.hint).toContain('zero-permission fine-grained PAT');
  });

  test('RESULT_CAP → hint points the caller at the shard suggestion carried in the message', async () => {
    const envelope = await guard('search', async () => {
      throw new EngineError(
        'RESULT_CAP',
        '1000-result cap hit; try stars:>500 or split by created: date range',
      );
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.hint).toContain('stars:');
    expect(envelope.error.hint).toContain('created:');
  });

  test('QUERY_TOO_COMPLEX → hint recommends splitting into batch shards', async () => {
    const envelope = await guard('plan', async () => {
      throw new EngineError('QUERY_TOO_COMPLEX', 'too many operators');
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.hint).toContain('batch');
  });

  test('ABUSE_DETECTED → hint recommends a serialized retry after cooldown', async () => {
    const envelope = await guard('batch', async () => {
      throw new EngineError('ABUSE_DETECTED', 'secondary rate limit');
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.hint).toContain('cooldown');
  });

  test('SOURCE_DOWN → hint explains the signal degrades to nodata', async () => {
    const envelope = await guard('enrich', async () => {
      throw new EngineError('SOURCE_DOWN', 'ecosyste.ms unreachable');
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.hint).toContain('nodata');
  });

  test('CONFIRMATION_REQUIRED → hint tells the caller to re-run with --confirm', async () => {
    const envelope = await guard('cache', async () => {
      throw new EngineError('CONFIRMATION_REQUIRED', 'clear needs confirmation');
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.hint).toContain('--confirm');
  });

  test('NOT_FOUND → no hint (self-explanatory)', async () => {
    const envelope = await guard('read', async () => {
      throw new EngineError('NOT_FOUND', 'repo does not exist');
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.hint).toBeUndefined();
  });

  test('a non-EngineError throw becomes FETCH_FAILED with the raw message', async () => {
    const envelope = await guard('skim', async () => {
      throw new Error('ECONNRESET');
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('FETCH_FAILED');
    expect(envelope.error.message).toBe('ECONNRESET');
  });

  test('a non-Error throw (string) is stringified into the message', async () => {
    const envelope = await guard('skim', async () => {
      throw 'literal string failure';
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('FETCH_FAILED');
    expect(envelope.error.message).toBe('literal string failure');
  });
});
