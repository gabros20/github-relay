import { mergeCorpus, saveCorpus } from '../cache/corpus.ts';
// `hydrate` — the multi-source lane (design §3 item 4, GATE 1): ingest
// candidate owner/repo ids the agent found anywhere else (its own web
// search, awesome lists, HN/Reddit threads) and enrich them via one aliased
// GraphQL batch, tagged `source:'agent'`. Shape validation is a hard
// pre-flight gate (INVALID_INPUT, zero network); per-id fetch failures
// (not found, transient) are soft — reported per-item, never batch-fatal.
import { CORPUS_SCHEMA, type Cache, type Corpus, type CorpusRepo } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import type { GhGraphql } from '../sources/gh-graphql.ts';
import { EngineError } from '../types.ts';
import {
  type CompactRow,
  PRE_ENRICH_FRAGMENT,
  type RawRepoNode,
  compactRow,
  learnedCeilingRecorder,
  loadCorpusOrEmpty,
  normalizeRepoNode,
  startingBatchSize,
  updateBudgetFromGraphql,
} from './_shared.ts';

const BATCH_SIZE = 50;
// owner/repo: GitHub-legal charset (alnum, `.`, `_`, `-`), no leading/trailing
// separator on either segment, exactly one slash.
const REPO_ID_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface HydrateOpts {
  /** Raw positionals — may include a literal `-` marking "read ids from stdin". */
  ids: string[];
  out?: string;
}

export interface HydrateFailure {
  id: string;
  code: string;
  message: string;
}

export interface HydrateResult {
  requested: number;
  hydrated: number;
  failed: HydrateFailure[];
  out?: string;
  repos?: CompactRow[];
}

export function hydrateOptsFromArgs(parsed: ParsedArgs): HydrateOpts {
  return { ids: parsed.positionals, out: parsed.flags.out?.[0] };
}

/** Only the GhGraphql surface hydrate actually calls — narrower than `Pick<Sources,'ghGraphql'>`, which would still demand the full GhGraphql shape (Sources.ghGraphql's declared type), unused `graphql` included. */
export interface HydrateSources {
  ghGraphql: Pick<GhGraphql, 'batchRepositories' | 'lastRateLimit'>;
}

/** Expands a literal `-` positional into stdin's newline-separated ids (blank lines skipped); everything else passes through. */
function idsFromArgs(positionals: string[], stdin: string): string[] {
  const ids: string[] = [];
  for (const p of positionals) {
    if (p === '-') {
      for (const line of stdin.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) ids.push(trimmed);
      }
    } else {
      ids.push(p);
    }
  }
  return ids;
}

/** Case-insensitive dedupe (full_name identity, design §2), first occurrence's casing wins. */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

export async function runHydrate(
  sources: HydrateSources,
  cache: Cache,
  opts: HydrateOpts,
  stdin: string,
  deps: { now?: () => number } = {},
): Promise<HydrateResult> {
  const now = deps.now ?? Date.now;
  const rawIds = idsFromArgs(opts.ids, stdin);
  if (rawIds.length === 0) {
    throw new EngineError(
      'INVALID_INPUT',
      'provide one or more owner/repo ids, or `-` to read them (newline-separated) from stdin',
    );
  }
  for (const id of rawIds) {
    if (!REPO_ID_RE.test(id)) {
      throw new EngineError('INVALID_INPUT', `invalid owner/repo id: '${id}'`);
    }
  }
  const ids = dedupe(rawIds);

  const batchSize = startingBatchSize(cache, 'pre-enrich', BATCH_SIZE);
  const results = await sources.ghGraphql.batchRepositories<RawRepoNode>(ids, PRE_ENRICH_FRAGMENT, {
    batchSize,
    onEffectiveSize: learnedCeilingRecorder(cache, 'pre-enrich', batchSize),
  });
  updateBudgetFromGraphql(cache, sources.ghGraphql);

  const failed: HydrateFailure[] = [];
  const hydrated: { repo: CorpusRepo; node: RawRepoNode }[] = [];
  for (const r of results) {
    if (r.data) {
      hydrated.push({ repo: normalizeRepoNode(r.data, 'agent'), node: r.data });
    } else {
      failed.push({
        id: r.name,
        code: r.error?.code ?? 'NOT_FOUND',
        message: r.error?.message ?? `no data returned for ${r.name}`,
      });
    }
  }

  const result: HydrateResult = { requested: ids.length, hydrated: hydrated.length, failed };

  if (opts.out) {
    const defaultIntent = 'agent-hydrated repos';
    const existing = loadCorpusOrEmpty(opts.out, defaultIntent, now);
    const fresh: Corpus = {
      schema: CORPUS_SCHEMA,
      intent: existing.intent || defaultIntent,
      generatedAt: new Date(now()).toISOString(),
      queries: [],
      count: hydrated.length,
      repos: hydrated.map((h) => h.repo),
    };
    const merged = mergeCorpus(existing, fresh);
    saveCorpus(opts.out, merged, now);
    result.out = opts.out;
  } else {
    result.repos = hydrated.map((h) => compactRow(h.repo, h.node.url));
  }

  return result;
}
