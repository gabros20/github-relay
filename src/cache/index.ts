// The cache layer's single entry point (design §8): createCache(rootOverride?)
// resolves the cache root once and returns every store bound to its
// subpath — mirrors sources/index.ts's createSources shape. Pure local
// persistence: nothing under src/cache/ touches the network.
import * as budgetStore from './budget.ts';
import type { Budget, GraphqlPoints, GrepAppBreaker, RateWindow, SimplePool } from './budget.ts';
import type { EtagRecord } from './etags.ts';
import * as etagsStore from './etags.ts';
import type { CachePaths } from './paths.ts';
import { resolveCachePaths } from './paths.ts';
import type { TarballRecord } from './tarballs.ts';
import * as tarballsStore from './tarballs.ts';
import type { TreeEntry } from './trees.ts';
import * as treesStore from './trees.ts';

export * from './paths.ts';
export * from './store.ts';
export * from './blobs.ts';
export * from './trees.ts';
export * from './tarballs.ts';
export * from './budget.ts';
export * from './etags.ts';
export * from './corpus.ts';

import { getBlob, hasBlob, putBlob } from './blobs.ts';

export interface Cache {
  paths: CachePaths;
  etags: {
    get(url: string): EtagRecord | undefined;
    set(url: string, etag: string, body: string, now?: () => number): EtagRecord;
    getBody(bodyHash: string): string | undefined;
    prune(maxAgeMs: number, now?: () => number): { pruned: number };
  };
  blobs: {
    has(sha: string): boolean;
    get(sha: string): string | undefined;
    put(sha: string, content: string): void;
  };
  trees: {
    has(commitSha: string): boolean;
    get(commitSha: string): TreeEntry[] | undefined;
    put(commitSha: string, entries: TreeEntry[]): void;
  };
  tarballs: {
    has(commitSha: string): boolean;
    get(commitSha: string): TarballRecord | undefined;
    put(commitSha: string, filePath: string, now?: () => number): void;
    gc(maxAgeMs: number, now?: () => number): { removed: string[] };
  };
  budget: {
    load(): Budget;
    save(budget: Budget): void;
    // Matches budget.ts's own updatePool signature: 'graphqlPoints' is the
    // only pool that carries lastCost, but the union isn't narrowed by pool
    // name here either — same shape as the underlying store.
    updatePool(pool: SimplePool, state: RateWindow | GraphqlPoints): Budget;
    updateGrepAppBreaker(state: GrepAppBreaker): Budget;
    updateLearnedCeiling(fragmentWeight: string, batchSize: number): Budget;
  };
}

/** Resolves the cache root once (env override / `~/.ghrelay`) and binds every store to it. */
export function createCache(rootOverride?: string): Cache {
  const paths = resolveCachePaths(rootOverride);

  return {
    paths,
    etags: {
      get: (url) => etagsStore.getEtag(paths.etagsFile, url),
      set: (url, etag, body, now) =>
        etagsStore.setEtag(paths.etagsFile, paths.blobsDir, url, etag, body, now),
      getBody: (bodyHash) => etagsStore.getCachedBody(paths.blobsDir, bodyHash),
      prune: (maxAgeMs, now) => etagsStore.pruneEtags(paths.etagsFile, maxAgeMs, now),
    },
    blobs: {
      has: (sha) => hasBlob(paths.blobsDir, sha),
      get: (sha) => getBlob(paths.blobsDir, sha),
      put: (sha, content) => putBlob(paths.blobsDir, sha, content),
    },
    trees: {
      has: (commitSha) => treesStore.hasTree(paths.treesDir, commitSha),
      get: (commitSha) => treesStore.getTree(paths.treesDir, commitSha),
      put: (commitSha, entries) => treesStore.putTree(paths.treesDir, commitSha, entries),
    },
    tarballs: {
      has: (commitSha) => tarballsStore.hasTarball(paths.tarballsDir, commitSha),
      get: (commitSha) => tarballsStore.getTarball(paths.tarballsDir, commitSha),
      put: (commitSha, filePath, now) =>
        tarballsStore.putTarball(paths.tarballsDir, commitSha, filePath, now),
      gc: (maxAgeMs, now) => tarballsStore.gcTarballs(paths.tarballsDir, maxAgeMs, now),
    },
    budget: {
      load: () => budgetStore.loadBudget(paths.budgetFile),
      save: (budget) => budgetStore.saveBudget(paths.budgetFile, budget),
      updatePool: (pool, state) => budgetStore.updatePool(paths.budgetFile, pool, state),
      updateGrepAppBreaker: (state) => budgetStore.updateGrepAppBreaker(paths.budgetFile, state),
      updateLearnedCeiling: (fragmentWeight, batchSize) =>
        budgetStore.updateLearnedCeiling(paths.budgetFile, fragmentWeight, batchSize),
    },
  };
}
