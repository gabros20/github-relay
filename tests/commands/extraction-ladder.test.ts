// Acceptance test for the extraction ladder end-to-end (design §7, task 6
// brief): skim resolves the ref and populates the tree/readme caches, read
// reuses that cached tree with zero extra resolution cost, and digest reuses
// the same resolved sha for its own tarball fetch/cache. A second full pass
// against an unchanged commit proves the whole ladder is quota-free except
// for the ETag revalidation round trips.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createCache } from '../../src/cache/index.ts';
import type { DigestSources } from '../../src/commands/digest.ts';
import { runDigest } from '../../src/commands/digest.ts';
import type { ReadSources } from '../../src/commands/read.ts';
import { runRead } from '../../src/commands/read.ts';
import type { SkimSources } from '../../src/commands/skim.ts';
import { runSkim } from '../../src/commands/skim.ts';

const SHA = 'a'.repeat(40);
const README_BLOB_SHA = 'b'.repeat(40);
const README = '# fixture\n\n## Install\n\nnpm install fixture\n\n## Usage\n\nuse it.';

// ── a tiny real ustar+gzip tarball, matching GitHub's owner-repo-sha layout ──

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
  writeString(header, 0, fullPath);
  header.set(octal(0o644, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(size, 12), 124);
  header.set(octal(0, 12), 136);
  header.set(new Uint8Array(8).fill(32), 148);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 'ustar');
  writeString(header, 263, '00');
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
function buildFixtureTarGz(): Uint8Array {
  const files = [
    { path: 'o-r-abc1234/README.md', content: README },
    { path: 'o-r-abc1234/src/index.ts', content: 'export const x = 1;\n' },
  ];
  const chunks: Uint8Array[] = [];
  for (const f of files) {
    const bytes = new TextEncoder().encode(f.content);
    chunks.push(tarHeader(f.path, bytes.length));
    chunks.push(pad512(bytes));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return gzipSync(out);
}

function fakeHeaders(): Headers {
  return new Headers({ 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '2000000000' });
}

describe('skim -> read -> digest against a real fixture tarball, end-to-end', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghrelay-ladder-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('the ladder shares the resolved sha and its caches across all three commands, and a second full pass is quota-free', async () => {
    const cache = createCache(dir);
    const calls: string[] = [];
    let commitHits = 0;

    const shared: SkimSources['ghRest'] & ReadSources['ghRest'] & DigestSources['ghRest'] = {
      get: async (path, opts = {}) => {
        calls.push(`get:${path}`);
        if (path.includes('/commits/HEAD')) {
          commitHits++;
          if (opts.etag === '"c1"') {
            return { status: 304, headers: fakeHeaders(), body: null, etag: '"c1"' };
          }
          return { status: 200, headers: fakeHeaders(), body: { sha: SHA }, etag: '"c1"' };
        }
        if (path.includes('/git/trees/')) {
          return {
            status: 200,
            headers: fakeHeaders(),
            body: {
              truncated: false,
              tree: [
                { path: 'README.md', type: 'blob', sha: README_BLOB_SHA, size: README.length },
                { path: 'src/index.ts', type: 'blob', sha: 'c'.repeat(40), size: 21 },
              ],
            },
            etag: '"t1"',
          };
        }
        if (path.includes('/readme')) {
          return { status: 200, headers: fakeHeaders(), body: README, etag: '"r1"' };
        }
        if (path.includes('/git/blobs/')) {
          return { status: 200, headers: fakeHeaders(), body: README, etag: null };
        }
        throw new Error(`unmapped fetch: ${path}`);
      },
      tarballUrl: async () => 'https://codeload.github.com/o/r/tar',
      downloadTarball: async (_owner, _repo, _ref, opts) => {
        calls.push('tarball');
        const bytes = buildFixtureTarGz();
        writeFileSync(opts.out, bytes);
        return { path: opts.out, bytes: bytes.length, headers: fakeHeaders() };
      },
    };

    // 1. skim resolves the head sha and populates cache.trees + the readme cache.
    const skimResult = await runSkim({ ghRest: shared }, cache, { repo: 'o/r' });
    expect(skimResult.sha).toBe(SHA);
    expect(cache.trees.has(SHA)).toBe(true);

    // 2. read, with no --ref, resolves the SAME sha and serves README.md from
    //    the tree skim already cached — no tree/contents fetch, just the blob.
    calls.length = 0;
    const readResult = await runRead({ ghRest: shared }, cache, {
      repo: 'o/r',
      paths: ['README.md'],
    });
    expect(readResult.sha).toBe(SHA);
    expect(calls).toEqual([
      'get:/repos/o/r/commits/HEAD',
      `get:/repos/o/r/git/blobs/${README_BLOB_SHA}`,
    ]);
    expect(readResult.results[0]?.content).toBe(README);

    // 3. digest, with no --ref, resolves the SAME sha and fetches the tarball once.
    calls.length = 0;
    const digestResult = await runDigest({ ghRest: shared }, cache, {
      repo: 'o/r',
      include: [],
      exclude: [],
    });
    expect(digestResult.sha).toBe(SHA);
    expect(digestResult.markdown).toContain('README.md');
    expect(calls).toContain('tarball');

    // 4. A second full pass against the SAME commit: skim's tree/readme are
    //    pure local cache hits, read's blob is cached, and digest reuses the
    //    cached tarball — the only network activity left anywhere is the
    //    commits/HEAD ETag revalidation (304, zero quota).
    calls.length = 0;
    await runSkim({ ghRest: shared }, cache, { repo: 'o/r' });
    await runRead({ ghRest: shared }, cache, { repo: 'o/r', paths: ['README.md'] });
    await runDigest({ ghRest: shared }, cache, { repo: 'o/r', include: [], exclude: [] });
    expect(calls.every((c) => c === 'get:/repos/o/r/commits/HEAD')).toBe(true);
    expect(calls).not.toContain('tarball');
    // Only the very first commits/HEAD call (skim's cold resolution, step 1)
    // was a fresh 200; every resolution since — read/digest reusing it in the
    // same pass, then all three again in the second pass — is a 304 (zero
    // quota). 6 total calls, 1 fresh + 5 revalidations.
    expect(commitHits).toBe(6);
  });
});
