import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORPUS_SCHEMA,
  type CorpusRepo,
  createCorpus,
  loadCorpus,
  mergeCorpus,
  saveCorpus,
} from '../../src/cache/corpus.ts';
import { EngineError } from '../../src/types.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-corpus-'));
  path = join(dir, 'corpus.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function repo(overrides: Partial<CorpusRepo> = {}): CorpusRepo {
  return {
    full_name: 'octocat/hello-world',
    ghid: 'R_kgDOA1',
    aliases: [],
    source: 'search',
    signals: {},
    ...overrides,
  };
}

describe('createCorpus', () => {
  test('builds a fresh, empty, schema-tagged corpus', () => {
    const now = () => Date.parse('2026-07-10T00:00:00.000Z');
    const corpus = createCorpus('markdown editors for macOS', ['topic:markdown'], now);
    expect(corpus).toEqual({
      schema: CORPUS_SCHEMA,
      intent: 'markdown editors for macOS',
      generatedAt: '2026-07-10T00:00:00.000Z',
      queries: ['topic:markdown'],
      count: 0,
      repos: [],
    });
  });
});

describe('saveCorpus / loadCorpus — round trip', () => {
  test('save then load round-trips, with count recomputed from repos', () => {
    const corpus = createCorpus('intent', ['q1']);
    corpus.repos.push(repo());
    saveCorpus(path, corpus);

    const loaded = loadCorpus(path);
    expect(loaded.count).toBe(1);
    expect(loaded.repos).toEqual([repo()]);
    expect(loaded.schema).toBe(CORPUS_SCHEMA);
  });

  test('saveCorpus stamps generatedAt from the injected clock', () => {
    const now = () => Date.parse('2026-07-10T12:00:00.000Z');
    saveCorpus(path, createCorpus('intent'), now);
    expect(loadCorpus(path).generatedAt).toBe('2026-07-10T12:00:00.000Z');
  });
});

describe('loadCorpus — fail loud, no silent migration', () => {
  test('missing file throws NOT_FOUND', () => {
    expect(() => loadCorpus(path)).toThrow(EngineError);
    try {
      loadCorpus(path);
    } catch (e) {
      expect((e as EngineError).code).toBe('NOT_FOUND');
    }
  });

  test('unparseable JSON throws INVALID_INPUT', () => {
    writeFileSync(path, '{ not json');
    try {
      loadCorpus(path);
      throw new Error('expected loadCorpus to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
  });

  test('a valid JSON file with no schema tag throws INVALID_INPUT', () => {
    writeFileSync(path, JSON.stringify({ intent: 'x', repos: [] }));
    try {
      loadCorpus(path);
      throw new Error('expected loadCorpus to throw');
    } catch (e) {
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
  });

  test('a wrong/legacy schema tag throws INVALID_INPUT rather than silently migrating', () => {
    writeFileSync(path, JSON.stringify({ schema: 'github-relay/corpus@0', repos: [] }));
    try {
      loadCorpus(path);
      throw new Error('expected loadCorpus to throw');
    } catch (e) {
      expect((e as EngineError).code).toBe('INVALID_INPUT');
    }
  });
});

describe('mergeCorpus — dedupe by full_name, fresh-wins', () => {
  test('a repo absent from existing is added as-is', () => {
    const existing = createCorpus('intent');
    const fresh = createCorpus('intent');
    fresh.repos.push(repo());
    const merged = mergeCorpus(existing, fresh);
    expect(merged.repos).toEqual([repo()]);
  });

  test('same full_name: fresh mutable fields win, base fields survive when fresh omits them', () => {
    const existing = createCorpus('intent');
    existing.repos.push(repo({ stars: 100, forks: 10, description: 'old desc', language: 'Go' }));
    const fresh = createCorpus('intent');
    fresh.repos.push(repo({ stars: 150, description: 'new desc' }));

    const merged = mergeCorpus(existing, fresh);
    expect(merged.repos).toHaveLength(1);
    const result = merged.repos[0];
    expect(result?.stars).toBe(150); // fresh wins
    expect(result?.description).toBe('new desc'); // fresh wins
    expect(result?.forks).toBe(10); // preserved — fresh didn't supply it
    expect(result?.language).toBe('Go'); // preserved — fresh didn't supply it
  });

  test('queries union across merges', () => {
    const existing = createCorpus('intent', ['topic:markdown']);
    const fresh = createCorpus('intent', ['topic:markdown', 'topic:macos']);
    const merged = mergeCorpus(existing, fresh);
    expect(merged.queries).toEqual(['topic:markdown', 'topic:macos']);
  });

  test('intent is preserved from existing when already set', () => {
    const existing = createCorpus('original intent');
    const fresh = createCorpus('should not win');
    expect(mergeCorpus(existing, fresh).intent).toBe('original intent');
  });
});

describe('mergeCorpus — aliases union + rename re-keying by ghid', () => {
  test('a fresh repo whose ghid matches an existing row under a different full_name is renamed', () => {
    const existing = createCorpus('intent');
    existing.repos.push(repo({ full_name: 'old-owner/old-name', ghid: 'R_kgDOSAME' }));
    const fresh = createCorpus('intent');
    fresh.repos.push(repo({ full_name: 'new-owner/new-name', ghid: 'R_kgDOSAME' }));

    const merged = mergeCorpus(existing, fresh);
    expect(merged.repos).toHaveLength(1);
    const result = merged.repos[0];
    expect(result?.full_name).toBe('new-owner/new-name');
    expect(result?.aliases).toEqual(['old-owner/old-name']);
    expect(result?.renamed).toBe(true);
  });

  test('non-renamed repos keep aliases as a plain union, no renamed flag', () => {
    const existing = createCorpus('intent');
    existing.repos.push(repo({ aliases: ['a/legacy'] }));
    const fresh = createCorpus('intent');
    fresh.repos.push(repo({ aliases: ['b/other'] }));

    const merged = mergeCorpus(existing, fresh);
    const result = merged.repos[0];
    expect(result?.aliases.sort()).toEqual(['a/legacy', 'b/other']);
    expect(result?.renamed).toBeUndefined();
  });
});

describe('mergeCorpus — provenance per-signal overwrite granularity', () => {
  test('a fresh signal overwrites only that signal, leaving other signals from base untouched', () => {
    const existing = createCorpus('intent');
    existing.repos.push(
      repo({
        signals: {
          commits90d: { value: 42, source: 'gh-graphql', fetchedAt: '2026-07-01T00:00:00.000Z' },
          dependents: { value: 900, source: 'ecosystems', fetchedAt: '2026-07-01T00:00:00.000Z' },
        },
      }),
    );
    const fresh = createCorpus('intent');
    fresh.repos.push(
      repo({
        signals: {
          commits90d: { value: 55, source: 'gh-graphql', fetchedAt: '2026-07-10T00:00:00.000Z' },
        },
      }),
    );

    const merged = mergeCorpus(existing, fresh);
    const result = merged.repos[0];
    expect(result?.signals.commits90d).toEqual({
      value: 55,
      source: 'gh-graphql',
      fetchedAt: '2026-07-10T00:00:00.000Z',
    });
    expect(result?.signals.dependents).toEqual({
      value: 900,
      source: 'ecosystems',
      fetchedAt: '2026-07-01T00:00:00.000Z',
    });
  });
});

describe('mergeCorpus — same-batch rename resolution is order-independent (fix wave 2, Important 1)', () => {
  const newer = repo({
    full_name: 'new-owner/new-name',
    ghid: 'R_kgDOSAME',
    pushedAt: '2026-07-05T00:00:00.000Z',
  });
  const older = repo({
    full_name: 'old-owner/old-name',
    ghid: 'R_kgDOSAME',
    pushedAt: '2026-01-01T00:00:00.000Z',
  });

  test('new-name-first ordering canonicalizes on the newer (current) name', () => {
    const existing = createCorpus('intent');
    const fresh = createCorpus('intent');
    fresh.repos.push(newer, older);

    const merged = mergeCorpus(existing, fresh);
    expect(merged.repos).toHaveLength(1);
    expect(merged.repos[0]?.full_name).toBe('new-owner/new-name');
    expect(merged.repos[0]?.aliases).toEqual(['old-owner/old-name']);
    expect(merged.repos[0]?.renamed).toBe(true);
  });

  test('old-name-first ordering converges to the SAME result', () => {
    const existing = createCorpus('intent');
    const fresh = createCorpus('intent');
    fresh.repos.push(older, newer);

    const merged = mergeCorpus(existing, fresh);
    expect(merged.repos).toHaveLength(1);
    expect(merged.repos[0]?.full_name).toBe('new-owner/new-name');
    expect(merged.repos[0]?.aliases).toEqual(['old-owner/old-name']);
    expect(merged.repos[0]?.renamed).toBe(true);
  });
});

describe('mergeCorpus — full_name case-insensitive identity (fix wave 2, Important 2)', () => {
  test('a case collision without a shared ghid still merges into one row, fresh casing wins', () => {
    const existing = createCorpus('intent');
    existing.repos.push(repo({ full_name: 'octocat/Hello-World', ghid: 'R_kgDOA1' }));
    const fresh = createCorpus('intent');
    fresh.repos.push(repo({ full_name: 'Octocat/hello-world', ghid: 'R_kgDOA2' }));

    const merged = mergeCorpus(existing, fresh);
    expect(merged.repos).toHaveLength(1);
    expect(merged.repos[0]?.full_name).toBe('Octocat/hello-world'); // fresh wins
    expect(merged.repos[0]?.renamed).toBeUndefined();
  });

  test('a case collision with a shared ghid merges into one row and does not fabricate a rename', () => {
    const existing = createCorpus('intent');
    existing.repos.push(repo({ full_name: 'Octocat/Hello-World', ghid: 'R_kgDOSAME' }));
    const fresh = createCorpus('intent');
    fresh.repos.push(repo({ full_name: 'octocat/hello-world', ghid: 'R_kgDOSAME' }));

    const merged = mergeCorpus(existing, fresh);
    expect(merged.repos).toHaveLength(1);
    expect(merged.repos[0]?.full_name).toBe('octocat/hello-world'); // fresh wins
    expect(merged.repos[0]?.renamed).toBeUndefined();
  });
});

describe('acceptance: full round trip save → load → merge → save', () => {
  test('a session persists, a follow-up loads and merges fresh data, and saves again', () => {
    const first = createCorpus('markdown editors', ['topic:markdown']);
    first.repos.push(repo({ stars: 10 }));
    saveCorpus(path, first, () => Date.parse('2026-07-01T00:00:00.000Z'));

    const loaded = loadCorpus(path);
    const fresh = createCorpus('markdown editors', ['topic:markdown', 'topic:macos']);
    fresh.repos.push(repo({ stars: 20 }), repo({ full_name: 'other/repo', ghid: 'R_kgDOB2' }));

    const merged = mergeCorpus(loaded, fresh);
    saveCorpus(path, merged, () => Date.parse('2026-07-10T00:00:00.000Z'));

    const final = loadCorpus(path);
    expect(final.count).toBe(2);
    expect(final.queries).toEqual(['topic:markdown', 'topic:macos']);
    expect(final.generatedAt).toBe('2026-07-10T00:00:00.000Z');
    expect(final.repos.find((r) => r.full_name === 'octocat/hello-world')?.stars).toBe(20);
  });
});
