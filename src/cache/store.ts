// Generic local JSON/raw persistence (design §8): atomic temp-file+rename
// writes, directory auto-create, and a load() that never throws — a missing
// or corrupt file falls back to a caller-supplied default rather than
// crashing a command. Every other cache module builds on these two
// primitives; none of them touches fs directly.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write raw text atomically: a temp file in the same directory, then a
 * rename. A failure on either step (ENOSPC/EACCES on the write, or a rename
 * failure) unlinks the temp file before rethrowing — a half-written `.tmp`
 * must never linger in the cache directory after a failed write.
 *
 * Deliberately no `fsync` before the rename: this is a single-user local
 * cache, not a durability-critical store — every value here is either
 * re-derivable (etags, trees, blobs, budget state) or an agent-authored
 * corpus the agent can re-run to regenerate. A power-loss window between
 * write and rename losing the latest update is an accepted tradeoff against
 * the extra syscall on every write.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created (write itself failed) —
      // an unlink failure here is never the error worth surfacing.
    }
    throw e;
  }
}

/** Read raw text at `path`, or undefined if it doesn't exist / can't be read. */
export function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Read+parse JSON at `path`; on missing OR unparseable, return `fallback`. Never throws. */
export function load<T>(path: string, fallback: T): T {
  const raw = readFileIfExists(path);
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write `data` as pretty JSON, atomically. */
export function save<T>(path: string, data: T): void {
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}
