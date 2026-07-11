// Calibration = ORDERING regression suite (design §5, PLAN decision 1). The
// contract per profile: every known-good outranks every known-junk, and the
// junk set trips the flags the design promises. These lock the model's shape;
// absolute scores are free to drift, relative order is not.
import { describe, expect, test } from 'bun:test';
import { BUILD_ON_CASES } from '../../fixtures/calibration/build-on.ts';
import { DISSECT_CASES } from '../../fixtures/calibration/dissect.ts';
import { IDEAS_CASES } from '../../fixtures/calibration/ideas.ts';
import { CALIB_NOW, type CalibrationCase } from '../../fixtures/calibration/support.ts';
import type { CorpusRepo } from '../../src/cache/corpus.ts';
import { PROFILES, type Profile } from '../../src/score/profiles.ts';
import { type RepoScore, scoreRepo } from '../../src/score/scoring.ts';

/** Score every case in a set together (siblings inform `ideas` topic novelty). */
function scoreSet(cases: CalibrationCase[], profile: Profile): Map<string, RepoScore> {
  const repos: CorpusRepo[] = cases.map((c) => c.repo);
  const allTopics = repos.map((r) => r.topics ?? []);
  const out = new Map<string, RepoScore>();
  repos.forEach((repo, i) => {
    out.set(
      repo.full_name,
      scoreRepo(repo, profile, {
        now: CALIB_NOW,
        siblingTopics: allTopics.filter((_, j) => j !== i),
      }),
    );
  });
  return out;
}

const SETS: { name: string; profile: Profile; cases: CalibrationCase[] }[] = [
  { name: 'build-on', profile: PROFILES['build-on'], cases: BUILD_ON_CASES },
  { name: 'dissect', profile: PROFILES.dissect, cases: DISSECT_CASES },
  { name: 'ideas', profile: PROFILES.ideas, cases: IDEAS_CASES },
];

describe('calibration — seed set shape', () => {
  test('each profile has ~10 labelled cases with both good and junk', () => {
    for (const { name, cases } of SETS) {
      const good = cases.filter((c) => c.label === 'good');
      const junk = cases.filter((c) => c.label === 'junk');
      expect(good.length, `${name} good`).toBeGreaterThanOrEqual(4);
      expect(junk.length, `${name} junk`).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('calibration — every good outranks every junk within its profile', () => {
  for (const { name, profile, cases } of SETS) {
    test(`${name}: worst good beats best junk`, () => {
      const scores = scoreSet(cases, profile);
      const goodScores = cases
        .filter((c) => c.label === 'good')
        .map((c) => ({ id: c.repo.full_name, s: scores.get(c.repo.full_name)?.score ?? 0 }));
      const junkScores = cases
        .filter((c) => c.label === 'junk')
        .map((c) => ({ id: c.repo.full_name, s: scores.get(c.repo.full_name)?.score ?? 0 }));

      const worstGood = goodScores.reduce((a, b) => (a.s <= b.s ? a : b));
      const bestJunk = junkScores.reduce((a, b) => (a.s >= b.s ? a : b));

      expect(
        worstGood.s,
        `${name}: worst good ${worstGood.id}=${worstGood.s} must beat best junk ${bestJunk.id}=${bestJunk.s}`,
      ).toBeGreaterThan(bestJunk.s);
    });
  }
});

describe('calibration — the promised flags fire on the junk set', () => {
  for (const { name, profile, cases } of SETS) {
    test(`${name}: every expectFlags case trips those flags`, () => {
      const scores = scoreSet(cases, profile);
      for (const c of cases) {
        if (!c.expectFlags) continue;
        const flags = scores.get(c.repo.full_name)?.flags ?? [];
        for (const expected of c.expectFlags) {
          expect(flags, `${name}: ${c.repo.full_name} expected flag '${expected}'`).toContain(
            expected,
          );
        }
      }
    });
  }
});

describe('calibration — coverage honesty holds on the fixtures', () => {
  test('build-on: an unpackaged app repo (zed) is 6/7 with nodata:[B]', () => {
    const scores = scoreSet(DISSECT_CASES, PROFILES['build-on']);
    const zed = scores.get('zed-industries/zed');
    expect(zed?.nodata).toContain('B');
  });
});
