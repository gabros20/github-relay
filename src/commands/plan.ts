// `plan` — GATE 0 (design §3 item 1, §6): validate agent-written query slices
// offline before spending anything, and optionally `--probe` their result
// counts (1 GraphQL point each, serialized, 500ms apart), auto-sharding any
// slice over the 1,000-result cap by iteratively re-probing each half until
// every leaf is under the cap or a hard policy floor is hit (design §1 row 8
// — the "naive one-shot split" weakness repo-relay shipped is fixed here by
// ALWAYS re-probing a shard and recursing on it, never trusting one split).
//
// Sharding model: a slice's stars:/created: qualifier (if any) defines a
// [lo, hi] window; splitting REPLACES that qualifier with two narrower,
// gap-free, non-overlapping windows — never appends a second qualifier for
// the same field, so a shard can never carry a contradictory `stars:>X` next
// to an existing `stars:10..50` (design §3 item 1's explicit requirement).
// When the active dimension's window can no longer be split (already at a
// single value, or — for created: — already down to sub-month width), the
// splitter switches to the OTHER dimension; when both are exhausted (or the
// depth cap of 5 is reached) the shard is reported as a leaf with a
// `hint` explaining why, never silently dropped.
import { writeFileSync } from 'node:fs';
import type { Cache } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import { type ProgressReporter, progressReporter } from '../progress.ts';
import type { GhGraphql } from '../sources/gh-graphql.ts';
import { defaultSleep } from '../sources/seams.ts';
import { EngineError } from '../types.ts';
import {
  parseQueryLines,
  probeRepositoryCount,
  updateBudgetFromGraphql,
  validateQuerySyntax,
} from './_shared.ts';

const RESULT_CAP = 1000;
const MAX_SHARD_DEPTH = 5;
const PROBE_DELAY_MS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
/** GitHub's own founding date (2008-04-10), rounded down to the year — the floor for an unbounded created: window. */
const REPO_EPOCH = Date.UTC(2008, 0, 1);
/** A practical ceiling for an unbounded stars: window's geometric-mean split point — well above any real repo's star count (~400k as of 2026), so it never distorts a real query, only gives the recursion something finite to bisect against. */
const PRACTICAL_MAX_STARS = 500_000;

const STARS_QUALIFIER_RE = /(?:^|\s)stars:(\S+)/i;
const CREATED_QUALIFIER_RE = /(?:^|\s)created:(\S+)/i;

type ShardDim = 'stars' | 'created';

interface Window {
  lo: number;
  hi: number;
}

export interface PlanOpts {
  /** Raw positionals — may include a literal `-` marking "read slices from stdin". */
  slices: string[];
  dry?: boolean;
  probe?: boolean;
  shard?: string;
  out?: string;
  quiet?: boolean;
}

export interface PlanShard {
  query: string;
  count: number;
  /** Present only when this shard is still over the 1,000-result cap and could not be split further (depth cap or both dimensions exhausted) — always paired with a manual-narrowing suggestion, never a silent drop. */
  hint?: string;
}

export interface PlanSliceResult {
  slice: string;
  ok: boolean;
  /** Set when the slice was probed and fit under the cap without sharding. */
  count?: number;
  /** Set when the slice was probed and needed sharding (or couldn't be split at all — a single-entry array). */
  shards?: PlanShard[];
  error?: { code: string; message: string };
}

export interface PlanResult {
  slices: PlanSliceResult[];
  /** Flat, batch-ready query list: valid slices as-is (offline mode) or their probed/sharded leaves (--probe mode). */
  queries: string[];
  /** Forecasted GraphQL cost of running `queries` for real via `batch` (1 pt/query). */
  estimatedPoints: number;
  /** GraphQL points plan ITSELF actually spent probing (0 unless --probe). */
  pointsSpent: number;
  out?: string;
}

export function planOptsFromArgs(parsed: ParsedArgs): PlanOpts {
  return {
    slices: parsed.positionals,
    dry: parsed.bools.has('dry'),
    probe: parsed.bools.has('probe'),
    shard: parsed.flags.shard?.[0],
    out: parsed.flags.out?.[0],
    quiet: parsed.bools.has('quiet'),
  };
}

/** Only the GhGraphql surface plan actually calls — narrower than `Pick<Sources,'ghGraphql'>`. */
export interface PlanSources {
  ghGraphql: Pick<GhGraphql, 'graphql' | 'lastRateLimit'>;
}

/** Expands a literal `-` positional into stdin's newline-separated slices (blank lines/`#`-comments skipped, shared with batch's --file reader); everything else passes through verbatim. */
function slicesFromArgs(positionals: string[], stdin: string): string[] {
  const out: string[] = [];
  for (const p of positionals) {
    if (p === '-') out.push(...parseQueryLines(stdin));
    else out.push(p);
  }
  return out;
}

// ── stars: window parse/format/split ────────────────────────────────────────

function parseStarsToken(token: string): Window {
  if (/^\d+\.\.\*$/.test(token)) {
    const lo = Number(token.split('..')[0]);
    return { lo, hi: Number.POSITIVE_INFINITY };
  }
  if (/^\*\.\.\d+$/.test(token)) {
    const hi = Number(token.split('..')[1]);
    return { lo: 0, hi };
  }
  if (/^\d+\.\.\d+$/.test(token)) {
    const [a, b] = token.split('..').map(Number);
    return { lo: a as number, hi: b as number };
  }
  if (/^>=\d+$/.test(token)) return { lo: Number(token.slice(2)), hi: Number.POSITIVE_INFINITY };
  if (/^>\d+$/.test(token)) return { lo: Number(token.slice(1)) + 1, hi: Number.POSITIVE_INFINITY };
  if (/^<=\d+$/.test(token)) return { lo: 0, hi: Number(token.slice(2)) };
  if (/^<\d+$/.test(token)) return { lo: 0, hi: Math.max(Number(token.slice(1)) - 1, 0) };
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return { lo: n, hi: n };
  }
  // Unparseable (shouldn't happen given upstream QUERY_TOO_COMPLEX/search validation) —
  // degrade to the fully-open window rather than throwing on a shape we don't recognize.
  return { lo: 0, hi: Number.POSITIVE_INFINITY };
}

function parseStarsWindow(slice: string): Window {
  const m = slice.match(STARS_QUALIFIER_RE);
  return m?.[1] ? parseStarsToken(m[1]) : { lo: 0, hi: Number.POSITIVE_INFINITY };
}

function formatStarsQualifier(w: Window): string {
  if (w.hi === Number.POSITIVE_INFINITY) return `stars:>=${w.lo}`;
  if (w.lo === w.hi) return `stars:${w.lo}`;
  return `stars:${w.lo}..${w.hi}`;
}

function canSplitStars(w: Window): boolean {
  return w.hi === Number.POSITIVE_INFINITY ? true : w.hi - w.lo >= 1;
}

/** Log-scale bisection: the geometric mean of the window's bounds (an open upper bound is treated as PRACTICAL_MAX_STARS for this calculation only — the resulting shard still carries an open `>=` qualifier). Always returns two non-empty, gap-free, non-overlapping integer windows covering exactly `w`. */
function splitStarsWindow(w: Window): [Window, Window] {
  const effLo = Math.max(w.lo, 1);
  const effHi = w.hi === Number.POSITIVE_INFINITY ? PRACTICAL_MAX_STARS : w.hi;
  const rawMid = Math.round(Math.sqrt(effLo * Math.max(effHi, effLo)));
  const upperClamp = w.hi === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : w.hi - 1;
  const mid = Math.min(Math.max(rawMid, w.lo), upperClamp);
  return [
    { lo: w.lo, hi: mid },
    { lo: mid + 1, hi: w.hi },
  ];
}

// ── created: window parse/format/split ──────────────────────────────────────

function parseDateToken(token: string, now: number): Window {
  if (/\.\.\*$/.test(token)) {
    const [a] = token.split('..');
    const lo = Date.parse(a as string);
    return Number.isNaN(lo) ? { lo: REPO_EPOCH, hi: now } : { lo, hi: now };
  }
  if (/^\*\.\./.test(token)) {
    const [, b] = token.split('..');
    const hi = Date.parse(b as string);
    return Number.isNaN(hi) ? { lo: REPO_EPOCH, hi: now } : { lo: REPO_EPOCH, hi };
  }
  if (token.includes('..')) {
    const [a, b] = token.split('..');
    const lo = Date.parse(a as string);
    const hi = Date.parse(b as string);
    return Number.isNaN(lo) || Number.isNaN(hi) ? { lo: REPO_EPOCH, hi: now } : { lo, hi };
  }
  if (token.startsWith('>=')) {
    const lo = Date.parse(token.slice(2));
    return Number.isNaN(lo) ? { lo: REPO_EPOCH, hi: now } : { lo, hi: now };
  }
  if (token.startsWith('>')) {
    const lo = Date.parse(token.slice(1));
    return Number.isNaN(lo) ? { lo: REPO_EPOCH, hi: now } : { lo: lo + DAY_MS, hi: now };
  }
  if (token.startsWith('<=')) {
    const hi = Date.parse(token.slice(2));
    return Number.isNaN(hi) ? { lo: REPO_EPOCH, hi: now } : { lo: REPO_EPOCH, hi };
  }
  if (token.startsWith('<')) {
    const hi = Date.parse(token.slice(1));
    return Number.isNaN(hi) ? { lo: REPO_EPOCH, hi: now } : { lo: REPO_EPOCH, hi: hi - DAY_MS };
  }
  const exact = Date.parse(token);
  return Number.isNaN(exact) ? { lo: REPO_EPOCH, hi: now } : { lo: exact, hi: exact };
}

function parseCreatedWindow(slice: string, now: number): Window {
  const m = slice.match(CREATED_QUALIFIER_RE);
  return m?.[1] ? parseDateToken(m[1], now) : { lo: REPO_EPOCH, hi: now };
}

function formatDate(ms: number): string {
  return (new Date(ms).toISOString().split('T')[0] as string) ?? '';
}

function formatCreatedQualifier(w: Window): string {
  if (w.lo === w.hi) return `created:${formatDate(w.lo)}`;
  return `created:${formatDate(w.lo)}..${formatDate(w.hi)}`;
}

/** Policy floor: only yearly-then-monthly splits (design §3 item 1) — a window at or below one month wide is "exhausted" on this dimension, even if finer (daily) splitting is technically possible. */
function canSplitCreated(w: Window): boolean {
  return (w.hi - w.lo) / DAY_MS > 31;
}

function pickCalendarBoundary(
  lo: number,
  hi: number,
  align: (d: Date) => number,
  step: (d: Date) => number,
): number | undefined {
  const mid = new Date((lo + hi) / 2);
  let boundary = align(mid);
  if (boundary <= lo) boundary = step(new Date(boundary));
  else if (boundary >= hi) boundary = step(new Date(boundary - DAY_MS));
  return boundary > lo && boundary < hi ? boundary : undefined;
}

const alignYear = (d: Date) => Date.UTC(d.getUTCFullYear(), 0, 1);
const nextYear = (d: Date) => Date.UTC(d.getUTCFullYear() + 1, 0, 1);
const alignMonth = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
const nextMonth = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);

/** Guarded by canSplitCreated (span > 31 days), so a fallback to the raw midpoint (clamped strictly interior) is always available even on the rare edge-alignment miss — this never returns an out-of-range or degenerate split. */
function splitCreatedWindow(w: Window): [Window, Window] {
  const spanDays = (w.hi - w.lo) / DAY_MS;
  const boundary =
    spanDays > 366
      ? pickCalendarBoundary(w.lo, w.hi, alignYear, nextYear)
      : pickCalendarBoundary(w.lo, w.hi, alignMonth, nextMonth);
  const b = boundary ?? clampInterior(w.lo, w.hi, w.lo + Math.round(spanDays / 2) * DAY_MS);
  return [
    { lo: w.lo, hi: b - DAY_MS },
    { lo: b, hi: w.hi },
  ];
}

function clampInterior(lo: number, hi: number, v: number): number {
  return Math.min(Math.max(v, lo + DAY_MS), hi - DAY_MS);
}

// ── dimension-agnostic shard machinery ──────────────────────────────────────

function getWindow(slice: string, dim: ShardDim, now: number): Window {
  return dim === 'stars' ? parseStarsWindow(slice) : parseCreatedWindow(slice, now);
}

function canSplit(dim: ShardDim, w: Window): boolean {
  return dim === 'stars' ? canSplitStars(w) : canSplitCreated(w);
}

function splitWindow(dim: ShardDim, w: Window): [Window, Window] {
  return dim === 'stars' ? splitStarsWindow(w) : splitCreatedWindow(w);
}

function stripQualifier(slice: string, re: RegExp): string {
  return slice.replace(re, ' ').replace(/\s+/g, ' ').trim();
}

function applyWindow(slice: string, dim: ShardDim, w: Window): string {
  const re = dim === 'stars' ? STARS_QUALIFIER_RE : CREATED_QUALIFIER_RE;
  const qualifier = dim === 'stars' ? formatStarsQualifier(w) : formatCreatedQualifier(w);
  return `${stripQualifier(slice, re)} ${qualifier}`.trim();
}

/** Prefer `preferred`; fall back to the other dimension when `preferred` can't be split further; `undefined` when BOTH are exhausted (design §3 item 1's INVALID_INPUT case — surfaced as a hint on the leaf shard rather than aborting the whole slice, so a partial result is never silently dropped). */
function chooseDimension(slice: string, preferred: ShardDim, now: number): ShardDim | undefined {
  if (canSplit(preferred, getWindow(slice, preferred, now))) return preferred;
  const other: ShardDim = preferred === 'stars' ? 'created' : 'stars';
  if (canSplit(other, getWindow(slice, other, now))) return other;
  return undefined;
}

interface ShardCtx {
  ghGraphql: Pick<GhGraphql, 'graphql' | 'lastRateLimit'>;
  cache: Cache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  progress: ProgressReporter;
  shardDim: ShardDim;
  spend: { points: number };
  first: { done: boolean };
}

/** One serialized probe: sleeps PROBE_DELAY_MS before every probe EXCEPT the very first of the whole `plan` run (never a trailing sleep after the last one, matching batch's convention), then spends 1 point and updates the budget pool immediately. */
async function probeOne(ctx: ShardCtx, query: string): Promise<number> {
  if (ctx.first.done) await ctx.sleep(PROBE_DELAY_MS);
  else ctx.first.done = true;
  ctx.progress(`plan probe: ${query}`);
  const count = await probeRepositoryCount(ctx.ghGraphql, query);
  updateBudgetFromGraphql(ctx.cache, ctx.ghGraphql);
  ctx.spend.points += 1;
  return count;
}

function depthCapHint(query: string): string {
  return (
    `still exceeds the ${RESULT_CAP}-result cap after ${MAX_SHARD_DEPTH} shard levels; ` +
    `narrow '${query}' manually with a tighter stars:/created: range`
  );
}

function exhaustedHint(query: string): string {
  return `cannot be sharded further — both stars: and created: ranges are exhausted for '${query}'; narrow it manually or supply a different qualifier (INVALID_INPUT: no further automatic split is possible)`;
}

/**
 * Probe `query`; if it's over the cap, split it on the current best dimension
 * and recurse into BOTH halves (never a one-shot split — design §1 row 8),
 * re-probing each one exactly like the original. Terminates because every
 * split strictly narrows its window and the depth cap (5) bounds the worst
 * case regardless. Returns a flat list of leaves: each either under the cap,
 * or over-cap-with-a-hint when no further split is possible.
 */
async function shardRecursive(ctx: ShardCtx, query: string, depth: number): Promise<PlanShard[]> {
  const count = await probeOne(ctx, query);
  if (count <= RESULT_CAP) return [{ query, count }];
  if (depth >= MAX_SHARD_DEPTH) return [{ query, count, hint: depthCapHint(query) }];

  const dim = chooseDimension(query, ctx.shardDim, ctx.now());
  if (dim === undefined) return [{ query, count, hint: exhaustedHint(query) }];

  const [leftW, rightW] = splitWindow(dim, getWindow(query, dim, ctx.now()));
  const leftQuery = applyWindow(query, dim, leftW);
  const rightQuery = applyWindow(query, dim, rightW);
  const left = await shardRecursive(ctx, leftQuery, depth + 1);
  const right = await shardRecursive(ctx, rightQuery, depth + 1);
  return [...left, ...right];
}

function toErrorRecord(e: unknown): { code: string; message: string } {
  if (e instanceof EngineError) return { code: e.code, message: e.message };
  return { code: 'FETCH_FAILED', message: e instanceof Error ? e.message : String(e) };
}

async function planOneSlice(
  ctx: ShardCtx,
  slice: string,
  doProbe: boolean,
): Promise<PlanSliceResult> {
  const problem = validateQuerySyntax(slice);
  if (problem) return { slice, ok: false, error: problem };
  if (!doProbe) return { slice, ok: true };

  try {
    const shards = await shardRecursive(ctx, slice, 0);
    const only = shards.length === 1 ? shards[0] : undefined;
    if (only && only.query === slice && only.hint === undefined) {
      return { slice, ok: true, count: only.count };
    }
    return { slice, ok: true, shards };
  } catch (e) {
    // Continue-on-error, same as batch/hydrate: one slice's transport failure
    // (RATE_LIMITED, AUTH_FAILED, ...) never aborts the rest of the plan run.
    return { slice, ok: false, error: toErrorRecord(e) };
  }
}

function buildQueriesList(results: PlanSliceResult[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    if (r.shards) out.push(...r.shards.map((s) => s.query));
    else out.push(r.slice);
  }
  return out;
}

function writeQueriesFile(path: string, queries: string[], now: () => number): void {
  const header = `# generated by ghrelay plan — ${new Date(now()).toISOString()}\n`;
  writeFileSync(path, header + queries.map((q) => `${q}\n`).join(''));
}

export interface PlanDeps {
  sleep?: (ms: number) => Promise<void>;
  progress?: ProgressReporter;
  now?: () => number;
}

export async function runPlan(
  sources: PlanSources,
  cache: Cache,
  opts: PlanOpts,
  stdin: string,
  deps: PlanDeps = {},
): Promise<PlanResult> {
  if (opts.shard !== undefined && opts.shard !== 'stars' && opts.shard !== 'created') {
    throw new EngineError(
      'INVALID_INPUT',
      `--shard must be 'stars' or 'created' (got '${opts.shard}')`,
    );
  }
  const shardDim: ShardDim = opts.shard === 'created' ? 'created' : 'stars';

  const slices = slicesFromArgs(opts.slices, stdin);
  if (slices.length === 0) {
    throw new EngineError(
      'INVALID_INPUT',
      'provide one or more query slices, or `-` to read them (newline-separated) from stdin',
    );
  }

  // --dry is a documented alias of the (probe-less) default — both just skip
  // the probe branch below; --probe is the only flag that turns it on.
  const doProbe = opts.probe === true;

  const now = deps.now ?? Date.now;
  const ctx: ShardCtx = {
    ghGraphql: sources.ghGraphql,
    cache,
    now,
    sleep: deps.sleep ?? defaultSleep,
    progress: deps.progress ?? progressReporter(opts.quiet ?? false),
    shardDim,
    spend: { points: 0 },
    first: { done: false },
  };

  const results: PlanSliceResult[] = [];
  for (const slice of slices) {
    results.push(await planOneSlice(ctx, slice, doProbe));
  }

  const queries = buildQueriesList(results);
  const result: PlanResult = {
    slices: results,
    queries,
    estimatedPoints: queries.length,
    pointsSpent: ctx.spend.points,
  };

  if (opts.out) {
    writeQueriesFile(opts.out, queries, now);
    result.out = opts.out;
  }

  return result;
}
