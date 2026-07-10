// Local tree-inventory cache keyed by commit SHA (design §8, extraction
// ladder step 2): the full recursive `{path, sha, size}[]` listing the trees
// API returns, so a re-skim can diff blob SHAs instead of refetching.
import { join } from 'node:path';
import { load, save } from './store.ts';

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

function treePath(dir: string, commitSha: string): string {
  return join(dir, `${commitSha}.json`);
}

export function hasTree(dir: string, commitSha: string): boolean {
  return getTree(dir, commitSha) !== undefined;
}

export function getTree(dir: string, commitSha: string): TreeEntry[] | undefined {
  return load<TreeEntry[] | undefined>(treePath(dir, commitSha), undefined);
}

export function putTree(dir: string, commitSha: string, entries: TreeEntry[]): void {
  save(treePath(dir, commitSha), entries);
}
