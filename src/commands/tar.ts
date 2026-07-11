// A minimal POSIX ustar reader (design §3.11 — "Bun/node tar — pick a
// zero-dep or tiny approach"). GitHub's tarball snapshots are plain ustar
// archives (produced server-side by `git archive`), so this ~90-line parser
// is enough for `digest` without adding a runtime dependency. Gzip framing
// is handled by the caller via `node:zlib` (also built-in); this module only
// ever sees the decompressed tar bytes.
//
// GNU long-name entries (typeflag 'L' — the archive's real path exceeds the
// ustar name+prefix budget, ~255 bytes) are handled: the L entry's content
// IS the following header's real path, substituted in place of that
// header's own truncated/placeholder `name` field. Skipping an L entry's
// payload without consuming it (as an earlier version of this parser did)
// silently accepted the next header's wrong, truncated short name instead —
// path corruption, not a loud failure. PAX extended headers (typeflag 'x'/
// 'g') are still unhandled (accepted for v0.1, YAGNI) — real-world repos
// essentially never hit those, and digest's own default excludes
// (node_modules, vendored/minified trees) remove most of the paths that
// would.

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
const GNU_LONGNAME = 'L';

// Deferred (v0.1 YAGNI): GNU tar's base-256 size encoding (the top bit of the
// first size byte set, for files >=8GB in plain octal) is unsupported — only
// ordinary ASCII-octal sizes are read. GitHub's server-side `git archive`
// tarballs never need it in practice; a repo whose files require it would
// already be well past digest's own byte/token caps.
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

/** An L entry's content is the long name, NUL-padded to the next 512-byte boundary — trim the padding. */
function decodeLongName(content: Uint8Array): string {
  let end = content.length;
  while (end > 0 && content[end - 1] === 0) end--;
  return new TextDecoder().decode(content.subarray(0, end));
}

/** Parse decompressed ustar bytes into regular-file entries (directories are consumed but not returned). */
export function parseTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break; // end-of-archive marker

    const name = readString(header, NAME_OFFSET, NAME_LEN);
    const prefix = readString(header, PREFIX_OFFSET, PREFIX_LEN);
    const size = readOctal(header, SIZE_OFFSET, SIZE_LEN);
    const typeflagByte = header[TYPEFLAG_OFFSET];
    const typeflag = String.fromCharCode(typeflagByte ?? 0);

    offset += BLOCK;
    const contentBlocks = Math.ceil(size / BLOCK) * BLOCK;
    // `subarray` is a VIEW, not a copy: it shares `buf`'s underlying
    // ArrayBuffer. As long as digest.ts keeps even one entry's `content`
    // around (post-filtering), the WHOLE decompressed tarball buffer stays
    // retained in memory — not just the bytes for the entries actually kept.
    const content = buf.subarray(offset, offset + size);

    if (typeflag === GNU_LONGNAME) {
      // This entry's payload is the NEXT header's real path — remember it,
      // consume this entry's blocks, and move on without pushing anything.
      pendingLongName = decodeLongName(content);
      offset += contentBlocks;
      continue;
    }

    const path = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
    pendingLongName = undefined; // consumed here whether or not this entry gets pushed

    if (REGULAR_FILE.has(typeflag) && name !== '') {
      entries.push({ path, content, size });
    }
    offset += contentBlocks;
  }

  return entries;
}
