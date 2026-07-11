// Shared internals for the discovery commands (search/batch/hydrate — task 4):
// the pre-enriched GraphQL fragment (design §3.2), a pure node→CorpusRepo
// normalizer, a thin GraphQL search-page runner, budget bookkeeping, the
// "load-or-create" corpus helper for --out incremental merges, and the
// compact-row shape shared by search/hydrate stdout output. Every function
// here is pure or takes its I/O by injection (youtube-context pattern) so
// each command's own tests stay network-free.
import type { Cache, Corpus, CorpusRepo, LearnedCeiling } from '../cache/index.ts';
import { createCorpus, loadCorpus } from '../cache/index.ts';
import type { GhGraphql } from '../sources/gh-graphql.ts';
import { EngineError } from '../types.ts';

// ── pre-enrich fragment (design §3.2) ───────────────────────────────────────

/**
 * Zero-extra-call enrichment fields, fetched inline on every search/batch/
 * hydrate result. Usable both inside `... on Repository { … }` (search) and
 * directly as an aliased `repository() { … }` selection (batchRepositories).
 */
export const PRE_ENRICH_FRAGMENT = `
  nameWithOwner
  databaseId
  id
  stargazerCount
  forkCount
  pushedAt
  createdAt
  licenseInfo { spdxId }
  repositoryTopics(first: 10) { nodes { topic { name } } }
  primaryLanguage { name }
  isArchived
  description
  url
`.trim();

export interface RawRepoNode {
  nameWithOwner?: string;
  id?: string;
  databaseId?: number;
  stargazerCount?: number;
  forkCount?: number;
  pushedAt?: string;
  createdAt?: string;
  licenseInfo?: { spdxId?: string | null } | null;
  repositoryTopics?: { nodes?: Array<{ topic?: { name?: string } | null }> } | null;
  primaryLanguage?: { name?: string } | null;
  isArchived?: boolean;
  description?: string | null;
  url?: string;
}

export type CorpusSource = CorpusRepo['source'];

/** Pure: a raw enrich-fragment node → the CorpusRepo shape (design §8). `signals` stays empty — these are pre-enriched fields, not enrichment-fact provenance (task 6's job). */
export function normalizeRepoNode(node: RawRepoNode, source: CorpusSource): CorpusRepo {
  const topics = (node.repositoryTopics?.nodes ?? [])
    .map((n) => n?.topic?.name)
    .filter((t): t is string => Boolean(t));
  return {
    full_name: node.nameWithOwner ?? '',
    ghid: node.id ?? '',
    aliases: [],
    source,
    signals: {},
    stars: node.stargazerCount,
    forks: node.forkCount,
    pushedAt: node.pushedAt,
    createdAt: node.createdAt,
    license: node.licenseInfo?.spdxId ?? undefined,
    topics,
    language: node.primaryLanguage?.name ?? null,
    archived: node.isArchived,
    description: node.description ?? null,
  };
}

// ── compact stdout rows ─────────────────────────────────────────────────────

export interface CompactRow {
  full_name: string;
  ghid: string;
  stars?: number;
  forks?: number;
  pushedAt?: string;
  createdAt?: string;
  license?: string;
  topics?: string[];
  language?: string | null;
  archived?: boolean;
  description?: string | null;
  url?: string;
}

/** `url` isn't part of the corpus schema (derivable), so it's threaded through separately from the raw node for display-only rows. */
export function compactRow(repo: CorpusRepo, url?: string): CompactRow {
  return {
    full_name: repo.full_name,
    ghid: repo.ghid,
    stars: repo.stars,
    forks: repo.forks,
    pushedAt: repo.pushedAt,
    createdAt: repo.createdAt,
    license: repo.license,
    topics: repo.topics,
    language: repo.language,
    archived: repo.archived,
    description: repo.description,
    url,
  };
}

// ── GraphQL search runner ───────────────────────────────────────────────────

export interface SearchPage {
  repositoryCount: number;
  nodes: RawRepoNode[];
}

function buildSearchDocument(): string {
  return `query($q: String!, $first: Int!) {
  search(type: REPOSITORY, query: $q, first: $first) {
    repositoryCount
    nodes {
      ... on Repository {
        ${PRE_ENRICH_FRAGMENT}
      }
    }
  }
}`;
}

const SEARCH_DOCUMENT = buildSearchDocument();

/** One page of `search(type: REPOSITORY)`, pre-enriched. Never persists a cursor — v0.1 is single-page only (design §3 item 2). */
export async function searchRepositories(
  ghGraphql: Pick<GhGraphql, 'graphql'>,
  q: string,
  first: number,
): Promise<SearchPage> {
  const data = await ghGraphql.graphql<{
    search: { repositoryCount: number; nodes: (RawRepoNode | null)[] };
  }>(SEARCH_DOCUMENT, { q, first });
  return {
    repositoryCount: data.search.repositoryCount,
    nodes: (data.search.nodes ?? []).filter((n): n is RawRepoNode => n != null),
  };
}

// ── budget bookkeeping ───────────────────────────────────────────────────────

/** Persist the last embedded `rateLimit{}` block into the graphqlPoints pool — never a trusted constant, only what the last live response said (design §8). */
export function updateBudgetFromGraphql(
  cache: Cache,
  ghGraphql: Pick<GhGraphql, 'lastRateLimit'>,
): void {
  const rl = ghGraphql.lastRateLimit();
  if (!rl) return;
  cache.budget.updatePool('graphqlPoints', {
    remaining: rl.remaining,
    resetAt: rl.resetAt,
    lastCost: rl.cost,
  });
}

/**
 * Persist `x-ratelimit-remaining`/`x-ratelimit-reset` from a REST response
 * into the given pool (design §4/§8 — REST search/core windows updated at
 * runtime from live headers, never a trusted constant). `resetAt` arrives as
 * Unix epoch seconds over the wire; converted to ISO for consistency with
 * every other pool's `resetAt`. A response with neither header (or an
 * adapter that didn't pass any) is a no-op, not a crash — reusable across
 * any REST adapter call site (search's --source rest today; skim/read/digest
 * in later tasks).
 */
export function updateBudgetFromRestHeaders(
  cache: Cache,
  pool: 'restCore' | 'restSearch',
  headers: Headers,
): void {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining === null || reset === null) return;
  cache.budget.updatePool(pool, {
    remaining: Number(remaining),
    resetAt: new Date(Number(reset) * 1000).toISOString(),
  });
}

// ── OSS Insight pool bookkeeping (design §4: 600/hr/IP) ────────────────────

/** Seeds ONLY the very first local-count estimate when OSS Insight's own headers are absent — the documented policy ceiling (design §4), not a trusted live value. */
const OSSINSIGHT_DEFAULT_HOURLY = 600;
const OSSINSIGHT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Persist the ossinsight pool from a trending call's live rate-window headers
 * when present (never a trusted constant, same as every other pool). When
 * OSS Insight omits them, fall back to counting locally: decrement the last
 * known window by one observed call, or — only when nothing has ever been
 * observed AND no live window is currently in progress — seed from the
 * documented 600/hr ceiling (design §4). Never re-trusts that seed once a
 * real header snapshot (or even a prior local count) exists.
 */
export function updateBudgetFromOssInsight(
  cache: Cache,
  rateWindow: { remaining: number; resetAt: string } | undefined,
  now: () => number = Date.now,
): void {
  if (rateWindow) {
    cache.budget.updatePool('ossinsight', rateWindow);
    return;
  }
  const nowMs = now();
  const current = cache.budget.load().ossinsight;
  const windowLive = current !== undefined && Date.parse(current.resetAt) > nowMs;
  if (windowLive) {
    cache.budget.updatePool('ossinsight', {
      remaining: Math.max(0, (current as { remaining: number }).remaining - 1),
      resetAt: (current as { resetAt: string }).resetAt,
    });
    return;
  }
  cache.budget.updatePool('ossinsight', {
    remaining: OSSINSIGHT_DEFAULT_HOURLY - 1,
    resetAt: new Date(nowMs + OSSINSIGHT_WINDOW_MS).toISOString(),
  });
}

// ── learned GraphQL batch ceilings (design §2 gh-graphql, §12 risk 5) ──────
// Persisted per FRAGMENT (not a shared weight bucket, fix wave 2 IMP 2):
// enrich's ~15-signal fragment ('enrich-light'), hydrate's flat pre-enrich
// fragment ('pre-enrich'), and health's heavy fragment ('heavy') each get
// their own ceiling key. They used to share one 'light' bucket on the theory
// that both hit the same GraphQL 10s-timeout wall — true in principle, but
// enrich's fragment (6 nested totalCounts) and hydrate's (flat, cheaper)
// don't actually cost the same per-repo, so a ceiling enrich's payload
// earned (e.g. 12) would throttle hydrate's unrelated 50-default batches to
// the same 12 — ~4x more calls for a fragment that was never the problem.
//
// Lifecycle (fix wave 2 IMP 1): a persisted ceiling can never be written
// BELOW a floor of 5 — bisection may still run below 5 IN-FLIGHT (a single
// genuinely-tiny batch can still succeed this run), but nothing under 5 is
// ever saved, so one pathological timeout storm can't permanently throttle
// every future run to a batch of one (this happened live: a size-1 success
// after larger siblings timed out floored the ceiling forever, since `cache
// clear` deliberately spares budget.json — there was no recovery path).
// Every persisted entry also carries `observedAt`; `startingBatchSize`
// ignores anything older than 7 days and starts back at the static default
// — if the constraint that caused it is still real, the very next bisection
// re-learns it cheaply (one 502, one halving); if it isn't, the entry simply
// ages out instead of calcifying. A bare `number` (the pre-fix-wave-2 shape)
// has no timestamp to trust, so it's always treated as stale on read/write
// — never actively rewritten, just superseded the next time a genuine
// bisection fires for that key.

export type FragmentWeight = 'enrich-light' | 'pre-enrich' | 'heavy';

const LEARNED_CEILING_FLOOR = 5;
const LEARNED_CEILING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A fresh, trustworthy entry: the shaped `{size, observedAt}` form, with a parseable timestamp no older than 7 days. Anything else (undefined, a legacy bare number, a corrupt/unparseable timestamp, or one past its age) is stale. */
function freshCeiling(
  raw: number | LearnedCeiling | undefined,
  nowMs: number,
): LearnedCeiling | undefined {
  if (raw === undefined || typeof raw === 'number') return undefined;
  const observedMs = Date.parse(raw.observedAt);
  if (Number.isNaN(observedMs)) return undefined;
  if (nowMs - observedMs > LEARNED_CEILING_MAX_AGE_MS) return undefined;
  return raw;
}

/** The batch size a caller should START at this run: a fresh learned ceiling for `weight`, clamped into [1, staticDefault] — or `staticDefault` itself when nothing fresh has been learned. */
export function startingBatchSize(
  cache: Cache,
  weight: FragmentWeight,
  staticDefault: number,
  now: () => number = Date.now,
): number {
  const entry = freshCeiling(cache.budget.load().learnedCeilings[weight], now());
  if (entry === undefined) return staticDefault;
  return Math.min(staticDefault, Math.max(1, entry.size));
}

/**
 * Build the `onEffectiveSize` callback for one `batchRepositories` call.
 * Fires ONLY when `observed < requestedBatchSize` — i.e. only when THIS
 * call's adaptive bisection actually tightened below what was asked for (a
 * chunk that succeeds at the full requested size teaches nothing new). Each
 * firing persists `max(FLOOR, min(current fresh size, observed))` with a
 * fresh `observedAt` — a stale/legacy/absent current entry doesn't
 * constrain the new minimum, and a RECURRING constraint keeps refreshing
 * its own timestamp (bisection firing again is itself fresh evidence the
 * constraint still holds), so it never expires while still true.
 */
export function learnedCeilingRecorder(
  cache: Cache,
  weight: FragmentWeight,
  requestedBatchSize: number,
  now: () => number = Date.now,
): (size: number) => void {
  return (size: number) => {
    if (size >= requestedBatchSize) return;
    const nowMs = now();
    const current = freshCeiling(cache.budget.load().learnedCeilings[weight], nowMs);
    const tightened = current === undefined ? size : Math.min(current.size, size);
    cache.budget.updateLearnedCeiling(weight, {
      size: Math.max(LEARNED_CEILING_FLOOR, tightened),
      observedAt: new Date(nowMs).toISOString(),
    });
  };
}

// ── offline query-shape validators (design §3 item 1) ───────────────────────
// Shared by batch's --dry-run and plan's offline validation (task 9) —
// exactly one place defines "what makes a search-query slice too complex",
// so the two commands can never drift out of sync on the 256-char / 5-operator
// limits GitHub itself would reject with a query-complexity error.

export const MAX_QUERY_LENGTH = 256;
export const MAX_OPERATORS = 5;
const OPERATOR_RE = /\b(?:AND|OR|NOT)\b/gi;

/** The offline 256-char / 5-operator limits — QUERY_TOO_COMPLEX per query, zero network. */
export function validateQuerySyntax(
  query: string,
): { code: 'QUERY_TOO_COMPLEX'; message: string } | undefined {
  if (query.length > MAX_QUERY_LENGTH) {
    return {
      code: 'QUERY_TOO_COMPLEX',
      message: `query exceeds ${MAX_QUERY_LENGTH} characters (${query.length}); split into smaller shards`,
    };
  }
  const opCount = (query.match(OPERATOR_RE) ?? []).length;
  if (opCount > MAX_OPERATORS) {
    return {
      code: 'QUERY_TOO_COMPLEX',
      message: `query has ${opCount} AND/OR/NOT operators (max ${MAX_OPERATORS}); split into smaller shards`,
    };
  }
  return undefined;
}

/** Newline-separated query/slice lines: blank lines and `#`-comments skipped, each trimmed. Shared by batch's --file reader and plan's `-` stdin reader. */
export function parseQueryLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

// ── GraphQL result-count probe (design §3 item 1, plan --probe) ────────────

const PROBE_DOCUMENT = `query($q: String!) {
  search(type: REPOSITORY, query: $q, first: 0) {
    repositoryCount
  }
}`;

/** `search(..., first: 0) { repositoryCount }` — 1 GraphQL point, zero nodes. Used by plan --probe to check a slice's result count before deciding whether/how to shard it. */
export async function probeRepositoryCount(
  ghGraphql: Pick<GhGraphql, 'graphql'>,
  q: string,
): Promise<number> {
  const data = await ghGraphql.graphql<{ search: { repositoryCount: number } }>(PROBE_DOCUMENT, {
    q,
  });
  return data.search.repositoryCount;
}

// ── corpus load-or-create ───────────────────────────────────────────────────

/** loadCorpus, but a missing file (expected absence on a first --out write) becomes a fresh corpus instead of throwing. Any other failure (bad JSON, wrong schema) still propagates. */
export function loadCorpusOrEmpty(
  path: string,
  intent: string,
  now: () => number = Date.now,
): Corpus {
  try {
    return loadCorpus(path);
  } catch (e) {
    if (e instanceof EngineError && e.code === 'NOT_FOUND') return createCorpus(intent, [], now);
    throw e;
  }
}
