// A minimal POSIX ustar reader (design §3.11 — "Bun/node tar — pick a
// zero-dep or tiny approach"). GitHub's tarball snapshots are plain ustar
// archives (produced server-side by `git archive`), so this ~60-line parser
// is enough for `digest` without adding a runtime dependency. Gzip framing
// is handled by the caller via `node:zlib` (also built-in); this module only
// ever sees the decompressed tar bytes.
//
// Known limitation (accepted for v0.1, YAGNI): only regular files (typeflag
// '0'/NUL) and directories (typeflag '5') are recognized; paths longer than
// the ustar name+prefix budget (~255 bytes) or GNU/PAX long-name extension
// headers are not handled — real-world repos essentially never hit this,
// and digest's own default excludes (node_modules, vendored/minified trees)
// remove most of the paths that would.

export interface TarEntry {
  path: string;
  content: Uint8Array;
  size: number;
}

const BLOCK = 512;
const NAME_OFFSET = 0;
const NAME_LEN = 100;
const SIZE_OFFSET = 124;
const SIZE_LEN = 12;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LEN = 155;

const REGULAR_FILE = new Set(['0', '\0']);

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = buf[offset + i];
    if (c === undefined || c === 0) break;
    s += String.fromCharCode(c);
  }
  s = s.trim();
  return s === '' ? 0 : Number.parseInt(s, 8);
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && buf[end] !== 0 && buf[end] !== undefined) end++;
  return new TextDecoder().decode(buf.subarray(offset, end));
}

function isZeroBlock(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/** Parse decompressed ustar bytes into regular-file entries (directories are consumed but not returned). */
export function parseTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break; // end-of-archive marker

    const name = readString(header, NAME_OFFSET, NAME_LEN);
    const prefix = readString(header, PREFIX_OFFSET, PREFIX_LEN);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, SIZE_OFFSET, SIZE_LEN);
    const typeflagByte = header[TYPEFLAG_OFFSET];
    const typeflag = String.fromCharCode(typeflagByte ?? 0);

    offset += BLOCK;
    const contentBlocks = Math.ceil(size / BLOCK) * BLOCK;

    if (REGULAR_FILE.has(typeflag) && name !== '') {
      entries.push({ path, content: buf.subarray(offset, offset + size), size });
    }
    offset += contentBlocks;
  }

  return entries;
}
