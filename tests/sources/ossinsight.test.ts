import { describe, expect, test } from 'bun:test';
import { createOssInsight } from '../../src/sources/ossinsight.ts';
import type { EngineError } from '../../src/types.ts';

interface Call {
  url: string;
  headers: Headers;
}

function recordingFetch(handler: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), headers: new Headers(init?.headers) };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** The live-probed sql_endpoint envelope shape — numeric fields as strings. */
function sqlEndpointJson(
  rows: {
    repo_name: string;
    primary_language?: string;
    description?: string;
    stars?: string | number;
    forks?: string | number;
    total_score?: string | number;
  }[],
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: 'sql_endpoint',
      data: { columns: [], rows },
    }),
    { status: 200, headers: { 'content-type': 'application/json', ...headers } },
  );
}

describe('createOssInsight — request shape', () => {
  test('GETs the trends endpoint with period + polite UA, no auth/session', async () => {
    const { fetchImpl, calls } = recordingFetch(() => sqlEndpointJson([]));
    const oi = createOssInsight({ fetchImpl });
    await oi.trending('past_week');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.ossinsight.io/v1/trends/repos/?period=past_week');
    expect(calls[0]?.headers.get('user-agent')).toBe(
      'github-relay (mailto:t.gabor880312@gmail.com)',
    );
  });

  test('an optional language filter is passed through as a query param', async () => {
    const { fetchImpl, calls } = recordingFetch(() => sqlEndpointJson([]));
    const oi = createOssInsight({ fetchImpl });
    await oi.trending('past_24_hours', 'Rust');
    expect(calls[0]?.url).toBe(
      'https://api.ossinsight.io/v1/trends/repos/?period=past_24_hours&language=Rust',
    );
  });

  test('no language given omits the param entirely', async () => {
    const { fetchImpl, calls } = recordingFetch(() => sqlEndpointJson([]));
    const oi = createOssInsight({ fetchImpl });
    await oi.trending('past_month');
    expect(calls[0]?.url).not.toContain('language');
  });
});

describe('createOssInsight — row parsing', () => {
  test('coerces stringified numeric fields (SQL-endpoint convention) into real numbers', async () => {
    const { fetchImpl } = recordingFetch(() =>
      sqlEndpointJson([
        {
          repo_name: 'facebook/react',
          primary_language: 'JavaScript',
          description: 'A library',
          stars: '150',
          forks: '20',
          total_score: '220.19',
        },
      ]),
    );
    const oi = createOssInsight({ fetchImpl });
    const page = await oi.trending('past_week');
    expect(page.rows).toEqual([
      {
        repo_name: 'facebook/react',
        primary_language: 'JavaScript',
        description: 'A library',
        stars: 150,
        forks: 20,
        total_score: 220.19,
      },
    ]);
  });

  test('empty-string SQL NULLs coerce to 0/"" rather than NaN', async () => {
    const { fetchImpl } = recordingFetch(() =>
      sqlEndpointJson([
        {
          repo_name: 'a/b',
          primary_language: '',
          description: '',
          stars: '',
          forks: '',
          total_score: '',
        },
      ]),
    );
    const oi = createOssInsight({ fetchImpl });
    const page = await oi.trending('past_week');
    expect(page.rows[0]).toEqual({
      repo_name: 'a/b',
      primary_language: '',
      description: '',
      stars: 0,
      forks: 0,
      total_score: 0,
    });
  });

  test('rows with no repo_name are skipped', async () => {
    const { fetchImpl } = recordingFetch(() =>
      sqlEndpointJson([{ repo_name: '' }, { repo_name: 'a/b', stars: '1' }]),
    );
    const oi = createOssInsight({ fetchImpl });
    const page = await oi.trending('past_week');
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.repo_name).toBe('a/b');
  });
});

describe('createOssInsight — rate-window headers (the real 600/hr/IP pool)', () => {
  test('parses x-ratelimit-remaining + a seconds-until x-ratelimit-reset into an absolute resetAt', async () => {
    const now = () => Date.parse('2026-07-11T13:10:00Z');
    const { fetchImpl } = recordingFetch(() =>
      sqlEndpointJson([], { 'x-ratelimit-remaining': '598', 'x-ratelimit-reset': '52' }),
    );
    const oi = createOssInsight({ fetchImpl, now });
    const page = await oi.trending('past_week');
    expect(page.rateWindow).toEqual({
      remaining: 598,
      resetAt: new Date(Date.parse('2026-07-11T13:10:00Z') + 52_000).toISOString(),
    });
  });

  test('headers absent → rateWindow is undefined, not fabricated', async () => {
    const { fetchImpl } = recordingFetch(() => sqlEndpointJson([]));
    const oi = createOssInsight({ fetchImpl });
    const page = await oi.trending('past_week');
    expect(page.rateWindow).toBeUndefined();
  });
});

describe('createOssInsight — error mapping', () => {
  test('a 5xx → SOURCE_DOWN', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('boom', { status: 500 }));
    const oi = createOssInsight({ fetchImpl });
    const err = (await oi.trending('past_week').catch((e) => e)) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
  });

  test('a network throw is SOURCE_DOWN, never a leaked exception', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const oi = createOssInsight({ fetchImpl });
    const err = (await oi.trending('past_week').catch((e) => e)) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
  });

  test('a non-5xx non-ok status → FETCH_FAILED', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('nope', { status: 418 }));
    const oi = createOssInsight({ fetchImpl });
    const err = (await oi.trending('past_week').catch((e) => e)) as EngineError;
    expect(err.code).toBe('FETCH_FAILED');
  });

  test('a malformed 2xx body fails loud (FETCH_FAILED), never a silent empty result', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('not json', { status: 200 }));
    const oi = createOssInsight({ fetchImpl });
    const err = (await oi.trending('past_week').catch((e) => e)) as EngineError;
    expect(err.code).toBe('FETCH_FAILED');
  });

  test('an unexpected 2xx JSON shape (no data.rows) → FETCH_FAILED', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ type: 'sql_endpoint' }), { status: 200 }),
    );
    const oi = createOssInsight({ fetchImpl });
    const err = (await oi.trending('past_week').catch((e) => e)) as EngineError;
    expect(err.code).toBe('FETCH_FAILED');
  });
});
