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
