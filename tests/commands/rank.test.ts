import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Corpus,
  type CorpusRepo,
  type SignalProvenance,
  createCorpus,
  saveCorpus,
} from '../../src/cache/corpus.ts';
import { parseArgs } from '../../src/cli.ts';
import { type RankData, rankOptsFromArgs, runRank } from '../../src/commands/rank.ts';
import { EngineError } from '../../src/types.ts';

const NOW = () => Date.parse('2026-07-11T00:00:00Z');

function prov(
  value: unknown,
  source = 'github-graphql',
  fetchedAt = '2026-07-10T00:00:00Z',
): SignalProvenance {
  return { value, source, fetchedAt };
}

function repo(fullName: string, overrides: Partial<CorpusRepo> = {}): CorpusRepo {
  return {
    full_name: fullName,
    ghid: `R_${fullName}`,
    aliases: [],
    source: 'search',
    stars: 3000,
    forks: 300,
    pushedAt: '2026-07-01T00:00:00Z',
    createdAt: '2022-01-01T00:00:00Z',
    license: 'MIT',
    topics: ['cli'],
    language: 'Go',
    archived: false,
    description: 'a solid, well-maintained library for doing things',
    signals: {
      commits90d: prov(150),
      mentionableUsers: prov(50),
      openIssues: prov(10),
      closedIssues: prov(200),
      dependentReposCount: prov(1200, 'ecosyste.ms'),
      packaged: prov(true, 'ecosyste.ms'),
    },
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-rank-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCorpus(repos: CorpusRepo[]): string {
  const path = join(dir, 'corpus.json');
  const corpus: Corpus = { ...createCorpus('intent', [], NOW), repos, count: repos.length };
  saveCorpus(path, corpus, NOW);
  return path;
}

describe('rank — validation', () => {
  test('no corpus path → INVALID_INPUT', () => {
    expect(() => runRank({}, { now: NOW })).toThrow(EngineError);
  });
});

describe('rank — compact rows', () => {
  test('emits repo id, score, subs, coverage, description, flags, nodata', () => {
    const path = writeCorpus([repo('acme/widget')]);
    const data = runRank({ corpusPath: path }, { now: NOW });
    const row = data.rows?.[0];
    expect(row?.r).toBe('acme/widget');
    expect(typeof row?.s).toBe('number');
    expect(row?.subs.A).not.toBeNull();
    expect(row?.coverage).toBe('7/7');
    expect(row?.lic).toBe('permissive');
    expect(row?.vel).toBe(150);
    expect(row?.dep).toBe(1200);
    expect(row?.push).toBe('2026-07-01');
  });

  test('description is truncated to 90 chars', () => {
    const long = 'x'.repeat(200);
    const path = writeCorpus([repo('acme/widget', { description: long })]);
    const data = runRank({ corpusPath: path }, { now: NOW });
    expect(data.rows?.[0]?.d.length ?? 0).toBeLessThanOrEqual(90);
  });

  test('rows are sorted by score desc, deterministic tie-break', () => {
    const path = writeCorpus([repo('acme/z'), repo('acme/a')]);
    const data = runRank({ corpusPath: path }, { now: NOW });
    // identical repos → same score → tie-break by name asc
    expect(data.rows?.map((r) => r.r)).toEqual(['acme/a', 'acme/z']);
  });
});

describe('rank — coverage honesty in the header + rows', () => {
  test('a missing-B corpus shows renormalized score + coverage 6/7 + nodata:["B"]', () => {
    const app = repo('acme/app');
    const signals = Object.fromEntries(
      Object.entries(app.signals).filter(([k]) => k !== 'dependentReposCount'),
    );
    signals.packaged = prov(false, 'deps.dev');
    const path = writeCorpus([{ ...app, signals }]);
    const data = runRank({ corpusPath: path }, { now: NOW });
    const row = data.rows?.[0];
    expect(row?.coverage).toBe('6/7');
    expect(row?.nodata).toEqual(['B']);
    expect(row?.s).toBeGreaterThan(0);
    expect(data.header).toContain('missing groups B');
    expect(data.header).toContain('enrich');
  });

  test('a fully-enriched corpus reports full coverage in the header', () => {
    const path = writeCorpus([repo('acme/widget')]);
    const data = runRank({ corpusPath: path }, { now: NOW });
    expect(data.header).toContain('7/7');
  });

  test('surfaces dataAge in the row when B provenance is >90d stale', () => {
    const stale = repo('acme/stale', {
      signals: {
        ...repo('acme/stale').signals,
        dataAge: prov(200, 'ecosyste.ms'),
      },
    });
    const path = writeCorpus([stale]);
    const data = runRank({ corpusPath: path }, { now: NOW });
    expect(data.rows?.[0]?.dataAge).toBe(200);
  });
});

describe('rank — top + min-score', () => {
  test('--top limits the row count', () => {
    const path = writeCorpus([repo('acme/a'), repo('acme/b'), repo('acme/c')]);
    const data = runRank({ corpusPath: path, top: '2' }, { now: NOW });
    expect(data.rows).toHaveLength(2);
  });

  test('--min-score filters below the floor', () => {
    const good = repo('acme/good');
    const junk = repo('acme/junk', { archived: true }); // archived ×0.2 → low score
    const path = writeCorpus([good, junk]);
    const data = runRank({ corpusPath: path, minScore: '30' }, { now: NOW });
    expect(data.rows?.map((r) => r.r)).toEqual(['acme/good']);
  });
});

describe('rank — profiles + weights (zero refetch)', () => {
  test('--weights override changes the ranking without touching the corpus', () => {
    const path = writeCorpus([repo('acme/widget')]);
    const data = runRank({ corpusPath: path, weights: 'A=100' }, { now: NOW });
    expect(data.profile).toContain('custom-weights');
    expect(data.rows).toHaveLength(1);
  });

  test('an invalid profile is INVALID_INPUT', () => {
    const path = writeCorpus([repo('acme/widget')]);
    expect(() => runRank({ corpusPath: path, profile: 'nonsense' }, { now: NOW })).toThrow(
      EngineError,
    );
  });
});

describe('rank — jsonl', () => {
  test('--jsonl emits one row per line, omits the rows array', () => {
    const path = writeCorpus([repo('acme/a'), repo('acme/b')]);
    const data = runRank({ corpusPath: path, jsonl: true }, { now: NOW });
    expect(data.rows).toBeUndefined();
    expect(data.jsonl?.split('\n')).toHaveLength(2);
    expect(JSON.parse((data.jsonl ?? '').split('\n')[0] as string).r).toBeDefined();
  });
});

describe('rank — explain', () => {
  test('--explain returns raw values, saturation, penalty trail, and provenance', () => {
    const path = writeCorpus([repo('acme/widget', { archived: true })]);
    const data: RankData = runRank({ corpusPath: path, explain: 'acme/widget' }, { now: NOW });
    expect(data.explain?.repo).toBe('acme/widget');
    expect(data.explain?.detail.raw.stars).toBe(3000);
    expect(data.explain?.detail.saturation.dependents?.threshold).toBe(1000);
    expect(data.explain?.detail.penalties[0]?.rule).toBe('archived');
    expect(data.explain?.detail.provenance.dependentReposCount?.source).toBe('ecosyste.ms');
  });

  test('--explain on an absent repo → NOT_FOUND', () => {
    const path = writeCorpus([repo('acme/widget')]);
    expect(() => runRank({ corpusPath: path, explain: 'acme/ghost' }, { now: NOW })).toThrow(
      /no repo/,
    );
  });
});

describe('rankOptsFromArgs', () => {
  test('maps the corpus path + flags', () => {
    const parsed = parseArgs([
      'rank',
      'corpus.json',
      '--profile',
      'ideas',
      '--top',
      '20',
      '--explain',
      'o/r',
      '--jsonl',
    ]);
    const opts = rankOptsFromArgs(parsed);
    expect(opts.corpusPath).toBe('corpus.json');
    expect(opts.profile).toBe('ideas');
    expect(opts.top).toBe('20');
    expect(opts.explain).toBe('o/r');
    expect(opts.jsonl).toBe(true);
  });
});
