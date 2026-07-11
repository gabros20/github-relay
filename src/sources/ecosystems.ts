// The ONLY module that speaks ecosyste.ms (design §2) — the B-group real-usage
// primary. A polite-pool mailto User-Agent buys the 15,000/hr window. Repo
// lookups hit repos.ecosyste.ms; package usage comes from packages.ecosyste.ms
// bulk_lookup, chunked at 100 purls per POST. Upstream downtime degrades to
// SOURCE_DOWN (nodata), a 404 to NOT_FOUND — the caller decides which is which.
import { thirdPartyJson } from './http.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

const REPOS_BASE = 'https://repos.ecosyste.ms';
const PACKAGES_BASE = 'https://packages.ecosyste.ms';
const USER_AGENT = 'github-relay (mailto:t.gabor880312@gmail.com)';
const BULK_CHUNK = 100;

export interface Ecosystems {
  /** Repo-level usage signals (dependent_repos_count, downloads, last_synced_at) by full_name. */
  repo(fullName: string): Promise<unknown>;
  /** Look up many packages by purl, chunked at 100 per POST; results concatenated in order. */
  bulkLookupPackages(purls: string[]): Promise<unknown[]>;
}

export type EcosystemsDeps = Partial<Seams>;

export function createEcosystems(deps: EcosystemsDeps = {}): Ecosystems {
  const { fetchImpl } = withSeamDefaults(deps);

  function repo(fullName: string): Promise<unknown> {
    return thirdPartyJson(fetchImpl, 'ecosyste.ms', {
      url: `${REPOS_BASE}/api/v1/hosts/GitHub/repositories/${fullName}`,
      headers: { 'User-Agent': USER_AGENT },
    });
  }

  async function bulkLookupPackages(purls: string[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < purls.length; i += BULK_CHUNK) {
      const chunk = purls.slice(i, i + BULK_CHUNK);
      const result = await thirdPartyJson(fetchImpl, 'ecosyste.ms', {
        url: `${PACKAGES_BASE}/api/v1/packages/bulk_lookup`,
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
        body: JSON.stringify({ purls: chunk }),
      });
      if (Array.isArray(result)) out.push(...result);
    }
    return out;
  }

  return { repo, bulkLookupPackages };
}
