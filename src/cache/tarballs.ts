// Local tarball path registry keyed by commit SHA — never by archive
// checksum, those changed Jan 2023 (design §8, extraction ladder step 4).
// This module only tracks WHERE a downloaded snapshot lives on disk and when
// it was cached; the download itself is wired in a later task that pairs
// this store with gh-rest's downloadTarball.
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { load, save } from './store.ts';

export interface TarballRecord {
  path: string;
  cachedAt: string;
}

type Registry = Record<string, TarballRecord>;

function registryPath(dir: string): string {
  return join(dir, 'index.json');
}

function loadRegistry(dir: string): Registry {
  return load<Registry>(registryPath(dir), {});
}

export function hasTarball(dir: string, commitSha: string): boolean {
  return commitSha in loadRegistry(dir);
}

export function getTarball(dir: string, commitSha: string): TarballRecord | undefined {
  return loadRegistry(dir)[commitSha];
}

export function putTarball(
  dir: string,
  commitSha: string,
  filePath: string,
  now: () => number = Date.now,
): void {
  const registry = loadRegistry(dir);
  registry[commitSha] = { path: filePath, cachedAt: new Date(now()).toISOString() };
  save(registryPath(dir), registry);
}

/** Drop registry entries (and best-effort unlink their files) older than `maxAgeMs`. */
export function gcTarballs(
  dir: string,
  maxAgeMs: number,
  now: () => number = Date.now,
): { removed: string[] } {
  const registry = loadRegistry(dir);
  const cutoff = now() - maxAgeMs;
  const removed: string[] = [];
  for (const [sha, record] of Object.entries(registry)) {
    if (Date.parse(record.cachedAt) >= cutoff) continue;
    removed.push(sha);
    delete registry[sha];
    if (existsSync(record.path)) {
      try {
        unlinkSync(record.path);
      } catch {
        // A missing/locked file shouldn't block gc — best-effort only.
      }
    }
  }
  if (removed.length > 0) save(registryPath(dir), registry);
  return { removed };
}
