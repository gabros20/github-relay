import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createCache } from '../../src/cache/index.ts';
import { parseArgs } from '../../src/cli.ts';
import { type DigestSources, digestOptsFromArgs, runDigest } from '../../src/commands/digest.ts';
import type { Exec } from '../../src/sources/auth.ts';
import { EngineError } from '../../src/types.ts';

const SHA = 'a'.repeat(40);
const PREFIX = 'o-r-1234567';

// ── a minimal ustar+gzip fixture writer (test-only; mirrors tar.test.ts) ──

function octal(value: number, length: number): Uint8Array {
  const s = value.toString(8).padStart(length - 1, '0');
  const buf = new Uint8Array(length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  buf[length - 1] = 0;
  return buf;
}
function writeString(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
}
function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
  return sum;
}
function tarHeader(fullPath: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  let name = fullPath;
  let prefix = '';
  if (fullPath.length > 100) {
    const splitAt = fullPath.lastIndexOf('/', fullPath.length - 100);
    prefix = fullPath.slice(0, splitAt);
    name = fullPath.slice(splitAt + 1);
  }
  writeString(header, 0, name);
  header.set(octal(0o644, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(size, 12), 124);
  header.set(octal(0, 12), 136);
  header.set(new Uint8Array(8).fill(32), 148);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 'ustar');
  writeString(header, 263, '00');
  writeString(header, 345, prefix);
  const sumStr = `${checksum(header).toString(8).padStart(6, '0')}\0 `;
  writeString(header, 148, sumStr);
  return header;
}
function pad512(buf: Uint8Array): Uint8Array {
  const rem = buf.length % 512;
  if (rem === 0) return buf;
  const out = new Uint8Array(buf.length + (512 - rem));
  out.set(buf);
  return out;
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** entries are relative paths (without the PREFIX/ leader — this adds it, matching GitHub's tarball layout). */
function buildFixtureTarGz(entries: { path: string; content: string }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    const bytes = new TextEncoder().encode(e.content);
    chunks.push(tarHeader(`${PREFIX}/${e.path}`, bytes.length));
    chunks.push(pad512(bytes));
  }
  chunks.push(new Uint8Array(1024));
  return gzipSync(concat(chunks));
}

const FIXTURE_FILES = [
  { path: 'README.md', content: '# fixture repo\n\nsome docs.' },
  { path: 'src/index.ts', content: 'export const x = 1;\n' },
  { path: 'src/util.ts', content: 'export function util() {}\n' },
  { path: 'docs/guide.md', content: '# guide\n\nmore docs.' },
  { path: 'node_modules/dep/index.js', content: 'module.exports = {};' },
  { path: 'package-lock.json', content: '{"lockfileVersion": 3}' },
  { path: 'assets/logo.png', content: '\0PNGbinarydata\0\0\0' },
  { path: 'dist/bundle.min.js', content: 'function a(){return 1}' },
  { path: 'huge.txt', content: 'x'.repeat(1024 * 1024 + 10) },
];

interface FakeSourcesConfig {
  commitSha?: string;
  downloadTarball?: DigestSources['ghRest']['downloadTarball'];
  getError?: EngineError;
}

function fakeHeaders(): Headers {
  return new Headers({ 'x-ratelimit-remaining': '999', 'x-ratelimit-reset': '2000000000' });
}

function fakeSources(cfg: FakeSourcesConfig = {}): {
  ghRest: DigestSources['ghRest'];
  calls: string[];
} {
  const calls: string[] = [];
  const ghRest: DigestSources['ghRest'] = {
    get: async (path) => {
      calls.push(`get:${path}`);
      if (cfg.getError) throw cfg.getError;
      return {
        status: 200,
        headers: fakeHeaders(),
        body: { sha: cfg.commitSha ?? SHA },
        etag: '"c1"',
      };
    },
    downloadTarball:
      cfg.downloadTarball ??
      (async (owner, repo, ref, opts) => {
        calls.push(`tarball:${owner}/${repo}@${ref}`);
        const bytes = buildFixtureTarGz(FIXTURE_FILES);
        writeFileSync(opts.out, bytes);
        return { path: opts.out, bytes: bytes.length, headers: fakeHeaders() };
      }),
  };
  return { ghRest, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-digest-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('digestOptsFromArgs', () => {
  test('parses repo, --ref, repeated --include/--exclude, --max-tokens, --out, --list', () => {
    const parsed = parseArgs([
      'digest',
      'o/r',
      '--ref',
      'main',
      '--include',
      'src/**',
      '--include',
      '*.md',
      '--exclude',
      'docs/**',
      '--max-tokens',
      '5000',
      '--out',
      'digest.md',
      '--list',
    ]);
    expect(digestOptsFromArgs(parsed)).toEqual({
      repo: 'o/r',
      ref: 'main',
      include: ['src/**', '*.md'],
      exclude: ['docs/**'],
      maxTokens: '5000',
      out: 'digest.md',
      list: true,
    });
  });
});

describe('runDigest — default excludes, tarball path', () => {
  test('applies default excludes and emits a tree + fenced sections, inline markdown for a small digest', async () => {
    const cache = createCache(dir);
    const { ghRest, calls } = fakeSources();
    const result = await runDigest({ ghRest }, cache, { repo: 'o/r', include: [], exclude: [] });

    expect(calls).toEqual(['get:/repos/o/r/commits/HEAD', `tarball:o/r@${SHA}`]);
    expect(result.sha).toBe(SHA);
    expect(result.files).toBe(4); // README, src/index.ts, src/util.ts, docs/guide.md
    expect(result.markdown).toContain('README.md');
    expect(result.markdown).toContain('src/index.ts');
    expect(result.markdown).not.toContain('node_modules');
    expect(result.markdown).not.toContain('package-lock.json');
    expect(result.markdown).not.toContain('bundle.min.js');
    expect(result.markdown).not.toContain('huge.txt');
    expect(result.markdown).not.toContain('logo.png');
    expect(result.out).toBeUndefined();
  });

  test('a second digest against the same commit reuses the cached tarball (zero fresh downloads)', async () => {
    const cache = createCache(dir);
    const { ghRest, calls } = fakeSources();
    await runDigest({ ghRest }, cache, { repo: 'o/r', include: [], exclude: [] });
    calls.length = 0;
    const second = await runDigest({ ghRest }, cache, { repo: 'o/r', include: [], exclude: [] });
    expect(calls).toEqual(['get:/repos/o/r/commits/HEAD']); // no fresh tarball download
    expect(second.files).toBe(4);
  });

  test('--include narrows to matching files only', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeSources();
    const result = await runDigest({ ghRest }, cache, {
      repo: 'o/r',
      include: ['src/**'],
      exclude: [],
    });
    expect(result.files).toBe(2);
    expect(result.markdown).toContain('src/index.ts');
    expect(result.markdown).not.toContain('README.md');
  });

  test('--exclude removes additional files on top of the defaults', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeSources();
    const result = await runDigest({ ghRest }, cache, {
      repo: 'o/r',
      include: [],
      exclude: ['docs/**'],
    });
    expect(result.files).toBe(3);
    expect(result.markdown).not.toContain('docs/guide.md');
  });
});

describe('runDigest — --list is a zero-content dry run', () => {
  test('lists included files + estimated tokens, no content anywhere in the result', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeSources();
    const result = await runDigest({ ghRest }, cache, {
      repo: 'o/r',
      include: [],
      exclude: [],
      list: true,
    });
    expect(result.list?.sort()).toEqual(
      ['README.md', 'docs/guide.md', 'src/index.ts', 'src/util.ts'].sort(),
    );
    expect(result.markdown).toBeUndefined();
    expect(result.tokens).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('some docs');
  });
});

describe('runDigest — --max-tokens hard stop', () => {
  test('stops adding files once the budget would be exceeded and reports what was dropped', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeSources();
    const result = await runDigest({ ghRest }, cache, {
      repo: 'o/r',
      include: [],
      exclude: [],
      maxTokens: '20', // tiny — forces an immediate hard stop
    });
    expect(result.dropped?.files).toBeGreaterThan(0);
    expect(result.dropped?.hint).toContain('--include');
  });
});

describe('runDigest — --out requirement for large digests', () => {
  test('an estimate over the inline threshold without --out is INVALID_INPUT', async () => {
    const cache = createCache(dir);
    const bigContent = 'y'.repeat(40_000); // ~10k tokens
    const { ghRest } = fakeSources({
      downloadTarball: async (_owner, _repo, _ref, opts) => {
        const bytes = buildFixtureTarGz([{ path: 'big.txt', content: bigContent }]);
        writeFileSync(opts.out, bytes);
        return { path: opts.out, bytes: bytes.length, headers: fakeHeaders() };
      },
    });
    await expect(
      runDigest({ ghRest }, cache, { repo: 'o/r', include: [], exclude: [] }),
    ).rejects.toBeInstanceOf(EngineError);
  });

  test('with --out, a large digest writes the markdown file and returns a summary envelope only', async () => {
    const cache = createCache(dir);
    const bigContent = 'y'.repeat(40_000);
    const { ghRest } = fakeSources({
      downloadTarball: async (_owner, _repo, _ref, opts) => {
        const bytes = buildFixtureTarGz([{ path: 'big.txt', content: bigContent }]);
        writeFileSync(opts.out, bytes);
        return { path: opts.out, bytes: bytes.length, headers: fakeHeaders() };
      },
    });
    const outPath = join(dir, 'digest.md');
    const result = await runDigest({ ghRest }, cache, {
      repo: 'o/r',
      include: [],
      exclude: [],
      out: outPath,
    });
    expect(result.out).toBe(outPath);
    expect(result.markdown).toBeUndefined();
    const written = await Bun.file(outPath).text();
    expect(written).toContain('big.txt');
    expect(written).toContain('y'.repeat(100));
  });
});

describe('runDigest — clone fallback', () => {
  function cloningExec(fixtureFiles: { path: string; content: string }[]): Exec {
    return async (cmd) => {
      if (cmd[0] === 'git' && cmd[1] === '--version') {
        return { stdout: 'git version 2.40.0', exitCode: 0 };
      }
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        const targetDir = cmd[cmd.length - 1] as string;
        for (const f of fixtureFiles) {
          const full = join(targetDir, f.path);
          mkdirSync(join(full, '..'), { recursive: true });
          writeFileSync(full, f.content);
        }
        return { stdout: '', exitCode: 0 };
      }
      return { stdout: 'unrecognized', exitCode: 1 };
    };
  }

  test('a tarball failure with git present falls back to a clone and marks fallback:"clone"', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeSources({
      downloadTarball: async () => {
        throw new EngineError('FETCH_FAILED', 'tarball exceeds the 200MB size guard');
      },
    });
    const exec = cloningExec([
      { path: 'README.md', content: '# cloned' },
      { path: 'src/index.ts', content: 'export {}' },
    ]);
    const result = await runDigest(
      { ghRest },
      cache,
      { repo: 'o/r', include: [], exclude: [] },
      { exec },
    );
    expect(result.fallback).toBe('clone');
    expect(result.markdown).toContain('cloned');
  });

  test('a tarball failure with git absent fails loud (no fallback possible)', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeSources({
      downloadTarball: async () => {
        throw new EngineError('FETCH_FAILED', 'tarball exceeds the 200MB size guard');
      },
    });
    const exec: Exec = async () => ({ stdout: '', exitCode: 1 }); // git --version fails
    await expect(
      runDigest({ ghRest }, cache, { repo: 'o/r', include: [], exclude: [] }, { exec }),
    ).rejects.toBeInstanceOf(EngineError);
  });
});

describe('runDigest — --ref resolution', () => {
  test('a bare 40-hex --ref skips resolution entirely', async () => {
    const cache = createCache(dir);
    const { ghRest, calls } = fakeSources();
    await runDigest({ ghRest }, cache, { repo: 'o/r', include: [], exclude: [], ref: SHA });
    expect(calls).toEqual([`tarball:o/r@${SHA}`]); // no commits/{ref} resolution call
  });

  test('a branch-name --ref resolves via commits/{ref}', async () => {
    const cache = createCache(dir);
    const { ghRest, calls } = fakeSources();
    await runDigest({ ghRest }, cache, {
      repo: 'o/r',
      include: [],
      exclude: [],
      ref: 'develop',
    });
    expect(calls[0]).toBe('get:/repos/o/r/commits/develop');
  });
});

describe('runDigest — input validation', () => {
  test('rejects a repo without a slash', async () => {
    const cache = createCache(dir);
    const { ghRest } = fakeSources();
    await expect(
      runDigest({ ghRest }, cache, { repo: 'bad', include: [], exclude: [] }),
    ).rejects.toBeInstanceOf(EngineError);
  });
});
