import { saveCorpus } from '../cache/corpus.ts';
// `skim` — the cheap structural peek (design §3 item 9, §7 ladder step 2):
// resolve the default branch's head SHA (1 conditional REST call, ETag-cached
// — reused by `digest`), fetch the full tree inventory (cached forever by
// that resolved sha, content-addressed) and the README head, then emit a
// structure summary. The E-group skim booleans (`hasCi`/`hasTests`/
// `readmeInstall`/`readmeUsage`/`readmeExample`, matching scoring.ts's
// skimQualityOf exactly) are optionally written into a corpus row's signals
// with `source:'skim'` provenance via `--in`; `sourceFileShare`/
// `treeDepthSanity` (dissect profile's Structure component — otherwise
// unreachable anywhere in the codebase) ride along the same tree walk.
import type { Cache, Corpus, CorpusRepo, SignalProvenance } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import type { GhRest } from '../sources/gh-rest.ts';
import { EngineError } from '../types.ts';
import { loadCorpusOrEmpty, updateBudgetFromRestHeaders } from './_shared.ts';
import { parseOwnerRepo, resolveRefSha } from './extract-shared.ts';

const DEFAULT_MAX_CHARS = 4000;

export interface SkimOpts {
  repo?: string;
  maxChars?: string;
  treeOnly?: boolean;
  in?: string;
}

export interface SkimSources {
  ghRest: Pick<GhRest, 'get'>;
}

export interface SkimDeps {
  now?: () => number;
}

export interface SkimTreeSummary {
  totalFiles: number;
  topLevelDirs: string[];
  extensionCounts: Record<string, number>;
}

export interface SkimReadme {
  head: string;
  truncated: boolean;
}

export interface SkimSignals {
  hasCi: boolean;
  hasTests: boolean;
  hasDocs: boolean;
  hasExamples: boolean;
  hasLicenseFile: boolean;
  readmeInstall: boolean;
  readmeUsage: boolean;
  readmeExample: boolean;
}

export interface SkimResult {
  repo: string;
  sha: string;
  truncatedTree: boolean;
  hint?: string;
  tree?: SkimTreeSummary;
  /** undefined = --tree-only (never attempted); null = attempted, repo has no README (expected absence). */
  readme?: SkimReadme | null;
  signals: SkimSignals;
  corpusUpdated?: string;
}

export function skimOptsFromArgs(parsed: ParsedArgs): SkimOpts {
  return {
    repo: parsed.positionals[0],
    maxChars: parsed.flags['max-chars']?.[0],
    treeOnly: parsed.bools.has('tree-only'),
    in: parsed.flags.in?.[0],
  };
}

interface RawTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface TreeResponse {
  truncated?: boolean;
  tree?: RawTreeEntry[];
}

function parseMaxChars(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_CHARS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new EngineError('INVALID_INPUT', `--max-chars must be a positive integer (got '${raw}')`);
  }
  return n;
}

function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // no extension, or a dotfile with nothing after the leading dot
  return base.slice(dot + 1).toLowerCase();
}

const CI_RE = /^\.github\/workflows\//;
const TEST_DIR_RE = /(^|\/)(test|tests|__tests__|spec)\//i;
const DOCS_DIR_RE = /(^|\/)docs?\//i;
const EXAMPLES_DIR_RE = /(^|\/)examples?\//i;
const LICENSE_FILE_RE = /^licen[cs]e(\.|$)/i;

const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'rb',
  'php',
  'swift',
  'scala',
  'hs',
  'clj',
  'ex',
  'exs',
  'lua',
  'sh',
  'zig',
  'ml',
  'dart',
  'vue',
  'svelte',
]);

// diskBand-style saturation for tree-depth sanity (design §5 Structure —
// too shallow reads as a stub, absurdly deep as an unmanaged monorepo dump).
const DEPTH_MIN = 1;
const DEPTH_MAX = 8;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function depthBand(depth: number): number {
  if (depth >= DEPTH_MIN && depth <= DEPTH_MAX) return 1;
  if (depth < DEPTH_MIN) return clamp01(depth / DEPTH_MIN);
  return clamp01(DEPTH_MAX / depth);
}

interface StructureWalk {
  summary: SkimTreeSummary;
  signals: Pick<SkimSignals, 'hasCi' | 'hasTests' | 'hasDocs' | 'hasExamples' | 'hasLicenseFile'>;
  sourceFileShare: number;
  treeDepthSanity: number;
}

function walkTree(entries: RawTreeEntry[]): StructureWalk {
  const files = entries.filter((e) => e.type === 'blob');
  const topLevelDirs = new Set<string>();
  const extensionCounts: Record<string, number> = {};
  let hasCi = false;
  let hasTests = false;
  let hasDocs = false;
  let hasExamples = false;
  let hasLicenseFile = false;
  let sourceFiles = 0;
  let maxDepth = 0;

  for (const f of files) {
    const slash = f.path.indexOf('/');
    if (slash > 0) topLevelDirs.add(f.path.slice(0, slash));
    const ext = extensionOf(f.path);
    if (ext) {
      extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
      if (SOURCE_EXTENSIONS.has(ext)) sourceFiles += 1;
    }
    if (CI_RE.test(f.path)) hasCi = true;
    if (TEST_DIR_RE.test(f.path)) hasTests = true;
    if (DOCS_DIR_RE.test(f.path)) hasDocs = true;
    if (EXAMPLES_DIR_RE.test(f.path)) hasExamples = true;
    if (slash < 0 && LICENSE_FILE_RE.test(f.path)) hasLicenseFile = true;
    const depth = f.path.split('/').length;
    if (depth > maxDepth) maxDepth = depth;
  }

  return {
    summary: {
      totalFiles: files.length,
      topLevelDirs: [...topLevelDirs],
      extensionCounts,
    },
    signals: { hasCi, hasTests, hasDocs, hasExamples, hasLicenseFile },
    sourceFileShare: files.length > 0 ? sourceFiles / files.length : 0,
    treeDepthSanity: depthBand(maxDepth),
  };
}

const INSTALL_RE = /install|setup|getting started/i;
const USAGE_RE = /usage|how to use/i;
const EXAMPLE_RE = /example|quick ?start/i;
const HEADING_RE = /^#{1,6}\s+\S/;

function readmeHeadingBooleans(text: string): {
  install: boolean;
  usage: boolean;
  example: boolean;
} {
  const headings = text.split('\n').filter((l) => HEADING_RE.test(l));
  return {
    install: headings.some((l) => INSTALL_RE.test(l)),
    usage: headings.some((l) => USAGE_RE.test(l)),
    example: headings.some((l) => EXAMPLE_RE.test(l)),
  };
}

interface TreeFetch {
  entries: RawTreeEntry[];
  /** True only on a cold, truncated fetch — a cache hit never re-reports it (design §7 item 2: the tree is cached as-is either way; truncation is inherent to the commit, not something a refetch would resolve). */
  truncated: boolean;
}

async function fetchTree(
  ghRest: SkimSources['ghRest'],
  cache: Cache,
  owner: string,
  repo: string,
  sha: string,
): Promise<TreeFetch> {
  const cached = cache.trees.get(sha);
  if (cached) {
    return {
      entries: cached.map((e) => ({ path: e.path, type: 'blob', sha: e.sha, size: e.size })),
      truncated: false,
    };
  }

  const res = await ghRest.get(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  updateBudgetFromRestHeaders(cache, 'restCore', res.headers);
  const body = res.body as TreeResponse;
  const entries = body.tree ?? [];
  const blobs = entries.filter((e) => e.type === 'blob');
  cache.trees.put(
    sha,
    blobs.map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })),
  );
  return { entries, truncated: body.truncated === true };
}

/**
 * Content-addressed by `${owner}/${repo}@${sha}` — once fetched, never
 * refetched (README at a fixed commit is immutable). A repo with no README
 * is expected absence (design's "missing file -> ok:true" contract), not a
 * hard failure: NOT_FOUND from the readme fetch resolves to `null` rather
 * than propagating and aborting the whole skim.
 */
async function fetchReadme(
  ghRest: SkimSources['ghRest'],
  cache: Cache,
  owner: string,
  repo: string,
  sha: string,
): Promise<string | null> {
  const url = `/repos/${owner}/${repo}/readme?ref=${sha}`;
  const existing = cache.etags.get(url);
  if (existing) {
    const body = cache.etags.getBody(existing.bodyHash);
    if (body !== undefined) return body;
  }
  let res: Awaited<ReturnType<SkimSources['ghRest']['get']>>;
  try {
    res = await ghRest.get(url, { raw: true, etag: existing?.etag });
  } catch (e) {
    if (e instanceof EngineError && e.code === 'NOT_FOUND') return null;
    throw e;
  }
  updateBudgetFromRestHeaders(cache, 'restCore', res.headers);
  if (res.status === 304) {
    const body = existing ? cache.etags.getBody(existing.bodyHash) : undefined;
    if (body === undefined)
      throw new EngineError('FETCH_FAILED', `304 for ${url} but no cached body`);
    return body;
  }
  const body = res.body as string;
  if (res.etag) cache.etags.set(url, res.etag, body);
  return body;
}

function makeProv(value: unknown, fetchedAt: string): SignalProvenance {
  return { value, source: 'skim', fetchedAt };
}

function skimSignalProvenance(
  walk: StructureWalk,
  readmeBooleans: { install: boolean; usage: boolean; example: boolean } | undefined,
  fetchedAt: string,
): Record<string, SignalProvenance> {
  return {
    hasCi: makeProv(walk.signals.hasCi, fetchedAt),
    hasTests: makeProv(walk.signals.hasTests, fetchedAt),
    readmeInstall: makeProv(readmeBooleans?.install ?? false, fetchedAt),
    readmeUsage: makeProv(readmeBooleans?.usage ?? false, fetchedAt),
    readmeExample: makeProv(readmeBooleans?.example ?? false, fetchedAt),
    sourceFileShare: makeProv(walk.sourceFileShare, fetchedAt),
    treeDepthSanity: makeProv(walk.treeDepthSanity, fetchedAt),
  };
}

function upsertCorpusRow(
  corpus: Corpus,
  fullName: string,
  signals: Record<string, SignalProvenance>,
): Corpus {
  const key = fullName.toLowerCase();
  const idx = corpus.repos.findIndex((r) => r.full_name.toLowerCase() === key);
  const repos = corpus.repos.slice();
  if (idx === -1) {
    const fresh: CorpusRepo = {
      full_name: fullName,
      ghid: '',
      aliases: [],
      source: 'skim',
      signals,
    };
    repos.push(fresh);
  } else {
    const existing = repos[idx] as CorpusRepo;
    repos[idx] = { ...existing, signals: { ...existing.signals, ...signals } };
  }
  return { ...corpus, repos, count: repos.length };
}

export async function runSkim(
  sources: SkimSources,
  cache: Cache,
  opts: SkimOpts,
  deps: SkimDeps = {},
): Promise<SkimResult> {
  const now = deps.now ?? Date.now;
  const { owner, repo } = parseOwnerRepo(opts.repo);
  const maxChars = parseMaxChars(opts.maxChars);

  const { sha } = await resolveRefSha(sources.ghRest, cache, owner, repo);
  const { entries: tree, truncated: truncatedTree } = await fetchTree(
    sources.ghRest,
    cache,
    owner,
    repo,
    sha,
  );
  const walk = walkTree(tree);

  let readmeHead: string | undefined;
  let readmeTruncated = false;
  let readmeBooleans: { install: boolean; usage: boolean; example: boolean } | undefined;
  let readmeMissing = false;
  if (!opts.treeOnly) {
    const full = await fetchReadme(sources.ghRest, cache, owner, repo, sha);
    if (full === null) {
      readmeMissing = true;
    } else {
      readmeTruncated = full.length > maxChars;
      readmeHead = readmeTruncated ? full.slice(0, maxChars) : full;
      readmeBooleans = readmeHeadingBooleans(full);
    }
  }

  const fetchedAt = new Date(now()).toISOString();
  const signals: SkimSignals = {
    ...walk.signals,
    readmeInstall: readmeBooleans?.install ?? false,
    readmeUsage: readmeBooleans?.usage ?? false,
    readmeExample: readmeBooleans?.example ?? false,
  };

  const result: SkimResult = {
    repo: `${owner}/${repo}`,
    sha,
    truncatedTree,
    tree: walk.summary,
    signals,
  };
  if (truncatedTree) result.hint = 'tree truncated; use digest for the full snapshot';
  if (readmeMissing) result.readme = null;
  else if (readmeHead !== undefined)
    result.readme = { head: readmeHead, truncated: readmeTruncated };

  if (opts.in) {
    const fullName = `${owner}/${repo}`;
    const corpus = loadCorpusOrEmpty(opts.in, fullName, now);
    const provenance = skimSignalProvenance(walk, readmeBooleans, fetchedAt);
    const updated = upsertCorpusRow(corpus, fullName, provenance);
    saveCorpus(opts.in, updated, now);
    result.corpusUpdated = opts.in;
  }

  return result;
}
