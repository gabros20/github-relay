// Shared internals for the discovery commands (search/batch/hydrate — task 4):
// the pre-enriched GraphQL fragment (design §3.2), a pure node→CorpusRepo
// normalizer, a thin GraphQL search-page runner, budget bookkeeping, the
// "load-or-create" corpus helper for --out incremental merges, and the
// compact-row shape shared by search/hydrate stdout output. Every function
// here is pure or takes its I/O by injection (youtube-context pattern) so
// each command's own tests stay network-free.
import type { Cache, Corpus, CorpusRepo } from '../cache/index.ts';
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
