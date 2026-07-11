// `batch` — serialized multi-query corpus building (design §3 item 3).
// x-relay semantics exactly (see ~/Documents/Personal/Projects/x-relay/src/commands/batch.ts):
// strictly serialized, a delay between queries (never after the last), a
// RATE_LIMITED retryAfterMs REPLACES that delay, continue-on-error with a
// perQuery[] ledger, cross-query dedupe by full_name, --out merges
// (incremental top-up). `--dry-run` validates every query's shape offline —
// zero network — using the same 256-char / 5-operator limits (_shared.ts's
// validateQuerySyntax) `plan` also applies before spending a probe.
import { readFileSync } from 'node:fs';
import { mergeCorpus, saveCorpus } from '../cache/corpus.ts';
import { CORPUS_SCHEMA, type Cache, type Corpus, type CorpusRepo } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import { type ProgressReporter, progressReporter } from '../progress.ts';
import type { GhGraphql } from '../sources/gh-graphql.ts';
import { defaultSleep } from '../sources/seams.ts';
import { EngineError } from '../types.ts';
import {
  loadCorpusOrEmpty,
  normalizeRepoNode,
  parseQueryLines,
  searchRepositories,
  updateBudgetFromGraphql,
  validateQuerySyntax,
} from './_shared.ts';

const DEFAULT_DELAY_MS = 2000;
const BATCH_SEARCH_LIMIT = 100;

export interface BatchOpts {
  file?: string;
  delay?: string;
  dryRun?: boolean;
  out?: string;
  quiet?: boolean;
}

export interface BatchQueryResult {
  query: string;
  /** Result count for this query. Absent on error, and absent (alongside `error`) for a validated-but-unexecuted --dry-run entry. */
  count?: number;
  error?: { code: string; message: string; retryAfterMs?: number };
}

export interface BatchResult {
  queries: number;
  succeeded: number;
  failed: number;
  totalUnique: number;
  out?: string;
  perQuery: BatchQueryResult[];
  dryRun?: boolean;
}

export interface BatchDeps {
  sleep?: (ms: number) => Promise<void>;
  progress?: ProgressReporter;
  now?: () => number;
}

/** Only the GhGraphql surface batch actually calls — narrower than `Pick<Sources,'ghGraphql'>`, which would still demand the full GhGraphql shape (Sources.ghGraphql's declared type), unused batchRepositories included. */
export interface BatchSources {
  ghGraphql: Pick<GhGraphql, 'graphql' | 'lastRateLimit'>;
}

export function batchOptsFromArgs(parsed: ParsedArgs): BatchOpts {
  return {
    file: parsed.flags.file?.[0],
    delay: parsed.flags.delay?.[0],
    dryRun: parsed.bools.has('dry-run'),
    out: parsed.flags.out?.[0],
    quiet: parsed.bools.has('quiet'),
  };
}

function toBatchErrorRecord(e: unknown): { code: string; message: string; retryAfterMs?: number } {
  if (e instanceof EngineError) {
    return {
      code: e.code,
      message: e.message,
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
    };
  }
  return { code: 'FETCH_FAILED', message: e instanceof Error ? e.message : String(e) };
}

/** Run one query: fold its repos into `seen` (first-wins, cross-query dedupe by full_name) and record a perQuery entry. Returns the ms to wait before the NEXT query. */
async function runOneQuery(
  ghGraphql: Pick<GhGraphql, 'graphql' | 'lastRateLimit'>,
  cache: Cache,
  query: string,
  seen: Map<string, CorpusRepo>,
  perQuery: BatchQueryResult[],
  delay: number,
): Promise<number> {
  try {
    const page = await searchRepositories(ghGraphql, query, BATCH_SEARCH_LIMIT);
    updateBudgetFromGraphql(cache, ghGraphql);
    const repos = page.nodes.map((n) => normalizeRepoNode(n, 'search'));
    for (const r of repos) {
      const key = r.full_name.toLowerCase();
      if (!seen.has(key)) seen.set(key, r);
    }
    perQuery.push({ query, count: repos.length });
    return delay;
  } catch (e) {
    const rec = toBatchErrorRecord(e);
    perQuery.push({ query, error: rec });
    return rec.code === 'RATE_LIMITED' ? (rec.retryAfterMs ?? delay) : delay;
  }
}

async function executeQueries(
  ghGraphql: Pick<GhGraphql, 'graphql' | 'lastRateLimit'>,
  cache: Cache,
  queries: string[],
  delay: number,
  sleep: (ms: number) => Promise<void>,
  progress: ProgressReporter,
): Promise<{ seen: Map<string, CorpusRepo>; perQuery: BatchQueryResult[] }> {
  const seen = new Map<string, CorpusRepo>();
  const perQuery: BatchQueryResult[] = [];
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i] as string;
    progress(`batch ${i + 1}/${queries.length}: ${query}`);
    const waitMs = await runOneQuery(ghGraphql, cache, query, seen, perQuery, delay);
    if (i < queries.length - 1) await sleep(waitMs);
  }
  return { seen, perQuery };
}

function runDryRun(queries: string[]): BatchResult {
  const perQuery: BatchQueryResult[] = queries.map((query) => {
    const problem = validateQuerySyntax(query);
    return problem ? { query, error: problem } : { query };
  });
  const failed = perQuery.filter((q) => q.error !== undefined).length;
  return {
    queries: queries.length,
    succeeded: perQuery.length - failed,
    failed,
    totalUnique: 0,
    perQuery,
    dryRun: true,
  };
}

function readQueries(file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    throw new EngineError('INVALID_INPUT', `could not read --file '${file}'`);
  }
  const queries = parseQueryLines(raw);
  if (queries.length === 0) {
    throw new EngineError(
      'INVALID_INPUT',
      `no queries in '${file}' (blank lines and # comments are skipped)`,
    );
  }
  return queries;
}

export async function runBatch(
  sources: BatchSources,
  cache: Cache,
  opts: BatchOpts,
  deps: BatchDeps = {},
): Promise<BatchResult> {
  if (!opts.file) throw new EngineError('INVALID_INPUT', 'provide --file <queries.txt>');
  if (!opts.dryRun && !opts.out)
    throw new EngineError('INVALID_INPUT', 'provide --out <corpus.json>');

  const queries = readQueries(opts.file);
  if (opts.dryRun) return runDryRun(queries);

  const delay = opts.delay !== undefined ? Number(opts.delay) : DEFAULT_DELAY_MS;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new EngineError(
      'INVALID_INPUT',
      `--delay must be a non-negative number (got '${opts.delay}')`,
    );
  }

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const progress = deps.progress ?? progressReporter(opts.quiet ?? false);

  const { seen, perQuery } = await executeQueries(
    sources.ghGraphql,
    cache,
    queries,
    delay,
    sleep,
    progress,
  );

  const succeeded = perQuery.filter((q) => q.error === undefined).length;
  const result: BatchResult = {
    queries: queries.length,
    succeeded,
    failed: perQuery.length - succeeded,
    totalUnique: seen.size,
    perQuery,
  };

  const outPath = opts.out as string;
  const freshRepos = [...seen.values()];
  const existing = loadCorpusOrEmpty(outPath, `batch:${opts.file}`, now);
  const fresh: Corpus = {
    schema: CORPUS_SCHEMA,
    intent: existing.intent || `batch:${opts.file}`,
    generatedAt: new Date(now()).toISOString(),
    queries,
    count: freshRepos.length,
    repos: freshRepos,
  };
  const merged = mergeCorpus(existing, fresh);
  saveCorpus(outPath, merged, now);
  result.out = outPath;

  return result;
}
