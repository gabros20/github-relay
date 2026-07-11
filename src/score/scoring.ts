// The scoring engine (design §5): turn a CorpusRepo's signals into the seven
// canonical group subscores (A–F + L), the profile-specific derived components
// (Structure/Recency/Novelty/BC), a renormalized 0–100 score, coverage honesty
// ("N/7" + nodata[]), the penalty trail, and a full explainability payload.
// Pure — CorpusRepo in, RepoScore out; `rank` is the only caller and it never
// touches the network.
import type { CorpusRepo, SignalProvenance } from '../cache/corpus.ts';
import { type FlagInputs, type Penalty, evaluateFlags } from './flags.ts';
import { clamp01, daysSince, meanPresent, pike, recencyFromDays } from './normalize.ts';
import { CANONICAL_GROUPS, type CanonicalGroup, type Profile, THRESHOLDS } from './profiles.ts';

export type LicenseClass = 'permissive' | 'weak' | 'strong' | 'none' | 'custom';

// SPDX ids grouped by design §5's classification. Uppercased for lookup.
const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'BSD-3-CLAUSE-CLEAR',
  'BSD',
  'ISC',
  '0BSD',
  'ZLIB',
  'UNLICENSE',
  'BSL-1.0',
]);
const WEAK = new Set([
  'MPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'LGPL-2.1-ONLY',
  'LGPL-3.0-ONLY',
  'LGPL-2.1-OR-LATER',
  'LGPL-3.0-OR-LATER',
  'EPL-1.0',
  'EPL-2.0',
  'CDDL-1.0',
  'CDDL-1.1',
]);
const STRONG = new Set([
  'GPL-2.0',
  'GPL-3.0',
  'GPL-2.0-ONLY',
  'GPL-3.0-ONLY',
  'GPL-2.0-OR-LATER',
  'GPL-3.0-OR-LATER',
  'AGPL-3.0',
  'AGPL-3.0-ONLY',
  'AGPL-3.0-OR-LATER',
]);

const LICENSE_POINTS: Record<LicenseClass, number> = {
  permissive: 1.0,
  weak: 0.7,
  strong: 0.4,
  none: 0.1,
  custom: 0.1,
};

/** Classify a license from its SPDX id + GraphQL pseudoLicense flag (design §5). */
export function classifyLicense(
  spdx: string | undefined,
  pseudo: boolean | undefined,
): LicenseClass {
  if (pseudo === true) return 'custom';
  if (!spdx) return 'none';
  const id = spdx.toUpperCase();
  if (id === 'NOASSERTION') return 'custom';
  if (PERMISSIVE.has(id)) return 'permissive';
  if (WEAK.has(id)) return 'weak';
  if (STRONG.has(id)) return 'strong';
  // A real SPDX id we don't recognize is still a license, not "none".
  return 'custom';
}

const DAYS_PER_MONTH = 30.44;
const DISK_MIN_KB = 1024; // 1 MB
const DISK_MAX_KB = 512_000; // ~500 MB

// ── signal access helpers ────────────────────────────────────────────────────

function sig(repo: CorpusRepo, key: string): unknown {
  return repo.signals[key]?.value;
}
function numSig(repo: CorpusRepo, key: string): number | null {
  const v = sig(repo, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function boolSig(repo: CorpusRepo, key: string): boolean | undefined {
  const v = sig(repo, key);
  return typeof v === 'boolean' ? v : undefined;
}
function strSig(repo: CorpusRepo, key: string): string | undefined {
  const v = sig(repo, key);
  return typeof v === 'string' ? v : undefined;
}

/** Jaccard-overlap novelty: 1 − max topic overlap with any sibling; 1 when no topics/siblings. */
function topicNovelty(topics: string[] | undefined, siblingTopics: string[][] | undefined): number {
  if (!topics || topics.length === 0 || !siblingTopics || siblingTopics.length === 0) return 1;
  const self = new Set(topics.map((t) => t.toLowerCase()));
  let maxOverlap = 0;
  for (const sib of siblingTopics) {
    if (sib.length === 0) continue;
    const other = new Set(sib.map((t) => t.toLowerCase()));
    let inter = 0;
    for (const t of self) if (other.has(t)) inter += 1;
    const union = new Set([...self, ...other]).size;
    const jaccard = union === 0 ? 0 : inter / union;
    if (jaccard > maxOverlap) maxOverlap = jaccard;
  }
  return clamp01(1 - maxOverlap);
}

function diskBand(kb: number): number {
  if (kb >= DISK_MIN_KB && kb <= DISK_MAX_KB) return 1;
  if (kb < DISK_MIN_KB) return clamp01(kb / DISK_MIN_KB); // too small (a stub) ramps up to 1MB
  return clamp01(DISK_MAX_KB / kb); // too big (a monorepo/binary dump) decays past 500MB
}

// ── derived metrics ──────────────────────────────────────────────────────────

export interface ScoreContext {
  now: number;
  /** Topic sets of the other corpus repos, for `ideas` Novelty overlap. */
  siblingTopics?: string[][];
}

interface Metrics {
  stars: number;
  forks: number;
  ageDays: number | null;
  // A
  pushRecency: number | null;
  commitsScore: number | null;
  releaseScore: number | null;
  commits90d: number | null;
  // B
  dependentsRaw: number | null;
  dependentsScore: number | null;
  downloadsScore: number | null;
  forksScore: number | null;
  packaged: boolean | undefined;
  dataAgeDays: number | null;
  // C
  mentionableUsers: number | null;
  mentionableScore: number | null;
  contributorShareScore: number | null;
  orgOwned: boolean;
  // D
  closeRatio: number | null;
  closeRatioBasis: CloseRatioBasis;
  latencyScore: number | null;
  // E
  descPresent: number;
  topicsPresent: number;
  homepagePresent: number;
  scorecardScore: number | null;
  skimQualityScore: number | null;
  // F
  starsPerMonth: number;
  spmScore: number;
  burstValidity: number | null;
  // L
  license: LicenseClass;
  licenseScore: number;
  // Structure
  structureScore: number | null;
  // Recency
  createdRecency: number | null;
  // Novelty
  noveltyScore: number;
  flagInputs: FlagInputs;
}

function engagementSum(repo: CorpusRepo): number | null {
  const parts = [
    numSig(repo, 'mentionableUsers'),
    numSig(repo, 'openIssues'),
    numSig(repo, 'closedIssues'),
    numSig(repo, 'openPRs'),
    numSig(repo, 'mergedPRs'),
    numSig(repo, 'closedPRs'),
  ];
  const present = parts.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

export type CloseRatioBasis = '90d' | 'lifetime' | null;

/**
 * D-group close ratio + which basis produced it. The 90d window (design §5 D)
 * lives in health's OWN signal keys (`openIssues90d`/`closedIssues90d`, source
 * `health`), kept distinct from enrich's lifetime `openIssues`/`closedIssues`
 * so a later re-enrich can never silently revert D to the lifetime
 * approximation. Preference: the 90d pair when BOTH are present, else the
 * lifetime pair (the honest pre-health D approximation). This is key selection
 * only — the closed/(open+closed) formula and §5 thresholds are unchanged.
 */
function closeRatioOf(repo: CorpusRepo): { value: number | null; basis: CloseRatioBasis } {
  const open90 = numSig(repo, 'openIssues90d');
  const closed90 = numSig(repo, 'closedIssues90d');
  if (open90 !== null && closed90 !== null) {
    const total = open90 + closed90;
    return { value: total <= 0 ? null : closed90 / total, basis: '90d' };
  }
  const open = numSig(repo, 'openIssues');
  const closed = numSig(repo, 'closedIssues');
  if (open === null || closed === null) return { value: null, basis: null };
  const total = open + closed;
  return { value: total <= 0 ? null : closed / total, basis: 'lifetime' };
}

function skimQualityOf(repo: CorpusRepo): number | null {
  return meanPresent([
    boolBit(boolSig(repo, 'hasCi')),
    boolBit(boolSig(repo, 'hasTests')),
    boolBit(boolSig(repo, 'readmeInstall')),
    boolBit(boolSig(repo, 'readmeUsage')),
    boolBit(boolSig(repo, 'readmeExample')),
  ]);
}

function boolBit(v: boolean | undefined): number | null {
  return v === undefined ? null : v ? 1 : 0;
}

function structureOf(repo: CorpusRepo): number | null {
  const disk = numSig(repo, 'diskUsage');
  return meanPresent([
    disk !== null ? diskBand(disk) : null,
    numSig(repo, 'sourceFileShare'),
    numSig(repo, 'treeDepthSanity'),
  ]);
}

/** `pike(v, T)` but null-preserving — an absent raw signal stays absent, never a 0. */
function satOrNull(v: number | null, threshold: number): number | null {
  return v === null ? null : pike(v, threshold);
}
/** `recencyFromDays(days, T)` but null-preserving. */
function recencyOrNull(days: number | null, threshold: number): number | null {
  return days === null ? null : recencyFromDays(days, threshold);
}
/** A known boolean → 0/1 novelty point, undefined → absent. */
function noveltyBit(v: boolean | undefined): number | null {
  return v === undefined ? null : v ? 0 : 1;
}

function noveltyOf(repo: CorpusRepo, ctx: ScoreContext): number {
  return (
    meanPresent([
      noveltyBit(boolSig(repo, 'isFork')),
      noveltyBit(boolSig(repo, 'isTemplate')),
      topicNovelty(repo.topics, ctx.siblingTopics),
    ]) ?? 1
  );
}

function flagInputsOf(
  repo: CorpusRepo,
  stars: number,
  forks: number,
  ageDays: number | null,
  burstiness: number | null,
  topShare: number | null,
): FlagInputs {
  return {
    archived: repo.archived,
    disabled: boolSig(repo, 'isDisabled'),
    description: repo.description,
    readmeText: strSig(repo, 'readmeHead') ?? null,
    stars,
    forks,
    ageDays,
    burstiness,
    engagementSum: engagementSum(repo),
    topContributorShare: topShare,
    renamed: repo.renamed,
    burstReleaseCoincides: boolSig(repo, 'burstReleaseCoincides'),
    burstIssueInflux: boolSig(repo, 'burstIssueInflux'),
    burstForkGrowth: boolSig(repo, 'burstForkGrowth'),
  };
}

function presentBit(present: unknown): number {
  return present ? 1 : 0;
}

function deriveMetrics(repo: CorpusRepo, ctx: ScoreContext): Metrics {
  const stars = repo.stars ?? 0;
  const forks = repo.forks ?? 0;
  const ageDays = daysSince(repo.createdAt, ctx.now);
  const ageMonths = ageDays !== null && ageDays > 0 ? ageDays / DAYS_PER_MONTH : null;

  const closeRatio = closeRatioOf(repo);
  const commits90d = numSig(repo, 'commits90d');
  const dependentsRaw = numSig(repo, 'dependentReposCount') ?? numSig(repo, 'dependents');
  // No v0.1 source ever writes `downloadsPercentile` — no adapter computes an
  // ecosystem-relative download percentile yet, so this always reads
  // undefined today. The read site is kept (rather than removed) for v0.2,
  // when a source does.
  const downloadsPct = numSig(repo, 'downloadsPercentile');
  const mentionableUsers = numSig(repo, 'mentionableUsers');
  const topShare = numSig(repo, 'topContributorShare');
  const burstiness = numSig(repo, 'burstiness');
  const license = classifyLicense(repo.license, boolSig(repo, 'pseudoLicense'));

  const starsPerMonth = ageMonths && ageMonths > 0 ? stars / ageMonths : stars;

  return {
    stars,
    forks,
    ageDays,
    pushRecency: recencyOrNull(daysSince(repo.pushedAt, ctx.now), THRESHOLDS.push),
    commitsScore: satOrNull(commits90d, THRESHOLDS.commits90d),
    releaseScore: recencyOrNull(
      daysSince(strSig(repo, 'releasePublishedAt'), ctx.now),
      THRESHOLDS.release,
    ),
    commits90d,
    dependentsRaw,
    dependentsScore: satOrNull(dependentsRaw, THRESHOLDS.dependents),
    downloadsScore: downloadsPct === null ? null : clamp01(downloadsPct),
    forksScore: pike(forks, THRESHOLDS.forks),
    packaged: boolSig(repo, 'packaged'),
    dataAgeDays: numSig(repo, 'dataAge'),
    mentionableUsers,
    mentionableScore: satOrNull(mentionableUsers, THRESHOLDS.mentionableUsers),
    contributorShareScore: topShare === null ? null : clamp01(1 - topShare),
    orgOwned: boolSig(repo, 'orgOwned') === true,
    closeRatio: closeRatio.value,
    closeRatioBasis: closeRatio.basis,
    latencyScore: recencyOrNull(numSig(repo, 'closeLatencyDays'), THRESHOLDS.closeLatency),
    descPresent: presentBit(repo.description && repo.description.trim() !== ''),
    topicsPresent: presentBit(repo.topics && repo.topics.length > 0),
    homepagePresent: presentBit(strSig(repo, 'homepageUrl')),
    scorecardScore: numSig(repo, 'scorecard'),
    skimQualityScore: skimQualityOf(repo),
    starsPerMonth,
    spmScore: pike(starsPerMonth, THRESHOLDS.starsPerMonth),
    burstValidity: burstiness === null ? null : clamp01(1 - burstiness),
    license,
    licenseScore: LICENSE_POINTS[license],
    structureScore: structureOf(repo),
    createdRecency: recencyOrNull(ageDays, THRESHOLDS.createdRecency),
    noveltyScore: noveltyOf(repo, ctx),
    flagInputs: flagInputsOf(repo, stars, forks, ageDays, burstiness, topShare),
  };
}

// ── subscores ────────────────────────────────────────────────────────────────

/** The seven canonical group subscores (design §5). `null` = the group has no data. */
function canonicalSubscores(m: Metrics): Record<CanonicalGroup, number | null> {
  const a = meanPresent([m.pushRecency, m.commitsScore, m.releaseScore]);

  // B is absent-with-reason when explicitly unpackaged, or when no usage signal
  // landed. Forks alone never mark B present (an app repo with forks but no
  // dependents is still "no real-usage data" — design §5 flagship case).
  let b: number | null;
  if (m.packaged === false || (m.dependentsScore === null && m.downloadsScore === null)) {
    b = null;
  } else {
    b = meanPresent([m.dependentsScore, m.downloadsScore, m.forksScore]);
  }

  const cBase = meanPresent([m.mentionableScore, m.contributorShareScore]);
  const c = cBase === null ? null : clamp01(cBase + (m.orgOwned ? 0.1 : 0));

  const d = meanPresent([m.closeRatio, m.latencyScore]);
  const e = meanPresent([
    m.descPresent,
    m.topicsPresent,
    m.homepagePresent,
    m.scorecardScore,
    m.skimQualityScore,
  ]);
  const f = meanPresent([m.spmScore, m.burstValidity]);
  return { A: a, B: b, C: c, D: d, E: e, F: f, L: m.licenseScore };
}

/** All weightable component subscores: the 7 canonical plus the derived ones. */
function componentSubscores(
  canon: Record<CanonicalGroup, number | null>,
  m: Metrics,
): Record<string, number | null> {
  return {
    ...canon,
    Structure: m.structureScore,
    Recency: meanPresent([m.createdRecency, m.pushRecency]),
    Novelty: m.noveltyScore,
    BC: meanPresent([canon.B, canon.C]),
  };
}

/**
 * Renormalize the profile weights over the components that actually have data
 * (design §5): score = Σ (w_i / Σw_present) · sub_i. Dividing by the present
 * weight sum makes the profile's absolute total immaterial — a profile that
 * lists weights totalling 95 or 100 produces identical ordering.
 */
function weightedScore(componentSubs: Record<string, number | null>, profile: Profile): number {
  let totalWeight = 0;
  let acc = 0;
  for (const comp of profile.components) {
    if (comp.weight <= 0) continue;
    const sub = componentSubs[comp.key];
    if (sub === null || sub === undefined) continue;
    totalWeight += comp.weight;
    acc += comp.weight * sub;
  }
  return totalWeight > 0 ? acc / totalWeight : 0;
}

function round(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

// ── public result ────────────────────────────────────────────────────────────

export interface ExplainSaturation {
  value: number | null;
  threshold?: number;
  score: number | null;
}

export interface ExplainDetail {
  raw: Record<string, unknown>;
  saturation: Record<string, ExplainSaturation>;
  componentSubs: Record<string, number | null>;
  penalties: Penalty[];
  provenance: Record<string, { source: string; fetchedAt: string }>;
}

export interface RepoScore {
  full_name: string;
  score: number;
  subs: Record<CanonicalGroup, number | null>;
  coverage: string;
  coverageCount: number;
  nodata: CanonicalGroup[];
  flags: string[];
  penalties: Penalty[];
  penaltyProduct: number;
  license: LicenseClass;
  packaged: boolean | undefined;
  // display helpers for the compact row
  stars: number;
  forks: number;
  pushedAt?: string;
  commits90d: number | null;
  dependents: number | null;
  dataAgeDays: number | null;
  description?: string | null;
  explain: ExplainDetail;
}

function roundSubs(
  subs: Record<CanonicalGroup, number | null>,
): Record<CanonicalGroup, number | null> {
  const out = {} as Record<CanonicalGroup, number | null>;
  for (const g of CANONICAL_GROUPS) {
    const v = subs[g];
    out[g] = v === null ? null : round(v, 2);
  }
  return out;
}

function provenanceOf(repo: CorpusRepo): Record<string, { source: string; fetchedAt: string }> {
  const out: Record<string, { source: string; fetchedAt: string }> = {};
  for (const [key, prov] of Object.entries(repo.signals as Record<string, SignalProvenance>)) {
    out[key] = { source: prov.source, fetchedAt: prov.fetchedAt };
  }
  return out;
}

function buildExplain(
  repo: CorpusRepo,
  m: Metrics,
  componentSubs: Record<string, number | null>,
  penalties: Penalty[],
): ExplainDetail {
  return {
    raw: {
      stars: m.stars,
      forks: m.forks,
      ageDays: m.ageDays,
      createdAt: repo.createdAt,
      pushedAt: repo.pushedAt,
      commits90d: m.commits90d,
      dependents: m.dependentsRaw,
      mentionableUsers: m.mentionableUsers,
      starsPerMonth: round(m.starsPerMonth, 2),
      license: m.license,
      packaged: m.packaged,
      dataAgeDays: m.dataAgeDays,
      closeRatio: m.closeRatio,
      // Which issue window fed D's close ratio: '90d' once health has run
      // (openIssues90d/closedIssues90d), 'lifetime' from enrich's totals, or
      // null when neither is present — so --explain shows the basis plainly.
      closeRatioBasis: m.closeRatioBasis,
    },
    saturation: {
      pushRecency: { value: m.ageDays, threshold: THRESHOLDS.push, score: m.pushRecency },
      commits90d: { value: m.commits90d, threshold: THRESHOLDS.commits90d, score: m.commitsScore },
      releaseRecency: { value: null, threshold: THRESHOLDS.release, score: m.releaseScore },
      dependents: {
        value: m.dependentsRaw,
        threshold: THRESHOLDS.dependents,
        score: m.dependentsScore,
      },
      forks: { value: m.forks, threshold: THRESHOLDS.forks, score: m.forksScore },
      mentionableUsers: {
        value: m.mentionableUsers,
        threshold: THRESHOLDS.mentionableUsers,
        score: m.mentionableScore,
      },
      starsPerMonth: {
        value: round(m.starsPerMonth, 2),
        threshold: THRESHOLDS.starsPerMonth,
        score: m.spmScore,
      },
      createdRecency: {
        value: m.ageDays,
        threshold: THRESHOLDS.createdRecency,
        score: m.createdRecency,
      },
      license: { value: null, score: m.licenseScore },
    },
    componentSubs,
    penalties,
    provenance: provenanceOf(repo),
  };
}

/**
 * Score one repo under a profile. Produces the compact-row fields, the coverage
 * honesty ("N/7" + nodata[]), the flag/penalty trail, and the full explain
 * payload — everything `rank` needs, computed with zero network.
 */
export function scoreRepo(repo: CorpusRepo, profile: Profile, ctx: ScoreContext): RepoScore {
  const m = deriveMetrics(repo, ctx);
  const canon = canonicalSubscores(m);
  const componentSubs = componentSubscores(canon, m);

  const raw01 = weightedScore(componentSubs, profile);
  const flagResult = evaluateFlags(m.flagInputs);
  const score = round(clamp01(raw01) * flagResult.penaltyProduct * 100, 1);

  const nodata = CANONICAL_GROUPS.filter((g) => canon[g] === null);
  const coverageCount = CANONICAL_GROUPS.length - nodata.length;

  return {
    full_name: repo.full_name,
    score,
    subs: roundSubs(canon),
    coverage: `${coverageCount}/${CANONICAL_GROUPS.length}`,
    coverageCount,
    nodata,
    flags: flagResult.flags,
    penalties: flagResult.penalties,
    penaltyProduct: flagResult.penaltyProduct,
    license: m.license,
    packaged: m.packaged,
    stars: m.stars,
    forks: m.forks,
    pushedAt: repo.pushedAt,
    commits90d: m.commits90d,
    dependents: m.dependentsRaw,
    dataAgeDays: m.dataAgeDays,
    description: repo.description,
    explain: buildExplain(repo, m, componentSubs, flagResult.penalties),
  };
}
