// Content-addressing key validation (design §8, review fix wave 2 —
// Important 3). blobs.ts/trees.ts/tarballs.ts all join a caller-supplied key
// straight into a filesystem path (or, for the tarball registry, a plain
// object key). An unvalidated key is a path-traversal vector
// (`../../etc/passwd`) on the fs side and a prototype-pollution vector
// (`__proto__`) on the object-key side — reject anything that isn't a plain
// lowercase git SHA before it touches either.
import { EngineError } from '../types.ts';

// Git SHA-1 (40 hex) or SHA-256 (64 hex, the newer git object format —
// sha256 etag bodies also share the blob store's keyspace, per the accepted
// Minor from the prior review).
const HEX_KEY = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Throws INVALID_INPUT unless `key` is exactly 40 or 64 lowercase hex characters. */
export function assertHexKey(key: string, label = 'key'): void {
  if (!HEX_KEY.test(key)) {
    throw new EngineError(
      'INVALID_INPUT',
      `invalid ${label} ${JSON.stringify(key)}: expected 40 or 64 lowercase hex characters`,
    );
  }
}
