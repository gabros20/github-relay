// Cache-root ownership guard (quality-review fix wave 1): `cache clear`/`gc`
// must refuse to touch a directory that doesn't demonstrably belong to us —
// a misconfigured `GHRELAY_CACHE_DIR` pointed at a real, unrelated directory
// (one that merely happens to contain subfolders NAMED blobs/trees/corpora)
// must never be silently wiped. A `.ghrelay` marker file at the cache root
// is the ownership proof: `ensureMarker` is called from every cache-layer
// store write (createCache's setters), so a fresh root gets stamped the
// first time anything is actually written through OUR code — deletion
// commands then simply require the marker to exist.
//
// `looksLikeExistingGhrelayRoot` exists ONLY for one-time migration: a root
// populated by a pre-marker-era github-relay (so it has no marker yet, but
// does have our own store artifacts) must not lock existing users out. It is
// deliberately schema-specific — checking for OUR exact file shapes
// (budget.json's `learnedCeilings` key, a bare hex-named file under blobs/)
// — and never a bare "some file exists under a same-named folder" check,
// which is exactly the operator-misconfiguration scenario this guard exists
// to catch.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CachePaths } from './paths.ts';
import { load, writeFileAtomic } from './store.ts';

export const MARKER_FILENAME = '.ghrelay';
export const MARKER_SCHEMA = 'github-relay/cache-root@1';

export interface CacheMarker {
  schema: typeof MARKER_SCHEMA;
  createdAt: string;
}

const HEX_KEY_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function markerPath(root: string): string {
  return join(root, MARKER_FILENAME);
}

export function hasMarker(root: string): boolean {
  return existsSync(markerPath(root));
}

/** Idempotent: a no-op once the marker exists, so every call site can call it unconditionally and cheaply (one existsSync). */
export function ensureMarker(root: string, now: () => number = Date.now): void {
  if (hasMarker(root)) return;
  const marker: CacheMarker = { schema: MARKER_SCHEMA, createdAt: new Date(now()).toISOString() };
  writeFileAtomic(markerPath(root), `${JSON.stringify(marker, null, 2)}\n`);
}

/** `load` never throws — a missing or corrupt file simply falls back to `undefined`, which correctly reads as "not evidence of ownership" either way. */
function hasOurBudgetShape(paths: CachePaths): boolean {
  const parsed = load<{ learnedCeilings?: unknown } | undefined>(paths.budgetFile, undefined);
  return parsed !== undefined && typeof parsed === 'object' && 'learnedCeilings' in parsed;
}

function hasOurEtagsShape(paths: CachePaths): boolean {
  const parsed = load<unknown>(paths.etagsFile, undefined);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/** A bare 40/64-hex filename is our content-addressed blob-key convention (assertHexKey) — distinctive enough that a coincidental collision in an unrelated directory is implausible. */
function dirHasHexKeyedFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => HEX_KEY_RE.test(name));
}

/** One-time adoption signal for a pre-marker-era root — schema-specific by construction (see module doc); never a bare "a file exists here" check. */
export function looksLikeExistingGhrelayRoot(paths: CachePaths): boolean {
  return hasOurBudgetShape(paths) || hasOurEtagsShape(paths) || dirHasHexKeyedFile(paths.blobsDir);
}
