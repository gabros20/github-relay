import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorpus, loadCorpus, saveCorpus } from '../../src/cache/corpus.ts';
import { createCache } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import { type SkimSources, runSkim, skimOptsFromArgs } from '../../src/commands/skim.ts';
import { EngineError } from '../../src/types.ts';

const SHA = 'a'.repeat(40);

const README = [
  '# my-lib',
  '',
  '## Install',
  '',
  '```bash',
  'npm install my-lib',
  '```',
  '',
  '## Usage',
  '',
  'call it.',
  '',
  '## Example',
  '',
  'see below.',
].join('\n');

function treeBody(truncated = false) {
  return {
    sha: SHA,
    truncated,
    tree: [
      { path: '.github', mode: '040000', type: 'tree', sha: 't1' },
      {
        path: '.github/workflows/ci.yml',
        mode: '100644',
        type: 'blob',
        sha: 'b'.repeat(40),
        size: 120,
      },
      { path: 'LICENSE', mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: 1066 },
      { path: 'README.md', mode: '100644', type: 'blob', sha: 'd'.repeat(40), size: 300 },
      { path: 'src', mode: '040000', type: 'tree', sha: 't2' },
      { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'e'.repeat(40), size: 400 },
      { path: 'test', mode: '040000', type: 'tree', sha: 't3' },
      { path: 'test/index.test.ts', mode: '100644', type: 'blob', sha: 'f'.repeat(40), size: 200 },
    ],
  };
}

interface RouteResult {
  status: number;
  body: unknown;
  etag: string | null;
}

function fakeGhRest(
  routes: Record<string, (opts: { etag?: string; raw?: boolean }) => RouteResult>,
): { ghRest: SkimSources['ghRest']; calls: string[] } {
  const calls: string[] = [];
  const ghRest: SkimSources['ghRest'] = {
    get: async (path, opts = {}) => {
      calls.push(path);
      const route = routes[path];
      if (!route) throw new Error(`unexpected fetch: ${path}`);
      const r = route(opts);
      return {
        status: r.status,
        headers: new Headers({
          'x-ratelimit-remaining': '4321',
          'x-ratelimit-reset': '2000000000',
        }),
        body: r.body,
        etag: r.etag,
      };
    },
  };
  return { ghRest, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-skim-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('skimOptsFromArgs', () => {
  test('parses repo, --max-chars, --tree-only, --in', () => {
    const parsed = parseArgs([
      'skim',
      'o/r',
      '--max-chars',
      '2000',
      '--tree-only',
      '--in',
      'corpus.json',
    ]);
    expect(skimOptsFromArgs(parsed)).toEqual({
      repo: 'o/r',
      maxChars: '2000',
      treeOnly: true,
      in: 'corpus.json',
    });
  });
});

describe('runSkim — cold run', () => {
  test('resolves head sha, fetches tree + readme, emits structure summary + signals', async () => {
    const cache = createCache(dir);
    const { ghRest, calls } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(),
        etag: '"t1"',
      }),
      [`/repos/o/r/readme?ref=${SHA}`]: () => ({ status: 200, body: README, etag: '"r1"' }),
    });
    const result = await runSkim({ ghRest }, cache, { repo: 'o/r' });

    expect(calls).toEqual([
      '/repos/o/r/commits/HEAD',
      `/repos/o/r/git/trees/${SHA}?recursive=1`,
      `/repos/o/r/readme?ref=${SHA}`,
    ]);
    expect(result.sha).toBe(SHA);
    expect(result.truncatedTree).toBe(false);
    expect(result.tree?.totalFiles).toBe(5);
    expect(result.tree?.topLevelDirs.sort()).toEqual(['.github', 'src', 'test']);
    expect(result.tree?.extensionCounts).toEqual({ yml: 1, ts: 2, md: 1 });
    expect(result.signals.hasCi).toBe(true);
    expect(result.signals.hasTests).toBe(true);
    expect(result.signals.hasDocs).toBe(false);
    expect(result.signals.hasExamples).toBe(false);
    expect(result.signals.hasLicenseFile).toBe(true);
    expect(result.signals.readmeInstall).toBe(true);
    expect(result.signals.readmeUsage).toBe(true);
    expect(result.signals.readmeExample).toBe(true);
    expect(result.readme?.head).toContain('# my-lib');
    expect(result.readme?.truncated).toBe(false);

    // Budget updated after each REST call.
    expect(cache.budget.load().restCore?.remaining).toBe(4321);

    // The tree is now cached by resolved sha (content-addressed, ladder step 0).
    expect(cache.trees.has(SHA)).toBe(true);
  });

  test('--tree-only skips the readme fetch entirely', async () => {
    const cache = createCache(dir);
    const { ghRest, calls } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(),
        etag: '"t1"',
      }),
    });
    const result = await runSkim({ ghRest }, cache, { repo: 'o/r', treeOnly: true });
    expect(calls).toEqual(['/repos/o/r/commits/HEAD', `/repos/o/r/git/trees/${SHA}?recursive=1`]);
    expect(result.readme).toBeUndefined();
  });

  test('a truncated tree carries a hint to use digest instead', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(true),
        etag: '"t1"',
      }),
      [`/repos/o/r/readme?ref=${SHA}`]: () => ({ status: 200, body: README, etag: '"r1"' }),
    });
    const result = await runSkim({ ghRest }, cache, { repo: 'o/r' });
    expect(result.truncatedTree).toBe(true);
    expect(result.hint).toContain('digest');
  });

  test('--max-chars truncates the README head and marks truncated:true', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(),
        etag: '"t1"',
      }),
      [`/repos/o/r/readme?ref=${SHA}`]: () => ({ status: 200, body: README, etag: '"r1"' }),
    });
    const result = await runSkim({ ghRest }, cache, { repo: 'o/r', maxChars: '10' });
    expect(result.readme?.head).toHaveLength(10);
    expect(result.readme?.truncated).toBe(true);
  });

  test('a repo with no README is expected absence, not a hard failure — command still succeeds', async () => {
    const cache = createCache(dir);
    const { ghRest, calls } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(),
        etag: '"t1"',
      }),
      [`/repos/o/r/readme?ref=${SHA}`]: () => {
        throw new EngineError('NOT_FOUND', 'no readme');
      },
    });
    const result = await runSkim({ ghRest }, cache, { repo: 'o/r' });
    expect(calls).toEqual([
      '/repos/o/r/commits/HEAD',
      `/repos/o/r/git/trees/${SHA}?recursive=1`,
      `/repos/o/r/readme?ref=${SHA}`,
    ]);
    expect(result.readme).toBeNull();
    expect(result.signals.readmeInstall).toBe(false);
    expect(result.signals.readmeUsage).toBe(false);
    expect(result.signals.readmeExample).toBe(false);
    // Tree-derived signals (hasCi/hasTests/...) still land — only the
    // README-derived booleans are affected by the missing README.
    expect(result.signals.hasCi).toBe(true);
  });

  test('a missing README still writes readme signals (false, with provenance) into --in corpus.json', async () => {
    const cache = createCache(dir);
    const corpusPath = join(dir, 'corpus.json');
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(),
        etag: '"t1"',
      }),
      [`/repos/o/r/readme?ref=${SHA}`]: () => {
        throw new EngineError('NOT_FOUND', 'no readme');
      },
    });
    const result = await runSkim({ ghRest }, cache, { repo: 'o/r', in: corpusPath });
    expect(result.corpusUpdated).toBe(corpusPath);
    const saved = loadCorpus(corpusPath);
    const row = saved.repos[0];
    expect(row?.signals.readmeInstall?.value).toBe(false);
    expect(row?.signals.readmeInstall?.source).toBe('skim');
  });
});

describe('runSkim — repeat run against an unchanged commit is quota-free', () => {
  test('second skim: commits/HEAD 304s, tree + readme served from local cache with zero fresh fetches', async () => {
    const cache = createCache(dir);
    let commitHits = 0;
    const { ghRest, calls } = fakeGhRest({
      '/repos/o/r/commits/HEAD': (opts) => {
        commitHits++;
        if (opts.etag === '"c1"') return { status: 304, body: null, etag: '"c1"' };
        return { status: 200, body: { sha: SHA }, etag: '"c1"' };
      },
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(),
        etag: '"t1"',
      }),
      [`/repos/o/r/readme?ref=${SHA}`]: () => ({ status: 200, body: README, etag: '"r1"' }),
    });

    await runSkim({ ghRest }, cache, { repo: 'o/r' });
    calls.length = 0; // reset the recording after the cold run

    const second = await runSkim({ ghRest }, cache, { repo: 'o/r' });
    expect(second.sha).toBe(SHA);
    expect(calls).toEqual(['/repos/o/r/commits/HEAD']); // only the ETag revalidation
    expect(commitHits).toBe(2);
  });
});

describe('runSkim — --in corpus.json writes E-group signals with provenance', () => {
  function writeCorpus(fullName: string) {
    const path = join(dir, 'corpus.json');
    const now = () => Date.parse('2026-07-11T00:00:00Z');
    const corpus = createCorpus('intent', [], now);
    corpus.repos.push({
      full_name: fullName,
      ghid: 'R_x',
      aliases: [],
      source: 'search',
      signals: {},
    });
    saveCorpus(path, corpus, now);
    return path;
  }

  test('updates the matching row in place, source:"skim"', async () => {
    const cache = createCache(dir);
    const corpusPath = writeCorpus('o/r');
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(),
        etag: '"t1"',
      }),
      [`/repos/o/r/readme?ref=${SHA}`]: () => ({ status: 200, body: README, etag: '"r1"' }),
    });

    const result = await runSkim({ ghRest }, cache, { repo: 'o/r', in: corpusPath });
    expect(result.corpusUpdated).toBe(corpusPath);

    const saved = loadCorpus(corpusPath);
    expect(saved.repos).toHaveLength(1);
    const row = saved.repos[0];
    expect(row?.signals.hasCi?.value).toBe(true);
    expect(row?.signals.hasCi?.source).toBe('skim');
    expect(row?.signals.hasTests?.value).toBe(true);
    expect(row?.signals.readmeInstall?.value).toBe(true);
    expect(row?.signals.readmeUsage?.value).toBe(true);
    expect(row?.signals.readmeExample?.value).toBe(true);
  });

  test('creates a bare row when the repo is not yet in the corpus', async () => {
    const cache = createCache(dir);
    const corpusPath = join(dir, 'corpus.json');
    const { ghRest } = fakeGhRest({
      '/repos/o/r/commits/HEAD': () => ({ status: 200, body: { sha: SHA }, etag: '"c1"' }),
      [`/repos/o/r/git/trees/${SHA}?recursive=1`]: () => ({
        status: 200,
        body: treeBody(),
        etag: '"t1"',
      }),
      [`/repos/o/r/readme?ref=${SHA}`]: () => ({ status: 200, body: README, etag: '"r1"' }),
    });
    await runSkim({ ghRest }, cache, { repo: 'o/r', in: corpusPath });
    const saved = loadCorpus(corpusPath);
    expect(saved.repos.map((r) => r.full_name)).toEqual(['o/r']);
  });
});

describe('runSkim — input validation', () => {
  test('rejects a repo without a slash', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeGhRest({});
    await expect(runSkim({ ghRest }, cache, { repo: 'not-a-repo' })).rejects.toBeInstanceOf(
      EngineError,
    );
  });
});
