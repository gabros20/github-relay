import { describe, expect, test } from 'bun:test';
import { parseTar } from '../../src/commands/tar.ts';

// A minimal ustar writer, TEST-ONLY: builds the exact byte layout GitHub's
// tarball endpoint produces (POSIX ustar, name/prefix split, regular files +
// directory entries), so parseTar can be exercised without any real network.
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

function tarHeader(fullPath: string, size: number, typeflag: string): Uint8Array {
  const header = new Uint8Array(512);
  // Split at 100 bytes: name gets the tail, prefix gets everything before it,
  // mirroring real ustar producers (and GitHub's long `owner-repo-sha/` lead).
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
  header.set(new Uint8Array(8).fill(32), 148); // checksum placeholder (spaces)
  header[156] = typeflag.charCodeAt(0);
  writeString(header, 257, 'ustar');
  header[262] = 0;
  writeString(header, 263, '00');
  writeString(header, 345, prefix);
  const sum = checksum(header);
  const sumStr = `${sum.toString(8).padStart(6, '0')}\0 `;
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

interface FixtureEntry {
  path: string;
  content?: string;
  dir?: boolean;
}

function buildTar(entries: FixtureEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    if (e.dir) {
      chunks.push(tarHeader(e.path, 0, '5'));
      continue;
    }
    const bytes = new TextEncoder().encode(e.content ?? '');
    chunks.push(tarHeader(e.path, bytes.length, '0'));
    chunks.push(pad512(bytes));
  }
  chunks.push(new Uint8Array(1024)); // two zero-blocks = end of archive
  return concat(chunks);
}

describe('parseTar', () => {
  test('extracts regular files with their path and content, skipping directory entries', () => {
    const tar = buildTar([
      { path: 'repo-1234567/', dir: true },
      { path: 'repo-1234567/README.md', content: '# hello' },
      { path: 'repo-1234567/src/', dir: true },
      { path: 'repo-1234567/src/index.ts', content: 'export {}' },
    ]);
    const entries = parseTar(tar);
    expect(entries.map((e) => e.path).sort()).toEqual([
      'repo-1234567/README.md',
      'repo-1234567/src/index.ts',
    ]);
    const readme = entries.find((e) => e.path === 'repo-1234567/README.md');
    expect(new TextDecoder().decode(readme?.content)).toBe('# hello');
  });

  test('empty files (size 0) round-trip with zero-length content and no extra padding block', () => {
    const tar = buildTar([{ path: 'repo-1234567/.gitkeep', content: '' }]);
    const entries = parseTar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.size).toBe(0);
  });

  test('paths beyond the 100-byte name field use the ustar prefix split correctly', () => {
    const longPath = `repo-1234567/${'a'.repeat(30)}/${'b'.repeat(30)}/${'c'.repeat(30)}/file.ts`;
    const tar = buildTar([{ path: longPath, content: 'x' }]);
    const entries = parseTar(tar);
    expect(entries[0]?.path).toBe(longPath);
  });

  test('an empty archive (just the two zero end-blocks) parses to zero entries', () => {
    expect(parseTar(new Uint8Array(1024))).toEqual([]);
  });

  test('a GNU longname (typeflag L) entry supplies the full path for the entry that follows it, never a silently truncated/wrong one', () => {
    // GNU tar's long-name extension: an 'L' entry whose CONTENT is the real
    // path, immediately followed by a real header whose own 100-byte `name`
    // field is a truncated/placeholder stand-in (GNUtar conventionally
    // writes something short there, e.g. the tail of the real name).
    const longPath =
      'repo-1234567/very/deeply/nested/directory/structure/that/exceeds/the/ustar/name/and/prefix/budget/entirely/so/a/GNU/longname/header/is/required/to/represent/it/correctly/file.ts';
    const longNameBytes = pad512(new TextEncoder().encode(`${longPath}\0`));
    const chunks: Uint8Array[] = [
      tarHeader('././@LongLink', longNameBytes.length, 'L'),
      longNameBytes,
      tarHeader('file.ts', 5, '0'), // the header's own name is the wrong, truncated stand-in
      pad512(new TextEncoder().encode('hello')),
      new Uint8Array(1024),
    ];
    const tar = concat(chunks);
    const entries = parseTar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(longPath);
    expect(new TextDecoder().decode(entries[0]?.content)).toBe('hello');
  });

  test('an L entry immediately followed by another L entry does not leak a stale long name past a skipped directory', () => {
    const longPath = 'repo-1234567/a-real-long-name/file.ts';
    const longNameBytes = pad512(new TextEncoder().encode(`${longPath}\0`));
    const chunks: Uint8Array[] = [
      tarHeader('././@LongLink', longNameBytes.length, 'L'),
      longNameBytes,
      tarHeader('somedir', 0, '5'), // a directory entry — consumed, never uses the pending long name
      tarHeader('short.ts', 3, '0'), // a plain, unrelated file right after — must NOT inherit the long name
      pad512(new TextEncoder().encode('abc')),
      new Uint8Array(1024),
    ];
    const tar = concat(chunks);
    const entries = parseTar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('short.ts');
  });
});
