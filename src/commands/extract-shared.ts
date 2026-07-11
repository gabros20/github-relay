// Shared plumbing for the extraction-ladder commands (skim/read/digest —
// design §7, task 6): owner/repo parsing and the ONE ref→commit-SHA
// resolution every extraction command needs. `resolveRefSha` is the "resolve
// default-branch head SHA (1 conditional REST call)" step from design §3
// item 9 — ETag-cached via cache.etags so repeat resolutions against an
// unchanged ref come back 304 (ladder step 1, zero quota). `digest` calls
// this same function to "pin ref→commit SHA once, reuse skim's resolution"
// (design §3 item 11).
import type { Cache } from '../cache/index.ts';
import type { GhRest } from '../sources/gh-rest.ts';
import { EngineError } from '../types.ts';
import { updateBudgetFromRestHeaders } from './_shared.ts';

export function parseOwnerRepo(input: string | undefined): { owner: string; repo: string } {
  if (!input || !input.includes('/')) {
    throw new EngineError('INVALID_INPUT', `expected <owner/repo>, got '${input ?? ''}'`);
  }
  const parts = input.split('/');
  const [owner, repo] = parts;
  if (!owner || !repo || parts.length !== 2) {
    throw new EngineError('INVALID_INPUT', `expected exactly <owner/repo>, got '${input}'`);
  }
  return { owner, repo };
}

export interface HeadShaResult {
  sha: string;
  /** True when this call was a 304 (or otherwise served without a fresh fetch) — no quota spent. */
  cached: boolean;
}

interface CommitBody {
  sha?: string;
}

/**
 * Resolve `ref` (default `"HEAD"`, i.e. the default branch's tip) to a real
 * commit SHA via `GET /repos/{owner}/{repo}/commits/{ref}`, ETag-cached
 * end-to-end through `cache.etags` — a second call against an unchanged ref
 * is a 304 that reuses the cached sha, not a fresh fetch (design §7 ladder
 * step 1). The resolved sha is what `cache.trees`/`cache.tarballs` key on.
 */
export async function resolveRefSha(
  ghRest: Pick<GhRest, 'get'>,
  cache: Cache,
  owner: string,
  repo: string,
  ref = 'HEAD',
): Promise<HeadShaResult> {
  const url = `/repos/${owner}/${repo}/commits/${ref}`;
  const etagRecord = cache.etags.get(url);
  const res = await ghRest.get(url, { etag: etagRecord?.etag });
  updateBudgetFromRestHeaders(cache, 'restCore', res.headers);

  if (res.status === 304) {
    const body = etagRecord ? cache.etags.getBody(etagRecord.bodyHash) : undefined;
    if (body === undefined) {
      throw new EngineError('FETCH_FAILED', `304 for ${url} but no cached body on file`);
    }
    const parsed = JSON.parse(body) as CommitBody;
    if (!parsed.sha) {
      throw new EngineError('FETCH_FAILED', `cached commit body for ${url} has no sha`);
    }
    return { sha: parsed.sha, cached: true };
  }

  const body = res.body as CommitBody;
  if (!body.sha) {
    throw new EngineError('FETCH_FAILED', `commit response for ${owner}/${repo}@${ref} has no sha`);
  }
  if (res.etag) cache.etags.set(url, res.etag, JSON.stringify(res.body));
  return { sha: body.sha, cached: false };
}
