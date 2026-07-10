import { describe, expect, test } from 'bun:test';
import { createGhRest } from '../../src/sources/gh-rest.ts';
import { EngineError } from '../../src/types.ts';

interface Call {
  url: string;
  init: RequestInit;
}

// Route responses by URL via a handler that also sees how many times THIS url
// has been requested (for retry-then-succeed sequences). No real network.
function routingFetch(handler: (url: string, attempt: number, init: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const perUrl = new Map<string, number>();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const attempt = perUrl.get(u) ?? 0;
    perUrl.set(u, attempt + 1);
    calls.push({ url: u, init: init ?? {} });
    return handler(u, attempt, init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return { sleep: async (ms) => void slept.push(ms), slept };
}

const getToken = async () => 'test-token';

describe('get — request shape', () => {
  test('GETs api.github.com + path with bearer auth, UA, and api-version header', async () => {
    const { fetchImpl, calls } = routingFetch(() => Response.json({ full_name: 'a/b' }));
    const rest = createGhRest({ fetchImpl, getToken });
    const res = await rest.get('/repos/a/b');

    expect(calls[0]?.url).toBe('https://api.github.com/repos/a/b');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer test-token');
    expect(headers.get('user-agent')).toBe('github-relay');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(res.body).toEqual({ full_name: 'a/b' });
    expect(res.status).toBe(200);
  });

  test('raw option switches the Accept media type and returns text', async () => {
    const { fetchImpl, calls } = routingFetch(() => new Response('# Readme', { status: 200 }));
    const rest = createGhRest({ fetchImpl, getToken });
    const res = await rest.get('/repos/a/b/readme', { raw: true });
    expect(new Headers(calls[0]?.init.headers).get('accept')).toBe(
      'application/vnd.github.raw+json',
    );
    expect(res.body).toBe('# Readme');
  });
});

describe('get — ETag', () => {
  test('passes If-None-Match and surfaces the response etag to callers', async () => {
    const { fetchImpl, calls } = routingFetch(
      () => new Response('{}', { status: 200, headers: { etag: 'W/"abc"' } }),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const res = await rest.get('/repos/a/b', { etag: 'W/"prev"' });
    expect(new Headers(calls[0]?.init.headers).get('if-none-match')).toBe('W/"prev"');
    expect(res.etag).toBe('W/"abc"');
  });

  test('304 Not Modified is surfaced distinctly with no body (cache layer serves the body)', async () => {
    const { fetchImpl } = routingFetch(
      () => new Response(null, { status: 304, headers: { etag: 'W/"x"' } }),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const res = await rest.get('/repos/a/b', { etag: 'W/"x"' });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get('etag')).toBe('W/"x"');
  });
});

describe('get — error mapping', () => {
  test('404 → NOT_FOUND', async () => {
    const { fetchImpl } = routingFetch(() =>
      Response.json({ message: 'Not Found' }, { status: 404 }),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const err = (await rest.get('/repos/a/missing').catch((e) => e)) as EngineError;
    expect(err.code).toBe('NOT_FOUND');
  });

  test('401 → AUTH_FAILED', async () => {
    const { fetchImpl } = routingFetch(() =>
      Response.json({ message: 'Bad credentials' }, { status: 401 }),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const err = (await rest.get('/repos/a/b').catch((e) => e)) as EngineError;
    expect(err.code).toBe('AUTH_FAILED');
  });

  test('a 403 that is neither retry-after nor remaining:0 is a scope error → AUTH_FAILED, not retried', async () => {
    const { fetchImpl, calls } = routingFetch(() =>
      Response.json(
        { message: 'Resource not accessible' },
        { status: 403, headers: { 'x-ratelimit-remaining': '4999' } },
      ),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const err = (await rest.get('/repos/a/b').catch((e) => e)) as EngineError;
    expect(err.code).toBe('AUTH_FAILED');
    expect(calls).toHaveLength(1);
  });
});

describe('get — backoff (x-relay discipline)', () => {
  test('429 sleeps until x-ratelimit-reset then retries and succeeds', async () => {
    const now = () => Date.parse('2026-07-10T00:00:00Z');
    const reset = Math.floor(Date.parse('2026-07-10T00:00:05Z') / 1000); // +5s
    const { sleep, slept } = recordingSleep();
    const { fetchImpl } = routingFetch((_u, attempt) =>
      attempt === 0
        ? Response.json(
            { message: 'rate limited' },
            { status: 429, headers: { 'x-ratelimit-reset': String(reset) } },
          )
        : Response.json({ ok: true }),
    );
    const rest = createGhRest({ fetchImpl, getToken, now, sleep });
    const res = await rest.get('/repos/a/b');
    expect(slept).toEqual([5000]);
    expect(res.body).toEqual({ ok: true });
  });

  test('secondary 403 honors retry-after exactly, then retries', async () => {
    const { sleep, slept } = recordingSleep();
    const { fetchImpl } = routingFetch((_u, attempt) =>
      attempt === 0
        ? new Response('abuse', { status: 403, headers: { 'retry-after': '7' } })
        : Response.json({ ok: true }),
    );
    const rest = createGhRest({ fetchImpl, getToken, sleep });
    await rest.get('/repos/a/b');
    expect(slept).toEqual([7000]); // exact header, not a computed reset window
  });

  test('no reset/retry-after header falls back to a 1000ms default sleep', async () => {
    const { sleep, slept } = recordingSleep();
    const { fetchImpl } = routingFetch((_u, attempt) =>
      attempt === 0 ? new Response('slow', { status: 429 }) : Response.json({ ok: true }),
    );
    const rest = createGhRest({ fetchImpl, getToken, sleep });
    await rest.get('/repos/a/b');
    expect(slept).toEqual([1000]);
  });

  test('exhausting maxRetries on 429 → RATE_LIMITED with retryAfterMs', async () => {
    const { sleep, slept } = recordingSleep();
    const { fetchImpl, calls } = routingFetch(() => new Response('no', { status: 429 }));
    const rest = createGhRest({ fetchImpl, getToken, sleep, maxRetries: 2 });
    const err = (await rest.get('/repos/a/b').catch((e) => e)) as EngineError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterMs).toBe(1000);
    expect(calls).toHaveLength(3); // initial + 2 retries
    expect(slept).toHaveLength(2);
  });

  test('exhausting retries on a secondary 403 → ABUSE_DETECTED', async () => {
    const { sleep } = recordingSleep();
    const { fetchImpl } = routingFetch(
      () => new Response('abuse', { status: 403, headers: { 'retry-after': '2' } }),
    );
    const rest = createGhRest({ fetchImpl, getToken, sleep, maxRetries: 1 });
    const err = (await rest.get('/repos/a/b').catch((e) => e)) as EngineError;
    expect(err.code).toBe('ABUSE_DETECTED');
    expect(err.retryAfterMs).toBe(2000);
  });
});

describe('tarballUrl — 302 follow + host enforcement', () => {
  test('follows the 302 (manual) to codeload and returns the location', async () => {
    const codeload = 'https://codeload.github.com/a/b/legacy.tar.gz/refs/heads/main';
    const { fetchImpl, calls } = routingFetch(
      () => new Response(null, { status: 302, headers: { location: codeload } }),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const url = await rest.tarballUrl('a', 'b', 'main');
    expect(url).toBe(codeload);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/a/b/tarball/main');
    expect(calls[0]?.init.redirect).toBe('manual');
  });

  test('a redirect to any host other than codeload/api.github.com is rejected (anti-scraping contract)', async () => {
    const { fetchImpl } = routingFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://raw.githubusercontent.com/a/b/main/x' },
        }),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const err = (await rest.tarballUrl('a', 'b', 'main').catch((e) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
  });
});

describe('downloadTarball — size guard', () => {
  const OUT = `${import.meta.dir}/../../node_modules/.cache-ghrelay-test-tarball.tar.gz`;

  test('content-length over maxBytes throws before streaming', async () => {
    const codeload = 'https://codeload.github.com/a/b/tar';
    const { fetchImpl } = routingFetch((u) =>
      u.startsWith('https://api.github.com')
        ? new Response(null, { status: 302, headers: { location: codeload } })
        : new Response('x'.repeat(50), { status: 200, headers: { 'content-length': '999999' } }),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const err = (await rest
      .downloadTarball('a', 'b', 'main', { out: OUT, maxBytes: 100 })
      .catch((e) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
  });

  test('a within-guard tarball streams to the out file and reports its byte count', async () => {
    const codeload = 'https://codeload.github.com/a/b/tar';
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const { fetchImpl } = routingFetch((u) =>
      u.startsWith('https://api.github.com')
        ? new Response(null, { status: 302, headers: { location: codeload } })
        : new Response(payload, { status: 200 }),
    );
    const rest = createGhRest({ fetchImpl, getToken });
    const result = await rest.downloadTarball('a', 'b', 'main', { out: OUT, maxBytes: 1000 });
    expect(result.bytes).toBe(5);
    expect(await Bun.file(OUT).bytes()).toEqual(payload);
  });
});
