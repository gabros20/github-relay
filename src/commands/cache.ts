// `cache stats|clear|gc` — inspect or reclaim the local `~/.ghrelay` cache
// (design §3 item 14, §8). Entirely local: no Sources dependency, mirroring
// `rank`'s offline shape. `blobs/` deliberately holds BOTH 40-hex git blobs
// AND 64-hex sha256 etag bodies (task 3's accepted design) — every op below
// treats that directory as an opaque bag of content-addressed files and
// never assumes a git-blobs-only shape; gc's orphan sweep is the one place
// that DOES care about the distinction, and it does so by hex-length alone
// (64 = an etag body, eligible for orphan collection; 40 = a git blob,
// spared unconditionally, gc has no notion of when a blob is "unreferenced"
// since nothing tracks blob→referrer edges).
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Cache, EtagRecord } from '../cache/index.ts';
import { load, resolveCacheRoot, save } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import { EngineError } from '../types.ts';

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d, matching the documented usage default
const SIXTY_FOUR_HEX = /^[0-9a-f]{64}$/;
const DURATION_RE = /^(\d+)(d|h|m)$/;

export interface CacheOpts {
  subcommand?: string;
  olderThan?: string;
  confirm?: boolean;
}

export interface StoreStats {
  count: number;
  bytes: number;
}

export interface CacheStatsResult {
  root: string;
  etags: StoreStats;
  blobs: StoreStats;
  trees: StoreStats;
  tarballs: StoreStats;
  /** Only reported when this Cache instance is bound to the true default root (no override) — never a signal about an arbitrary --out corpus path, which stats never touches. */
  corpora?: StoreStats;
}

export interface CacheClearResult {
  cleared: string[];
}

export interface CacheGcResult {
  etagsPruned: number;
  tarballsRemoved: string[];
  orphanedBlobsRemoved: string[];
}

export type CacheResult = CacheStatsResult | CacheClearResult | CacheGcResult;

export interface CacheDeps {
  now?: () => number;
  /** Injectable for the "is this the default root" stats gate — defaults to the real `resolveCacheRoot`. */
  resolveDefaultRoot?: () => string;
}

export function cacheOptsFromArgs(parsed: ParsedArgs): CacheOpts {
  return {
    subcommand: parsed.positionals[0],
    olderThan: parsed.flags['older-than']?.[0],
    confirm: parsed.bools.has('confirm'),
  };
}

function dirStats(dir: string, excludeNames: ReadonlySet<string> = new Set()): StoreStats {
  if (!existsSync(dir)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    if (excludeNames.has(name)) continue;
    const st = statSync(join(dir, name));
    if (st.isDirectory()) continue; // every store here is a flat directory; a stray subdir is ignored, not walked
    count += 1;
    bytes += st.size;
  }
  return { count, bytes };
}

function etagsStats(cache: Cache): StoreStats {
  const bytes = existsSync(cache.paths.etagsFile) ? statSync(cache.paths.etagsFile).size : 0;
  const entries = load<Record<string, EtagRecord>>(cache.paths.etagsFile, {});
  return { count: Object.keys(entries).length, bytes };
}

function runStats(cache: Cache, deps: CacheDeps): CacheStatsResult {
  const resolveDefaultRoot = deps.resolveDefaultRoot ?? (() => resolveCacheRoot());
  const result: CacheStatsResult = {
    root: cache.paths.root,
    etags: etagsStats(cache),
    blobs: dirStats(cache.paths.blobsDir),
    trees: dirStats(cache.paths.treesDir),
    tarballs: dirStats(cache.paths.tarballsDir, new Set(['index.json'])),
  };
  if (cache.paths.root === resolveDefaultRoot()) {
    result.corpora = dirStats(cache.paths.corporaDir);
  }
  return result;
}

function wipeDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Wipes only stores rooted under THIS cache instance's resolved root — never an arbitrary `--out` corpus path, which lives outside cache.paths entirely and is never touched here. `budget.json` is deliberately spared: it's session rate-limit state, not a content cache. */
function runClear(cache: Cache, opts: CacheOpts): CacheClearResult {
  if (!opts.confirm) {
    throw new EngineError(
      'CONFIRMATION_REQUIRED',
      `cache clear wipes etags/blobs/trees/tarballs/corpora under ${cache.paths.root} — re-run with --confirm to proceed`,
    );
  }
  wipeDir(cache.paths.blobsDir);
  wipeDir(cache.paths.treesDir);
  wipeDir(cache.paths.tarballsDir);
  wipeDir(cache.paths.corporaDir);
  save(cache.paths.etagsFile, {});
  return { cleared: ['etags', 'blobs', 'trees', 'tarballs', 'corpora'] };
}

function parseOlderThan(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_AGE_MS;
  const m = DURATION_RE.exec(raw);
  if (!m) {
    throw new EngineError(
      'INVALID_INPUT',
      `--older-than must look like '30d', '12h', or '90m' (got '${raw}')`,
    );
  }
  const n = Number(m[1]);
  const unitMs = m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000;
  return n * unitMs;
}

/** 64-hex files in blobs/ are sha256 etag bodies; a body no longer referenced by any live etags.json entry is safe to drop. 40-hex git blobs are never inspected here — gc has no referrer-tracking for them, so it never claims to know one is unreferenced. */
function gcOrphanedEtagBodies(cache: Cache): string[] {
  if (!existsSync(cache.paths.blobsDir)) return [];
  const entries = load<Record<string, EtagRecord>>(cache.paths.etagsFile, {});
  const referenced = new Set(Object.values(entries).map((r) => r.bodyHash));
  const removed: string[] = [];
  for (const name of readdirSync(cache.paths.blobsDir)) {
    if (!SIXTY_FOUR_HEX.test(name) || referenced.has(name)) continue;
    unlinkSync(join(cache.paths.blobsDir, name));
    removed.push(name);
  }
  return removed;
}

/** Age-based prune, run in an order where pruning etags first is what MAKES a body orphaned (a stale etag entry aged out → its body is now unreferenced → collected in the same pass). */
function runGc(cache: Cache, opts: CacheOpts, now: () => number): CacheGcResult {
  const maxAgeMs = parseOlderThan(opts.olderThan);
  const { pruned } = cache.etags.prune(maxAgeMs, now);
  const { removed: tarballsRemoved } = cache.tarballs.gc(maxAgeMs, now);
  const orphanedBlobsRemoved = gcOrphanedEtagBodies(cache);
  return { etagsPruned: pruned, tarballsRemoved, orphanedBlobsRemoved };
}

export function runCache(cache: Cache, opts: CacheOpts, deps: CacheDeps = {}): CacheResult {
  const now = deps.now ?? Date.now;
  switch (opts.subcommand) {
    case 'stats':
      return runStats(cache, deps);
    case 'clear':
      return runClear(cache, opts);
    case 'gc':
      return runGc(cache, opts, now);
    default:
      throw new EngineError(
        'INVALID_INPUT',
        `cache subcommand must be one of stats|clear|gc (got '${opts.subcommand ?? ''}')`,
      );
  }
}
