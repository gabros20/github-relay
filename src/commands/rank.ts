// `rank` — GATE 2 offline scoring (design §3.7, §5). ZERO network: it takes NO
// Sources, only a corpus path, and re-ranking with a different --profile or
// --weights refetches nothing. Emits ~50-token compact rows (repo id, score,
// the seven subscores, coverage, a 90-char description, stars, velocity,
// dependents, license class, push date, flags, nodata) with a header that
// states average coverage and which command completes the missing groups.
// `--explain owner/repo` prints one repo's raw values, per-signal saturation,
// penalty trail, and per-signal provenance; `--jsonl` emits one row per line.
import { type CorpusRepo, loadCorpus } from '../cache/corpus.ts';
import type { ParsedArgs } from '../cli.ts';
import { type Profile, effectiveProfile } from '../score/profiles.ts';
import { type ExplainDetail, type RepoScore, scoreRepo } from '../score/scoring.ts';
import { EngineError } from '../types.ts';

const DESCRIPTION_MAX = 90;
const STALE_DATA_AGE_DAYS = 90;

export interface RankOpts {
  corpusPath?: string;
  profile?: string;
  weights?: string;
  top?: string;
  minScore?: string;
  explain?: string;
  jsonl?: boolean;
}

/** One compact ranked row (~50 tokens). `r` is the repo id; array order is the rank. */
export interface RankRow {
  r: string;
  s: number;
  subs: RepoScore['subs'];
  coverage: string;
  d: string;
  st: number;
  vel?: number;
  dep?: number;
  lic: string;
  push?: string;
  f: string[];
  nodata: string[];
  dataAge?: number;
}

export interface RankExplain {
  repo: string;
  profile: string;
  score: number;
  coverage: string;
  nodata: string[];
  flags: string[];
  subs: RepoScore['subs'];
  detail: ExplainDetail;
}

export interface RankData {
  profile: string;
  header: string;
  count: number;
  coverage?: { avg: number; min: number };
  rows?: RankRow[];
  jsonl?: string;
  explain?: RankExplain;
}

export function rankOptsFromArgs(parsed: ParsedArgs): RankOpts {
  return {
    corpusPath: parsed.positionals[0],
    profile: parsed.flags.profile?.[0],
    weights: parsed.flags.weights?.[0],
    top: parsed.flags.top?.[0],
    minScore: parsed.flags['min-score']?.[0],
    explain: parsed.flags.explain?.[0],
    jsonl: parsed.bools.has('jsonl'),
  };
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function parseTop(top: string | undefined): number | undefined {
  if (top === undefined) return undefined;
  const n = Number(top);
  if (!Number.isInteger(n) || n < 0) {
    throw new EngineError('INVALID_INPUT', `--top must be a non-negative integer (got '${top}')`);
  }
  return n;
}

function parseMinScore(minScore: string | undefined): number | undefined {
  if (minScore === undefined) return undefined;
  const n = Number(minScore);
  if (!Number.isFinite(n)) {
    throw new EngineError('INVALID_INPUT', `--min-score must be a number (got '${minScore}')`);
  }
  return n;
}

/** Score every repo, giving each the OTHER repos' topic sets for `ideas` Novelty overlap. */
function scoreAll(repos: CorpusRepo[], profile: Profile, now: number): RepoScore[] {
  const allTopics = repos.map((r) => r.topics ?? []);
  return repos.map((repo, i) =>
    scoreRepo(repo, profile, {
      now,
      siblingTopics: allTopics.filter((_, j) => j !== i),
    }),
  );
}

/** Score desc, then repo id asc — a deterministic order independent of corpus array position. */
function byScoreThenName(a: RepoScore, b: RepoScore): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0;
}

function toRow(s: RepoScore): RankRow {
  const row: RankRow = {
    r: s.full_name,
    s: s.score,
    subs: s.subs,
    coverage: s.coverage,
    d: truncate(s.description, DESCRIPTION_MAX),
    st: s.stars,
    lic: s.license,
    f: s.flags,
    nodata: s.nodata,
  };
  if (s.commits90d !== null) row.vel = s.commits90d;
  if (s.dependents !== null) row.dep = s.dependents;
  if (s.pushedAt) row.push = s.pushedAt.slice(0, 10);
  if (s.dataAgeDays !== null && s.dataAgeDays > STALE_DATA_AGE_DAYS) {
    row.dataAge = Math.round(s.dataAgeDays);
  }
  return row;
}

/** Which cheaper command still needs to run to fill a given canonical group. */
const GROUP_COMPLETION: Record<string, string> = {
  A: 'enrich',
  B: 'enrich',
  C: 'enrich/health',
  D: 'enrich/health',
  E: 'skim',
  F: 'health',
  L: 'enrich',
};

function buildHeader(
  profile: Profile,
  scores: RepoScore[],
): { header: string; avg: number; min: number } {
  const counts = scores.map((s) => s.coverageCount);
  const avg = counts.length
    ? Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10
    : 7;
  const min = counts.length ? Math.min(...counts) : 7;
  const missing = new Set<string>();
  for (const s of scores) for (const g of s.nodata) missing.add(g);

  let tail: string;
  if (missing.size === 0) {
    tail = 'full coverage (7/7).';
  } else {
    const groups = [...missing].sort();
    const commands = new Set<string>();
    for (const g of groups) {
      for (const cmd of (GROUP_COMPLETION[g] ?? 'health').split('/')) commands.add(cmd);
    }
    tail = `missing groups ${groups.join('/')} — run ${[...commands].join(', ')} on finalists to complete them.`;
  }
  return {
    header: `profile=${profile.name} · ${scores.length} repos · coverage avg ${avg}/7 (min ${min}/7) · ${tail}`,
    avg,
    min,
  };
}

function explainOne(
  repos: CorpusRepo[],
  profile: Profile,
  now: number,
  target: string,
): RankExplain {
  const key = target.toLowerCase();
  const idx = repos.findIndex((r) => r.full_name.toLowerCase() === key);
  if (idx === -1) throw new EngineError('NOT_FOUND', `no repo '${target}' in the corpus`);
  const allTopics = repos.map((r) => r.topics ?? []);
  const scored = scoreRepo(repos[idx] as CorpusRepo, profile, {
    now,
    siblingTopics: allTopics.filter((_, j) => j !== idx),
  });
  return {
    repo: scored.full_name,
    profile: profile.name,
    score: scored.score,
    coverage: scored.coverage,
    nodata: scored.nodata,
    flags: scored.flags,
    subs: scored.subs,
    detail: scored.explain,
  };
}

export interface RankDeps {
  now?: () => number;
}

export function runRank(opts: RankOpts, deps: RankDeps = {}): RankData {
  if (!opts.corpusPath)
    throw new EngineError('INVALID_INPUT', 'provide a corpus path: rank <corpus.json>');
  const now = (deps.now ?? Date.now)();
  const profile = effectiveProfile(opts.profile, opts.weights);
  const corpus = loadCorpus(opts.corpusPath);

  // --explain is a single-repo focus; it ignores --top/--min-score.
  if (opts.explain !== undefined) {
    const explain = explainOne(corpus.repos, profile, now, opts.explain);
    return {
      profile: profile.name,
      header: `explain ${explain.repo} (profile=${profile.name})`,
      count: 1,
      explain,
    };
  }

  const top = parseTop(opts.top);
  const minScore = parseMinScore(opts.minScore);

  let scored = scoreAll(corpus.repos, profile, now).sort(byScoreThenName);
  if (minScore !== undefined) scored = scored.filter((s) => s.score >= minScore);
  if (top !== undefined) scored = scored.slice(0, top);

  const { header, avg, min } = buildHeader(profile, scored);
  const rows = scored.map(toRow);

  const data: RankData = {
    profile: profile.name,
    header,
    count: rows.length,
    coverage: { avg, min },
  };
  if (opts.jsonl) data.jsonl = rows.map((r) => JSON.stringify(r)).join('\n');
  else data.rows = rows;
  return data;
}
