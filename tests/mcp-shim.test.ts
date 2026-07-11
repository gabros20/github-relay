import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { type CorpusRepo, saveCorpus } from '../src/cache/corpus.ts';
import { createCache } from '../src/cache/index.ts';
import { parseArgs } from '../src/cli.ts';
import { searchOptsFromArgs } from '../src/commands/search.ts';
import {
  BATCH_INPUT,
  CODE_INPUT,
  DIGEST_INPUT,
  PLAN_INPUT,
  RANK_INPUT,
  SEARCH_INPUT,
  buildBatchArgv,
  buildBudgetArgv,
  buildCacheArgv,
  buildCodeArgv,
  buildDigestArgv,
  buildDoctorArgv,
  buildEnrichArgv,
  buildHealthArgv,
  buildHydrateArgv,
  buildPlanArgv,
  buildRankArgv,
  buildReadArgv,
  buildSearchArgv,
  buildSkimArgv,
  executeToolWith,
  implementedCommands,
  withForcedFlags,
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
  test('includes all 14 registered commands (milestone A + plan/code/health, tasks 9-11)', () => {
    const names = implementedCommands()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(
      [
        'batch',
        'budget',
        'cache',
        'code',
        'digest',
        'doctor',
        'enrich',
        'health',
        'hydrate',
        'plan',
        'rank',
        'read',
        'search',
        'skim',
      ].sort(),
    );
  });

  test('health is now exposed as an MCP tool (task 11)', () => {
    expect(implementedCommands().map((c) => c.name)).toContain('health');
  });
});

describe('argv builders — plan', () => {
  test('flags come first, then "--", then the slices verbatim', () => {
    const argv = buildPlanArgv({ slices: ['topic:markdown', 'topic:notes'] });
    expect(argv).toEqual(['plan', '--', 'topic:markdown', 'topic:notes']);
  });

  test('probe/shard/maxProbes/out map onto their flags, all before "--"', () => {
    const argv = buildPlanArgv({
      slices: ['topic:markdown'],
      probe: true,
      shard: 'created',
      maxProbes: 10,
      out: 'queries.txt',
    });
    expect(argv).toEqual([
      'plan',
      '--probe',
      '--shard',
      'created',
      '--max-probes',
      '10',
      '--out',
      'queries.txt',
      '--',
      'topic:markdown',
    ]);
  });

  test('a slice that itself starts with "--" survives parseArgs intact', () => {
    const argv = buildPlanArgv({ slices: ['--weird-slice'] });
    const parsed = parseArgs(argv);
    expect(parsed.positionals).toEqual(['--weird-slice']);
  });
});

describe('argv builders — search', () => {
  test('flags come first, then "--", then the query verbatim', () => {
    const argv = buildSearchArgv({ query: 'markdown editor', out: 'corpus.json' });
    expect(argv).toEqual(['search', '--out', 'corpus.json', '--', 'markdown editor']);
  });

  test('folds repeatable language/topic flags and scalar filters in, all before "--"', () => {
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
      '--',
      'editor',
    ]);
  });

  test('a query that itself starts with "--" survives parseArgs intact (fix wave 1, Important 2)', () => {
    const argv = buildSearchArgv({ query: '--force push workflows', out: 'corpus.json' });
    const parsed = parseArgs(argv);
    expect(parsed.command).toBe('search');
    expect(searchOptsFromArgs(parsed).query).toBe('--force push workflows');
  });

  test('--source trending + --period fold in before "--", like every other scalar flag', () => {
    const argv = buildSearchArgv({
      query: '',
      out: 'corpus.json',
      source: 'trending',
      period: '24h',
    });
    expect(argv).toEqual([
      'search',
      '--source',
      'trending',
      '--period',
      '24h',
      '--out',
      'corpus.json',
      '--',
      '',
    ]);
  });
});

describe('argv builders — code', () => {
  test('flags come first, then "--", then the pattern verbatim', () => {
    const argv = buildCodeArgv({ pattern: 'useState(' });
    expect(argv).toEqual(['code', '--', 'useState(']);
  });

  test('folds repeatable lang and scalar repo/path/limit/out/literal in, all before "--"', () => {
    const argv = buildCodeArgv({
      pattern: 'useState(',
      lang: ['TypeScript', 'TSX'],
      repo: 'facebook/react',
      path: 'src/',
      limit: 10,
      out: 'corpus.json',
      literal: true,
    });
    expect(argv).toEqual([
      'code',
      '--lang',
      'TypeScript',
      '--lang',
      'TSX',
      '--repo',
      'facebook/react',
      '--path',
      'src/',
      '--limit',
      '10',
      '--out',
      'corpus.json',
      '--literal',
      '--',
      'useState(',
    ]);
  });

  test('omits --literal when absent (never a bare --literal=false)', () => {
    const argv = buildCodeArgv({ pattern: 'useState(' });
    expect(argv).not.toContain('--literal');
  });

  test('a pattern that itself starts with "--" survives parseArgs intact', () => {
    const argv = buildCodeArgv({ pattern: '--force push workflows' });
    const parsed = parseArgs(argv);
    expect(parsed.command).toBe('code');
    expect(parsed.positionals.join(' ')).toBe('--force push workflows');
  });
});

describe('CODE_INPUT — pattern required, everything else optional (out is NOT required, unlike search/batch/digest)', () => {
  test('rejects a missing pattern', () => {
    expect(z.object(CODE_INPUT).safeParse({}).success).toBe(false);
  });

  test('accepts a bare pattern with no other fields', () => {
    expect(z.object(CODE_INPUT).safeParse({ pattern: 'useState(' }).success).toBe(true);
  });

  test('limit is capped at 100', () => {
    expect(z.object(CODE_INPUT).safeParse({ pattern: 'useState(', limit: 100 }).success).toBe(true);
    expect(z.object(CODE_INPUT).safeParse({ pattern: 'useState(', limit: 101 }).success).toBe(
      false,
    );
  });

  test('accepts an explicit literal:true (fix wave 1, IMP 2 escape hatch)', () => {
    expect(
      z.object(CODE_INPUT).safeParse({ pattern: 'how to parse markdown files', literal: true })
        .success,
    ).toBe(true);
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

  test('health spreads the finalist ids and maps --in', () => {
    const argv = buildHealthArgv({ ids: ['a/b', 'c/d'], in: 'corpus.json' });
    expect(argv).toEqual(['health', 'a/b', 'c/d', '--in', 'corpus.json']);
  });
});

describe('argv builders — rank/skim/read', () => {
  test('rank carries flags first, then "--", then the corpus path', () => {
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
      '--profile',
      'dissect',
      '--top',
      '20',
      '--min-score',
      '10',
      '--explain',
      'a/b',
      '--jsonl',
      '--',
      'corpus.json',
    ]);
  });

  test('skim carries flags first, then "--", then repo', () => {
    const argv = buildSkimArgv({ repo: 'a/b', maxChars: 2000, treeOnly: true, in: 'corpus.json' });
    expect(argv).toEqual([
      'skim',
      '--max-chars',
      '2000',
      '--tree-only',
      '--in',
      'corpus.json',
      '--',
      'a/b',
    ]);
  });

  test('read carries flags first, then "--", then repo + paths verbatim', () => {
    const argv = buildReadArgv({ repo: 'a/b', paths: ['README.md', 'src/index.ts'], ref: 'main' });
    expect(argv).toEqual(['read', '--ref', 'main', '--', 'a/b', 'README.md', 'src/index.ts']);
  });

  test('a repo/path that itself starts with "--" survives parseArgs intact', () => {
    const argv = buildReadArgv({ repo: 'a/b', paths: ['--weird-file.md'] });
    const parsed = parseArgs(argv);
    expect(parsed.positionals).toEqual(['a/b', '--weird-file.md']);
  });
});

describe('argv builders — digest/budget/doctor/cache', () => {
  test('digest carries flags (incl. repeatable include/exclude and out) first, then "--", then repo', () => {
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
      '--',
      'a/b',
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

describe('PLAN_INPUT — slices required, out optional', () => {
  test('rejects an empty slices array', () => {
    const result = z.object(PLAN_INPUT).safeParse({ slices: [] });
    expect(result.success).toBe(false);
  });

  test('accepts slices with no out/probe/shard (offline validation is the default)', () => {
    const result = z.object(PLAN_INPUT).safeParse({ slices: ['topic:markdown'] });
    expect(result.success).toBe(true);
  });

  test('maxProbes accepts a positive integer, rejects zero/negative', () => {
    expect(
      z.object(PLAN_INPUT).safeParse({ slices: ['topic:markdown'], maxProbes: 10 }).success,
    ).toBe(true);
    expect(
      z.object(PLAN_INPUT).safeParse({ slices: ['topic:markdown'], maxProbes: 0 }).success,
    ).toBe(false);
  });
});

describe('zod schemas — require-out enforcement', () => {
  test('search rejects a missing out, accepts a present one', () => {
    const schema = z.object(SEARCH_INPUT);
    expect(schema.safeParse({ query: 'x' }).success).toBe(false);
    expect(schema.safeParse({ query: 'x', out: 'corpus.json' }).success).toBe(true);
  });

  test('search accepts a valid --period, rejects an unknown one', () => {
    const schema = z.object(SEARCH_INPUT);
    expect(
      schema.safeParse({ query: '', out: 'corpus.json', source: 'trending', period: '24h' })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ query: '', out: 'corpus.json', source: 'trending', period: 'yesterday' })
        .success,
    ).toBe(false);
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

describe('RANK_INPUT — top defaults + caps (fix wave 1, Critical 1)', () => {
  test('an absent top defaults to 20 (matching the registry usage hint)', () => {
    const parsed = z.object(RANK_INPUT).parse({ corpusPath: 'corpus.json' });
    expect(parsed.top).toBe(20);
  });

  test('an explicit top under the cap is kept as-is', () => {
    const parsed = z.object(RANK_INPUT).parse({ corpusPath: 'corpus.json', top: 5 });
    expect(parsed.top).toBe(5);
  });

  test('an explicit top over 100 is rejected, not silently clamped', () => {
    const result = z.object(RANK_INPUT).safeParse({ corpusPath: 'corpus.json', top: 500 });
    expect(result.success).toBe(false);
  });

  test('the default flows through buildRankArgv into a real --top flag', () => {
    const parsed = z.object(RANK_INPUT).parse({ corpusPath: 'corpus.json' });
    const argv = buildRankArgv(parsed);
    expect(argv).toContain('--top');
    expect(argv[argv.indexOf('--top') + 1]).toBe('20');
  });
});

describe('withForcedFlags — quiet/compact land BEFORE the "--" sentinel (fix wave 2)', () => {
  test('a sentinel-using tool (search) gets --quiet/--compact inserted before "--", not appended after it', () => {
    const argv = buildSearchArgv({ query: 'markdown editor', out: 'corpus.json' });
    const full = withForcedFlags(argv);
    expect(full).toEqual([
      'search',
      '--out',
      'corpus.json',
      '--quiet',
      '--compact',
      '--',
      'markdown editor',
    ]);
  });

  test('a tool with no sentinel (batch) still gets the flags appended at the end, unchanged', () => {
    const argv = buildBatchArgv({ file: 'q.txt', out: 'corpus.json' });
    const full = withForcedFlags(argv);
    expect(full).toEqual([
      'batch',
      '--file',
      'q.txt',
      '--out',
      'corpus.json',
      '--quiet',
      '--compact',
    ]);
  });

  test('the real pipeline: search query lands EXACTLY, quiet+compact parse as real flags (not swallowed positionals)', () => {
    const argv = buildSearchArgv({ query: 'markdown editor', out: 'corpus.json' });
    const parsed = parseArgs(withForcedFlags(argv));
    expect(parsed.bools.has('quiet')).toBe(true);
    expect(parsed.bools.has('compact')).toBe(true);
    expect(searchOptsFromArgs(parsed).query).toBe('markdown editor');
  });

  test('a leading-dash query survives WITH the forced flags injected (the exact fix-wave-1 + fix-wave-2 interaction)', () => {
    const argv = buildSearchArgv({ query: '--force push workflows', out: 'corpus.json' });
    const parsed = parseArgs(withForcedFlags(argv));
    expect(parsed.bools.has('quiet')).toBe(true);
    expect(parsed.bools.has('compact')).toBe(true);
    expect(searchOptsFromArgs(parsed).query).toBe('--force push workflows');
  });

  test('read gains no junk paths from the forced flags', () => {
    const argv = buildReadArgv({ repo: 'a/b', paths: ['README.md'] });
    const parsed = parseArgs(withForcedFlags(argv));
    expect(parsed.positionals).toEqual(['a/b', 'README.md']);
    expect(parsed.bools.has('quiet')).toBe(true);
    expect(parsed.bools.has('compact')).toBe(true);
  });

  test('rank keeps exactly its corpus path positional, plus real quiet/compact flags', () => {
    const argv = buildRankArgv({ corpusPath: 'corpus.json' });
    const parsed = parseArgs(withForcedFlags(argv));
    expect(parsed.positionals).toEqual(['corpus.json']);
    expect(parsed.bools.has('quiet')).toBe(true);
    expect(parsed.bools.has('compact')).toBe(true);
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

  test('forces --quiet and --compact even for a sentinel-using tool (fix wave 2)', async () => {
    // rank's argv ends "... -- <corpusPath>" (the "--" sentinel from fix wave
    // 1) — the forced flags must land BEFORE that sentinel, or they parse as
    // extra positionals instead of real flags and compact/quiet are lost.
    const argv = buildRankArgv({ corpusPath: '/nonexistent/ghrelay-mcp-shim-test-corpus.json' });
    const result = await executeToolWith(fakeSources, cache, argv);
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

describe('rank over MCP does not flood the model (fix wave 1, Critical 1, live)', () => {
  test('a 500-repo corpus, ranked with no explicit top, returns at most the default 20 rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghrelay-mcp-rank-flood-'));
    const corpusPath = join(dir, 'corpus.json');
    const repos: CorpusRepo[] = Array.from({ length: 500 }, (_, i) => ({
      full_name: `owner/repo-${i}`,
      ghid: `R_${i}`,
      aliases: [],
      source: 'search',
      signals: {},
      stars: i,
      description: 'a repo in the flood-test fixture',
    }));
    saveCorpus(corpusPath, {
      schema: 'github-relay/corpus@1',
      intent: 'flood test',
      generatedAt: new Date(0).toISOString(),
      queries: [],
      count: repos.length,
      repos,
    });

    const parsedInput = z.object(RANK_INPUT).parse({ corpusPath });
    const argv = buildRankArgv(parsedInput);
    const result = await executeToolWith(fakeSources, cache, argv);
    expect(result.isError).toBe(false);
    const first = result.content[0];
    expect(first).toBeDefined();
    const envelope = JSON.parse(first?.text ?? '{}') as {
      ok: boolean;
      data: { count: number; rows?: unknown[] };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.rows?.length).toBeLessThanOrEqual(20);
    expect(envelope.data.count).toBeLessThanOrEqual(20);
  });
});
