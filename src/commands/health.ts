import { CORPUS_SCHEMA, mergeCorpus, saveCorpus } from '../cache/corpus.ts';
// `health` — GATE 3 forensics consolidation (design §3 item 8, §5, §12 risks
// 1+2). ONE command completes the C/D/F groups on the finalists instead of
// three separate calls:
//   • a HEAVY GraphQL fragment (aliased ≤10/batch, bisection inherited from
//     batchRepositories): the last ~20 non-bot closed issues → median close
//     latency (D), a 90-day state-split issue ratio (D), and — only when the
//     doctor starredAt probe says the field is alive — a first:100 starredAt
//     sample (F secondary).
//   • ONE ClickHouse POST for the WHOLE id set: lifetime monthly WatchEvent
//     histograms → burstiness (max-month share, F), plus IssuesEvent/ForkEvent
//     for the viral-corroboration downgrade (design §5). ClickHouse down → F
//     degrades to `f_coverage:"partial"`, never silently.
//   • serialized `/contributors?per_page=5` per id → top-1 commit share (C bus
//     factor / single-maintainer flag).
// It WRITES signals the existing scoring path already consumes (burstiness,
// topContributorShare, closeLatencyDays, the 90d issue split, the three
// viral-corroboration booleans) with per-signal provenance, then re-scores via
// the SAME scoreRepo path rank uses — it never reshapes scoring policy (the
// fake-star flag rules live in score/flags.ts, panel-settled). Goodwill-degrade
// discipline throughout: any single source failing degrades that group to
// nodata/partial and is recorded, never aborting the batch.
import { type Corpus, type CorpusRepo, type SignalProvenance, loadCorpus } from '../cache/index.ts';
import type { Cache } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import { type ProgressReporter, progressReporter } from '../progress.ts';
import { resolveProfile } from '../score/profiles.ts';
import { type RepoScore, scoreRepo } from '../score/scoring.ts';
import type { ClickhouseEventRow, ClickhousePlay } from '../sources/clickhouse-play.ts';
import type { GhGraphql, RepoResult } from '../sources/gh-graphql.ts';
import type { GhRest } from '../sources/gh-rest.ts';
import { EngineError } from '../types.ts';
import {
  learnedCeilingRecorder,
  startingBatchSize,
  updateBudgetFromGraphql,
  updateBudgetFromRestHeaders,
} from './_shared.ts';

const HEAVY_BATCH = 10; // design §3: ≤10 ids per heavy fragment
const ISSUE_WINDOW_DAYS = 90;
const CLOSED_SAMPLE_SIZE = 20; // "last 20 closed issues" (design §5 D)
const CLOSED_FETCH_SIZE = 30; // over-fetch so bot filtering still leaves ~20
const STARGAZER_SAMPLE_SIZE = 100; // starredAt is a 1-point sample, never pagination (design §6)
const CONTRIBUTORS_PER_PAGE = 5; // top-1 share denominator (design §3 item 8)
const MS_PER_DAY = 86_400_000;

// ── options ──────────────────────────────────────────────────────────────────

export interface HealthOpts {
  in?: string;
  ids: string[];
  quiet?: boolean;
}

export function healthOptsFromArgs(parsed: ParsedArgs): HealthOpts {
  return {
    in: parsed.flags.in?.[0],
    ids: parsed.positionals,
    quiet: parsed.bools.has('quiet'),
  };
}

export interface HealthSources {
  ghGraphql: Pick<GhGraphql, 'graphql' | 'batchRepositories' | 'lastRateLimit'>;
  ghRest: Pick<GhRest, 'get'>;
  clickhouse: Pick<ClickhousePlay, 'monthlyEvents'>;
}

export interface HealthDeps {
  now?: () => number;
  progress?: ProgressReporter;
}

export type StarredAtShape = 'ok' | 'null-connection' | 'null-edges' | 'probe-skipped';
export type FCoverage = 'partial' | 'partial-renamed';

export interface HealthFailure {
  id: string;
  code: string;
  message: string;
}

export interface HealthRepoSummary {
  id: string;
  coverage: string;
  /** The re-scored C/D/F subscores (the groups health completes); null = still nodata. */
  subs: { C: number | null; D: number | null; F: number | null };
  flags: string[];
  fCoverage?: FCoverage;
  starredAt?: StarredAtShape;
}

export interface HealthResult {
  verified: number;
  failed: HealthFailure[];
  /** Whole-set ClickHouse status: 'ok' when the POST answered, 'partial' when it was SOURCE_DOWN. */
  clickhouse: 'ok' | 'partial';
  starredAtProbe: 'available' | 'restricted' | 'skipped';
  pointsSpent: number;
  repos: HealthRepoSummary[];
  out: string;
}

// ── pure: bot filtering + median close latency (design §5 D) ──────────────────

export interface HeavyIssue {
  createdAt?: string | null;
  closedAt?: string | null;
  author?: { __typename?: string; login?: string } | null;
}

/** A `[bot]`-suffixed login or a Bot actor typename — the design's `[bot]`-filter approximation. */
export function isBotAuthor(author: HeavyIssue['author']): boolean {
  if (!author) return false;
  if (author.__typename === 'Bot') return true;
  return typeof author.login === 'string' && author.login.endsWith('[bot]');
}

/** Median of a pre-sorted, non-empty array. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  if (sorted.length % 2 !== 0) return hi;
  const lo = sorted[mid - 1] ?? hi;
  return (lo + hi) / 2;
}

/**
 * Median close latency in days over the most-recent up-to-20 NON-bot closed
 * issues (design §5 D). `null` when no human-closed issue with both timestamps
 * is present — D then rests on the 90d ratio alone rather than a fake zero.
 */
export function medianCloseLatencyDays(issues: HeavyIssue[]): number | null {
  const latencies: number[] = [];
  for (const issue of issues) {
    if (isBotAuthor(issue.author)) continue;
    if (!issue.createdAt || !issue.closedAt) continue;
    const created = Date.parse(issue.createdAt);
    const closed = Date.parse(issue.closedAt);
    if (Number.isNaN(created) || Number.isNaN(closed)) continue;
    const days = (closed - created) / MS_PER_DAY;
    if (days >= 0) latencies.push(days);
    if (latencies.length >= CLOSED_SAMPLE_SIZE) break;
  }
  if (latencies.length === 0) return null;
  return median([...latencies].sort((a, b) => a - b));
}

// ── pure: top-1 contributor share (design §5 C bus factor) ────────────────────

export interface ContributorEntry {
  login?: string;
  contributions?: number;
}

/**
 * Top-1 contributor's share of the returned contributors' commits (design §5
 * C). The denominator is the (up to 5) contributors `/contributors?per_page=5`
 * returns — a bus-factor proxy, documented as such: one author holding >80% of
 * even the top-5's commits is a single-maintainer signal. `null` when no
 * contributor data is present.
 */
export function topContributorShare(contributors: ContributorEntry[]): number | null {
  const counts = contributors
    .map((c) => c.contributions)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  if (counts.length === 0) return null;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return Math.max(...counts) / total;
}

// ── pure: ClickHouse monthly histogram → velocity (design §5 F) ───────────────

export interface RepoVelocity {
  burstiness: number;
  lifetimeStars: number;
  peakStarMonth: string;
  /** last-3-active-months stars vs the previous 3 (>1 = accelerating). null when too few months. */
  acceleration: number | null;
  burstReleaseCoincides: boolean;
  burstIssueInflux: boolean;
  burstForkGrowth: boolean;
}

function monthCounts(rows: ClickhouseEventRow[], eventType: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.event_type === eventType) m.set(r.month, (m.get(r.month) ?? 0) + r.stars);
  }
  return m;
}

/**
 * Derive F-group velocity for ONE repo from its ClickHouse monthly rows.
 * `null` when the dataset carries no stars for it (renamed repo under an old
 * name, or simply not present) → F stays partial rather than inventing a
 * bursty-looking histogram from noise. `releaseMonth` is the enrich
 * `releasePublishedAt` bucketed to its first-of-month, for the viral-
 * corroboration release check (design §5).
 */
export function deriveVelocity(
  rows: ClickhouseEventRow[],
  releaseMonth: string | null,
): RepoVelocity | null {
  const watch = monthCounts(rows, 'WatchEvent');
  if (watch.size === 0) return null;
  let lifetimeStars = 0;
  let peakStarMonth = '';
  let peak = -1;
  for (const [month, stars] of watch) {
    lifetimeStars += stars;
    if (stars > peak) {
      peak = stars;
      peakStarMonth = month;
    }
  }
  if (lifetimeStars <= 0) return null;

  const issues = monthCounts(rows, 'IssuesEvent');
  const forks = monthCounts(rows, 'ForkEvent');
  const activeMonths = watch.size;
  const avgIssues = sum(issues.values()) / activeMonths;
  const avgForks = sum(forks.values()) / activeMonths;
  const issuesInBurst = issues.get(peakStarMonth) ?? 0;
  const forksInBurst = forks.get(peakStarMonth) ?? 0;

  return {
    burstiness: peak / lifetimeStars,
    lifetimeStars,
    peakStarMonth,
    acceleration: accelerationOf(watch),
    burstReleaseCoincides: releaseMonth !== null && releaseMonth === peakStarMonth,
    burstIssueInflux: issuesInBurst > 0 && issuesInBurst > avgIssues,
    burstForkGrowth: forksInBurst > 0 && forksInBurst > avgForks,
  };
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** last-3 active months' stars over the previous 3 — null when fewer than 6 active months. */
function accelerationOf(watch: Map<string, number>): number | null {
  const series = [...watch.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, n]) => n);
  if (series.length < 6) return null;
  const recent = sum(series.slice(-3));
  const prior = sum(series.slice(-6, -3));
  if (prior <= 0) return null;
  return recent / prior;
}

/** enrich's `releasePublishedAt` ISO → its first-of-month `YYYY-MM-01`, or null. */
function releaseMonthOf(repo: CorpusRepo): string | null {
  const raw = repo.signals.releasePublishedAt?.value;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-01`;
}

// ── heavy GraphQL fragment ─────────────────────────────────────────────────────

export interface HeavyNode {
  nameWithOwner?: string;
  id?: string;
  recentClosed?: { nodes?: HeavyIssue[] | null } | null;
  open90d?: { totalCount?: number } | null;
  closed90d?: { totalCount?: number } | null;
  /** Present only when the starredAt probe said the field is alive; null itself is the partial-error shape. */
  stargazers?: { edges?: ({ starredAt?: string | null } | null)[] | null } | null;
}

/**
 * The heavy fragment body (goes inside each aliased `repository(...) { … }`).
 * `includeStargazers` gates the starredAt sample on the doctor probe result —
 * when restricted we don't even ask, saving the field and avoiding the
 * partial-error path entirely (design §12 risk 1).
 */
export function buildHeavyFragment(nowMs: number, includeStargazers: boolean): string {
  const since = new Date(nowMs - ISSUE_WINDOW_DAYS * MS_PER_DAY).toISOString();
  const stargazers = includeStargazers
    ? `\n  stargazers(first: ${STARGAZER_SAMPLE_SIZE}, orderBy: { field: STARRED_AT, direction: DESC }) { edges { starredAt } }`
    : '';
  // recentClosed is ordered by UPDATED_AT desc (GraphQL offers no CLOSED_AT
  // order) — a closed issue's last update is its close in the overwhelming
  // common case, so this approximates "the last 20 closed" (design §5 D).
  return `
  nameWithOwner
  id
  recentClosed: issues(states: CLOSED, first: ${CLOSED_FETCH_SIZE}, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes { createdAt closedAt author { __typename login } }
  }
  open90d: issues(states: OPEN, filterBy: { since: "${since}" }) { totalCount }
  closed90d: issues(states: CLOSED, filterBy: { since: "${since}" }) { totalCount }${stargazers}
`.trim();
}

const STARRED_AT_PROBE_QUERY = `query {
  repository(owner: "octocat", name: "Hello-World") {
    stargazers(first: 1) { edges { starredAt } }
  }
}`;

/**
 * Re-probe the contested starredAt field once (design §12 risk 1 — doctor
 * doesn't persist its probe result). Hardened to inspect the DATA, not just
 * "did it throw": GitHub's field-level restriction can arrive as a 200 with a
 * null stargazers connection or null edge values, none of which throws.
 * Returns 'available' only when a real starredAt value comes back.
 */
async function probeStarredAt(
  ghGraphql: Pick<GhGraphql, 'graphql'>,
): Promise<'available' | 'restricted' | 'skipped'> {
  try {
    const data = await ghGraphql.graphql<{
      repository?: { stargazers?: { edges?: ({ starredAt?: string | null } | null)[] } | null };
    }>(STARRED_AT_PROBE_QUERY);
    const conn = data?.repository?.stargazers;
    if (conn == null) return 'restricted'; // null connection = the partial-error shape
    const first = conn.edges?.[0];
    return typeof first?.starredAt === 'string' ? 'available' : 'restricted';
  } catch {
    // A thrown INSUFFICIENT_SCOPES / field error / transport failure: treat as
    // unavailable, never abort health (F still has ClickHouse).
    return 'skipped';
  }
}

/**
 * Classify the starredAt sample against all three degradation shapes (design's
 * CRITICAL hardening note): a null connection (partial error), null edge values,
 * or a genuine sample. Returns the span in days across the sampled edges when
 * present, plus which shape occurred (recorded in provenance).
 */
export function readStarredAtSample(node: HeavyNode): {
  shape: StarredAtShape;
  spanDays: number | null;
  count: number;
} {
  if (node.stargazers === undefined) return { shape: 'probe-skipped', spanDays: null, count: 0 };
  if (node.stargazers === null) return { shape: 'null-connection', spanDays: null, count: 0 };
  const times: number[] = [];
  for (const edge of node.stargazers.edges ?? []) {
    if (edge && typeof edge.starredAt === 'string') {
      const t = Date.parse(edge.starredAt);
      if (!Number.isNaN(t)) times.push(t);
    }
  }
  if (times.length === 0) return { shape: 'null-edges', spanDays: null, count: 0 };
  const spanDays = (Math.max(...times) - Math.min(...times)) / MS_PER_DAY;
  return { shape: 'ok', spanDays, count: times.length };
}

// ── signal assembly ────────────────────────────────────────────────────────────

function prov(value: unknown, source: string, fetchedAt: string): SignalProvenance {
  return { value, source, fetchedAt };
}

/** Set a signal when the value is meaningfully present (0 and false kept; null/undefined/'' dropped). */
function put(
  signals: Record<string, SignalProvenance>,
  key: string,
  value: unknown,
  source: string,
  fetchedAt: string,
): void {
  if (value === undefined || value === null || value === '') return;
  signals[key] = prov(value, source, fetchedAt);
}

const GH = 'github-graphql';
const REST = 'github-rest';
const CH = 'clickhouse-play';
// health's own 90d issue-window facts live under distinct keys with a distinct
// provenance source, kept separate from enrich's lifetime openIssues/closedIssues
// so a later re-enrich can't silently revert D's basis (scoring prefers the 90d
// keys when present). The source marker also makes --explain's basis obvious.
const HEALTH = 'health';

interface AssembledSignals {
  signals: Record<string, SignalProvenance>;
  fCoverage?: FCoverage;
  starredAt?: StarredAtShape;
}

/**
 * Fold one repo's three forensic sources into a signal set. `renamed` rows get
 * `f_coverage:"partial-renamed"` and NO burstiness: GH Archive keys events by
 * repo-name-at-event-time, so a renamed repo's velocity is undercounted under
 * its current name and a burst reading would be spurious — no false fake-star
 * penalty (design §9/§12 risk 9).
 */
function assembleSignals(args: {
  heavy: HeavyNode | undefined;
  velocity: RepoVelocity | null;
  topShare: number | null;
  renamed: boolean;
  fetchedAt: string;
}): AssembledSignals {
  const { heavy, velocity, topShare, renamed, fetchedAt } = args;
  const signals: Record<string, SignalProvenance> = {};
  let starredAt: StarredAtShape | undefined;

  // D — heavy fragment: median close latency + the 90d state-split ratio. The
  // 90d counts land in DISTINCT keys (openIssues90d/closedIssues90d, source
  // `health`), NOT enrich's lifetime openIssues/closedIssues — scoring prefers
  // the 90d pair when present but keeps the lifetime pair as an honest fallback,
  // so a re-enrich after health can never silently revert D's basis.
  if (heavy) {
    const latency = medianCloseLatencyDays(heavy.recentClosed?.nodes ?? []);
    put(signals, 'closeLatencyDays', latency, GH, fetchedAt);
    put(signals, 'openIssues90d', heavy.open90d?.totalCount, HEALTH, fetchedAt);
    put(signals, 'closedIssues90d', heavy.closed90d?.totalCount, HEALTH, fetchedAt);
    const sample = readStarredAtSample(heavy);
    starredAt = sample.shape;
    put(signals, 'starredAtSampleShape', sample.shape, GH, fetchedAt);
    put(signals, 'starredAtSampleSpanDays', sample.spanDays, GH, fetchedAt);
    put(signals, 'starredAtSampleCount', sample.count, GH, fetchedAt);
  }

  // C — /contributors top-1 share (bus factor / single-maintainer flag).
  put(signals, 'topContributorShare', topShare, REST, fetchedAt);

  // F — ClickHouse velocity. Renamed repos skip burstiness (see above).
  let fCoverage: FCoverage | undefined;
  if (renamed) {
    fCoverage = 'partial-renamed';
    put(signals, 'velocityPartialRenamed', true, CH, fetchedAt);
  } else if (velocity) {
    put(signals, 'burstiness', velocity.burstiness, CH, fetchedAt);
    put(signals, 'lifetimeStars', velocity.lifetimeStars, CH, fetchedAt);
    put(signals, 'peakStarMonth', velocity.peakStarMonth, CH, fetchedAt);
    put(signals, 'acceleration', velocity.acceleration, CH, fetchedAt);
    put(signals, 'burstReleaseCoincides', velocity.burstReleaseCoincides, CH, fetchedAt);
    put(signals, 'burstIssueInflux', velocity.burstIssueInflux, CH, fetchedAt);
    put(signals, 'burstForkGrowth', velocity.burstForkGrowth, CH, fetchedAt);
  } else {
    // ClickHouse down, or no rows for this repo → F stays on ratio checks only.
    fCoverage = 'partial';
  }
  if (fCoverage) put(signals, 'fCoverage', fCoverage, CH, fetchedAt);

  return { signals, fCoverage, starredAt };
}

// ── target selection ───────────────────────────────────────────────────────────

/** Rows to verify: the given ids (case-insensitive), or every corpus row when no id is given. Unknown ids become failures. */
function selectTargets(
  repos: CorpusRepo[],
  ids: string[],
): { targets: CorpusRepo[]; failed: HealthFailure[] } {
  if (ids.length === 0) return { targets: repos, failed: [] };
  const byName = new Map(repos.map((r) => [r.full_name.toLowerCase(), r]));
  const targets: CorpusRepo[] = [];
  const failed: HealthFailure[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = byName.get(key);
    if (row) targets.push(row);
    else failed.push({ id, code: 'NOT_FOUND', message: `'${id}' is not in the corpus` });
  }
  return { targets, failed };
}

// ── the three network stages ───────────────────────────────────────────────────

interface HeavyStage {
  byName: Map<string, HeavyNode>;
  failed: HealthFailure[];
  pointsSpent: number;
}

async function runHeavyStage(
  sources: HealthSources,
  cache: Cache,
  names: string[],
  fragment: string,
  progress: ProgressReporter,
): Promise<HeavyStage> {
  const byName = new Map<string, HeavyNode>();
  const failed: HealthFailure[] = [];
  let pointsSpent = 0;
  const batchSize = startingBatchSize(cache, 'heavy', HEAVY_BATCH);
  const onEffectiveSize = learnedCeilingRecorder(cache, 'heavy', batchSize);
  for (let i = 0; i < names.length; i += HEAVY_BATCH) {
    const chunk = names.slice(i, i + HEAVY_BATCH);
    progress(`health heavy ${i + 1}-${Math.min(i + HEAVY_BATCH, names.length)}/${names.length}`);
    const results: RepoResult<HeavyNode>[] = await sources.ghGraphql.batchRepositories<HeavyNode>(
      chunk,
      fragment,
      { batchSize, onEffectiveSize },
    );
    updateBudgetFromGraphql(cache, sources.ghGraphql);
    const rl = sources.ghGraphql.lastRateLimit();
    if (rl) pointsSpent += rl.cost;
    for (const r of results) {
      if (r.data) byName.set(r.name.toLowerCase(), r.data);
      else
        failed.push({
          id: r.name,
          code: r.error?.code ?? 'NOT_FOUND',
          message: r.error?.message ?? `no heavy data for ${r.name}`,
        });
    }
  }
  return { byName, failed, pointsSpent };
}

/** ONE ClickHouse POST for the whole set; a SOURCE_DOWN degrades every repo's F to partial. */
async function runClickhouseStage(
  sources: HealthSources,
  names: string[],
  progress: ProgressReporter,
): Promise<{ rowsByRepo: Map<string, ClickhouseEventRow[]>; ok: boolean }> {
  progress(`health clickhouse (1 POST, ${names.length} ids)`);
  const rowsByRepo = new Map<string, ClickhouseEventRow[]>();
  try {
    const rows = await sources.clickhouse.monthlyEvents(names);
    for (const row of rows) {
      const key = row.repo_name.toLowerCase();
      const list = rowsByRepo.get(key);
      if (list) list.push(row);
      else rowsByRepo.set(key, [row]);
    }
    return { rowsByRepo, ok: true };
  } catch (e) {
    // INVALID_INPUT here would be our own bug (an unsafe name we built the query
    // from) — stay loud. Any goodwill degradation is swallowed to partial.
    if (e instanceof EngineError && e.code === 'INVALID_INPUT') throw e;
    return { rowsByRepo, ok: false };
  }
}

interface ContribEntryRaw {
  login?: string;
  contributions?: number;
}

/** Serialized `/contributors?per_page=5` per repo (never Promise.all). Per-repo failure degrades C, never aborts. */
async function runContributorsStage(
  sources: HealthSources,
  cache: Cache,
  targets: CorpusRepo[],
  progress: ProgressReporter,
): Promise<Map<string, number>> {
  const shareByName = new Map<string, number>();
  let i = 0;
  for (const row of targets) {
    i += 1;
    progress(`health contributors ${i}/${targets.length}: ${row.full_name}`);
    const slash = row.full_name.indexOf('/');
    if (slash <= 0) continue;
    const owner = row.full_name.slice(0, slash);
    const repo = row.full_name.slice(slash + 1);
    try {
      const res = await sources.ghRest.get(
        `/repos/${owner}/${repo}/contributors?per_page=${CONTRIBUTORS_PER_PAGE}&anon=false`,
      );
      updateBudgetFromRestHeaders(cache, 'restCore', res.headers);
      const body = Array.isArray(res.body) ? (res.body as ContribEntryRaw[]) : [];
      const share = topContributorShare(body);
      if (share !== null) shareByName.set(row.full_name.toLowerCase(), share);
    } catch {
      // A 404/SOURCE_DOWN/rate-limit on one repo degrades only that repo's C.
    }
  }
  return shareByName;
}

// ── run ────────────────────────────────────────────────────────────────────────

function loadInputCorpus(path: string | undefined): { corpus: Corpus; path: string } {
  if (!path) throw new EngineError('INVALID_INPUT', 'provide --in <corpus.json>');
  return { corpus: loadCorpus(path), path };
}

function summarize(
  repo: CorpusRepo,
  scored: RepoScore,
  assembled: AssembledSignals,
): HealthRepoSummary {
  const summary: HealthRepoSummary = {
    id: repo.full_name,
    coverage: scored.coverage,
    subs: { C: scored.subs.C, D: scored.subs.D, F: scored.subs.F },
    flags: scored.flags,
  };
  if (assembled.fCoverage) summary.fCoverage = assembled.fCoverage;
  if (assembled.starredAt) summary.starredAt = assembled.starredAt;
  return summary;
}

export async function runHealth(
  sources: HealthSources,
  cache: Cache,
  opts: HealthOpts,
  deps: HealthDeps = {},
): Promise<HealthResult> {
  const nowFn = deps.now ?? Date.now;
  const progress = deps.progress ?? progressReporter(opts.quiet ?? false);
  const { corpus, path } = loadInputCorpus(opts.in);

  const { targets, failed: selectFailed } = selectTargets(corpus.repos, opts.ids);
  const nowMs = nowFn();
  const fetchedAt = new Date(nowMs).toISOString();

  if (targets.length === 0) {
    return {
      verified: 0,
      failed: selectFailed,
      clickhouse: 'ok',
      starredAtProbe: 'skipped',
      pointsSpent: 0,
      repos: [],
      out: path,
    };
  }

  const names = targets.map((r) => r.full_name);

  // 1) re-probe the contested starredAt feature ONCE (design §12 risk 1).
  const probe = await probeStarredAt(sources.ghGraphql);
  const starredAtProbe =
    probe === 'available' ? 'available' : probe === 'restricted' ? 'restricted' : 'skipped';

  // 2) heavy fragment (aliased ≤10/batch, bisection inherited).
  const fragment = buildHeavyFragment(nowMs, probe === 'available');
  const heavy = await runHeavyStage(sources, cache, names, fragment, progress);

  // 3) ONE ClickHouse POST for the whole set.
  const clickhouse = await runClickhouseStage(sources, names, progress);

  // 4) serialized /contributors per id.
  const shares = await runContributorsStage(sources, cache, targets, progress);

  // 5) assemble + merge signals, then re-score via the SAME scoreRepo path.
  const freshRows: CorpusRepo[] = [];
  const assembledByName = new Map<string, AssembledSignals>();
  for (const row of targets) {
    const key = row.full_name.toLowerCase();
    const heavyNode = heavy.byName.get(key);
    const velocity = clickhouse.ok
      ? deriveVelocity(clickhouse.rowsByRepo.get(key) ?? [], releaseMonthOf(row))
      : null;
    const assembled = assembleSignals({
      heavy: heavyNode,
      velocity,
      topShare: shares.get(key) ?? null,
      renamed: row.renamed === true,
      fetchedAt,
    });
    assembledByName.set(key, assembled);
    if (Object.keys(assembled.signals).length > 0) {
      freshRows.push({
        full_name: row.full_name,
        ghid: heavyNode?.id || row.ghid,
        aliases: [],
        source: row.source,
        signals: assembled.signals,
      });
    }
  }

  const fresh: Corpus = {
    schema: CORPUS_SCHEMA,
    intent: corpus.intent,
    generatedAt: fetchedAt,
    queries: [],
    count: freshRows.length,
    repos: freshRows,
  };
  const merged = mergeCorpus(corpus, fresh);
  saveCorpus(path, merged, nowFn);

  // Re-score the targets from the MERGED corpus (enrich + health signals).
  const profile = resolveProfile(undefined); // build-on; canonical subs are profile-independent
  const allTopics = merged.repos.map((r) => r.topics ?? []);
  const mergedByName = new Map(merged.repos.map((r, i) => [r.full_name.toLowerCase(), { r, i }]));
  const repos: HealthRepoSummary[] = [];
  for (const target of targets) {
    const key = target.full_name.toLowerCase();
    const entry = mergedByName.get(key);
    if (!entry) continue;
    const scored = scoreRepo(entry.r, profile, {
      now: nowMs,
      siblingTopics: allTopics.filter((_, j) => j !== entry.i),
    });
    repos.push(summarize(entry.r, scored, assembledByName.get(key) ?? { signals: {} }));
  }

  return {
    verified: freshRows.length,
    failed: [...selectFailed, ...heavy.failed],
    clickhouse: clickhouse.ok ? 'ok' : 'partial',
    starredAtProbe,
    pointsSpent: heavy.pointsSpent,
    repos,
    out: path,
  };
}
