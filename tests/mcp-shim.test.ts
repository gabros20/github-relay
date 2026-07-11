import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createCache } from '../src/cache/index.ts';
import {
  BATCH_INPUT,
  DIGEST_INPUT,
  SEARCH_INPUT,
  buildBatchArgv,
  buildBudgetArgv,
  buildCacheArgv,
  buildDigestArgv,
  buildDoctorArgv,
  buildEnrichArgv,
  buildHydrateArgv,
  buildRankArgv,
  buildReadArgv,
  buildSearchArgv,
  buildSkimArgv,
  executeToolWith,
  implementedCommands,
} from '../src/mcp-shim.ts';
import type { Sources } from '../src/sources/index.ts';

// A minimal cache instance rooted under a throwaway dir — none of the tests
// below exercise a path that actually touches Sources, so an empty stub
// object is enough; only the cache needs to resolve real paths (createCache
// with no override just resolves ~/.ghrelay-style paths, same pattern as
// tests/cli.run.test.ts already relies on for `run([], {})`).
const fakeSources = {} as Sources;
const cache = createCache();

describe('implementedCommands', () => {
  test('includes exactly the 11 milestone-A commands', () => {
    const names = implementedCommands()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(
      [
        'batch',
        'budget',
        'cache',
        'digest',
        'doctor',
        'enrich',
        'hydrate',
        'rank',
        'read',
        'search',
        'skim',
      ].sort(),
    );
  });

  test('excludes the milestone-B roadmap commands (plan/code/health)', () => {
    const names = implementedCommands().map((c) => c.name);
    expect(names).not.toContain('plan');
    expect(names).not.toContain('code');
    expect(names).not.toContain('health');
  });
});

describe('argv builders — search', () => {
  test('builds query + out, omitting absent optional flags', () => {
    const argv = buildSearchArgv({ query: 'markdown editor', out: 'corpus.json' });
    expect(argv).toEqual(['search', 'markdown editor', '--out', 'corpus.json']);
  });

  test('folds repeatable language/topic flags and scalar filters in', () => {
    const argv = buildSearchArgv({
      query: 'editor',
      out: 'corpus.json',
      language: ['swift', 'rust'],
      topic: ['macos'],
      stars: '>100',
      created: '>2024-01-01',
      pushed: '>2025-01-01',
      sort: 'stars',
      source: 'rest',
      limit: 50,
    });
    expect(argv).toEqual([
      'search',
      'editor',
      '--source',
      'rest',
      '--limit',
      '50',
      '--language',
      'swift',
      '--language',
      'rust',
      '--topic',
      'macos',
      '--stars',
      '>100',
      '--created',
      '>2024-01-01',
      '--pushed',
      '>2025-01-01',
      '--sort',
      'stars',
      '--out',
      'corpus.json',
    ]);
  });
});

describe('argv builders — batch/hydrate/enrich', () => {
  test('batch carries file/out/delay', () => {
    const argv = buildBatchArgv({ file: 'queries.txt', out: 'corpus.json', delay: 3000 });
    expect(argv).toEqual([
      'batch',
      '--file',
      'queries.txt',
      '--out',
      'corpus.json',
      '--delay',
      '3000',
    ]);
  });

  test('hydrate spreads ids as positionals, out optional', () => {
    const argv = buildHydrateArgv({ ids: ['a/b', 'c/d'] });
    expect(argv).toEqual(['hydrate', 'a/b', 'c/d']);
  });

  test('hydrate carries out when given', () => {
    const argv = buildHydrateArgv({ ids: ['a/b'], out: 'corpus.json' });
    expect(argv).toEqual(['hydrate', 'a/b', '--out', 'corpus.json']);
  });

  test('enrich spreads ids and maps camelCase flags to kebab-case', () => {
    const argv = buildEnrichArgv({
      in: 'corpus.json',
      ids: ['a/b'],
      top: 50,
      skipDeps: true,
      staleOk: true,
    });
    expect(argv).toEqual([
      'enrich',
      'a/b',
      '--in',
      'corpus.json',
      '--top',
      '50',
      '--skip-deps',
      '--stale-ok',
    ]);
  });

  test('enrich omits bool flags when absent (never a bare --skip-deps=false)', () => {
    const argv = buildEnrichArgv({ in: 'corpus.json' });
    expect(argv).toEqual(['enrich', '--in', 'corpus.json']);
  });
});

describe('argv builders — rank/skim/read', () => {
  test('rank carries the corpus path positionally plus flags', () => {
    const argv = buildRankArgv({
      corpusPath: 'corpus.json',
      profile: 'dissect',
      top: 20,
      minScore: 10,
      explain: 'a/b',
      jsonl: true,
    });
    expect(argv).toEqual([
      'rank',
      'corpus.json',
      '--profile',
      'dissect',
      '--top',
      '20',
      '--min-score',
      '10',
      '--explain',
      'a/b',
      '--jsonl',
    ]);
  });

  test('skim carries repo positionally plus flags', () => {
    const argv = buildSkimArgv({ repo: 'a/b', maxChars: 2000, treeOnly: true, in: 'corpus.json' });
    expect(argv).toEqual([
      'skim',
      'a/b',
      '--max-chars',
      '2000',
      '--tree-only',
      '--in',
      'corpus.json',
    ]);
  });

  test('read spreads paths after repo', () => {
    const argv = buildReadArgv({ repo: 'a/b', paths: ['README.md', 'src/index.ts'], ref: 'main' });
    expect(argv).toEqual(['read', 'a/b', 'README.md', 'src/index.ts', '--ref', 'main']);
  });
});

describe('argv builders — digest/budget/doctor/cache', () => {
  test('digest carries repeatable include/exclude and out', () => {
    const argv = buildDigestArgv({
      repo: 'a/b',
      ref: 'main',
      include: ['src/**'],
      exclude: ['**/*.test.ts'],
      maxTokens: 5000,
      out: 'digest.md',
      list: true,
    });
    expect(argv).toEqual([
      'digest',
      'a/b',
      '--ref',
      'main',
      '--include',
      'src/**',
      '--exclude',
      '**/*.test.ts',
      '--max-tokens',
      '5000',
      '--out',
      'digest.md',
      '--list',
    ]);
  });

  test('budget carries forecast', () => {
    expect(buildBudgetArgv({ forecast: 'enrich:2,skim:8' })).toEqual([
      'budget',
      '--forecast',
      'enrich:2,skim:8',
    ]);
  });

  test('budget with no forecast is just the bare command', () => {
    expect(buildBudgetArgv({})).toEqual(['budget']);
  });

  test('doctor carries offline as a bool flag', () => {
    expect(buildDoctorArgv({ offline: true })).toEqual(['doctor', '--offline']);
    expect(buildDoctorArgv({})).toEqual(['doctor']);
  });

  test('cache carries subcommand positionally plus older-than/confirm', () => {
    const argv = buildCacheArgv({ subcommand: 'gc', olderThan: '7d' });
    expect(argv).toEqual(['cache', 'gc', '--older-than', '7d']);
    expect(buildCacheArgv({ subcommand: 'clear', confirm: true })).toEqual([
      'cache',
      'clear',
      '--confirm',
    ]);
  });
});

describe('zod schemas — require-out enforcement', () => {
  test('search rejects a missing out, accepts a present one', () => {
    const schema = z.object(SEARCH_INPUT);
    expect(schema.safeParse({ query: 'x' }).success).toBe(false);
    expect(schema.safeParse({ query: 'x', out: 'corpus.json' }).success).toBe(true);
  });

  test('batch rejects a missing out, accepts a present one', () => {
    const schema = z.object(BATCH_INPUT);
    expect(schema.safeParse({ file: 'q.txt' }).success).toBe(false);
    expect(schema.safeParse({ file: 'q.txt', out: 'corpus.json' }).success).toBe(true);
  });

  test('digest rejects a missing out even in --list mode', () => {
    const schema = z.object(DIGEST_INPUT);
    expect(schema.safeParse({ repo: 'a/b', list: true }).success).toBe(false);
    expect(schema.safeParse({ repo: 'a/b', list: true, out: 'digest.md' }).success).toBe(true);
  });
});

describe('executeToolWith — envelope passthrough (no server, no network)', () => {
  test('a validation failure (INVALID_INPUT) is an ordinary isError:true text result', async () => {
    const result = await executeToolWith(fakeSources, cache, ['rank']);
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first).toBeDefined();
    const envelope = JSON.parse(first?.text ?? '{}') as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  test('forces --quiet and --compact regardless of the argv passed in', async () => {
    const result = await executeToolWith(fakeSources, cache, ['doctor', '--offline']);
    const first = result.content[0];
    expect(first).toBeDefined();
    // Compact JSON is single-line — pretty-printed would contain '\n'.
    expect(first?.text.includes('\n')).toBe(false);
    expect(() => JSON.parse(first?.text ?? '')).not.toThrow();
  });

  test('an unknown-in-registry style failure still returns isError, never throws', async () => {
    const result = await executeToolWith(fakeSources, cache, ['read', 'a/b']);
    expect(result.isError).toBe(true);
  });
});
