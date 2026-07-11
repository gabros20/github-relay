// Fake-star handling + objective penalties (design §5, §1 ledger row 4 —
// panel-settled). The hard rule: penalties (multiplicative) fire ONLY for
// objective conditions (archived, deprecated) or a high-confidence corroborated
// fake-star combo; a star burst ALONE flags but never penalizes. Everything
// here is pure — signal fields in, {flags, penalties, penaltyProduct} out —
// and every penalty leaves an auditable trail entry.

export interface Penalty {
  rule: string;
  factor: number;
  reason: string;
}

export interface FlagResult {
  flags: string[];
  penalties: Penalty[];
  /** Product of every penalty factor (1 when none) — the multiplier scoring applies. */
  penaltyProduct: number;
}

/**
 * The signal fields the policy inspects. Several arrive only in later gates
 * (burstiness, topContributorShare, viral-corroboration inputs — task 11); when
 * absent the rules that need them simply cannot fire, never throw. Values are
 * pulled straight from a repo's derived metrics by scoring.ts.
 */
export interface FlagInputs {
  archived?: boolean;
  disabled?: boolean;
  description?: string | null;
  /** README head text, when a skim has run (task 6) — also scanned for deprecation markers. */
  readmeText?: string | null;
  stars?: number;
  forks?: number;
  ageDays?: number | null;
  /** Max-month share of lifetime stars (task 11 ClickHouse). >0.5 = bursty. */
  burstiness?: number | null;
  /** contributors + issues + PRs, the engagement floor for the fake-star combo. */
  engagementSum?: number | null;
  /** Top-1 contributor commit share (task 11 /contributors). >0.8 = single-maintainer. */
  topContributorShare?: number | null;
  renamed?: boolean;
  /** Viral-corroboration inputs (task 11): the burst month coincides with real activity. */
  burstReleaseCoincides?: boolean;
  burstIssueInflux?: boolean;
  burstForkGrowth?: boolean;
}

const DEPRECATION_RE =
  /\b(deprecat\w+|no longer maintained|unmaintained|abandoned|discontinued|do not use|end[- ]of[- ]life|end[- ]of[- ]support)\b/i;

const BURST_THRESHOLD = 0.5;
const SINGLE_MAINTAINER_SHARE = 0.8;
const FAKE_STAR_MIN_STARS = 500;
const FAKE_STAR_MIN_AGE_DAYS = 182; // ~6 months
const TOO_NEW_MAX_AGE_DAYS = 30;
const RATIO_MIN = 0.005;
const RATIO_MAX = 0.5;

function hasDeprecationMarker(inp: FlagInputs): boolean {
  return DEPRECATION_RE.test(inp.description ?? '') || DEPRECATION_RE.test(inp.readmeText ?? '');
}

/** The high-confidence combo: sustained burst on an old repo with real stars but no human engagement. */
function isFakeStarCombo(inp: FlagInputs): boolean {
  return (
    typeof inp.burstiness === 'number' &&
    inp.burstiness > BURST_THRESHOLD &&
    typeof inp.ageDays === 'number' &&
    inp.ageDays > FAKE_STAR_MIN_AGE_DAYS &&
    typeof inp.engagementSum === 'number' &&
    inp.engagementSum <= 0 &&
    (inp.stars ?? 0) > FAKE_STAR_MIN_STARS
  );
}

/** A burst month that lines up with a release + issue influx + fork growth is likely organic virality, not fraud. */
function isViralCorroborated(inp: FlagInputs): boolean {
  return Boolean(inp.burstReleaseCoincides && inp.burstIssueInflux && inp.burstForkGrowth);
}

/**
 * Evaluate the whole policy for one repo. Penalties stack multiplicatively;
 * flags accumulate. Order of the trail is deterministic (objective conditions
 * first, then the corroborated combo).
 */
export function evaluateFlags(inp: FlagInputs): FlagResult {
  const flags: string[] = [];
  const penalties: Penalty[] = [];

  // ── Objective penalties (design §5) ──
  if (inp.archived === true || inp.disabled === true) {
    flags.push('archived');
    penalties.push({
      rule: 'archived',
      factor: 0.2,
      reason: inp.disabled ? 'repository is disabled' : 'repository is archived',
    });
  }
  if (hasDeprecationMarker(inp)) {
    flags.push('deprecated');
    penalties.push({
      rule: 'deprecated',
      factor: 0.5,
      reason: 'deprecation marker in description/README',
    });
  }

  // ── Star burst: flag always; penalty ONLY on the corroborated combo ──
  const bursty = typeof inp.burstiness === 'number' && inp.burstiness > BURST_THRESHOLD;
  if (bursty) {
    if (isViralCorroborated(inp)) {
      // Corroboration (release + issue influx + fork growth in the burst month)
      // is evidence AGAINST fraud, so it wins over the fake-star combo and
      // downgrades to a no-penalty flag (design §5 viral-corroboration).
      flags.push('likely-viral');
    } else if (isFakeStarCombo(inp)) {
      flags.push('possible-fake-stars');
      penalties.push({
        rule: 'possible-fake-stars',
        factor: 0.5,
        reason: `burstiness ${inp.burstiness} with near-zero engagement and ${inp.stars} stars`,
      });
    } else {
      flags.push('star-burst');
    }
  }

  // ── Flags only, never a penalty ──
  const stars = inp.stars ?? 0;
  const forks = inp.forks ?? 0;
  if (stars > 0) {
    const ratio = forks / stars;
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) flags.push('ratio-anomaly');
  }
  if (
    typeof inp.ageDays === 'number' &&
    inp.ageDays < TOO_NEW_MAX_AGE_DAYS &&
    stars > FAKE_STAR_MIN_STARS
  ) {
    flags.push('too-new-for-stars');
  }
  if (
    typeof inp.topContributorShare === 'number' &&
    inp.topContributorShare > SINGLE_MAINTAINER_SHARE
  ) {
    flags.push('single-maintainer');
  }
  if (inp.renamed === true) flags.push('velocity-partial');

  const penaltyProduct = penalties.reduce((product, p) => product * p.factor, 1);
  return { flags, penalties, penaltyProduct };
}
