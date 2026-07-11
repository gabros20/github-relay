// `read` — targeted cached file reads (design §3 item 10, §7 ladder steps
// 0/1/3): when a tree is cached for the resolved ref, path→blob-sha
// resolution is local and the blob itself is content-addressed (immutable —
// repeat reads of the same blob are free, `cached:true`); otherwise falls
// back to `contents/{path}` pinned at the resolved sha. A missing path is
// expected absence (`ok:true, content:null, reason:'not in tree'`) with up
// to 5 nearest-path suggestions — never a hard error. Multi-path reads are
// strictly serialized; ANY hard error aborts the whole command (exit 1),
// since it propagates as a thrown EngineError rather than a per-path result.
import type { Cache, TreeEntry } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import type { GhRest } from '../sources/gh-rest.ts';
import { EngineError } from '../types.ts';
import { updateBudgetFromRestHeaders } from './_shared.ts';
import { parseOwnerRepo, resolveRefSha } from './extract-shared.ts';

const DEFAULT_MAX_CHARS = 6000;
const NEAREST_LIMIT = 5;
// Same shape cache/keys.ts's assertHexKey validates against (git SHA-1/SHA-256) —
// a --ref that already looks like a resolved commit sha skips resolution entirely.
const HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface ReadOpts {
  repo?: string;
  paths: string[];
  ref?: string;
  maxChars?: string;
}

export interface ReadSources {
  ghRest: Pick<GhRest, 'get'>;
}

export interface ReadEnvelope {
  path: string;
  ok: true;
  content: string | null;
  cached?: boolean;
  truncated?: boolean;
  reason?: string;
  nearest?: string[];
  sha?: string;
}

export interface ReadResult {
  repo: string;
  sha: string;
  ref?: string;
  results: ReadEnvelope[];
}

export function readOptsFromArgs(parsed: ParsedArgs): ReadOpts {
  return {
    repo: parsed.positionals[0],
    paths: parsed.positionals.slice(1),
    ref: parsed.flags.ref?.[0],
    maxChars: parsed.flags['max-chars']?.[0],
  };
}

function parseMaxChars(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_CHARS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new EngineError('INVALID_INPUT', `--max-chars must be a positive integer (got '${raw}')`);
  }
  return n;
}

/** Content-addressed dedup ambition aside, resolving an already-hex ref costs nothing to skip (it IS the commit sha). */
async function resolveSha(
  ghRest: ReadSources['ghRest'],
  cache: Cache,
  owner: string,
  repo: string,
  ref: string | undefined,
): Promise<string> {
  if (ref && HEX_SHA_RE.test(ref)) return ref;
  const resolved = await resolveRefSha(ghRest, cache, owner, repo, ref ?? 'HEAD');
  return resolved.sha;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Classic DP edit distance — "basename/levenshtein-lite" (design §3 item 10). */
function levenshtein(a: string, b: string): number {
  let prevRow: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const currRow: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const insertion = (currRow[j - 1] ?? 0) + 1;
      const deletion = (prevRow[j] ?? 0) + 1;
      const substitution = (prevRow[j - 1] ?? 0) + cost;
      currRow.push(Math.min(insertion, deletion, substitution));
    }
    prevRow = currRow;
  }
  return prevRow[b.length] ?? 0;
}

function nearestPaths(target: string, tree: TreeEntry[]): string[] {
  const targetBase = basename(target);
  return tree
    .map((e) => ({ path: e.path, dist: levenshtein(basename(e.path), targetBase) }))
    .sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.path.localeCompare(b.path)))
    .slice(0, NEAREST_LIMIT)
    .map((s) => s.path);
}

function finalize(
  path: string,
  content: string,
  maxChars: number,
  extra: { cached: boolean; sha: string },
): ReadEnvelope {
  const truncated = content.length > maxChars;
  const env: ReadEnvelope = {
    path,
    ok: true,
    content: truncated ? content.slice(0, maxChars) : content,
    cached: extra.cached,
    sha: extra.sha,
  };
  if (truncated) env.truncated = true;
  return env;
}

async function readFromCachedTree(
  sources: ReadSources,
  cache: Cache,
  owner: string,
  repo: string,
  path: string,
  tree: TreeEntry[],
  maxChars: number,
): Promise<ReadEnvelope> {
  const entry = tree.find((e) => e.path === path);
  if (!entry) {
    return {
      path,
      ok: true,
      content: null,
      reason: 'not in tree',
      nearest: nearestPaths(path, tree),
    };
  }
  const cached = cache.blobs.get(entry.sha);
  if (cached !== undefined) {
    return finalize(path, cached, maxChars, { cached: true, sha: entry.sha });
  }
  const res = await sources.ghRest.get(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`, {
    raw: true,
  });
  updateBudgetFromRestHeaders(cache, 'restCore', res.headers);
  const content = res.body as string;
  cache.blobs.put(entry.sha, content);
  return finalize(path, content, maxChars, { cached: false, sha: entry.sha });
}

interface ContentsBody {
  content?: string;
  encoding?: string;
  sha?: string;
  type?: string;
}

function decodeContent(body: ContentsBody): string {
  return body.encoding === 'base64' && body.content !== undefined
    ? Buffer.from(body.content, 'base64').toString('utf8')
    : (body.content ?? '');
}

async function readViaContentsApi(
  sources: ReadSources,
  cache: Cache,
  owner: string,
  repo: string,
  path: string,
  sha: string,
  maxChars: number,
): Promise<ReadEnvelope> {
  let res: Awaited<ReturnType<ReadSources['ghRest']['get']>>;
  try {
    res = await sources.ghRest.get(`/repos/${owner}/${repo}/contents/${path}?ref=${sha}`);
  } catch (e) {
    if (e instanceof EngineError && e.code === 'NOT_FOUND') {
      return { path, ok: true, content: null, reason: 'not in tree', nearest: [] };
    }
    throw e;
  }
  updateBudgetFromRestHeaders(cache, 'restCore', res.headers);
  const body = res.body as ContentsBody;
  if (body.type !== undefined && body.type !== 'file') {
    throw new EngineError('INVALID_INPUT', `'${path}' is a ${body.type}, not a readable file`);
  }
  if (!body.sha) {
    throw new EngineError('FETCH_FAILED', `contents response for '${path}' is missing a sha`);
  }
  const content = decodeContent(body);
  cache.blobs.put(body.sha, content);
  return finalize(path, content, maxChars, { cached: false, sha: body.sha });
}

async function readOnePath(
  sources: ReadSources,
  cache: Cache,
  owner: string,
  repo: string,
  path: string,
  sha: string,
  tree: TreeEntry[] | undefined,
  maxChars: number,
): Promise<ReadEnvelope> {
  if (tree) return readFromCachedTree(sources, cache, owner, repo, path, tree, maxChars);
  return readViaContentsApi(sources, cache, owner, repo, path, sha, maxChars);
}

export async function runRead(
  sources: ReadSources,
  cache: Cache,
  opts: ReadOpts,
): Promise<ReadResult> {
  const { owner, repo } = parseOwnerRepo(opts.repo);
  if (opts.paths.length === 0) {
    throw new EngineError(
      'INVALID_INPUT',
      'provide at least one path: read <owner/repo> <paths...>',
    );
  }
  const maxChars = parseMaxChars(opts.maxChars);
  const sha = await resolveSha(sources.ghRest, cache, owner, repo, opts.ref);
  const tree = cache.trees.get(sha);

  // Strictly serialized — never Promise.all over network calls (design constraint).
  const results: ReadEnvelope[] = [];
  for (const path of opts.paths) {
    results.push(await readOnePath(sources, cache, owner, repo, path, sha, tree, maxChars));
  }

  const result: ReadResult = { repo: `${owner}/${repo}`, sha, results };
  if (opts.ref) result.ref = opts.ref;
  return result;
}
