// The ONLY module that speaks GitHub's REST surface (design §2). It applies the
// x-relay backoff discipline (read x-ratelimit-*, sleep until reset / honor
// retry-after exactly, maxRetries=3), passes/returns ETags for the cache layer
// (task 3), and follows the tarball 302 to codeload for streamed snapshots.
// Anti-scraping contract enforced by construction: the only hosts it will ever
// touch are api.github.com and codeload.github.com — never raw.githubusercontent,
// never HTML, never stats/*.
import { createWriteStream } from 'node:fs';
import { EngineError } from '../types.ts';
import { discardBody } from './http.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

const API = 'https://api.github.com';
const ALLOWED_TARBALL_HOSTS = new Set(['codeload.github.com', 'api.github.com']);
const API_VERSION = '2022-11-28';

export interface RestResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, raw text (for `raw`), or null on 304. A malformed 2xx throws. */
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
  ): Promise<{ path: string; bytes: number; headers: Headers }>;
}

/** A streaming write target so a tarball never has to be buffered in memory. */
export interface WriteSink {
  write(chunk: Uint8Array): void | Promise<void>;
  close(): Promise<void>;
}

export type CreateSink = (path: string) => WriteSink | Promise<WriteSink>;

export type GhRestDeps = Partial<Seams> & {
  getToken: () => Promise<string>;
  /** Streaming file-sink seam (defaults to a node:fs write stream) — injectable for tests. */
  createSink?: CreateSink;
};

const defaultCreateSink: CreateSink = (path) => {
  const stream = createWriteStream(path);
  return {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        stream.write(chunk, (err) => (err ? reject(err) : resolve()));
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      }),
  };
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
  try {
    const body = await res.json();
    return { status: 200, headers: res.headers, body, etag };
  } catch {
    // A 2xx we can't parse is a transport failure, not an empty result.
    throw new EngineError('FETCH_FAILED', 'malformed GitHub response body', 200);
  }
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

export function createGhRest(deps: GhRestDeps): GhRest {
  const { fetchImpl, sleep, now, maxRetries } = withSeamDefaults(deps);
  const { getToken } = deps;
  const createSink = deps.createSink ?? defaultCreateSink;

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
      if (status === 404) {
        await discardBody(res);
        throw new EngineError('NOT_FOUND', `not found: ${path}`, 404);
      }
      if (status === 401) {
        await discardBody(res);
        throw new EngineError('AUTH_FAILED', 'GitHub rejected the token (401).', 401);
      }

      if (!isRetryableLimit(res)) {
        await discardBody(res);
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
      if (attempt >= maxRetries) {
        await discardBody(res);
        throw limitError(res, wait);
      }
      // Release the limit response before sleeping so we don't hold a connection.
      await discardBody(res);
      await sleep(wait);
    }
  }

  /**
   * Resolve the tarball's actual byte-download location plus the api.github.com
   * response headers (needed by callers to update the restCore budget pool —
   * task 6 — since the second hop is codeload.github.com, a different host
   * that carries no GitHub rate-limit headers at all). `tarballUrl` and
   * `downloadTarball` both delegate here so the public `tarballUrl()` contract
   * (a bare string) stays unchanged.
   */
  async function resolveTarballTarget(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{ location: string; headers: Headers }> {
    const token = await getToken();
    const url = `${API}/repos/${owner}/${repo}/tarball/${ref}`;
    const res = await fetchOrThrow(url, { headers: buildHeaders(token), redirect: 'manual' });

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      assertAllowedHost(location);
      return { location, headers: res.headers };
    }
    // A runtime that auto-followed lands on a 200 at codeload; still enforce the host.
    if (res.status === 200 && res.url) {
      assertAllowedHost(res.url);
      return { location: res.url, headers: res.headers };
    }
    if (res.status === 404)
      throw new EngineError('NOT_FOUND', `no tarball for ${owner}/${repo}@${ref}`, 404);
    throw new EngineError('FETCH_FAILED', `unexpected tarball response ${res.status}`, res.status);
  }

  async function tarballUrl(owner: string, repo: string, ref: string): Promise<string> {
    return (await resolveTarballTarget(owner, repo, ref)).location;
  }

  async function streamToFile(
    body: ReadableStream<Uint8Array>,
    out: string,
    maxBytes: number | undefined,
  ): Promise<number> {
    const sink = await createSink(out);
    const reader = body.getReader();
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (maxBytes !== undefined && total > maxBytes) {
          throw new EngineError('FETCH_FAILED', `tarball exceeds the ${maxBytes}-byte size guard`);
        }
        await sink.write(value);
      }
    } finally {
      await sink.close();
    }
    return total;
  }

  /**
   * Fetch the codeload tarball with the second hop host-checked: `redirect:
   * 'manual'` so a codeload→elsewhere bounce is vetted (not blindly followed),
   * plus a final-URL host check for a runtime that auto-followed.
   */
  async function fetchTarballBytes(target: string, token: string): Promise<Response> {
    const headers = buildHeaders(token);
    let res = await fetchOrThrow(target, { headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await discardBody(res);
      if (!location) {
        throw new EngineError(
          'FETCH_FAILED',
          `tarball redirect without a location (${res.status})`,
        );
      }
      assertAllowedHost(location);
      res = await fetchOrThrow(location, { headers });
    }
    if (res.url) assertAllowedHost(res.url);
    return res;
  }

  async function downloadTarball(
    owner: string,
    repo: string,
    ref: string,
    opts: DownloadOptions,
  ): Promise<{ path: string; bytes: number; headers: Headers }> {
    const { location: target, headers } = await resolveTarballTarget(owner, repo, ref);
    const token = await getToken();
    const res = await fetchTarballBytes(target, token);
    if (!res.ok || !res.body) {
      await discardBody(res);
      throw new EngineError('FETCH_FAILED', `tarball download failed (${res.status})`, res.status);
    }
    const contentLength = Number(res.headers.get('content-length'));
    if (
      opts.maxBytes !== undefined &&
      Number.isFinite(contentLength) &&
      contentLength > opts.maxBytes
    ) {
      await discardBody(res);
      throw new EngineError('FETCH_FAILED', `tarball exceeds the ${opts.maxBytes}-byte size guard`);
    }
    const bytes = await streamToFile(res.body, opts.out, opts.maxBytes);
    return { path: opts.out, bytes, headers };
  }

  return { get, tarballUrl, downloadTarball };
}
