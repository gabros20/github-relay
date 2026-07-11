// Cache root resolution (design §8): `GHRELAY_CACHE_DIR` env override, else
// `~/.ghrelay`. This is the only module that knows the on-disk layout —
// every store module below is handed an explicit file/dir path computed
// here, so tests can point at a throwaway tmp root instead.
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CachePaths {
  root: string;
  etagsFile: string;
  blobsDir: string;
  treesDir: string;
  tarballsDir: string;
  budgetFile: string;
  corporaDir: string;
}

/** `rootOverride` wins, else `GHRELAY_CACHE_DIR`, else `~/.ghrelay`. */
export function resolveCacheRoot(rootOverride?: string): string {
  return rootOverride ?? process.env.GHRELAY_CACHE_DIR ?? join(homedir(), '.ghrelay');
}

export function resolveCachePaths(rootOverride?: string): CachePaths {
  const root = resolveCacheRoot(rootOverride);
  return {
    root,
    etagsFile: join(root, 'etags.json'),
    blobsDir: join(root, 'blobs'),
    treesDir: join(root, 'trees'),
    tarballsDir: join(root, 'tarballs'),
    budgetFile: join(root, 'budget.json'),
    corporaDir: join(root, 'corpora'),
  };
}
