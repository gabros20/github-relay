import { randomUUID } from 'node:crypto';
// `digest` — GATE 4 whole-repo deep read (design §3 item 11, §7 ladder steps
// 4/5): pin ref→commit SHA once (reusing skim's `resolveRefSha`), fetch a
// tarball snapshot (cached forever by that sha) and unpack it locally with a
// zero-dep ustar reader (`./tar.ts`) + `node:zlib` gzip — or, when the
// tarball fails and `git` is available (feature-detected via an injectable
// exec seam, mirroring `sources/auth.ts`'s `Exec`), a blobless shallow clone.
// Default excludes (.git, node_modules, lockfiles, binaries, minified,
// >1MB) plus `--include`/`--exclude` globs narrow the set; the gitingest-
// style markdown (tree + fenced per-file sections) hard-stops at
// `--max-tokens` with a steering message. `--out` is required whenever the
// estimate exceeds the inline-safe threshold; `--list` never touches content.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Cache } from '../cache/index.ts';
import { writeFileAtomic } from '../cache/store.ts';
import type { ParsedArgs } from '../cli.ts';
import type { Exec } from '../sources/auth.ts';
import type { GhRest } from '../sources/gh-rest.ts';
import { EngineError } from '../types.ts';
import { updateBudgetFromRestHeaders } from './_shared.ts';
import { parseOwnerRepo, resolveRefSha } from './extract-shared.ts';
import { globMatch } from './glob.ts';
import { parseTar } from './tar.ts';

const DEFAULT_MAX_TOKENS = 20_000;
const CHARS_PER_TOKEN = 4;
/** Inline-safe stdout budget — beyond this, --out is required (design §3.11, "always over MCP later"). */
const OUT_REQUIRED_TOKENS = 8_000;
/** Also the tarball download's own size guard — a >200MB tarball fails this before the clone fallback kicks in. */
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface DigestOpts {
  repo?: string;
  ref?: string;
  include: string[];
  exclude: string[];
  maxTokens?: string;
  out?: string;
  list?: boolean;
}

export interface DigestSources {
  ghRest: Pick<GhRest, 'get' | 'downloadTarball'>;
}

export interface DigestDeps {
  now?: () => number;
  exec?: Exec;
}

export interface DigestDropped {
  files: number;
  estimatedTokens: number;
  hint: string;
}

export interface DigestResult {
  repo: string;
  sha: string;
  files: number;
  tokens: number;
  dropped?: DigestDropped;
  out?: string;
  markdown?: string;
  list?: string[];
  fallback?: 'clone';
}

export function digestOptsFromArgs(parsed: ParsedArgs): DigestOpts {
  return {
    repo: parsed.positionals[0],
    ref: parsed.flags.ref?.[0],
    include: parsed.flags.include ?? [],
    exclude: parsed.flags.exclude ?? [],
    maxTokens: parsed.flags['max-tokens']?.[0],
    out: parsed.flags.out?.[0],
    list: parsed.bools.has('list'),
  };
}

function parseMaxTokens(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_TOKENS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new EngineError(
      'INVALID_INPUT',
      `--max-tokens must be a positive integer (got '${raw}')`,
    );
  }
  return n;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ── filtering ────────────────────────────────────────────────────────────

const DEFAULT_EXCLUDE_GLOBS = [
  '.git/**',
  '**/.git/**',
  'node_modules/**',
  '**/node_modules/**',
  'package-lock.json',
  '**/package-lock.json',
  'yarn.lock',
  '**/yarn.lock',
  'pnpm-lock.yaml',
  '**/pnpm-lock.yaml',
  'bun.lockb',
  '**/bun.lockb',
  'bun.lock',
  '**/bun.lock',
  'Cargo.lock',
  '**/Cargo.lock',
  'Gemfile.lock',
  '**/Gemfile.lock',
  'composer.lock',
  '**/composer.lock',
  'poetry.lock',
  '**/poetry.lock',
  'Pipfile.lock',
  '**/Pipfile.lock',
  'go.sum',
  '**/go.sum',
  '*.min.js',
  '**/*.min.js',
  '*.min.css',
  '**/*.min.css',
];

const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'pdf',
  'zip',
  'tar',
  'gz',
  'tgz',
  '7z',
  'rar',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'otf',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wasm',
  'class',
  'jar',
  'pyc',
]);

export interface FileEntry {
  path: string;
  content: Uint8Array;
  size: number;
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function isBinaryContent(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  return sample.includes(0);
}

function isDefaultExcluded(entry: FileEntry): boolean {
  if (DEFAULT_EXCLUDE_GLOBS.some((g) => globMatch(g, entry.path))) return true;
  if (BINARY_EXTENSIONS.has(extOf(entry.path))) return true;
  if (entry.size > MAX_FILE_BYTES) return true;
  if (isBinaryContent(entry.content)) return true;
  return false;
}

function filterEntries(entries: FileEntry[], include: string[], exclude: string[]): FileEntry[] {
  return entries
    .filter((e) => !isDefaultExcluded(e))
    .filter((e) => !exclude.some((g) => globMatch(g, e.path)))
    .filter((e) => include.length === 0 || include.some((g) => globMatch(g, e.path)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ── snapshot acquisition (tarball, or blobless clone fallback) ─────────────

function stripLeadingPrefix(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

async function viaTarball(
  ghRest: DigestSources['ghRest'],
  cache: Cache,
  owner: string,
  repo: string,
  sha: string,
  now: () => number,
): Promise<FileEntry[]> {
  const cached = cache.tarballs.get(sha);
  let tarballPath: string;
  if (cached && existsSync(cached.path)) {
    tarballPath = cached.path;
  } else {
    const out = join(cache.paths.tarballsDir, `${sha}.tar.gz`);
    mkdirSync(cache.paths.tarballsDir, { recursive: true });
    const result = await ghRest.downloadTarball(owner, repo, sha, {
      out,
      maxBytes: MAX_TARBALL_BYTES,
    });
    updateBudgetFromRestHeaders(cache, 'restCore', result.headers);
    cache.tarballs.put(sha, result.path, now);
    tarballPath = result.path;
  }
  const tarBytes = gunzipSync(readFileSync(tarballPath));
  return parseTar(tarBytes).map((e) => ({
    path: stripLeadingPrefix(e.path),
    content: e.content,
    size: e.size,
  }));
}

const defaultExec: Exec = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout + stderr, exitCode };
};

function walkDir(root: string, dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkDir(root, full));
      continue;
    }
    const content = readFileSync(full);
    const path = relative(root, full).split(sep).join('/');
    out.push({ path, content, size: st.size });
  }
  return out;
}

async function viaClone(
  owner: string,
  repo: string,
  ref: string | undefined,
  exec: Exec,
): Promise<FileEntry[]> {
  const targetDir = join(tmpdir(), `ghrelay-clone-${randomUUID()}`);
  const args = ['git', 'clone', '--depth', '1', '--filter=blob:none'];
  // A bare commit sha (or the default HEAD) clones the default branch tip as-is
  // — shallow-clone-by-arbitrary-sha isn't guaranteed by git (design §3.11
  // concedes this is best-effort, not a byte-identical pin).
  if (ref && ref !== 'HEAD' && !HEX_SHA_RE.test(ref)) args.push('--branch', ref);
  args.push(`https://github.com/${owner}/${repo}.git`, targetDir);

  const { exitCode, stdout } = await exec(args);
  if (exitCode !== 0) {
    throw new EngineError('FETCH_FAILED', `git clone failed: ${stdout.slice(0, 500)}`);
  }
  return walkDir(targetDir, targetDir);
}

interface Snapshot {
  entries: FileEntry[];
  fallback?: 'clone';
}

async function obtainSnapshot(
  sources: DigestSources,
  cache: Cache,
  owner: string,
  repo: string,
  sha: string,
  ref: string | undefined,
  exec: Exec,
  now: () => number,
): Promise<Snapshot> {
  let tarballError: unknown;
  try {
    return { entries: await viaTarball(sources.ghRest, cache, owner, repo, sha, now) };
  } catch (e) {
    if (!(e instanceof EngineError)) throw e;
    tarballError = e;
  }

  const gitProbe = await exec(['git', '--version']).catch(() => ({ stdout: '', exitCode: 1 }));
  if (gitProbe.exitCode !== 0) {
    const message = tarballError instanceof Error ? tarballError.message : String(tarballError);
    throw new EngineError(
      'FETCH_FAILED',
      `tarball fetch failed (${message}) and git is not available for the clone fallback`,
    );
  }
  return { entries: await viaClone(owner, repo, ref, exec), fallback: 'clone' };
}

// ── gitingest-style markdown ─────────────────────────────────────────────

interface TreeNode {
  [name: string]: TreeNode;
}

function buildTreeStructure(paths: string[]): TreeNode {
  const root: TreeNode = {};
  for (const p of paths) {
    let node = root;
    for (const part of p.split('/')) {
      node[part] ??= {};
      node = node[part] as TreeNode;
    }
  }
  return root;
}

function renderTree(node: TreeNode, prefix = ''): string[] {
  const names = Object.keys(node).sort();
  const lines: string[] = [];
  names.forEach((name, i) => {
    const isLast = i === names.length - 1;
    lines.push(`${prefix}${isLast ? '└── ' : '├── '}${name}`);
    const child = node[name] as TreeNode;
    if (Object.keys(child).length > 0) {
      lines.push(...renderTree(child, `${prefix}${isLast ? '    ' : '│   '}`));
    }
  });
  return lines;
}

function treeSection(paths: string[]): string {
  return `# Tree\n\n\`\`\`\n${renderTree(buildTreeStructure(paths)).join('\n')}\n\`\`\`\n\n`;
}

function fileSection(f: FileEntry): string {
  const text = new TextDecoder().decode(f.content);
  return `## ${f.path}\n\n\`\`\`${extOf(f.path)}\n${text}\n\`\`\`\n\n`;
}

function droppedHint(remaining: FileEntry[]): string {
  const first = remaining[0];
  const dir = first ? first.path.split('/')[0] : undefined;
  return dir && dir !== first?.path
    ? `${remaining.length} files dropped past --max-tokens; narrow with --include '${dir}/**' or raise --max-tokens`
    : `${remaining.length} files dropped past --max-tokens; narrow with --include or raise --max-tokens`;
}

interface BuiltMarkdown {
  markdown: string;
  includedCount: number;
  dropped?: DigestDropped;
}

function buildMarkdown(filtered: FileEntry[], maxTokens: number): BuiltMarkdown {
  let markdown = treeSection(filtered.map((f) => f.path));
  let tokens = estimateTokens(markdown.length);
  let includedCount = 0;

  for (let i = 0; i < filtered.length; i++) {
    const f = filtered[i] as FileEntry;
    const section = fileSection(f);
    const sectionTokens = estimateTokens(section.length);
    if (tokens + sectionTokens > maxTokens) {
      const remaining = filtered.slice(i);
      const estimatedTokens = remaining.reduce((sum, r) => sum + estimateTokens(r.size), 0);
      return {
        markdown,
        includedCount,
        dropped: { files: remaining.length, estimatedTokens, hint: droppedHint(remaining) },
      };
    }
    markdown += section;
    tokens += sectionTokens;
    includedCount += 1;
  }
  return { markdown, includedCount };
}

// ── run ──────────────────────────────────────────────────────────────────

async function resolveSha(
  ghRest: DigestSources['ghRest'],
  cache: Cache,
  owner: string,
  repo: string,
  ref: string | undefined,
): Promise<string> {
  if (ref && HEX_SHA_RE.test(ref)) return ref;
  const resolved = await resolveRefSha(ghRest, cache, owner, repo, ref ?? 'HEAD');
  return resolved.sha;
}

export async function runDigest(
  sources: DigestSources,
  cache: Cache,
  opts: DigestOpts,
  deps: DigestDeps = {},
): Promise<DigestResult> {
  const now = deps.now ?? Date.now;
  const exec = deps.exec ?? defaultExec;
  const { owner, repo } = parseOwnerRepo(opts.repo);
  const maxTokens = parseMaxTokens(opts.maxTokens);

  const sha = await resolveSha(sources.ghRest, cache, owner, repo, opts.ref);
  const { entries, fallback } = await obtainSnapshot(
    sources,
    cache,
    owner,
    repo,
    sha,
    opts.ref,
    exec,
    now,
  );
  const filtered = filterEntries(entries, opts.include, opts.exclude);

  if (opts.list) {
    const tokens = filtered.reduce((sum, e) => sum + estimateTokens(e.size), 0);
    const result: DigestResult = {
      repo: `${owner}/${repo}`,
      sha,
      files: filtered.length,
      tokens,
      list: filtered.map((e) => e.path),
    };
    if (fallback) result.fallback = fallback;
    return result;
  }

  const estimatedTotal = filtered.reduce((sum, e) => sum + estimateTokens(e.size), 0);
  if (!opts.out && estimatedTotal > OUT_REQUIRED_TOKENS) {
    throw new EngineError(
      'INVALID_INPUT',
      `estimated digest size (~${estimatedTotal} tokens) exceeds the inline-safe threshold (${OUT_REQUIRED_TOKENS}); pass --out <path.md>`,
    );
  }

  const { markdown, includedCount, dropped } = buildMarkdown(filtered, maxTokens);
  const result: DigestResult = {
    repo: `${owner}/${repo}`,
    sha,
    files: includedCount,
    tokens: estimateTokens(markdown.length),
  };
  if (dropped) result.dropped = dropped;
  if (fallback) result.fallback = fallback;

  if (opts.out) {
    writeFileAtomic(opts.out, markdown);
    result.out = opts.out;
  } else {
    result.markdown = markdown;
  }
  return result;
}
