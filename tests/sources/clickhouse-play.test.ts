import { describe, expect, test } from 'bun:test';
import {
  buildMonthlyEventsQuery,
  createClickhousePlay,
  isSafeRepoName,
} from '../../src/sources/clickhouse-play.ts';
import type { EngineError } from '../../src/types.ts';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal?: AbortSignal;
}

function recordingFetch(handler: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ''),
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A ClickHouse JSON response: UInt64 counts arrive as strings, dates as YYYY-MM-DD. */
function clickhouseJson(
  rows: { repo_name: string; month: string; event_type: string; cnt: number | string }[],
): Response {
  return Response.json({
    meta: [],
    data: rows.map((r) => ({ ...r, cnt: String(r.cnt) })),
    rows: rows.length,
  });
}

describe('isSafeRepoName — strict owner/repo charset (SQL-injection guard)', () => {
  test('accepts ordinary owner/repo ids incl. dots, hyphens, underscores', () => {
    expect(isSafeRepoName('facebook/react')).toBe(true);
    expect(isSafeRepoName('zed-industries/zed')).toBe(true);
    expect(isSafeRepoName('a/b.c_d-e')).toBe(true);
    expect(isSafeRepoName('Micro-Soft/vs.code_1')).toBe(true);
  });

  test('rejects anything that could break out of the quoted literal', () => {
    expect(isSafeRepoName("a/b'; DROP TABLE github_events;--")).toBe(false);
    expect(isSafeRepoName('a/b OR 1=1')).toBe(false);
    expect(isSafeRepoName('a/b)')).toBe(false);
    expect(isSafeRepoName("a/b'")).toBe(false);
    expect(isSafeRepoName('a/b"')).toBe(false);
    expect(isSafeRepoName('no-slash')).toBe(false);
    expect(isSafeRepoName('a/b/c')).toBe(false);
    expect(isSafeRepoName('')).toBe(false);
    expect(isSafeRepoName('/b')).toBe(false);
    expect(isSafeRepoName('a/')).toBe(false);
    expect(isSafeRepoName('a b/c')).toBe(false);
  });
});

describe('buildMonthlyEventsQuery — pure SQL builder', () => {
  test('a hostile repo name never reaches the query — it throws INVALID_INPUT instead', () => {
    const err = ((): EngineError | undefined => {
      try {
        buildMonthlyEventsQuery(['facebook/react', "evil/repo'; DROP TABLE x;--"]);
      } catch (e) {
        return e as EngineError;
      }
    })();
    expect(err?.code).toBe('INVALID_INPUT');
  });

  test('emits one IN(...) list over the whole id set with the three event types', () => {
    const sql = buildMonthlyEventsQuery(['facebook/react', 'vercel/next.js']);
    expect(sql).toContain("IN ('facebook/react', 'vercel/next.js')");
    expect(sql).toContain('WatchEvent');
    expect(sql).toContain('IssuesEvent');
    expect(sql).toContain('ForkEvent');
    expect(sql).toContain('github_events');
    expect(sql).toContain('toStartOfMonth');
    // Each repo name is individually single-quoted; no injection metacharacters leak through.
    expect(sql).toContain("'facebook/react'");
    expect(sql).toContain("'vercel/next.js'");
    expect(sql).not.toContain(';');
    expect(sql).not.toContain('--');
  });
});

describe('createClickhousePlay — one POST for the whole set', () => {
  test('POSTs the SQL to the play endpoint with default_format=JSON and the polite UA', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      clickhouseJson([
        { repo_name: 'facebook/react', month: '2015-06-01', event_type: 'WatchEvent', cnt: 10 },
      ]),
    );
    const ch = createClickhousePlay({ fetchImpl });
    await ch.monthlyEvents(['facebook/react', 'vercel/next.js']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://play.clickhouse.com/?user=play&default_format=JSON');
    expect(calls[0]?.headers.get('user-agent')).toBe(
      'github-relay (mailto:t.gabor880312@gmail.com)',
    );
    expect(calls[0]?.body).toContain("IN ('facebook/react', 'vercel/next.js')");
  });

  test('parses UInt64-string counts and YYYY-MM-DD months into typed rows', async () => {
    const { fetchImpl } = recordingFetch(() =>
      clickhouseJson([
        { repo_name: 'a/b', month: '2021-01-01', event_type: 'WatchEvent', cnt: 500 },
        { repo_name: 'a/b', month: '2021-02-01', event_type: 'IssuesEvent', cnt: 3 },
      ]),
    );
    const ch = createClickhousePlay({ fetchImpl });
    const rows = await ch.monthlyEvents(['a/b']);
    expect(rows).toEqual([
      { repo_name: 'a/b', month: '2021-01-01', event_type: 'WatchEvent', stars: 500 },
      { repo_name: 'a/b', month: '2021-02-01', event_type: 'IssuesEvent', stars: 3 },
    ]);
  });

  test('an empty id set makes no request and returns []', async () => {
    const { fetchImpl, calls } = recordingFetch(() => clickhouseJson([]));
    const ch = createClickhousePlay({ fetchImpl });
    expect(await ch.monthlyEvents([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('a 5xx → SOURCE_DOWN (F degrades to partial)', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('overloaded', { status: 503 }));
    const ch = createClickhousePlay({ fetchImpl });
    const err = (await ch.monthlyEvents(['a/b']).catch((e) => e)) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
  });

  test('a network throw is SOURCE_DOWN, never a leaked exception', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const ch = createClickhousePlay({ fetchImpl });
    const err = (await ch.monthlyEvents(['a/b']).catch((e) => e)) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
  });

  test('a hung request past the hard timeout aborts → SOURCE_DOWN, no hang', async () => {
    const { fetchImpl } = recordingFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          // Never resolves on its own — only the abort signal settles it.
          call.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const ch = createClickhousePlay({ fetchImpl, timeoutMs: 15 });
    const err = (await ch.monthlyEvents(['a/b']).catch((e) => e)) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
  });

  test('a malformed 2xx body fails loud (FETCH_FAILED), never a silent empty result', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('not json', { status: 200 }));
    const ch = createClickhousePlay({ fetchImpl });
    const err = (await ch.monthlyEvents(['a/b']).catch((e) => e)) as EngineError;
    expect(err.code).toBe('FETCH_FAILED');
  });
});
