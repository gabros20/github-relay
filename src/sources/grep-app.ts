import { EngineError } from '../types.ts';
// The ONLY module that speaks grep.app's MCP-over-HTTP endpoint (design §2,
// §12 risk 2) — a free, no-SLA goodwill service, the code-token evidence
// lane's backing search index. A manual live probe during development
// (documented in the task-10 report) found the endpoint answers a stateless
// `tools/call` POST directly — no `initialize` handshake or session id is
// required first, unlike a long-lived MCP client session — so this adapter
// sends exactly one JSON-RPC request per search. The response always arrives
// as a single Server-Sent-Events `data:` frame (`content-type:
// text/event-stream`) even though nothing is actually streamed; the tool's
// name (`searchGitHub`) and its plain-text result format were both
// discovered live, not assumed. Circuit-breaker bookkeeping is NOT this
// adapter's job — it's a pure, single-shot transport; `commands/code.ts`
// owns the breaker (design's cache-owning-bookkeeping pattern, same split as
// `_shared.ts#updateBudgetFromGraphql`).
import { discardBody } from './http.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

const ENDPOINT = 'https://mcp.grep.app';
const USER_AGENT = 'github-relay (mailto:t.gabor880312@gmail.com)';
const TOOL_NAME = 'searchGitHub';
const SNIPPET_TRUNCATE_AT = 200;

export interface GrepAppSearchParams {
  query: string;
  lang?: string[];
  repo?: string;
  path?: string;
  useRegexp?: boolean;
  matchCase?: boolean;
  matchWholeWords?: boolean;
}

export interface GrepAppHit {
  repo: string;
  path: string;
  line: number;
  snippet: string;
  /** Best-effort, derived from the file extension — grep.app's tools/call result doesn't carry a per-hit language field. */
  lang?: string;
  license?: string;
  url?: string;
}

export interface GrepApp {
  search(params: GrepAppSearchParams): Promise<GrepAppHit[]>;
}

export type GrepAppDeps = Partial<Seams>;

// ── extension → language (best-effort; grep.app's response carries no per-hit language field) ──

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  jsx: 'JSX',
  mjs: 'JavaScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  sh: 'Shell',
  md: 'Markdown',
  yml: 'YAML',
  yaml: 'YAML',
  json: 'JSON',
};

function langFromPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return EXTENSION_LANGUAGE[path.slice(dot + 1).toLowerCase()];
}

// ── transport ────────────────────────────────────────────────────────────

function retryAfterMsFrom(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/**
 * Unwrap the single SSE `data: {...}` frame the endpoint answers a
 * `tools/call` POST with (live-probed: `content-type: text/event-stream`
 * even for a fully synchronous, non-streamed response). This tool call never
 * genuinely streams multiple frames; if more than one `data:` line ever
 * appears, the LAST one wins, so a late frame always overrides an earlier
 * partial one rather than the reverse.
 */
function parseSseJsonRpc(body: string): unknown {
  const dataLines = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  const last = dataLines[dataLines.length - 1];
  if (last === undefined) {
    throw new EngineError('FETCH_FAILED', 'grep.app returned no SSE data frame');
  }
  try {
    return JSON.parse(last);
  } catch {
    throw new EngineError('FETCH_FAILED', 'grep.app returned a malformed SSE data frame');
  }
}

async function postJsonRpc(
  fetchImpl: typeof fetch,
  body: Record<string, unknown>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new EngineError(
      'SOURCE_DOWN',
      `grep.app unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (res.status === 429) {
    const retryAfterMs = retryAfterMsFrom(res.headers);
    await discardBody(res);
    throw new EngineError('RATE_LIMITED', 'grep.app rate limit (429)', 429, retryAfterMs);
  }
  if (res.status >= 500) {
    await discardBody(res);
    throw new EngineError('SOURCE_DOWN', `grep.app is down (${res.status})`, res.status);
  }
  if (!res.ok) {
    await discardBody(res);
    throw new EngineError('FETCH_FAILED', `grep.app failed with status ${res.status}`, res.status);
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new EngineError('FETCH_FAILED', 'grep.app returned an unreadable response body');
  }
  return parseSseJsonRpc(text);
}

// ── JSON-RPC / tool-result shape ────────────────────────────────────────

interface ToolCallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** A malformed body here means the transport/protocol misbehaved (loud FETCH_FAILED per house rule) — distinct from `isError:true`, which is the tool answering cleanly that OUR query was bad. */
function asToolCallResult(payload: unknown): ToolCallResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new EngineError('FETCH_FAILED', 'grep.app returned a malformed JSON-RPC response');
  }
  const rpc = payload as { result?: unknown; error?: { message?: string } };
  if (rpc.error) {
    throw new EngineError(
      'FETCH_FAILED',
      `grep.app JSON-RPC error: ${rpc.error.message ?? 'unknown'}`,
    );
  }
  const result = rpc.result;
  if (
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray((result as ToolCallResult).content)
  ) {
    throw new EngineError('FETCH_FAILED', 'grep.app tool result is missing content[]');
  }
  return result as ToolCallResult;
}

/** `isError:true` is the tool cleanly reporting a bad query (e.g. an unclosed regex) — the caller's fault, not the service's, so it's INVALID_INPUT rather than a transport failure and never counts toward the circuit breaker. */
function rejectToolError(result: ToolCallResult): void {
  if (!result.isError) return;
  const message = result.content[0]?.text ?? 'grep.app rejected the query';
  throw new EngineError('INVALID_INPUT', `grep.app: ${message}`);
}

// ── plain-text result parsing (live-probed format, task-10 report) ─────

interface ParsedFile {
  repo: string;
  path: string;
  url: string;
  license?: string;
  snippets: { line: number; snippet: string }[];
}

const SNIPPET_HEADER_RE = /--- Snippet \d+ \(Line (\d+)\) ---\n/g;

/** One `content[]` text block per matched file: `Repository:`/`Path:`/`URL:`/`License:` header lines, then a `Snippets:` section with one or more `--- Snippet N (Line L) ---` blocks. A block with no `Repository:` line (e.g. "No results found for your query.") is a clean zero-hit answer, not an error — returns null. */
function parseContentBlock(text: string): ParsedFile | null {
  const repoMatch = text.match(/^Repository:\s*(.+)$/m);
  if (!repoMatch) return null;

  const pathMatch = text.match(/^Path:\s*(.+)$/m);
  const urlMatch = text.match(/^URL:\s*(.+)$/m);
  const licenseMatch = text.match(/^License:\s*(.+)$/m);
  const rawLicense = licenseMatch?.[1]?.trim();
  const license = rawLicense && rawLicense !== 'Unknown' ? rawLicense : undefined;

  const snippets: { line: number; snippet: string }[] = [];
  const headers = [...text.matchAll(SNIPPET_HEADER_RE)];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (!header?.[1] || header.index === undefined) continue;
    const start = header.index + header[0].length;
    const end = headers[i + 1]?.index ?? text.length;
    const body = text.slice(start, end).replace(/\n+$/, '');
    snippets.push({ line: Number(header[1]), snippet: body });
  }

  return {
    repo: repoMatch[1]?.trim() ?? '',
    path: pathMatch?.[1]?.trim() ?? '',
    url: urlMatch?.[1]?.trim() ?? '',
    license,
    snippets,
  };
}

function truncateSnippet(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > SNIPPET_TRUNCATE_AT
    ? `${trimmed.slice(0, SNIPPET_TRUNCATE_AT)}…`
    : trimmed;
}

// ── adapter ──────────────────────────────────────────────────────────────

export function createGrepApp(deps: GrepAppDeps = {}): GrepApp {
  const { fetchImpl } = withSeamDefaults(deps);

  async function search(params: GrepAppSearchParams): Promise<GrepAppHit[]> {
    const args: Record<string, unknown> = { query: params.query };
    if (params.repo !== undefined) args.repo = params.repo;
    if (params.path !== undefined) args.path = params.path;
    if (params.lang && params.lang.length > 0) args.language = params.lang;
    if (params.useRegexp !== undefined) args.useRegexp = params.useRegexp;
    if (params.matchCase !== undefined) args.matchCase = params.matchCase;
    if (params.matchWholeWords !== undefined) args.matchWholeWords = params.matchWholeWords;

    const payload = await postJsonRpc(fetchImpl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: TOOL_NAME, arguments: args },
    });

    const result = asToolCallResult(payload);
    rejectToolError(result);

    const hits: GrepAppHit[] = [];
    for (const block of result.content) {
      const parsed = parseContentBlock(block.text);
      if (!parsed) continue;
      for (const s of parsed.snippets) {
        hits.push({
          repo: parsed.repo,
          path: parsed.path,
          line: s.line,
          snippet: truncateSnippet(s.snippet),
          lang: langFromPath(parsed.path),
          license: parsed.license,
          url: parsed.url,
        });
      }
    }
    return hits;
  }

  return { search };
}
