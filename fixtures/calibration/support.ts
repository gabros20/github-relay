// Calibration fixture support (design §5, PLAN decision 1). Hand-authored
// plain-object repos with realistic signal values, labelled good/junk. These
// are ORDERING regression contracts, not absolute-truth assertions: within a
// profile every known-good must outrank every known-junk, and the junk set must
// trip the flags the design promises. A fixed reference clock keeps every
// relative date stable across runs.
import type { CorpusRepo, SignalProvenance } from '../../src/cache/corpus.ts';

export const CALIB_NOW = Date.parse('2026-07-11T00:00:00Z');
const MS_PER_DAY = 86_400_000;

/** ISO timestamp `n` days before the reference clock. */
export function daysAgo(n: number): string {
  return new Date(CALIB_NOW - n * MS_PER_DAY).toISOString();
}

const FETCHED_AT = daysAgo(2);

function sig(value: unknown, source = 'github-graphql'): SignalProvenance {
  return { value, source, fetchedAt: FETCHED_AT };
}

export interface CaseFields {
  stars: number;
  forks: number;
  createdDaysAgo: number;
  pushedDaysAgo: number;
  license?: string;
  pseudoLicense?: boolean;
  topics?: string[];
  description?: string | null;
  archived?: boolean;
  // enrich signals (any omitted → that signal is absent)
  commits90d?: number;
  releaseDaysAgo?: number;
  dependentReposCount?: number;
  packaged?: boolean;
  mentionableUsers?: number;
  openIssues?: number;
  closedIssues?: number;
  orgOwned?: boolean;
  diskUsage?: number;
  isFork?: boolean;
  isTemplate?: boolean;
  homepageUrl?: string;
  // skim/quality signals (task 6) + forensics (task 11)
  hasCi?: boolean;
  hasTests?: boolean;
  readmeInstall?: boolean;
  readmeUsage?: boolean;
  readmeExample?: boolean;
  burstiness?: number;
  engagementSumZero?: boolean; // model a fake-star repo: mentionable/issues all 0
}

export interface CalibrationCase {
  label: 'good' | 'junk';
  note: string;
  repo: CorpusRepo;
  /** Flags that MUST fire on this case (junk-set flag contract). */
  expectFlags?: string[];
}

function buildSignals(f: CaseFields): Record<string, SignalProvenance> {
  const s: Record<string, SignalProvenance> = {};
  const zero = f.engagementSumZero === true;
  if (f.commits90d !== undefined) s.commits90d = sig(f.commits90d);
  if (f.releaseDaysAgo !== undefined) s.releasePublishedAt = sig(daysAgo(f.releaseDaysAgo));
  if (f.dependentReposCount !== undefined) {
    s.dependentReposCount = sig(f.dependentReposCount, 'ecosyste.ms');
  }
  if (f.packaged !== undefined) s.packaged = sig(f.packaged, 'deps.dev');
  if (f.mentionableUsers !== undefined) s.mentionableUsers = sig(zero ? 0 : f.mentionableUsers);
  if (f.openIssues !== undefined) s.openIssues = sig(zero ? 0 : f.openIssues);
  if (f.closedIssues !== undefined) s.closedIssues = sig(zero ? 0 : f.closedIssues);
  if (f.orgOwned !== undefined) s.orgOwned = sig(f.orgOwned);
  if (f.diskUsage !== undefined) s.diskUsage = sig(f.diskUsage);
  if (f.isFork !== undefined) s.isFork = sig(f.isFork);
  if (f.isTemplate !== undefined) s.isTemplate = sig(f.isTemplate);
  if (f.homepageUrl !== undefined) s.homepageUrl = sig(f.homepageUrl);
  if (f.pseudoLicense !== undefined) s.pseudoLicense = sig(f.pseudoLicense);
  if (f.hasCi !== undefined) s.hasCi = sig(f.hasCi);
  if (f.hasTests !== undefined) s.hasTests = sig(f.hasTests);
  if (f.readmeInstall !== undefined) s.readmeInstall = sig(f.readmeInstall);
  if (f.readmeUsage !== undefined) s.readmeUsage = sig(f.readmeUsage);
  if (f.readmeExample !== undefined) s.readmeExample = sig(f.readmeExample);
  if (f.burstiness !== undefined) s.burstiness = sig(f.burstiness, 'clickhouse');
  return s;
}

/** Assemble one labelled calibration case. */
export function mk(
  full_name: string,
  label: 'good' | 'junk',
  note: string,
  f: CaseFields,
  expectFlags?: string[],
): CalibrationCase {
  const repo: CorpusRepo = {
    full_name,
    ghid: `R_${full_name}`,
    aliases: [],
    source: 'search',
    stars: f.stars,
    forks: f.forks,
    createdAt: daysAgo(f.createdDaysAgo),
    pushedAt: daysAgo(f.pushedDaysAgo),
    license: f.license,
    topics: f.topics ?? [],
    language: 'TypeScript',
    archived: f.archived ?? false,
    description: f.description === undefined ? 'a repository' : f.description,
    signals: buildSignals(f),
  };
  return { label, note, repo, expectFlags };
}
