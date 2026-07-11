// The ONLY module that speaks deps.dev (design §2) — keyless, caching expressly
// permitted. Supplies the B-group fallback (dependents) plus OpenSSF Scorecard
// and the repo→purl hop (projectPackageVersions) that reposift hand-waved.
// project/packageversions are stable v3; :dependents is v3alpha. 5xx →
// SOURCE_DOWN, 404 → NOT_FOUND.
import { thirdPartyJson } from './http.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

const BASE = 'https://api.deps.dev';
const USER_AGENT = 'github-relay';

/** A deps.dev package coordinate: an ecosystem `system` and package `name`. */
export interface PackageKey {
  system: string;
  name: string;
}

export interface DepsDev {
  /** Project record incl. OpenSSF Scorecard, keyed by github.com/owner/repo. */
  project(owner: string, repo: string): Promise<unknown>;
  /** The repo→purl mapping: packages/versions published from this project. */
  projectPackageVersions(owner: string, repo: string): Promise<unknown>;
  /** Aggregate dependents of a specific package version (v3alpha). */
  dependents(pkg: PackageKey, version: string): Promise<unknown>;
}

export type DepsDevDeps = Partial<Seams>;

/** github.com/owner/repo as a single URL-encoded path segment (slashes → %2F). */
function projectKey(owner: string, repo: string): string {
  return encodeURIComponent(`github.com/${owner}/${repo}`);
}

export function createDepsDev(deps: DepsDevDeps = {}): DepsDev {
  const { fetchImpl } = withSeamDefaults(deps);

  const get = (url: string): Promise<unknown> =>
    thirdPartyJson(fetchImpl, 'deps.dev', { url, headers: { 'User-Agent': USER_AGENT } });

  return {
    project: (owner, repo) => get(`${BASE}/v3/projects/${projectKey(owner, repo)}`),
    projectPackageVersions: (owner, repo) =>
      get(`${BASE}/v3/projects/${projectKey(owner, repo)}:packageversions`),
    dependents: (pkg, version) =>
      get(
        `${BASE}/v3alpha/systems/${pkg.system}/packages/${encodeURIComponent(pkg.name)}/versions/${encodeURIComponent(version)}:dependents`,
      ),
  };
}
