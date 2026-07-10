import { describe, expect, test } from 'bun:test';
import { thirdPartyJson } from '../../src/sources/http.ts';
import { EngineError } from '../../src/types.ts';

const constFetch = (res: Response): typeof fetch => (async () => res) as unknown as typeof fetch;

describe('thirdPartyJson — malformed 2xx body fails loud (CRITICAL 1)', () => {
  test('a 200 with a non-JSON body throws FETCH_FAILED, never a silent null', async () => {
    const fetchImpl = constFetch(new Response('<html>maintenance</html>', { status: 200 }));
    const err = (await thirdPartyJson(fetchImpl, 'ecosyste.ms', { url: 'https://x' }).catch(
      (e) => e,
    )) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('FETCH_FAILED');
  });
});

describe('thirdPartyJson — abandoned bodies are cancelled (IMPORTANT 3)', () => {
  test('a 404 cancels the response body before throwing', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = constFetch(new Response(body, { status: 404 }));
    await thirdPartyJson(fetchImpl, 'deps.dev', { url: 'https://x' }).catch(() => {});
    expect(cancelled).toBe(true);
  });

  test('a 5xx cancels the response body before throwing SOURCE_DOWN', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = constFetch(new Response(body, { status: 503 }));
    const err = (await thirdPartyJson(fetchImpl, 'deps.dev', { url: 'https://x' }).catch(
      (e) => e,
    )) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
    expect(cancelled).toBe(true);
  });
});
