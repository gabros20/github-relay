import { describe, expect, test } from 'bun:test';
import { createGrepApp } from '../../src/sources/grep-app.ts';
import type { EngineError } from '../../src/types.ts';

// ── fixture helpers ─────────────────────────────────────────────────────

/** SSE-wraps a JSON-RPC payload exactly the way the live endpoint answers a `tools/call` POST (task-10 report: `content-type: text/event-stream` even for a fully synchronous response). */
function sseResponse(payload: unknown, init: ResponseInit = {}): Response {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

function toolCallResponse(content: { type: 'text'; text: string }[], isError = false): Response {
  return sseResponse({
    jsonrpc: '2.0',
    id: 1,
    result: { content, isError },
  });
}

function fileBlock(overrides: {
  repo?: string;
  path?: string;
  url?: string;
  license?: string;
  snippets?: string;
}): string {
  const {
    repo = 'octocat/Hello-World',
    path = 'src/index.ts',
    url = 'https://github.com/octocat/Hello-World/blob/main/src/index.ts',
    license = 'MIT',
    snippets = '--- Snippet 1 (Line 10) ---\nconst x = useState(0);\n',
  } = overrides;
  return `Repository: ${repo}\nPath: ${path}\nURL: ${url}\nLicense: ${license}\n\nSnippets:\n${snippets}`;
}

function recordingFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function expectEngineError(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (e) {
    return e as EngineError;
  }
  throw new Error('expected the promise to reject');
}

// ── request shape ────────────────────────────────────────────────────────

describe('grep-app search — JSON-RPC request shape', () => {
  test('POSTs a tools/call envelope naming searchGitHub, with query as the only required arg', async () => {
    const { fetchImpl, calls } = recordingFetch(() => toolCallResponse([]));
    const grepApp = createGrepApp({ fetchImpl });
    await grepApp.search({ query: 'useState(' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://mcp.grep.app');
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'searchGitHub', arguments: { query: 'useState(' } },
    });
  });

  test('maps lang/repo/path/useRegexp/matchCase/matchWholeWords onto the tool arguments', async () => {
    const { fetchImpl, calls } = recordingFetch(() => toolCallResponse([]));
    const grepApp = createGrepApp({ fetchImpl });
    await grepApp.search({
      query: '(?s)useEffect\\(',
      lang: ['TypeScript', 'TSX'],
      repo: 'facebook/react',
      path: 'src/',
      useRegexp: true,
      matchCase: true,
      matchWholeWords: false,
    });

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.params.arguments).toEqual({
      query: '(?s)useEffect\\(',
      language: ['TypeScript', 'TSX'],
      repo: 'facebook/react',
      path: 'src/',
      useRegexp: true,
      matchCase: true,
      matchWholeWords: false,
    });
  });

  test('sends the polite-pool UA and both accept types the endpoint requires', async () => {
    const { fetchImpl, calls } = recordingFetch(() => toolCallResponse([]));
    const grepApp = createGrepApp({ fetchImpl });
    await grepApp.search({ query: 'useState(' });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('github-relay (mailto:t.gabor880312@gmail.com)');
    expect(headers.Accept).toBe('application/json, text/event-stream');
  });
});

// ── success parsing ──────────────────────────────────────────────────────

describe('grep-app search — parsing a successful result', () => {
  test('one content block, one snippet → one hit with repo/path/line/snippet/license/url/lang', async () => {
    const { fetchImpl } = recordingFetch(() =>
      toolCallResponse([{ type: 'text', text: fileBlock({}) }]),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const hits = await grepApp.search({ query: 'useState(' });

    expect(hits).toEqual([
      {
        repo: 'octocat/Hello-World',
        path: 'src/index.ts',
        line: 10,
        snippet: 'const x = useState(0);',
        lang: 'TypeScript',
        license: 'MIT',
        url: 'https://github.com/octocat/Hello-World/blob/main/src/index.ts',
      },
    ]);
  });

  test('multiple snippets in one file block become multiple hits, sharing repo/path/license/url', async () => {
    const block = fileBlock({
      snippets:
        '--- Snippet 1 (Line 10) ---\nconst [a, setA] = useState(0);\n\n\n' +
        '--- Snippet 2 (Line 42) ---\nconst [b, setB] = useState(false);\n',
    });
    const { fetchImpl } = recordingFetch(() => toolCallResponse([{ type: 'text', text: block }]));
    const grepApp = createGrepApp({ fetchImpl });
    const hits = await grepApp.search({ query: 'useState(' });

    expect(hits).toHaveLength(2);
    expect(hits[0]?.line).toBe(10);
    expect(hits[0]?.snippet).toBe('const [a, setA] = useState(0);');
    expect(hits[1]?.line).toBe(42);
    expect(hits[1]?.snippet).toBe('const [b, setB] = useState(false);');
    expect(hits[1]?.repo).toBe('octocat/Hello-World');
  });

  test('multiple file blocks each contribute their own hits', async () => {
    const { fetchImpl } = recordingFetch(() =>
      toolCallResponse([
        { type: 'text', text: fileBlock({ repo: 'a/one', path: 'a.ts' }) },
        { type: 'text', text: fileBlock({ repo: 'b/two', path: 'b.py' }) },
      ]),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const hits = await grepApp.search({ query: 'useState(' });
    expect(hits.map((h) => h.repo)).toEqual(['a/one', 'b/two']);
    expect(hits.map((h) => h.lang)).toEqual(['TypeScript', 'Python']);
  });

  test('"License: Unknown" becomes an absent license, not the literal string', async () => {
    const { fetchImpl } = recordingFetch(() =>
      toolCallResponse([{ type: 'text', text: fileBlock({ license: 'Unknown' }) }]),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const hits = await grepApp.search({ query: 'useState(' });
    expect(hits[0]?.license).toBeUndefined();
  });

  test('a snippet longer than ~200 chars is truncated with a trailing ellipsis', async () => {
    const longLine = 'x'.repeat(250);
    const block = fileBlock({ snippets: `--- Snippet 1 (Line 1) ---\n${longLine}\n` });
    const { fetchImpl } = recordingFetch(() => toolCallResponse([{ type: 'text', text: block }]));
    const grepApp = createGrepApp({ fetchImpl });
    const hits = await grepApp.search({ query: 'x'.repeat(10) });
    expect(hits[0]?.snippet.length).toBe(201); // 200 chars + '…'
    expect(hits[0]?.snippet.endsWith('…')).toBe(true);
  });

  test('a "no results" text block yields zero hits, not an error', async () => {
    const { fetchImpl } = recordingFetch(() =>
      toolCallResponse([{ type: 'text', text: 'No results found for your query.' }]),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const hits = await grepApp.search({ query: 'zzzznonexistentzzzz' });
    expect(hits).toEqual([]);
  });

  test('an unrecognized file extension leaves lang undefined rather than guessing', async () => {
    const { fetchImpl } = recordingFetch(() =>
      toolCallResponse([{ type: 'text', text: fileBlock({ path: 'Makefile' }) }]),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const hits = await grepApp.search({ query: 'useState(' });
    expect(hits[0]?.lang).toBeUndefined();
  });
});

// ── error classification ────────────────────────────────────────────────

describe('grep-app search — error classification', () => {
  test('429 → RATE_LIMITED, carrying retryAfterMs from the retry-after header', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: 'useState(' }));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterMs).toBe(30000);
  });

  test('a 5xx status → SOURCE_DOWN', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('boom', { status: 502 }));
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: 'useState(' }));
    expect(err.code).toBe('SOURCE_DOWN');
  });

  test('a network-level throw (fetch rejects) → SOURCE_DOWN', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: 'useState(' }));
    expect(err.code).toBe('SOURCE_DOWN');
  });

  test('some other non-2xx status (e.g. 404) → FETCH_FAILED', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('nope', { status: 404 }));
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: 'useState(' }));
    expect(err.code).toBe('FETCH_FAILED');
  });

  test('a malformed (non-SSE, unparseable) body → FETCH_FAILED', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('not sse at all', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: 'useState(' }));
    expect(err.code).toBe('FETCH_FAILED');
  });

  test('an SSE data frame that is not valid JSON → FETCH_FAILED', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('event: message\ndata: { not json\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: 'useState(' }));
    expect(err.code).toBe('FETCH_FAILED');
  });

  test('a top-level JSON-RPC error object → FETCH_FAILED', async () => {
    const { fetchImpl } = recordingFetch(() =>
      sseResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Tool not found' } }),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: 'useState(' }));
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.message).toContain('Tool not found');
  });

  test('a result missing content[] → FETCH_FAILED', async () => {
    const { fetchImpl } = recordingFetch(() =>
      sseResponse({ jsonrpc: '2.0', id: 1, result: { notContent: true } }),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: 'useState(' }));
    expect(err.code).toBe('FETCH_FAILED');
  });

  test('the tool cleanly reporting a bad query (isError:true) → INVALID_INPUT, not a transport failure', async () => {
    const { fetchImpl } = recordingFetch(() =>
      toolCallResponse(
        [{ type: 'text', text: 'Error executing query: missing closing ): `(unclosed`' }],
        true,
      ),
    );
    const grepApp = createGrepApp({ fetchImpl });
    const err = await expectEngineError(grepApp.search({ query: '(unclosed', useRegexp: true }));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('unclosed');
  });
});
