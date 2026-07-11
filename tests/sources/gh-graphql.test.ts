import { describe, expect, test } from 'bun:test';
import { createGhGraphql } from '../../src/sources/gh-graphql.ts';
import { EngineError } from '../../src/types.ts';

// A fetch fake that records every request and answers from a handler. The
// handler sees the parsed GraphQL body so tests can branch on the query /
// alias count. No real network is ever touched.
interface Call {
  url: string;
  init: RequestInit;
  query: string;
  variables: unknown;
  aliasCount: number;
}

function fakeFetch(handler: (call: Call) => Response): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables?: unknown };
    const query = body.query ?? '';
    const call: Call = {
      url: String(url),
      init: init ?? {},
      query,
      variables: body.variables,
      aliasCount: (query.match(/repository\(/g) ?? []).length,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const getToken = async () => 'test-token';

describe('graphql — request shape', () => {
  test('POSTs to api.github.com/graphql with bearer auth, UA, and {query,variables} body', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ data: { viewer: { login: 'x' } } }),
    );
    const gh = createGhGraphql({ fetchImpl, getToken });
    await gh.graphql('query { viewer { login } }', { a: 1 });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://api.github.com/graphql');
    expect(call?.init.method).toBe('POST');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer test-token');
    expect(headers.get('user-agent')).toBe('github-relay');
    expect(call?.variables).toEqual({ a: 1 });
  });

  test('returns the data payload to the caller', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ data: { n: 42 } }));
    const gh = createGhGraphql({ fetchImpl, getToken });
    expect(await gh.graphql<{ n: number }>('query{n}')).toEqual({ n: 42 });
  });
});

describe('graphql — rateLimit embedding', () => {
  test('lastRateLimit() surfaces the rateLimit block from the last response', async () => {
    const rateLimit = { cost: 1, remaining: 4999, resetAt: '2026-07-10T01:00:00Z', nodeCount: 1 };
    const { fetchImpl } = fakeFetch(() => jsonResponse({ data: { search: {}, rateLimit } }));
    const gh = createGhGraphql({ fetchImpl, getToken });
    expect(gh.lastRateLimit()).toBeNull();
    await gh.graphql('query{ search rateLimit }');
    expect(gh.lastRateLimit()).toEqual(rateLimit);
  });

  test('a query WITHOUT a rateLimit selection still ships one (adapter-level invariant)', async () => {
    const rateLimit = { cost: 1, remaining: 4998, resetAt: '2026-07-10T02:00:00Z', nodeCount: 1 };
    let sentQuery = '';
    const { fetchImpl } = fakeFetch((call) => {
      sentQuery = call.query;
      return jsonResponse({ data: { viewer: { login: 'x' }, rateLimit } });
    });
    const gh = createGhGraphql({ fetchImpl, getToken });
    await gh.graphql('query { viewer { login } }');
    expect(sentQuery).toContain('rateLimit { cost remaining resetAt nodeCount }');
    // The invariant is what lets budget tracking work even for a forgetful caller.
    expect(gh.lastRateLimit()).toEqual(rateLimit);
  });

  test('a query that ALREADY selects rateLimit is not double-embedded', async () => {
    let sentQuery = '';
    const { fetchImpl } = fakeFetch((call) => {
      sentQuery = call.query;
      return jsonResponse({ data: { viewer: {}, rateLimit: {} } });
    });
    const gh = createGhGraphql({ fetchImpl, getToken });
    await gh.graphql('query { viewer { login } rateLimit { cost remaining resetAt nodeCount } }');
    expect((sentQuery.match(/rateLimit/g) ?? []).length).toBe(1);
  });
});

describe('graphql — error mapping', () => {
  test('401 → AUTH_FAILED', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ message: 'Bad credentials' }, { status: 401 }),
    );
    const gh = createGhGraphql({ fetchImpl, getToken });
    const err = (await gh.graphql('q').catch((e) => e)) as EngineError;
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.status).toBe(401);
  });

  test('403 without retry-after → AUTH_FAILED (scope/permission)', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ message: 'Forbidden' }, { status: 403 }));
    const gh = createGhGraphql({ fetchImpl, getToken });
    const err = (await gh.graphql('q').catch((e) => e)) as EngineError;
    expect(err.code).toBe('AUTH_FAILED');
  });

  test('403 with retry-after → ABUSE_DETECTED honoring the header exactly', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(
        { message: 'secondary limit' },
        { status: 403, headers: { 'retry-after': '30' } },
      ),
    );
    const gh = createGhGraphql({ fetchImpl, getToken });
    const err = (await gh.graphql('q').catch((e) => e)) as EngineError;
    expect(err.code).toBe('ABUSE_DETECTED');
    expect(err.retryAfterMs).toBe(30_000);
  });

  test('primary rate limit (200 + RATE_LIMITED error) → RATE_LIMITED with retryAfterMs from reset', async () => {
    const now = () => Date.parse('2026-07-10T00:00:00Z');
    const reset = Math.floor(Date.parse('2026-07-10T00:10:00Z') / 1000);
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(
        { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
        { headers: { 'x-ratelimit-reset': String(reset) } },
      ),
    );
    const gh = createGhGraphql({ fetchImpl, getToken, now });
    const err = (await gh.graphql('q').catch((e) => e)) as EngineError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterMs).toBe(10 * 60 * 1000);
  });

  test('a non-rate GraphQL error with null data throws (not a silent null)', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ data: null, errors: [{ message: 'Field bogus does not exist' }] }),
    );
    const gh = createGhGraphql({ fetchImpl, getToken });
    const err = (await gh.graphql('q').catch((e) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
  });
});

describe('batchRepositories — aliasing + partial errors', () => {
  test('builds r0/r1 aliases from owner/repo and returns per-name data in order', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({
        data: { r0: { stargazerCount: 1 }, r1: { stargazerCount: 2 }, rateLimit: {} },
      }),
    );
    const gh = createGhGraphql({ fetchImpl, getToken });
    const results = await gh.batchRepositories(['a/one', 'b/two'], 'stargazerCount');

    expect(calls[0]?.query).toContain('r0: repository(owner: "a", name: "one")');
    expect(calls[0]?.query).toContain('r1: repository(owner: "b", name: "two")');
    expect(calls[0]?.query).toContain('rateLimit { cost remaining resetAt nodeCount }');
    expect(results).toEqual([
      { name: 'a/one', data: { stargazerCount: 1 } },
      { name: 'b/two', data: { stargazerCount: 2 } },
    ]);
  });

  test('a per-alias error isolates to that name; siblings still resolve', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({
        data: { r0: { stargazerCount: 9 }, r1: null },
        errors: [{ type: 'NOT_FOUND', path: ['r1'], message: 'Could not resolve to a Repository' }],
      }),
    );
    const gh = createGhGraphql({ fetchImpl, getToken });
    const results = await gh.batchRepositories(['ok/repo', 'gone/repo'], 'stargazerCount');
    expect(results[0]).toEqual({ name: 'ok/repo', data: { stargazerCount: 9 } });
    expect(results[1]?.data).toBeNull();
    expect(results[1]?.error?.code).toBe('NOT_FOUND');
  });
});

// A source that gateways (502) whenever asked for more than `threshold` repos
// at once, succeeding for batches at or under it. The adapter must halve,
// never blind-retry the same size. Module-scoped: shared by the adaptive
// bisection tests and the onEffectiveSize-provenance tests below.
function bisectingFetch(threshold: number, status = 502) {
  return fakeFetch((call) => {
    if (call.aliasCount > threshold) return new Response('gateway', { status });
    const data: Record<string, unknown> = { rateLimit: {} };
    for (let i = 0; i < call.aliasCount; i++) data[`r${i}`] = { i };
    return jsonResponse({ data });
  });
}

describe('batchRepositories — adaptive bisection', () => {
  test('halves a too-large batch and reports the effective successful size', async () => {
    const { fetchImpl, calls } = bisectingFetch(2);
    const gh = createGhGraphql({ fetchImpl, getToken });
    const sizes: number[] = [];
    const results = await gh.batchRepositories(['a/1', 'b/2', 'c/3', 'd/4'], 'x', {
      batchSize: 4,
      onEffectiveSize: (s) => sizes.push(s),
    });

    expect(calls.map((c) => c.aliasCount)).toEqual([4, 2, 2]);
    expect(sizes).toEqual([2, 2]);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.data !== null)).toBe(true);
  });

  test('504 and GraphQL timeout errors trigger the same bisection', async () => {
    // 200 response carrying a timeout error, above the size threshold.
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.aliasCount > 2) {
        return jsonResponse({
          data: null,
          errors: [
            { message: 'Something went wrong while executing your query. This may be a timeout.' },
          ],
        });
      }
      const data: Record<string, unknown> = { rateLimit: {} };
      for (let i = 0; i < call.aliasCount; i++) data[`r${i}`] = { i };
      return jsonResponse({ data });
    });
    const gh = createGhGraphql({ fetchImpl, getToken });
    const results = await gh.batchRepositories(['a/1', 'b/2', 'c/3', 'd/4'], 'x', { batchSize: 4 });
    expect(calls.map((c) => c.aliasCount)).toEqual([4, 2, 2]);
    expect(results).toHaveLength(4);
  });

  test('floors at size 1: a single repo that still gateways becomes a per-name SOURCE_DOWN, no infinite loop', async () => {
    const { fetchImpl, calls } = bisectingFetch(0); // every request 502s
    const gh = createGhGraphql({ fetchImpl, getToken });
    const results = await gh.batchRepositories(['a/1', 'b/2'], 'x', { batchSize: 2 });
    expect(calls.map((c) => c.aliasCount)).toEqual([2, 1, 1]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.error?.code === 'SOURCE_DOWN')).toBe(true);
  });

  test('a batch-level AUTH_FAILED is not bisected — it fails the whole batch', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('nope', { status: 401 }));
    const gh = createGhGraphql({ fetchImpl, getToken });
    const err = (await gh
      .batchRepositories(['a/1', 'b/2'], 'x', { batchSize: 2 })
      .catch((e) => e)) as EngineError;
    expect(err.code).toBe('AUTH_FAILED');
    expect(calls).toHaveLength(1);
  });
});

describe('batchRepositories — onEffectiveSize only reflects genuine bisection (task 12 fix wave 1)', () => {
  // Reproduces the bug: batchRepositories' own top-level loop slices `names`
  // into chunks of `batchSize`, and the LAST chunk is naturally smaller
  // whenever names.length isn't a multiple of batchSize. Pre-fix,
  // onEffectiveSize fired for every successful chunk regardless of origin,
  // so this "remainder" chunk was indistinguishable from a genuinely
  // bisected one — a clean, zero-failure run would report a smaller
  // "effective size" than requested, collapsing a caller's learned ceiling
  // even though nothing ever failed.
  function alwaysSucceedsFetch() {
    return fakeFetch((call) => {
      const data: Record<string, unknown> = { rateLimit: {} };
      for (let i = 0; i < call.aliasCount; i++) data[`r${i}`] = { i };
      return jsonResponse({ data });
    });
  }

  test('a clean 27-repo run at batchSize 25 (a 2-item remainder) never fires onEffectiveSize', async () => {
    const { fetchImpl, calls } = alwaysSucceedsFetch();
    const gh = createGhGraphql({ fetchImpl, getToken });
    const sizes: number[] = [];
    const names = Array.from({ length: 27 }, (_, i) => `o/repo${i}`);
    const results = await gh.batchRepositories(names, 'x', {
      batchSize: 25,
      onEffectiveSize: (s) => sizes.push(s),
    });
    expect(calls.map((c) => c.aliasCount)).toEqual([25, 2]);
    expect(sizes).toEqual([]);
    expect(results).toHaveLength(27);
  });

  test("a clean 55-id run at batchSize 50 (hydrate's shape, a 5-item remainder) never fires onEffectiveSize", async () => {
    const { fetchImpl, calls } = alwaysSucceedsFetch();
    const gh = createGhGraphql({ fetchImpl, getToken });
    const sizes: number[] = [];
    const names = Array.from({ length: 55 }, (_, i) => `o/repo${i}`);
    const results = await gh.batchRepositories(names, 'x', {
      batchSize: 50,
      onEffectiveSize: (s) => sizes.push(s),
    });
    expect(calls.map((c) => c.aliasCount)).toEqual([50, 5]);
    expect(sizes).toEqual([]);
    expect(results).toHaveLength(55);
  });

  test('a genuinely bisected batch (502s above size 12) fires onEffectiveSize only for the bisected sub-chunks', async () => {
    const { fetchImpl, calls } = bisectingFetch(12);
    const gh = createGhGraphql({ fetchImpl, getToken });
    const sizes: number[] = [];
    const names = Array.from({ length: 24 }, (_, i) => `o/repo${i}`);
    const results = await gh.batchRepositories(names, 'x', {
      batchSize: 24,
      onEffectiveSize: (s) => sizes.push(s),
    });
    expect(calls.map((c) => c.aliasCount)).toEqual([24, 12, 12]);
    expect(sizes).toEqual([12, 12]);
    expect(results).toHaveLength(24);
  });
});

describe('graphql — malformed 2xx body fails loud (CRITICAL 1)', () => {
  test('a 200 with a non-JSON body throws FETCH_FAILED, never a fabricated undefined', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('<html>gateway hiccup</html>', { status: 200 }),
    );
    const gh = createGhGraphql({ fetchImpl, getToken });
    const err = (await gh.graphql('query{viewer}').catch((e) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('FETCH_FAILED');
  });

  test('a malformed 200 in a batch fails the batch, not silently marks every repo nodata', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('not json', { status: 200 }));
    const gh = createGhGraphql({ fetchImpl, getToken });
    const err = (await gh
      .batchRepositories(['a/1', 'b/2'], 'x', { batchSize: 2 })
      .catch((e) => e)) as EngineError;
    expect(err.code).toBe('FETCH_FAILED');
  });
});

describe('graphql — abandoned response bodies are cancelled (IMPORTANT 3)', () => {
  test('a 401 cancels the response body before throwing (no leaked connection)', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 401 })) as unknown as typeof fetch;
    const gh = createGhGraphql({ fetchImpl, getToken });
    await gh.graphql('query{viewer}').catch(() => {});
    expect(cancelled).toBe(true);
  });
});

describe('ensureRateLimit — targets the operation, not a leading fragment (IMPORTANT 5)', () => {
  test('a fragment-leading document splices rateLimit into the query op, not the fragment', async () => {
    let sent = '';
    const { fetchImpl } = fakeFetch((call) => {
      sent = call.query;
      return jsonResponse({ data: { repo: {}, rateLimit: {} } });
    });
    const gh = createGhGraphql({ fetchImpl, getToken });
    await gh.graphql('fragment F on Repository { stargazerCount }\nquery { repo { ...F } }');

    // The fragment body must be untouched; rateLimit lands in the operation.
    const fragmentPart = sent.slice(0, sent.indexOf('query'));
    expect(fragmentPart).not.toContain('rateLimit');
    expect(sent).toContain('query { rateLimit { cost remaining resetAt nodeCount }');
  });
});
