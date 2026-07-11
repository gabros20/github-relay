import { mergeCorpus, saveCorpus } from '../cache/corpus.ts';
// `search` — the wide discovery net (design §3 item 2, GATE 1). One GraphQL
// `search(type: REPOSITORY)` page (or its REST fallback), pre-enriched,
// zero extra calls. Query-string qualifiers are built from flags and
// validated offline before any network call. `--out` merges into an
// existing corpus (fresh-wins); without it, stdout carries compact rows.
import { CORPUS_SCHEMA, type Cache, type Corpus, type CorpusRepo } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import type { GhGraphql } from '../sources/gh-graphql.ts';
import type { GhRest } from '../sources/gh-rest.ts';
import type { OssInsight, TrendingPeriod, TrendingRow } from '../sources/ossinsight.ts';
import { EngineError } from '../types.ts';
import {
  type CompactRow,
  type RawRepoNode,
  compactRow,
  loadCorpusOrEmpty,
  normalizeRepoNode,
  searchRepositories,
  updateBudgetFromGraphql,
  updateBudgetFromOssInsight,
  updateBudgetFromRestHeaders,
} from './_shared.ts';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const SOURCE_VALUES = new Set(['gh', 'rest', 'trending']);
const SORT_VALUES = new Set(['stars', 'updated']);

// `--period` (design §3 item 2): the CLI's short enum maps onto OSS Insight's
// own period values — the adapter never sees/interprets the CLI's spelling.
const PERIOD_API: Record<string, TrendingPeriod> = {
  '24h': 'past_24_hours',
  week: 'past_week',
  month: 'past_month',
};
const DEFAULT_PERIOD = 'week';

// GitHub's range-qualifier grammar (stars:/created:/pushed:): a bare number,
// a comparator (`>`, `>=`, `<`, `<=`), or a `..` range with an optional `*`
// bound on either side. Dates reuse the same shape with an ISO date/datetime
// token in place of the integer.
const STARS_RANGE_RE = /^(?:\d+|\d+\.\.\d+|\d+\.\.\*|\*\.\.\d+|[<>]=?\d+)$/;
const DATE_TOKEN = String.raw`\d{4}-\d{2}-\d{2}(?:T[\d:]+Z?)?`;
const DATE_RANGE_RE = new RegExp(
  `^(?:${DATE_TOKEN}|${DATE_TOKEN}\\.\\.${DATE_TOKEN}|${DATE_TOKEN}\\.\\.\\*|\\*\\.\\.${DATE_TOKEN}|[<>]=?${DATE_TOKEN})$`,
);

export interface SearchOpts {
  /** Free-text query (already joined from positionals). */
  query: string;
  source?: string;
  /** --source trending only: 24h|week|month → OSS Insight's own period values (default week). */
  period?: string;
  limit?: string;
  language: string[];
  topic: string[];
  stars?: string;
  created?: string;
  pushed?: string;
  sort?: string;
  fields?: string;
  out?: string;
}

export interface ResultCapWarning {
  code: 'RESULT_CAP';
  message: string;
  hint: string;
}

export interface SearchResult {
  query: string;
  count: number;
  merged?: number;
  out?: string;
  /** A full CompactRow, or narrowed to just the requested keys when --fields is given. */
  repos?: Partial<CompactRow>[];
  warning?: ResultCapWarning;
}

/** Only the surface search actually calls — narrower than `Pick<Sources,'ghGraphql'|'ghRest'|'ossinsight'>`, which would still demand each adapter's full declared shape. */
export interface SearchSources {
  ghGraphql: Pick<GhGraphql, 'graphql' | 'lastRateLimit'>;
  ghRest: Pick<GhRest, 'get'>;
  ossinsight: Pick<OssInsight, 'trending'>;
}

export function searchOptsFromArgs(parsed: ParsedArgs): SearchOpts {
  return {
    query: parsed.positionals.join(' '),
    source: parsed.flags.source?.[0],
    period: parsed.flags.period?.[0],
    limit: parsed.flags.limit?.[0],
    language: parsed.flags.language ?? [],
    topic: parsed.flags.topic ?? [],
    stars: parsed.flags.stars?.[0],
    created: parsed.flags.created?.[0],
    pushed: parsed.flags.pushed?.[0],
    sort: parsed.flags.sort?.[0],
    fields: parsed.flags.fields?.[0],
    out: parsed.flags.out?.[0],
  };
}

/** `--source trending` has no GitHub query-qualifier surface (OSS Insight takes only period/language) — every GH-only flag is a loud INVALID_INPUT rather than a silent no-op. */
function validateTrendingFlags(opts: SearchOpts): void {
  const unsupported: string[] = [];
  if (opts.topic.length > 0) unsupported.push('--topic');
  if (opts.stars !== undefined) unsupported.push('--stars');
  if (opts.created !== undefined) unsupported.push('--created');
  if (opts.pushed !== undefined) unsupported.push('--pushed');
  if (opts.sort !== undefined) unsupported.push('--sort');
  if (unsupported.length > 0) {
    throw new EngineError(
      'INVALID_INPUT',
      `--source trending does not support ${unsupported.join(', ')} (OSS Insight has no query-qualifier surface); use --source gh for those filters`,
    );
  }
  if (opts.language.length > 1) {
    throw new EngineError(
      'INVALID_INPUT',
      '--source trending accepts at most one --language (OSS Insight filters by a single language)',
    );
  }
}

function validateFlags(opts: SearchOpts): void {
  if (opts.source !== undefined && !SOURCE_VALUES.has(opts.source)) {
    throw new EngineError(
      'INVALID_INPUT',
      `unknown --source '${opts.source}' (expected gh, rest, or trending)`,
    );
  }
  if (opts.period !== undefined && !(opts.period in PERIOD_API)) {
    throw new EngineError(
      'INVALID_INPUT',
      `unknown --period '${opts.period}' (expected 24h, week, or month)`,
    );
  }
  if (opts.source === 'trending') validateTrendingFlags(opts);
  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw new EngineError(
        'INVALID_INPUT',
        `--limit must be an integer between 1 and ${MAX_LIMIT} (got '${opts.limit}')`,
      );
    }
  }
  if (opts.stars !== undefined && !STARS_RANGE_RE.test(opts.stars)) {
    throw new EngineError(
      'INVALID_INPUT',
      `invalid --stars range '${opts.stars}' (expected e.g. '>100', '10..500', '50..*')`,
    );
  }
  if (opts.created !== undefined && !DATE_RANGE_RE.test(opts.created)) {
    throw new EngineError(
      'INVALID_INPUT',
      `invalid --created range '${opts.created}' (expected an ISO date, comparator, or range)`,
    );
  }
  if (opts.pushed !== undefined && !DATE_RANGE_RE.test(opts.pushed)) {
    throw new EngineError(
      'INVALID_INPUT',
      `invalid --pushed range '${opts.pushed}' (expected an ISO date, comparator, or range)`,
    );
  }
  if (opts.sort !== undefined && !SORT_VALUES.has(opts.sort)) {
    throw new EngineError(
      'INVALID_INPUT',
      `invalid --sort '${opts.sort}' (expected stars or updated)`,
    );
  }
}

function buildQuery(opts: SearchOpts): string {
  const parts: string[] = [];
  if (opts.query.trim()) parts.push(opts.query.trim());
  for (const l of opts.language) parts.push(`language:${l}`);
  for (const t of opts.topic) parts.push(`topic:${t}`);
  if (opts.stars) parts.push(`stars:${opts.stars}`);
  if (opts.created) parts.push(`created:${opts.created}`);
  if (opts.pushed) parts.push(`pushed:${opts.pushed}`);
  if (opts.sort) parts.push(`sort:${opts.sort}`);
  return parts.join(' ');
}

/** A deterministic, ready-made shard suggestion: split the current query on the median star count of the returned page, plus a created: alternative. */
function buildShardHint(query: string, repos: CorpusRepo[]): string {
  const stars = repos.map((r) => r.stars ?? 0).sort((a, b) => a - b);
  const median = stars.length > 0 ? (stars[Math.floor(stars.length / 2)] ?? 0) : 0;
  return `split by stars: try "${query} stars:>${median}" and "${query} stars:<=${median}" (or split by created: date range) and batch the shards`;
}

function projectFields(row: CompactRow, fields: string): Partial<CompactRow> {
  const wanted = fields
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  const out: Partial<CompactRow> = {};
  const source = row as unknown as Record<string, unknown>;
  const dest = out as unknown as Record<string, unknown>;
  for (const key of wanted) {
    if (key in row) dest[key] = source[key];
  }
  return out;
}

interface RestSearchItem {
  full_name?: string;
  node_id?: string;
  stargazers_count?: number;
  forks_count?: number;
  pushed_at?: string;
  created_at?: string;
  license?: { spdx_id?: string | null } | null;
  topics?: string[];
  language?: string | null;
  archived?: boolean;
  description?: string | null;
  html_url?: string;
}

function restItemToRawNode(item: RestSearchItem): RawRepoNode {
  return {
    nameWithOwner: item.full_name,
    id: item.node_id,
    stargazerCount: item.stargazers_count,
    forkCount: item.forks_count,
    pushedAt: item.pushed_at,
    createdAt: item.created_at,
    licenseInfo: item.license ? { spdxId: item.license.spdx_id } : null,
    repositoryTopics: { nodes: (item.topics ?? []).map((t) => ({ topic: { name: t } })) },
    primaryLanguage: item.language ? { name: item.language } : null,
    isArchived: item.archived,
    description: item.description,
    url: item.html_url,
  };
}

async function fetchRest(
  ghRest: Pick<GhRest, 'get'>,
  cache: Cache,
  q: string,
  limit: number,
  sort?: string,
): Promise<{ repositoryCount: number; nodes: RawRepoNode[] }> {
  const sortParam = sort ? `&sort=${sort}&order=desc` : '';
  const res = await ghRest.get(
    `/search/repositories?q=${encodeURIComponent(q)}&per_page=${limit}${sortParam}`,
  );
  updateBudgetFromRestHeaders(cache, 'restSearch', res.headers);
  const body = res.body as { total_count?: number; items?: RestSearchItem[] };
  return {
    repositoryCount: body.total_count ?? 0,
    nodes: (body.items ?? []).map(restItemToRawNode),
  };
}

/** Merge `repos` into `--out`'s corpus (fresh-wins), returning the merged repo count. Shared by every source branch. */
function mergeIntoOut(out: string, intent: string, repos: CorpusRepo[], now: () => number): number {
  const existing = loadCorpusOrEmpty(out, intent, now);
  const fresh: Corpus = {
    schema: CORPUS_SCHEMA,
    intent,
    generatedAt: new Date(now()).toISOString(),
    queries: [intent],
    count: repos.length,
    repos,
  };
  const merged = mergeCorpus(existing, fresh);
  saveCorpus(out, merged, now);
  return merged.repos.length;
}

function buildRows(
  repos: CorpusRepo[],
  nodes: RawRepoNode[],
  fields?: string,
): Partial<CompactRow>[] {
  const rows = repos.map((r, i) => compactRow(r, nodes[i]?.url));
  return fields ? rows.map((r) => projectFields(r, fields)) : rows;
}

// ── --source trending (OSS Insight, design §3 item 2, §4) ──────────────────

/** Trending rows carry no GraphQL node id (like the `code` lane) — `ghid` stays the same '' sentinel `normalizeRepoNode` already uses for "no id yet". `url` is a deterministic github.com/owner/repo, never fabricated data. */
function trendingRowToRawNode(row: TrendingRow): RawRepoNode {
  return {
    nameWithOwner: row.repo_name,
    id: '',
    stargazerCount: row.stars,
    forkCount: row.forks,
    primaryLanguage: row.primary_language ? { name: row.primary_language } : null,
    description: row.description || null,
    url: `https://github.com/${row.repo_name}`,
  };
}

/** A descriptive `query`/corpus-intent label for the trending lane — OSS Insight takes no free-text query, so this is display/provenance only, never sent anywhere. */
function trendingLabel(opts: SearchOpts, period: string, language: string | undefined): string {
  const parts = ['source:trending', `period:${period}`];
  if (language) parts.push(`language:${language}`);
  if (opts.query.trim()) parts.push(opts.query.trim());
  return parts.join(' ');
}

async function runTrendingSearch(
  ossinsight: SearchSources['ossinsight'],
  cache: Cache,
  opts: SearchOpts,
  now: () => number,
): Promise<SearchResult> {
  const periodKey = opts.period ?? DEFAULT_PERIOD;
  const period = PERIOD_API[periodKey] as TrendingPeriod;
  const language = opts.language[0];
  const limit = opts.limit !== undefined ? Number(opts.limit) : DEFAULT_LIMIT;

  const page = await ossinsight.trending(period, language);
  updateBudgetFromOssInsight(cache, page.rateWindow, now);

  const nodes = page.rows.slice(0, limit).map(trendingRowToRawNode);
  const repos = nodes.map((n) => normalizeRepoNode(n, 'trending'));
  const label = trendingLabel(opts, periodKey, language);
  const result: SearchResult = { query: label, count: repos.length };

  if (opts.out) {
    result.merged = mergeIntoOut(opts.out, label, repos, now);
    result.out = opts.out;
  } else {
    result.repos = buildRows(repos, nodes, opts.fields);
  }

  return result;
}

export async function runSearch(
  sources: SearchSources,
  cache: Cache,
  opts: SearchOpts,
  deps: { now?: () => number } = {},
): Promise<SearchResult> {
  const now = deps.now ?? Date.now;
  validateFlags(opts);

  const source = opts.source ?? 'gh';
  if (source === 'trending') {
    return runTrendingSearch(sources.ossinsight, cache, opts, now);
  }

  const q = buildQuery(opts);
  if (!q) {
    throw new EngineError('INVALID_INPUT', 'provide a search query or at least one filter flag');
  }

  const limit = opts.limit !== undefined ? Number(opts.limit) : DEFAULT_LIMIT;

  let repositoryCount: number;
  let nodes: RawRepoNode[];
  if (source === 'rest') {
    const page = await fetchRest(sources.ghRest, cache, q, limit, opts.sort);
    repositoryCount = page.repositoryCount;
    nodes = page.nodes;
  } else {
    const page = await searchRepositories(sources.ghGraphql, q, limit);
    repositoryCount = page.repositoryCount;
    nodes = page.nodes;
    updateBudgetFromGraphql(cache, sources.ghGraphql);
  }

  const repos = nodes.map((n) => normalizeRepoNode(n, 'search'));
  const result: SearchResult = { query: q, count: repos.length };

  if (repositoryCount > 1000 && nodes.length >= limit) {
    result.warning = {
      code: 'RESULT_CAP',
      message: `repositoryCount (${repositoryCount}) exceeds the 1,000-result search cap; only the first page (${nodes.length}) was returned`,
      hint: buildShardHint(q, repos),
    };
  }

  if (opts.out) {
    result.merged = mergeIntoOut(opts.out, q, repos, now);
    result.out = opts.out;
  } else {
    result.repos = buildRows(repos, nodes, opts.fields);
  }

  return result;
}
