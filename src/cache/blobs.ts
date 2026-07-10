// Content-addressed local blob store keyed by git blob SHA (design §8,
// extraction ladder step 3): immutable — put() is idempotent for identical
// content, but a write under an existing key with DIFFERENT content means
// the caller has the wrong SHA or corrupted data, and throws loudly rather
// than silently overwriting cached history.
import { join } from 'node:path';
import { EngineError } from '../types.ts';
import { assertHexKey } from './keys.ts';
import { readFileIfExists, writeFileAtomic } from './store.ts';

// Validated here, once, since every CRUD op below goes through this join —
// an unvalidated sha is a path-traversal vector (design review fix wave 2).
function blobPath(dir: string, sha: string): string {
  assertHexKey(sha, 'blob sha');
  return join(dir, sha);
}

export function hasBlob(dir: string, sha: string): boolean {
  return readFileIfExists(blobPath(dir, sha)) !== undefined;
}

export function getBlob(dir: string, sha: string): string | undefined {
  return readFileIfExists(blobPath(dir, sha));
}

/** Idempotent for identical content; throws INVALID_INPUT on a content mismatch. */
export function putBlob(dir: string, sha: string, content: string): void {
  const existing = readFileIfExists(blobPath(dir, sha));
  if (existing !== undefined) {
    if (existing !== content) {
      throw new EngineError(
        'INVALID_INPUT',
        `blob ${sha} is already cached with different content — refusing to overwrite`,
      );
    }
    return;
  }
  writeFileAtomic(blobPath(dir, sha), content);
}
