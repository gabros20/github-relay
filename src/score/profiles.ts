// The three scoring profiles and their EXACT design §5 weights, the per-signal
// saturation thresholds, and the `--weights` override parser. Pure config +
// validation — no scoring math here (that's scoring.ts), so the panel-settled
// numbers live in one auditable place.
import { EngineError } from '../types.ts';

/**
 * Per-signal Pike thresholds T (design §5 / brief). A signal at its threshold
 * saturates to ~1. These are research-derived priors — calibration fixtures
 * pin ORDERING stability, not these absolute values.
 */
export const THRESHOLDS = {
  /** days-since-push, inverted */
  push: 365,
  /** commits in the last 90 days */
  commits90d: 250,
  /** days-since latest release, inverted */
  release: 730,
  /** dependent repos (ecosyste.ms) / dependents (deps.dev) */
  dependents: 1000,
  /** forks (a secondary real-usage proxy) */
  forks: 2000,
  /** mentionableUsers (C-lite community proxy) */
  mentionableUsers: 100,
  /** median issue close latency in days, inverted */
  closeLatency: 14,
  /** stars per month of age (the only star-derived F input) */
  starsPerMonth: 100,
  /** days-since-created, inverted (the `ideas` recency window ≈ 18 months) */
  createdRecency: 547,
} as const;

/** The seven canonical coverage groups (design §5) — coverage is always "N/7" over these. */
export const CANONICAL_GROUPS = ['A', 'B', 'C', 'D', 'E', 'F', 'L'] as const;
export type CanonicalGroup = (typeof CANONICAL_GROUPS)[number];

/**
 * Every weightable component key: the seven canonical groups plus the
 * profile-specific derived components. `Structure` (dissect) blends skim/disk
 * structure signals; `Recency` and `Novelty` (ideas) derive from always-present
 * pre-enrich fields; `BC` (ideas) is the combined B+C real-usage/community
 * facet. Derived components participate in weight renormalization but never in
 * the /7 coverage count (which is strictly the canonical groups).
 */
export type ComponentKey = CanonicalGroup | 'Structure' | 'Recency' | 'Novelty' | 'BC';

const ALL_COMPONENT_KEYS: ComponentKey[] = [
  ...CANONICAL_GROUPS,
  'Structure',
  'Recency',
  'Novelty',
  'BC',
];

export interface ProfileComponent {
  key: ComponentKey;
  weight: number;
}

export interface Profile {
  name: string;
  components: ProfileComponent[];
}

export type ProfileName = 'build-on' | 'dissect' | 'ideas';

/** The three profiles, weights verbatim from design §5. */
export const PROFILES: Record<ProfileName, Profile> = {
  'build-on': {
    name: 'build-on',
    components: [
      { key: 'A', weight: 25 },
      { key: 'B', weight: 20 },
      { key: 'C', weight: 15 },
      { key: 'D', weight: 10 },
      { key: 'E', weight: 10 },
      { key: 'F', weight: 10 },
      { key: 'L', weight: 10 },
    ],
  },
  dissect: {
    name: 'dissect',
    components: [
      { key: 'E', weight: 40 },
      // Erratum 2026-07-11 (design §5): panel text listed Structure15 (summing to
      // 95); corrected to 20 so dissect totals 100 — Structure, the dissect-only
      // group, absorbs the gap. Scoring renormalizes by present weight regardless.
      { key: 'Structure', weight: 20 },
      { key: 'A', weight: 5 },
      { key: 'B', weight: 10 },
      { key: 'C', weight: 10 },
      { key: 'D', weight: 5 },
      { key: 'F', weight: 10 },
      { key: 'L', weight: 0 },
    ],
  },
  ideas: {
    name: 'ideas',
    components: [
      { key: 'Recency', weight: 30 },
      { key: 'F', weight: 25 },
      { key: 'E', weight: 20 },
      { key: 'Novelty', weight: 15 },
      { key: 'BC', weight: 10 },
      { key: 'L', weight: 0 },
    ],
  },
};

export const DEFAULT_PROFILE: ProfileName = 'build-on';
export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];

/** Weights must sum to 100 within this tolerance, else INVALID_INPUT. */
const WEIGHT_SUM_TOLERANCE = 0.5;

export function isProfileName(name: string): name is ProfileName {
  return name in PROFILES;
}

export function resolveProfile(name: string | undefined): Profile {
  if (name === undefined) return PROFILES[DEFAULT_PROFILE];
  if (!isProfileName(name)) {
    throw new EngineError(
      'INVALID_INPUT',
      `unknown profile '${name}' (expected one of: ${PROFILE_NAMES.join(', ')})`,
    );
  }
  return PROFILES[name];
}

function isComponentKey(key: string): key is ComponentKey {
  return (ALL_COMPONENT_KEYS as string[]).includes(key);
}

/**
 * Parse a `--weights A=25,B=20,...` override into a component list. Validates
 * every key against the known component set, every value as a finite
 * non-negative number, and the total as 100 ± tolerance — any failure is a
 * pre-network INVALID_INPUT (design §9). The parsed set REPLACES the base
 * profile's components entirely (re-weighting is zero-network, design §5).
 */
export function parseWeights(spec: string): ProfileComponent[] {
  const components: ProfileComponent[] = [];
  const seen = new Set<string>();
  for (const rawPair of spec.split(',')) {
    const pair = rawPair.trim();
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if (eq === -1) {
      throw new EngineError('INVALID_INPUT', `--weights entry '${pair}' must be KEY=NUMBER`);
    }
    const key = pair.slice(0, eq).trim();
    const valueText = pair.slice(eq + 1).trim();
    if (!isComponentKey(key)) {
      throw new EngineError(
        'INVALID_INPUT',
        `--weights has unknown group '${key}' (valid: ${ALL_COMPONENT_KEYS.join(', ')})`,
      );
    }
    if (seen.has(key)) {
      throw new EngineError('INVALID_INPUT', `--weights lists '${key}' more than once`);
    }
    const weight = Number(valueText);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new EngineError(
        'INVALID_INPUT',
        `--weights value for '${key}' must be a non-negative number (got '${valueText}')`,
      );
    }
    seen.add(key);
    components.push({ key, weight });
  }
  if (components.length === 0) {
    throw new EngineError('INVALID_INPUT', '--weights was empty; expected e.g. A=25,B=20,...');
  }
  const total = components.reduce((sum, c) => sum + c.weight, 0);
  if (Math.abs(total - 100) > WEIGHT_SUM_TOLERANCE) {
    throw new EngineError('INVALID_INPUT', `--weights must sum to 100 (got ${total})`);
  }
  return components;
}

/**
 * Resolve the effective profile from `--profile` and/or `--weights`. A
 * `--weights` override keeps the named (or default) profile's identity for
 * reporting but swaps in the custom component set.
 */
export function effectiveProfile(
  profileName: string | undefined,
  weights: string | undefined,
): Profile {
  const base = resolveProfile(profileName);
  if (weights === undefined) return base;
  return { name: `${base.name}+custom-weights`, components: parseWeights(weights) };
}
