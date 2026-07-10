// The ONLY module that speaks GitHub's REST surface (design §2). It applies the
// x-relay backoff discipline (read x-ratelimit-*, sleep until reset / honor
// retry-after exactly, maxRetries=3), passes/returns ETags for the cache layer
// (task 3), and follows the tarball 302 to codeload for streamed snapshots.
// Anti-scraping contract enforced by construction: the only hosts it will ever
// touch are api.github.com and codeload.github.com — never raw.githubusercontent,
// never HTML, never stats/*.
import { EngineError } from '../types.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

const API = 'https://api.github.com';
const ALLOWED_TARBALL_HOSTS = new Set(['codeload.github.com', 'api.github.com']);
const API_VERSION = '2022-11-28';

export interface RestResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, raw text (for `raw`), or null on 304 / unparseable body. */
  body: unknown;
  etag: string | null;
}

export interface GetOptions {
  /** Request the raw media type (readme/contents) and return text. */
  raw?: boolean;
  /** Conditional GET: sent as If-None-Match; a 304 comes back distinctly. */
  etag?: string;
}

export interface DownloadOptions {
  out: string;
  /** Refuse (and don't write) a tarball larger than this — digest falls back to a clone. */
  maxBytes?: number;
}

export interface GhRest {
  get(path: string, opts?: GetOptions): Promise<RestResponse>;
  tarballUrl(owner: string, repo: string, ref: string): Promise<string>;
  downloadTarball(
    owner: string,
    repo: string,
    ref: string,
    opts: DownloadOptions,
  ): Promise<{ path: string; bytes: number }>;
}

export type GhRestDeps = Partial<Seams> & {
  getToken: () => Promise<string>;
  /** File-write seam (defaults to Bun.write) — injectable for tests. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>;
};

function buildHeaders(token: string, opts: GetOptions = {}): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'github-relay',
    'X-GitHub-Api-Version': API_VERSION,
    Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
  };
  if (opts.etag) h['If-None-Match'] = opts.etag;
  return h;
}

/** A 429, or a 403 that is really a limit (retry-after present, or quota exhausted). */
function isRetryableLimit(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status === 403) {
    return (
      res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0'
    );
  }
  return false;
}

/** ms to wait: retry-after (honored exactly) → x-ratelimit-reset window → 1000ms default. */
function waitMs(res: Response, now: () => number): number {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter !== null) return Number(retryAfter) * 1000;
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset !== null) {
    const until = Number(reset) * 1000 - now();
    return until > 0 ? until : 1000;
  }
  return 1000;
}

function limitError(res: Response, wait: number): EngineError {
  // A retry-after header is the secondary/abuse signal; a bare 429/403 with an
  // exhausted quota is the primary limit.
  const secondary = res.headers.get('retry-after') !== null;
  return secondary
    ? new EngineError(
        'ABUSE_DETECTED',
        `GitHub secondary rate limit (${res.status}).`,
        res.status,
        wait,
      )
    : new EngineError('RATE_LIMITED', `GitHub rate limit (${res.status}).`, res.status, wait);
}

async function readResponse(res: Response, opts: GetOptions): Promise<RestResponse> {
  const etag = res.headers.get('etag');
  if (opts.raw) return { status: 200, headers: res.headers, body: await res.text(), etag };
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: 200, headers: res.headers, body, etag };
}

function assertAllowedHost(location: string): void {
  let host: string;
  try {
    host = new URL(location).host;
  } catch {
    throw new EngineError('FETCH_FAILED', `unparseable redirect target: ${location}`);
  }
  if (!ALLOWED_TARBALL_HOSTS.has(host)) {
    throw new EngineError('FETCH_FAILED', `refusing tarball redirect to disallowed host: ${host}`);
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function createGhRest(deps: GhRestDeps): GhRest {
  const { fetchImpl, sleep, now, maxRetries } = withSeamDefaults(deps);
  const { getToken } = deps;
  const writeFile = deps.writeFile ?? (async (path, data) => void (await Bun.write(path, data)));

  async function fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, init);
    } catch (e) {
      throw new EngineError('FETCH_FAILED', e instanceof Error ? e.message : String(e));
    }
  }

  async function get(path: string, opts: GetOptions = {}): Promise<RestResponse> {
    const token = await getToken();
    const url = `${API}${path}`;
    const headers = buildHeaders(token, opts);

    for (let attempt = 0; ; attempt++) {
      const res = await fetchOrThrow(url, { headers });
      const { status } = res;
      if (status === 200) return await readResponse(res, opts);
      if (status === 304) {
        return { status: 304, headers: res.headers, body: null, etag: res.headers.get('etag') };
      }
      if (status === 404) throw new EngineError('NOT_FOUND', `not found: ${path}`, 404);
      if (status === 401)
        throw new EngineError('AUTH_FAILED', 'GitHub rejected the token (401).', 401);

      if (!isRetryableLimit(res)) {
        if (status === 403) {
          throw new EngineError(
            'AUTH_FAILED',
            'GitHub returned 403 (token scope/permission).',
            403,
          );
        }
        throw new EngineError('FETCH_FAILED', `GitHub REST failed with status ${status}.`, status);
      }

      const wait = waitMs(res, now);
      if (attempt >= maxRetries) throw limitError(res, wait);
      await sleep(wait);
    }
  }

  async function tarballUrl(owner: string, repo: string, ref: string): Promise<string> {
    const token = await getToken();
    const url = `${API}/repos/${owner}/${repo}/tarball/${ref}`;
    const res = await fetchOrThrow(url, { headers: buildHeaders(token), redirect: 'manual' });

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      assertAllowedHost(location);
      return location;
    }
    // A runtime that auto-followed lands on a 200 at codeload; still enforce the host.
    if (res.status === 200 && res.url) {
      assertAllowedHost(res.url);
      return res.url;
    }
    if (res.status === 404)
      throw new EngineError('NOT_FOUND', `no tarball for ${owner}/${repo}@${ref}`, 404);
    throw new EngineError('FETCH_FAILED', `unexpected tarball response ${res.status}`, res.status);
  }

  async function streamToFile(
    body: ReadableStream<Uint8Array>,
    out: string,
    maxBytes: number | undefined,
  ): Promise<number> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        throw new EngineError('FETCH_FAILED', `tarball exceeds the ${maxBytes}-byte size guard`);
      }
      chunks.push(value);
    }
    await writeFile(out, concatChunks(chunks, total));
    return total;
  }

  async function downloadTarball(
    owner: string,
    repo: string,
    ref: string,
    opts: DownloadOptions,
  ): Promise<{ path: string; bytes: number }> {
    const target = await tarballUrl(owner, repo, ref);
    const token = await getToken();
    const res = await fetchOrThrow(target, { headers: buildHeaders(token) });
    if (!res.ok || !res.body) {
      throw new EngineError('FETCH_FAILED', `tarball download failed (${res.status})`, res.status);
    }
    const contentLength = Number(res.headers.get('content-length'));
    if (
      opts.maxBytes !== undefined &&
      Number.isFinite(contentLength) &&
      contentLength > opts.maxBytes
    ) {
      throw new EngineError('FETCH_FAILED', `tarball exceeds the ${opts.maxBytes}-byte size guard`);
    }
    const bytes = await streamToFile(res.body, opts.out, opts.maxBytes);
    return { path: opts.out, bytes };
  }

  return { get, tarballUrl, downloadTarball };
}
