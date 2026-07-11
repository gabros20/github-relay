// The corpus file format (design §8, §2, §5): the durable, mergeable record
// of every repo a session has discovered, keyed by canonical `full_name`.
// loadCorpus fails loud on a missing/wrong schema tag — no silent migration
// — while mergeCorpus dedupes fresh-wins, unions aliases, re-keys renamed
// repos by `ghid`, and preserves provenance one signal at a time.
import { EngineError } from '../types.ts';
import { readFileIfExists, save } from './store.ts';

export const CORPUS_SCHEMA = 'github-relay/corpus@1' as const;

export interface SignalProvenance {
  value: unknown;
  source: string;
  fetchedAt: string;
}

export interface CorpusRepo {
  /** Canonical identity key (design §2). */
  full_name: string;
  /** New-format node id (R_kgDO…), never legacy MDEwOl…. */
  ghid: string;
  aliases: string[];
  renamed?: boolean;
  source: 'search' | 'agent' | 'trending' | 'code' | 'skim';
  /** Per-signal provenance — one entry per enrichment fact, not per fetch. */
  signals: Record<string, SignalProvenance>;
  // Pre-enriched search fields (zero extra enrichment calls to obtain).
  stars?: number;
  forks?: number;
  pushedAt?: string;
  createdAt?: string;
  license?: string;
  topics?: string[];
  language?: string | null;
  archived?: boolean;
  description?: string | null;
}

export interface Corpus {
  schema: typeof CORPUS_SCHEMA;
  /** The natural-language intent this corpus serves — re-rankable tomorrow. */
  intent: string;
  generatedAt: string;
  queries: string[];
  count: number;
  repos: CorpusRepo[];
}

/** A fresh, empty corpus for a new intent. Explicit construction — never implied by loadCorpus. */
export function createCorpus(
  intent: string,
  queries: string[] = [],
  now: () => number = Date.now,
): Corpus {
  return {
    schema: CORPUS_SCHEMA,
    intent,
    generatedAt: new Date(now()).toISOString(),
    queries,
    count: 0,
    repos: [],
  };
}

/** Fails loud: missing file → NOT_FOUND; unparseable/wrong/absent schema tag → INVALID_INPUT. */
export function loadCorpus(path: string): Corpus {
  const raw = readFileIfExists(path);
  if (raw === undefined) throw new EngineError('NOT_FOUND', `no corpus at ${path}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EngineError('INVALID_INPUT', `corpus at ${path} is not valid JSON`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== CORPUS_SCHEMA
  ) {
    throw new EngineError(
      'INVALID_INPUT',
      `corpus at ${path} has a missing or unrecognized schema tag (expected ${CORPUS_SCHEMA})`,
    );
  }
  return parsed as Corpus;
}

/** Atomic write; recomputes `count` and stamps `generatedAt` from the injected clock. */
export function saveCorpus(path: string, corpus: Corpus, now: () => number = Date.now): void {
  const next: Corpus = {
    ...corpus,
    schema: CORPUS_SCHEMA,
    count: corpus.repos.length,
    generatedAt: new Date(now()).toISOString(),
  };
  save(path, next);
}

function unionStrings(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

/**
 * GitHub full_names are case-insensitive but case-preserving: `Foo/Bar` and
 * `foo/bar` are the same repo, never two. This is the identity/dedup key
 * used everywhere two full_names are compared; the field itself always
 * keeps whichever literal casing fresh-wins picked (design review fix wave
 * 2, Important 2).
 */
function canonicalKey(fullName: string): string {
  return fullName.toLowerCase();
}

/**
 * The most recent evidence timestamp on a row: the newest per-signal
 * `fetchedAt`, falling back to the repo's own `pushedAt`. ISO-8601 strings
 * compare correctly with `>`. A row with neither sorts as the oldest
 * possible evidence (`''`).
 */
function freshnessOf(repo: CorpusRepo): string {
  const signalTimes = Object.values(repo.signals)
    .map((s) => s.fetchedAt)
    .filter((t): t is string => Boolean(t));
  const newestSignal =
    signalTimes.length > 0 ? signalTimes.reduce((a, b) => (a > b ? a : b)) : undefined;
  return newestSignal ?? repo.pushedAt ?? '';
}

/**
 * True if `a` is the more current row. Recency evidence (`freshnessOf`)
 * decides; when two rows carry identical evidence, a full_name comparison
 * breaks the tie deterministically — never array position, so the result
 * never depends on which order a batch happened to list two same-identity
 * rows in (design review fix wave 2, Important 1).
 */
function isNewer(a: CorpusRepo, b: CorpusRepo): boolean {
  const fa = freshnessOf(a);
  const fb = freshnessOf(b);
  if (fa !== fb) return fa > fb;
  return a.full_name > b.full_name;
}

/**
 * Merge `incoming` onto `base`: fresh-wins for every mutable field, aliases
 * union, and `signals` merged key-by-key so only the signals `incoming`
 * actually carries get overwritten (design §5 per-signal provenance).
 * `renamedFrom`, when set, is the repo's previous full_name — pushed into
 * aliases with `renamed:true` set. Alias cleanup compares case-insensitively
 * so a pure casing difference from `incoming.full_name` doesn't linger as a
 * bogus alias.
 */
function mergeRepoInto(base: CorpusRepo, incoming: CorpusRepo, renamedFrom?: string): CorpusRepo {
  const aliases = new Set(unionStrings(base.aliases, incoming.aliases));
  if (renamedFrom) aliases.add(renamedFrom);
  const incomingKey = canonicalKey(incoming.full_name);
  for (const alias of aliases) {
    if (canonicalKey(alias) === incomingKey) aliases.delete(alias);
  }

  return {
    full_name: incoming.full_name,
    // `||`, not `??`: the `code` lane (task 10) can only ever supply a
    // repo/path/line hit, never a GraphQL node id, so its rows carry
    // `ghid: ''` (the same "no id yet" sentinel normalizeRepoNode already
    // uses) rather than `undefined`. `??` would let that blank string win
    // over a real ghid a prior search/hydrate already recorded for the same
    // repo — `||` treats '' the same as "not supplied" instead.
    ghid: incoming.ghid || base.ghid,
    aliases: Array.from(aliases),
    renamed: renamedFrom !== undefined || base.renamed || incoming.renamed ? true : undefined,
    source: incoming.source ?? base.source,
    signals: { ...base.signals, ...incoming.signals },
    stars: incoming.stars ?? base.stars,
    forks: incoming.forks ?? base.forks,
    pushedAt: incoming.pushedAt ?? base.pushedAt,
    createdAt: incoming.createdAt ?? base.createdAt,
    license: incoming.license ?? base.license,
    topics: incoming.topics ?? base.topics,
    language: incoming.language ?? base.language,
    archived: incoming.archived ?? base.archived,
    description: incoming.description ?? base.description,
  };
}

/**
 * Collapse same-ghid rows WITHIN one fresh batch to a single row before any
 * of them touch `existing` state. Without this, resolving a same-batch
 * rename inline (mutating a shared ghid map mid-loop) makes the outcome
 * depend on which of the two rows the loop happened to visit first — the
 * canonical name must instead be decided once, by recency evidence, so both
 * orderings of the same batch converge to the same result (design review
 * fix wave 2, Important 1).
 */
function collapseFreshByGhid(fresh: CorpusRepo[]): CorpusRepo[] {
  const byGhid = new Map<string, CorpusRepo>();
  const ghidOrder: string[] = [];
  const withoutGhid: CorpusRepo[] = [];

  for (const repo of fresh) {
    if (!repo.ghid) {
      withoutGhid.push(repo);
      continue;
    }
    const seen = byGhid.get(repo.ghid);
    if (!seen) {
      byGhid.set(repo.ghid, repo);
      ghidOrder.push(repo.ghid);
      continue;
    }
    const winner = isNewer(repo, seen) ? repo : seen;
    const loser = winner === repo ? seen : repo;
    const renamedFrom =
      canonicalKey(loser.full_name) !== canonicalKey(winner.full_name)
        ? loser.full_name
        : undefined;
    byGhid.set(repo.ghid, mergeRepoInto(loser, winner, renamedFrom));
  }

  return [...ghidOrder.map((ghid) => byGhid.get(ghid) as CorpusRepo), ...withoutGhid];
}

function mergeRepos(existing: CorpusRepo[], fresh: CorpusRepo[]): CorpusRepo[] {
  const byName = new Map<string, CorpusRepo>();
  const byGhid = new Map<string, CorpusRepo>();
  for (const repo of existing) {
    byName.set(canonicalKey(repo.full_name), repo);
    if (repo.ghid) byGhid.set(repo.ghid, repo);
  }

  for (const incoming of collapseFreshByGhid(fresh)) {
    const key = canonicalKey(incoming.full_name);
    const renamedFrom = incoming.ghid ? byGhid.get(incoming.ghid) : undefined;
    const renamedKey = renamedFrom ? canonicalKey(renamedFrom.full_name) : undefined;

    if (renamedFrom && renamedKey !== key) {
      byName.delete(renamedKey as string);
      const merged = mergeRepoInto(renamedFrom, incoming, renamedFrom.full_name);
      byName.set(key, merged);
      byGhid.set(merged.ghid, merged);
      continue;
    }

    const base = byName.get(key) ?? renamedFrom;
    const merged = base ? mergeRepoInto(base, incoming) : incoming;
    byName.set(key, merged);
    if (merged.ghid) byGhid.set(merged.ghid, merged);
  }

  return Array.from(byName.values());
}

/**
 * Merge `fresh` into `existing`: repos dedupe by canonical full_name
 * (fresh-wins, rename-aware via ghid), queries union, intent keeps
 * `existing`'s (falling back to `fresh`'s for a first merge into an empty
 * corpus). `count`/`generatedAt` are left for saveCorpus to stamp.
 */
export function mergeCorpus(existing: Corpus, fresh: Corpus): Corpus {
  const repos = mergeRepos(existing.repos, fresh.repos);
  return {
    schema: CORPUS_SCHEMA,
    intent: existing.intent || fresh.intent,
    generatedAt: existing.generatedAt,
    queries: unionStrings(existing.queries, fresh.queries),
    count: repos.length,
    repos,
  };
}
