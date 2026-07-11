// `enrich` — GATE 2 signal deepening (design §3.6, §5). Two stages, both
// strictly serialized (never Promise.all over network calls):
//   1. the light ~15-signal GraphQL fragment in aliased batches of 25
//      (mentionableUsers, commit history(since:90d), state-split issue/PR
//      totals, latestRelease.publishedAt — NEVER releases.totalCount, which
//      design flags falsely-0 — licenseInfo{spdxId,pseudoLicense}, fundingLinks,
//      watchers, diskUsage, isFork/isTemplate/isDisabled, org owner, homepage).
//   2. the ONE mandatory B-group fallback chain per repo: ecosyste.ms →
//      deps.dev (projectPackageVersions → purl → dependents over the last 3
//      versions) → packaged:false + nodata. A mid-chain SOURCE_DOWN falls to
//      the next rung, and the source that actually answered is recorded in the
//      per-signal provenance.
// Every fact lands in the corpus with {value, source, fetchedAt} provenance.
import { mergeCorpus, saveCorpus } from '../cache/corpus.ts';
import {
  CORPUS_SCHEMA,
  type Cache,
  type Corpus,
  type CorpusRepo,
  type SignalProvenance,
  loadCorpus,
} from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import { type ProgressReporter, progressReporter } from '../progress.ts';
import type { DepsDev, PackageKey } from '../sources/depsdev.ts';
import type { Ecosystems } from '../sources/ecosystems.ts';
import type { GhGraphql, RepoResult } from '../sources/gh-graphql.ts';
import { EngineError } from '../types.ts';
import { type RawRepoNode, normalizeRepoNode, updateBudgetFromGraphql } from './_shared.ts';

const GRAPHQL_BATCH = 25;
const COMMIT_WINDOW_DAYS = 90;
const STALE_AFTER_DAYS = 7;
const MS_PER_DAY = 86_400_000;
/** deps.dev :dependents is aggregated over at most this many recent versions (design §3.6). */
const DEPENDENTS_VERSION_WINDOW = 3;

export interface EnrichOpts {
  in?: string;
  ids: string[];
  top?: string;
  skipDeps?: boolean;
  staleOk?: boolean;
  quiet?: boolean;
}

export interface EnrichFailure {
  id: string;
  code: string;
  message: string;
}

export interface EnrichResult {
  enriched: number;
  skipped: number;
  failed: EnrichFailure[];
  pointsSpent: number;
  out?: string;
}

export interface EnrichSources {
  ghGraphql: Pick<GhGraphql, 'batchRepositories' | 'lastRateLimit'>;
  ecosystems: Pick<Ecosystems, 'repo'>;
  depsdev: Pick<DepsDev, 'projectPackageVersions' | 'dependents'>;
}

export interface EnrichDeps {
  now?: () => number;
  progress?: ProgressReporter;
}

export function enrichOptsFromArgs(parsed: ParsedArgs): EnrichOpts {
  return {
    in: parsed.flags.in?.[0],
    ids: parsed.positionals,
    top: parsed.flags.top?.[0],
    skipDeps: parsed.bools.has('skip-deps'),
    staleOk: parsed.bools.has('stale-ok'),
    quiet: parsed.bools.has('quiet'),
  };
}

// ── the light enrich fragment ────────────────────────────────────────────────

/**
 * Build the ~15-signal light fragment (design §3.6). The 90-day commit window
 * is inlined as a literal `since:` — batchRepositories aliases repos without
 * query variables, so the date is baked in at call time, not passed as `$since`.
 */
export function buildEnrichFragment(nowMs: number): string {
  const since = new Date(nowMs - COMMIT_WINDOW_DAYS * MS_PER_DAY).toISOString();
  return `
  nameWithOwner
  id
  databaseId
  stargazerCount
  forkCount
  pushedAt
  createdAt
  isArchived
  isDisabled
  isFork
  isTemplate
  diskUsage
  homepageUrl
  description
  licenseInfo { spdxId pseudoLicense }
  repositoryTopics(first: 10) { nodes { topic { name } } }
  primaryLanguage { name }
  owner { __typename }
  watchers { totalCount }
  mentionableUsers { totalCount }
  fundingLinks { platform }
  defaultBranchRef { target { ... on Commit { history(since: "${since}") { totalCount } } } }
  openIssues: issues(states: OPEN) { totalCount }
  closedIssues: issues(states: CLOSED) { totalCount }
  openPRs: pullRequests(states: OPEN) { totalCount }
  mergedPRs: pullRequests(states: MERGED) { totalCount }
  closedPRs: pullRequests(states: CLOSED) { totalCount }
  latestRelease { publishedAt }
`.trim();
}

// ── the GraphQL enrich node ──────────────────────────────────────────────────

interface Count {
  totalCount?: number;
}
export interface EnrichNode extends RawRepoNode {
  isDisabled?: boolean;
  isFork?: boolean;
  isTemplate?: boolean;
  diskUsage?: number;
  homepageUrl?: string | null;
  licenseInfo?: { spdxId?: string | null; pseudoLicense?: boolean } | null;
  owner?: { __typename?: string } | null;
  watchers?: Count | null;
  mentionableUsers?: Count | null;
  fundingLinks?: Array<{ platform?: string }> | null;
  defaultBranchRef?: { target?: { history?: Count } | null } | null;
  openIssues?: Count | null;
  closedIssues?: Count | null;
  openPRs?: Count | null;
  mergedPRs?: Count | null;
  closedPRs?: Count | null;
  latestRelease?: { publishedAt?: string | null } | null;
}

function makeProv(value: unknown, source: string, fetchedAt: string): SignalProvenance {
  return { value, source, fetchedAt };
}

/** Set a signal only when the value is meaningfully present (counts of 0 are kept; null/undefined/'' are not). */
function put(
  signals: Record<string, SignalProvenance>,
  key: string,
  value: unknown,
  source: string,
  fetchedAt: string,
): void {
  if (value === undefined || value === null || value === '') return;
  signals[key] = makeProv(value, source, fetchedAt);
}

const GH = 'github-graphql';

/** Translate a light-fragment node into per-signal provenance entries. */
export function signalsFromNode(
  node: EnrichNode,
  fetchedAt: string,
): Record<string, SignalProvenance> {
  const s: Record<string, SignalProvenance> = {};
  put(s, 'commits90d', node.defaultBranchRef?.target?.history?.totalCount, GH, fetchedAt);
  put(s, 'releasePublishedAt', node.latestRelease?.publishedAt, GH, fetchedAt);
  put(s, 'openIssues', node.openIssues?.totalCount, GH, fetchedAt);
  put(s, 'closedIssues', node.closedIssues?.totalCount, GH, fetchedAt);
  put(s, 'openPRs', node.openPRs?.totalCount, GH, fetchedAt);
  put(s, 'mergedPRs', node.mergedPRs?.totalCount, GH, fetchedAt);
  put(s, 'closedPRs', node.closedPRs?.totalCount, GH, fetchedAt);
  put(s, 'mentionableUsers', node.mentionableUsers?.totalCount, GH, fetchedAt);
  put(s, 'watchers', node.watchers?.totalCount, GH, fetchedAt);
  put(s, 'diskUsage', node.diskUsage, GH, fetchedAt);
  put(s, 'homepageUrl', node.homepageUrl, GH, fetchedAt);
  put(s, 'fundingLinksCount', node.fundingLinks?.length, GH, fetchedAt);
  put(s, 'pseudoLicense', node.licenseInfo?.pseudoLicense, GH, fetchedAt);
  // Booleans: keep an explicit false (it is real signal), so bypass `put`.
  if (typeof node.isFork === 'boolean') s.isFork = makeProv(node.isFork, GH, fetchedAt);
  if (typeof node.isTemplate === 'boolean') s.isTemplate = makeProv(node.isTemplate, GH, fetchedAt);
  if (typeof node.isDisabled === 'boolean') s.isDisabled = makeProv(node.isDisabled, GH, fetchedAt);
  if (node.owner?.__typename) {
    s.orgOwned = makeProv(node.owner.__typename === 'Organization', GH, fetchedAt);
  }
  return s;
}

// ── the B-group fallback chain ───────────────────────────────────────────────

function numField(obj: unknown, key: string): number | null {
  if (obj === null || typeof obj !== 'object') return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function strField(obj: unknown, key: string): string | null {
  if (obj === null || typeof obj !== 'object') return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function isSourceDownOrMissing(e: unknown): boolean {
  return e instanceof EngineError && (e.code === 'SOURCE_DOWN' || e.code === 'NOT_FOUND');
}

/** Recent {pkg, version} coordinates from a deps.dev GetProjectPackageVersions response (last N). */
function recentVersions(pv: unknown): { pkg: PackageKey; version: string }[] {
  const versions =
    pv !== null && typeof pv === 'object' ? (pv as { versions?: unknown }).versions : undefined;
  if (!Array.isArray(versions)) return [];
  const coords: { pkg: PackageKey; version: string }[] = [];
  for (const entry of versions) {
    const key = (entry as { versionKey?: unknown })?.versionKey;
    const system = strField(key, 'system');
    const name = strField(key, 'name');
    const version = strField(key, 'version');
    if (system && name && version) coords.push({ pkg: { system, name }, version });
  }
  return coords.slice(-DEPENDENTS_VERSION_WINDOW);
}

/**
 * Try ecosyste.ms first: a repo-level dependent count resolves B immediately.
 * Returns the signals on success, or `null` to fall through to deps.dev (both
 * a SOURCE_DOWN/NOT_FOUND and a 2xx-with-no-usage-field fall through).
 */
async function tryEcosystems(
  ecosystems: EnrichSources['ecosystems'],
  fullName: string,
  now: number,
  fetchedAt: string,
): Promise<Record<string, SignalProvenance> | null> {
  let record: unknown;
  try {
    record = await ecosystems.repo(fullName);
  } catch (e) {
    if (isSourceDownOrMissing(e)) return null;
    throw e;
  }
  const dependents = numField(record, 'dependent_repos_count');
  if (dependents === null) return null;
  const s: Record<string, SignalProvenance> = {
    dependentReposCount: makeProv(dependents, 'ecosyste.ms', fetchedAt),
  };
  const downloads = numField(record, 'downloads');
  if (downloads !== null) s.downloads = makeProv(downloads, 'ecosyste.ms', fetchedAt);
  const lastSynced = strField(record, 'last_synced_at');
  if (lastSynced) {
    const ageDays = Math.max(0, (now - Date.parse(lastSynced)) / MS_PER_DAY);
    if (Number.isFinite(ageDays)) s.dataAge = makeProv(ageDays, 'ecosyste.ms', fetchedAt);
  }
  return s;
}

/**
 * deps.dev fallback: map the repo to its packages, aggregate dependents over
 * the last 3 versions (max, to dodge a fresh-release per-version undercount).
 * No packages / NOT_FOUND → `packaged:false`. SOURCE_DOWN → a visible
 * `bSourceDown` marker and B stays nodata.
 */
async function tryDepsDev(
  depsdev: EnrichSources['depsdev'],
  fullName: string,
  fetchedAt: string,
): Promise<Record<string, SignalProvenance>> {
  const slash = fullName.indexOf('/');
  const owner = fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);
  let versions: { pkg: PackageKey; version: string }[];
  try {
    versions = recentVersions(await depsdev.projectPackageVersions(owner, name));
  } catch (e) {
    if (e instanceof EngineError && e.code === 'NOT_FOUND') {
      return { packaged: makeProv(false, 'deps.dev', fetchedAt) };
    }
    if (e instanceof EngineError && e.code === 'SOURCE_DOWN') {
      return { bSourceDown: makeProv(true, 'deps.dev', fetchedAt) };
    }
    throw e;
  }
  if (versions.length === 0) return { packaged: makeProv(false, 'deps.dev', fetchedAt) };

  let maxDependents = 0;
  for (const { pkg, version } of versions) {
    try {
      const count = numField(await depsdev.dependents(pkg, version), 'dependentCount');
      if (count !== null && count > maxDependents) maxDependents = count;
    } catch (e) {
      if (!isSourceDownOrMissing(e)) throw e; // a transient version lookup is skipped, not fatal
    }
  }
  return {
    packaged: makeProv(true, 'deps.dev', fetchedAt),
    dependents: makeProv(maxDependents, 'deps.dev', fetchedAt),
  };
}

/** The whole B chain for one repo, serialized: ecosyste.ms → deps.dev → packaged:false/nodata. */
export async function resolveBGroup(
  sources: EnrichSources,
  fullName: string,
  now: number,
  fetchedAt: string,
): Promise<Record<string, SignalProvenance>> {
  const viaEcosystems = await tryEcosystems(sources.ecosystems, fullName, now, fetchedAt);
  if (viaEcosystems !== null) return viaEcosystems;
  return tryDepsDev(sources.depsdev, fullName, fetchedAt);
}

// ── selection ────────────────────────────────────────────────────────────────

function isEnriched(repo: CorpusRepo): boolean {
  return Object.keys(repo.signals).length > 0;
}

function newestSignalMs(repo: CorpusRepo): number | null {
  let newest: number | null = null;
  for (const prov of Object.values(repo.signals)) {
    const t = Date.parse(prov.fetchedAt);
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

function isFresh(repo: CorpusRepo, now: number): boolean {
  const newest = newestSignalMs(repo);
  return newest !== null && now - newest < STALE_AFTER_DAYS * MS_PER_DAY;
}

/** Resolve which corpus rows this run enriches (ids restrict · --stale-ok skips fresh · --top takes the N highest-star unenriched). */
function selectTargets(repos: CorpusRepo[], opts: EnrichOpts, now: number): CorpusRepo[] {
  let candidates = repos;
  if (opts.ids.length > 0) {
    const wanted = new Set(opts.ids.map((id) => id.toLowerCase()));
    candidates = candidates.filter((r) => wanted.has(r.full_name.toLowerCase()));
  }
  if (opts.staleOk) candidates = candidates.filter((r) => !isFresh(r, now));
  if (opts.top !== undefined) {
    const n = Number(opts.top);
    if (!Number.isInteger(n) || n < 0) {
      throw new EngineError(
        'INVALID_INPUT',
        `--top must be a non-negative integer (got '${opts.top}')`,
      );
    }
    candidates = candidates
      .filter((r) => !isEnriched(r))
      .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
      .slice(0, n);
  }
  return candidates;
}

// ── GraphQL stage ────────────────────────────────────────────────────────────

interface GraphqlStage {
  enrichedRows: CorpusRepo[];
  failed: EnrichFailure[];
  pointsSpent: number;
}

/** Fetch the light fragment for `targets` in serialized 25-batches, summing observed GraphQL cost. */
async function runGraphqlStage(
  sources: EnrichSources,
  cache: Cache,
  targets: CorpusRepo[],
  fragment: string,
  fetchedAt: string,
  progress: ProgressReporter,
): Promise<GraphqlStage> {
  const byName = new Map(targets.map((r) => [r.full_name.toLowerCase(), r]));
  const enrichedRows: CorpusRepo[] = [];
  const failed: EnrichFailure[] = [];
  let pointsSpent = 0;

  for (let i = 0; i < targets.length; i += GRAPHQL_BATCH) {
    const chunk = targets.slice(i, i + GRAPHQL_BATCH).map((r) => r.full_name);
    progress(
      `enrich graphql ${i + 1}-${Math.min(i + GRAPHQL_BATCH, targets.length)}/${targets.length}`,
    );
    const results = await sources.ghGraphql.batchRepositories<EnrichNode>(chunk, fragment, {
      batchSize: GRAPHQL_BATCH,
    });
    updateBudgetFromGraphql(cache, sources.ghGraphql);
    const rl = sources.ghGraphql.lastRateLimit();
    if (rl) pointsSpent += rl.cost;
    collectGraphqlResults(results, byName, fetchedAt, enrichedRows, failed);
  }
  return { enrichedRows, failed, pointsSpent };
}

function collectGraphqlResults(
  results: RepoResult<EnrichNode>[],
  byName: Map<string, CorpusRepo>,
  fetchedAt: string,
  enrichedRows: CorpusRepo[],
  failed: EnrichFailure[],
): void {
  for (const r of results) {
    if (!r.data) {
      failed.push({
        id: r.name,
        code: r.error?.code ?? 'NOT_FOUND',
        message: r.error?.message ?? `no data returned for ${r.name}`,
      });
      continue;
    }
    const existing = byName.get(r.name.toLowerCase());
    const fresh = normalizeRepoNode(r.data, existing?.source ?? 'search');
    fresh.signals = signalsFromNode(r.data, fetchedAt);
    enrichedRows.push(fresh);
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

function loadInputCorpus(path: string | undefined): { corpus: Corpus; path: string } {
  if (!path) throw new EngineError('INVALID_INPUT', 'provide --in <corpus.json>');
  return { corpus: loadCorpus(path), path };
}

/**
 * Run the B chain for every GraphQL-enriched row, strictly serialized (never a
 * Promise.all fan-out — design constraint), folding the resolved usage signals
 * into each row's signal set.
 */
async function runBStage(
  sources: EnrichSources,
  rows: CorpusRepo[],
  now: number,
  fetchedAt: string,
  progress: ProgressReporter,
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as CorpusRepo;
    progress(`enrich B-chain ${i + 1}/${rows.length}: ${row.full_name}`);
    const bSignals = await resolveBGroup(sources, row.full_name, now, fetchedAt);
    Object.assign(row.signals, bSignals);
  }
}

export async function runEnrich(
  sources: EnrichSources,
  cache: Cache,
  opts: EnrichOpts,
  deps: EnrichDeps = {},
): Promise<EnrichResult> {
  const nowFn = deps.now ?? Date.now;
  const progress = deps.progress ?? progressReporter(opts.quiet ?? false);
  const { corpus, path } = loadInputCorpus(opts.in);

  const nowMs = nowFn();
  const fetchedAt = new Date(nowMs).toISOString();
  const targets = selectTargets(corpus.repos, opts, nowMs);
  const skipped = corpus.repos.length - targets.length;

  if (targets.length === 0) {
    return { enriched: 0, skipped, failed: [], pointsSpent: 0, out: path };
  }

  const fragment = buildEnrichFragment(nowMs);
  const { enrichedRows, failed, pointsSpent } = await runGraphqlStage(
    sources,
    cache,
    targets,
    fragment,
    fetchedAt,
    progress,
  );

  if (!opts.skipDeps) await runBStage(sources, enrichedRows, nowMs, fetchedAt, progress);

  const fresh: Corpus = {
    schema: CORPUS_SCHEMA,
    intent: corpus.intent,
    generatedAt: fetchedAt,
    queries: [],
    count: enrichedRows.length,
    repos: enrichedRows,
  };
  const merged = mergeCorpus(corpus, fresh);
  saveCorpus(path, merged, nowFn);

  return { enriched: enrichedRows.length, skipped, failed, pointsSpent, out: path };
}
