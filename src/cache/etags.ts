// URL → {etag, bodyHash, cachedAt} conditional-GET cache (design §8,
// extraction ladder step 1 — "the single biggest quota multiplier"). The
// response body is stored alongside via the blob store so a 304 can serve
// what was cached without a re-fetch; bodyHash is a plain content hash (not
// a git blob SHA) but reuses the same immutable, content-addressed storage.
import { createHash } from 'node:crypto';
import { getBlob, putBlob } from './blobs.ts';
import { load, save } from './store.ts';

export interface EtagRecord {
  etag: string;
  bodyHash: string;
  cachedAt: string;
}

type EtagsFile = Record<string, EtagRecord>;

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function getEtag(etagsFile: string, url: string): EtagRecord | undefined {
  return load<EtagsFile>(etagsFile, {})[url];
}

export function getCachedBody(blobsDir: string, bodyHash: string): string | undefined {
  return getBlob(blobsDir, bodyHash);
}

export function setEtag(
  etagsFile: string,
  blobsDir: string,
  url: string,
  etag: string,
  body: string,
  now: () => number = Date.now,
): EtagRecord {
  const bodyHash = hashBody(body);
  putBlob(blobsDir, bodyHash, body);
  const entries = load<EtagsFile>(etagsFile, {});
  const record: EtagRecord = { etag, bodyHash, cachedAt: new Date(now()).toISOString() };
  entries[url] = record;
  save(etagsFile, entries);
  return record;
}

/** Drop entries older than `maxAgeMs`. The bodies they reference are left in the blob store. */
export function pruneEtags(
  etagsFile: string,
  maxAgeMs: number,
  now: () => number = Date.now,
): { pruned: number } {
  const entries = load<EtagsFile>(etagsFile, {});
  const cutoff = now() - maxAgeMs;
  let pruned = 0;
  for (const [url, record] of Object.entries(entries)) {
    if (Date.parse(record.cachedAt) >= cutoff) continue;
    delete entries[url];
    pruned += 1;
  }
  if (pruned > 0) save(etagsFile, entries);
  return { pruned };
}
