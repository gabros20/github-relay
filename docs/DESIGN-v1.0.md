# github-relay — Final Consensus Design (v1.0 of the design, targeting tool v0.1)

**Base design:** github-relay (highest combined verdict score). **Grafted:** repo-relay's `plan --probe`, budget forecasting, expected-absence reads, learned batch ceilings, compact-row format, ghid caching, anti-scraping contract; reposift's calibration fixtures, per-signal provenance, ClickHouse one-POST velocity, mandatory B-group fallback chain, `packaged:false` marking, polite-pool mailto UA, min-coverage field, viral-corroboration heuristic. Every fatal flaw from both skeptic panels is resolved or explicitly conceded in §1.

---

## 0. Name + Positioning

**github-relay** — bins `ghrelay` (CLI) + `github-relay-mcp` (shim); npm package `github-relay-mcp`.

A single-user, zero-paid-API, LLM-free Bun/TypeScript CLI (+ thin MCP shim + auto-generated Claude skill) that lets an agent **research GitHub instead of just reading it**. The agent expands natural-language intent into concrete inputs (query shards, candidate ids from its own web research, code-token probes); github-relay casts a 1-point GraphQL wide net, unions candidates from **four discovery lanes**, ranks offline on maintenance/real-usage/star-skeptical signals with explainable, coverage-honest subscores, and deep-reads only 2-3 finalists via a 1-request tarball digest. One free zero-permission fine-grained PAT. Positioning vs agent-reach: **"research GitHub, not read GitHub."**

---

## 1. Fatal-Flaw Resolution Ledger

Every fatal flaw from the verdicts, with its disposition:

| # | Flaw (design it hit) | Resolution |
|---|---|---|
| 1 | **Single-source discovery fails the brief** (github-relay, repo-relay) | RESOLVED. v0.1 ships four discovery lanes: (a) GitHub GraphQL search shards; (b) **`hydrate`** — a new command that ingests owner/repo ids the agent found anywhere (its own WebSearch over HN/Reddit/awesome lists is now a first-class source, and it beats keyword search on exactly the fuzzy flagship intents, as skeptic 2 observed); (c) OSS Insight trending (`search --source trending`); (d) grep.app code-token lane (`code`). Exa/Firecrawl NL lanes remain v0.2 optional-key. |
| 2 | **Fake-star differentiator vestigial at ship** — last-100 starredAt can't see historical campaigns (github-relay); F-group dark in v0.1 (reposift, repo-relay) | RESOLVED. ClickHouse playground velocity moves INTO v0.1: one unauthenticated SQL POST batch-scores lifetime monthly WatchEvent histograms for the entire finalist set → real burstiness (max-month share) at GATE 3. starredAt-100 stays as a secondary sample behind a doctor probe. If ClickHouse is down, F degrades to ratio checks + `f_coverage:"partial"` — visibly, never silently. |
| 3 | **Flagship app-repo use case nullifies differentiators** — B null, C/D renormalized away, score ≈ push recency (github-relay) | RESOLVED three ways: (a) every rank row carries `coverage:"5/7"` + per-group null markers, and rank's stdout header says which groups are missing and which command completes them; (b) the light enrich fragment runs at **25 repos/request** (measured-reliable) and includes `mentionableUsers.totalCount`, so C-lite lands at GATE 2; (c) `packaged:false` is marked explicitly so rank (and the agent) know *why* B is absent; F comes from ClickHouse, which works for app repos. |
| 4 | **Uncalibrated multiplicative penalties mislead on hot repos** (github-relay, repo-relay) | RESOLVED by policy: v0.1 applies score penalties ONLY for objective conditions (archived, deprecation marker) and for high-confidence fake-star combos (burst >0.5 AND engagement-zero). A burst alone → **flag, no penalty**, plus reposift's viral-corroboration downgrade (burst + same-window release + issue influx + fork growth → risk downgraded one level). Calibration fixtures ship in v0.1 as ordering regression tests. |
| 5 | **Scope kills it** (reposift's 16-cmd/8-adapter v0.1) | RESOLVED by construction: 14 commands, 7 adapters — but three adapters are single-endpoint wrappers (ClickHouse = 1 POST, OSS Insight = 1 GET, grep.app = 1 MCP-HTTP client), exactly **one** fallback chain exists in the whole system (B-group: ecosyste.ms → deps.dev → nodata), and v0.1 is internally staged into milestone A (core funnel) and milestone B (forensics + lanes) so a panic-cut loses polish, not the funnel. Tier-1 stargazer-account forensics (empty-profile/default-avatar profiling) is **CUT entirely** — it never had a costed fetch path. |
| 6 | **`stars` histogram mathematically impossible at 1 point** (repo-relay) | RESOLVED. Lifetime histograms come from ClickHouse (free POST); GraphQL only ever samples the last 100 starredAt edges (genuinely 1 point). No command promises pagination-scale data at sample-scale cost. |
| 7 | **Compact rows omit description → GATE-3 waste** (repo-relay) | RESOLVED. Compact row includes `d:` truncated to 90 chars (~18 tokens). Row budget ≈ 50 tokens; the "editor or parser library?" question is answered at GATE 2. |
| 8 | **Recall bet lives entirely in SKILL.md** (repo-relay) | PARTIALLY CONCEDED. `plan --dry/--probe` catches bad shards pre-spend, RESULT_CAP/QUERY_TOO_COMPLEX carry ready-made fixes, and `hydrate` gives a recall path that doesn't depend on shard-writing skill. But the tool still cannot force good decomposition — documented limitation, mitigated, not solved. |

Conceded limitations (documented, not silent): agent that skips `health` ranks on a thinner model (coverage field makes it visible); ClickHouse/OSS Insight/grep.app are no-SLA goodwill services (doctor narrates, `SOURCE_DOWN` + nodata degrade); GH Archive keys events by repo-name-at-event-time so renamed repos show partial velocity (flagged `velocity:"partial-renamed"`); weights ship as research-derived priors, calibration fixtures test ordering stability only.

---

## 2. Architecture

Direct clone of the proven x-relay/youtube-context shell; new GitHub engine inside.

**Three entry points, one command layer** (youtube-context pattern):
- `src/cli.ts` — parseArgs → discriminated-union `ParsedCommand` → `run(argv, sources, stdin)` → `{stdout, exitCode}`.
- `src/mcp-shim.ts` — ~450-line thin stdio server, zod schemas, zero business logic, lazy memoized sources, forced `--quiet`, `compact:true` default, file-writing tools REQUIRE `out` so nothing large transits the model.
- `src/index.ts` — library exports.

**Adapters** (`src/sources/*` — each the ONLY module touching its host; injectable `{fetchImpl, sleep, now, maxRetries}` seams):
- `gh-graphql.ts` — search + aliased-batch enrich + heavy fragments; `rateLimit{cost remaining resetAt nodeCount}` embedded in every query (free); adaptive bisection on 502/504 (halve batch, never blind-retry — timeouts deduct undocumented penalty points for an hour); **learned batch ceiling per fragment weight persisted** in `budget.json` (repo-relay graft); caches new-format `R_kgDO…` node ids, never legacy `MDEwOl…`.
- `gh-rest.ts` — search fallback, trees, readme-raw, contents/blobs, tarball 302-follow, /contributors, /rate_limit. x-relay backoff: read `x-ratelimit-*`, on 429/secondary-403 sleep until reset (or honor `retry-after` exactly), else 1000ms default, maxRetries=3, final failure → `RATE_LIMITED` with `retryAfterMs`. **No `stats/*` endpoints ever** (202-dance avoided; commit velocity via GraphQL `history(since:)`). **Explicit contract: never `raw.githubusercontent.com`, never HTML scraping** (repo-relay graft).
- `ecosystems.ts` — repos + packages lookups + `POST /api/v1/packages/bulk_lookup` (100 purls/call); `User-Agent: github-relay (mailto:t.gabor880312@gmail.com)` → 15,000/hr polite pool.
- `depsdev.ts` — `GET /v3/projects/github.com%2F{o}%2F{r}` (Scorecard), `GetProjectPackageVersions` (repo→purl mapping — the hop reposift hand-waved, done here explicitly), v3alpha `:dependents`.
- `clickhouse-play.ts` — `POST https://play.clickhouse.com/?user=play&default_format=JSON` against `github_events`; one `WHERE repo_name IN (...)` query per finalist set; hard 10s client timeout; failure → `SOURCE_DOWN` → nodata.
- `ossinsight.ts` — `GET https://api.ossinsight.io/v1/trends/repos/?period=…` only (600/hr/IP).
- `grep-app.ts` — MCP-over-HTTP client for `https://mcp.grep.app`; 429 circuit breaker; NL input rejected client-side with `INVALID_INPUT` hint.

**Command layer** (`src/commands/*`) — pure, takes `Sources` by injection. Peek primitives (`--max-chars`, head filters) are command-layer pure functions setting `truncated:true`, never engine-layer. `registry.ts` `CommandDef {name, cost, summary, usage}` is the single source of truth for help, unknown-command guard, and skill generation; **cost is a funnel hint string** ("cheap — the net" / "free — offline" / "expensive — full read").

**Scoring** (`src/score/`) — pure offline: `normalize.ts` (Pike log-saturation), `profiles.ts`, `flags.ts`; TDD'd on plain-object fixtures; `rank` never touches network.

**Envelope/DNA:** `{ok:true,command,data}` / `{ok:false,command,error:{code,message,hint,status?,retryAfterMs?}}`; exit 0/1/2; stdout = envelope only, progress → stderr (`--quiet`, forced over MCP). `guard()` maps engine errors to per-code hints. Expected absence is `ok:true` (missing file → `{content:null, reason:'not in tree', nearest:[…]}`). Fail-loud entry via import.meta.main + realpath (npm-bin-symlink lesson).

**Auth:** `GH_TOKEN`/`GITHUB_TOKEN` env → `gh auth token` shell-out → **fail loudly** with hint (deliberate DNA divergence: 60/hr unauth is unusable; a zero-permission fine-grained PAT is required and documented in doctor).

**Identity rule (one, not three):** corpus keys by canonical `full_name`; each row also stores `ghid` (R_kgDO…). On enrich, a `nameWithOwner` mismatch = rename detected → row re-keyed to the new name, old name kept in `aliases[]`, `renamed:true` flag set (feeds the velocity-partial flag).

**Toolchain:** Bun test + tsup (splitting:false) + Biome + semantic-release/Conventional Commits; `scripts/generate-skill.ts` (18 lines) inlines SKILL.md before every build.

---

## 3. Command Set (14 commands, each with registry cost hint)

1. **`plan <slices...> [--dry] [--probe] [--shard stars|created] [--out queries.txt]`** — *free local / --probe: 1 pt per slice* — validates agent-written slices against GitHub limits (256 chars, 5 AND/OR/NOT → `QUERY_TOO_COMPLEX` with split suggestion); `--probe` spends 1 GraphQL point per slice for `repositoryCount` and auto-expands >1,000-result slices into `created:`/`stars:` shards **iteratively re-probing each shard** until every window is under the cap (fixes repo-relay's naive-split weakness); emits batch-ready queries.txt + estimated point cost.
2. **`search <query> [--source gh|rest|trending] [--limit 30] [--language X --topic Y --stars A..B --created R --pushed R --sort stars|updated] [--fields …] [--out corpus.json]`** — *cheap — 1 GraphQL point per 100 results* — the wide net via `search(type:REPOSITORY, first:100)`, pre-enriched (stars, forks, pushedAt, createdAt, license spdxId, topics, language, archived, description — zero enrichment calls), escapes REST's 30/min pool; sort encoded in query string; `--source rest` fallback; `--source trending` = OSS Insight `/v1/trends/repos`. `RESULT_CAP` error carries a ready-made shard hint.
3. **`batch --file queries.txt --out corpus.json [--delay 2000] [--dry-run]`** — *N points, strictly serialized* — x-relay semantics: `#` comments skipped, 2000ms inter-query delay, `retryAfterMs` replaces delay on RATE_LIMITED, continue-on-error with `perQuery[]`, cross-query dedupe, fresh-wins merge into existing corpus; `--dry-run` = offline limit validation.
4. **`hydrate <owner/repo...> [--out corpus.json] [-]`** — *~1 GraphQL point per 50 ids* — **the multi-source lane**: ingests candidate ids the agent found anywhere (WebSearch → HN/Reddit "best X" threads, awesome lists, blog posts), hydrates them via one aliased GraphQL batch into the corpus tagged `source:"agent"`; `-` reads ids from stdin only when explicitly present. SKILL.md teaches: *for fuzzy intents, run your own web search FIRST and hydrate what humans already curated.*
5. **`code <pattern> [--lang X --repo o/r --path P] [--limit 20]`** — *free — grep.app lane* — code-token/regex evidence search (~1M top repos, license inline); repos found are hydratable. NL input → `INVALID_INPUT` ("code lanes need code tokens; use search for concepts"). REST `/search/code` verification lane is v0.2.
6. **`enrich --in corpus.json [ids...] [--top 50] [--skip-deps] [--stale-ok]`** — *~2-4 GraphQL points per 50 repos + zero-GitHub-quota third parties* — GATE 2: aliased `repository()` **batches of 25** (measured-reliable with the ~15-signal fragment incl. `mentionableUsers.totalCount`, commit `history(since:90d).totalCount`, state-split issue/PR totals, `latestRelease.publishedAt`, `licenseInfo{spdxId,pseudoLicense}`, fundingLinks, watchers, diskUsage); then the **one mandatory fallback chain** for B: ecosyste.ms `bulk_lookup` (repo-level `dependent_repos_count`, downloads, percentiles, `last_synced_at` surfaced as `dataAge`) → deps.dev `GetProjectPackageVersions` + `:dependents` (aggregated across the last 3 versions to dodge the per-version fresh-release undercount) → `packaged:false` + nodata. Writes signals with per-signal provenance `{value, source, fetchedAt}`.
7. **`rank <corpus.json> [--profile build-on|dissect|ideas] [--weights A=25,B=20,…] [--top 20] [--min-score N] [--explain owner/repo] [--jsonl]`** — *free — offline, zero network* — scores from cached signals; compact JSONL rows (~50 tokens, WITH truncated description); `--explain` prints one repo's raw values, per-signal saturation, flags, and full penalty trail; header states coverage ("scored on 6/7 groups; run `health` on finalists to complete C/D"). Re-weighting refetches nothing.
8. **`health <ids...>`** — *1 heavy GraphQL point per ≤10 ids + 1 ClickHouse POST + 1 REST /contributors per id* — GATE 3 consolidation (one command, not three — reduces choreography): heavy fragment (issue close-latency samples last 20 closed with `[bot]` filtered, starredAt-100 sample if the doctor probe says the API is alive), ClickHouse lifetime monthly WatchEvent histogram for the whole set in ONE POST (burstiness, velocity curve, acceleration), `/contributors` top-1 share (bus factor). Auto re-scores C/D/F and updates the corpus + coverage.
9. **`skim <owner/repo> [--max-chars 4000] [--tree-only]`** — *2 REST core calls (cached: 0)* — `trees?recursive=1` (full path/sha/size inventory, `truncated` flag → hint "use digest") + `/readme` raw media type; emits structure summary, CI/test/examples presence booleans, README head with `truncated:true`.
10. **`read <owner/repo> <paths...> [--ref SHA] [--max-chars 6000]`** — *1 REST call per uncached file* — contents raw media type, or blob-by-SHA when tree cached (content-addressed → repeat reads free, flagged `cached:true`); multi-path → array of envelopes, exit 0 only if all ok, serialized; missing path = `ok:true {content:null, nearest:[…]}`.
11. **`digest <owner/repo> [--ref SHA] [--include/--exclude glob] [--max-tokens 20000] [--out digest.md] [--list]`** — *expensive — 1 tarball request (or 0-quota blobless clone)* — GATE 4: pin ref→commit SHA once, tarball via API 302→codeload; if repo `size` >200MB or tarball fails AND git binary present (doctor-detected) → `git clone --depth 1 --filter=blob:none`; local gitingest-style filter (.git, lockfiles, binaries, node_modules, minified) → concatenated tree+contents digest, hard-stopped under `--max-tokens` with steering message; `--out` REQUIRED over MCP; `--list` dry-runs inclusion.
12. **`budget [--forecast 'enrich:2,skim:8,digest:3']`** — *free (+1 free GET /rate_limit)* — all pools from `budget.json` (GraphQL points from embedded rateLimit{}, REST core/search windows, ecosyste.ms, OSS Insight, grep.app breaker state) updated at runtime from headers, never trusted constants; `--forecast` answers "can I afford this plan now".
13. **`doctor [--offline]`** — *free / <15s live (Promise.race)* — ALWAYS `ok:true` with `{healthy, checks[], summary}`: token present+valid, /rate_limit all pools, GraphQL 1-pt round-trip, ecosyste.ms polite pool, deps.dev, ClickHouse reachability, grep.app circuit, **stargazer-starredAt feature probe** (contested 2026-06-30 restriction), git binary presence, cache dir writable. Failing check = data, not error.
14. **`cache stats|clear|gc [--older-than 30d] [--confirm]`** — *free, local* — etag/blob/tarball/corpus store sizes + hit rates; `clear` without `--confirm` → `CONFIRMATION_REQUIRED`.

---

## 4. Data-Source Plan + Rate-Budget Math

**Sources (v0.1, all free, one credential total):**

| Source | Endpoint | Limit | Role |
|---|---|---|---|
| GitHub GraphQL | api.github.com/graphql | 5,000 pts/hr (own pool) | discovery net + all enrichment; search 1pt/100; light batch 25 repos/1pt; heavy 10/1-2pt |
| GitHub REST core | api.github.com | 5,000/hr | skim/read/digest/contributors only; search fallback |
| ecosyste.ms | packages./repos.ecosyste.ms | **15,000/hr** (mailto UA) | B-group primary: bulk_lookup 100 purls/call, dependent_repos_count, downloads, percentiles |
| deps.dev | api.deps.dev | keyless, caching expressly permitted | B fallback + OpenSSF Scorecard per-check (E-group) + repo→purl mapping |
| ClickHouse playground | play.clickhouse.com `github_events` | free, no SLA | F-group: lifetime star histograms, 1 POST per finalist set |
| OSS Insight | api.ossinsight.io/v1 | 600/hr/IP | trending discovery lane; velocity fallback |
| grep.app | mcp.grep.app | free, no SLA | code-token evidence lane |
| Agent's own web search | (via `hydrate`) | agent-side | fuzzy-intent recall lane |

**Deferred:** Exa `category:"github"` (1,000/mo free, optional key) + Firecrawl (~500 searches/mo) NL lanes → v0.2; REST code search (9/min, scarcest resource) → v0.2 verification lane only. **Never:** raw.githubusercontent.com, github.com HTML scraping, hosted gitingest/repomix, Libraries.io (key-gated 60/min), Sourcegraph (unverifiable).

**One full session** (intent → 2-3 digested repos):

| Gate | Work | Cost |
|---|---|---|
| 0 plan | probe 6 slices | 6 GraphQL pts |
| 1 net | 8 shards batched + 1 trending GET + hydrate 20 agent-found ids | 9 GraphQL pts, 1 OSS Insight |
| 2 enrich | 50 candidates @ 25/batch + 1 bulk_lookup + ~30 deps.dev GETs | 2 GraphQL pts, 31 third-party |
| 3 verify | health on 10 (1 heavy batch + 10 /contributors + 1 ClickHouse POST); skim 8 | 1-2 GraphQL pts, 26 REST core, 1 CH |
| 4 read | digest 3 | 3 REST core |
| **Total** | | **≈18 GraphQL pts of 5,000/hr; ≈30 REST core of 5,000/hr; ≈33 of 15,000/hr ecosyste.ms** |

Headroom >250 sessions/hr. The binding constraints are NOT points: (a) GraphQL 10s execution timeout — handled by 25-light/10-heavy ceilings, adaptive bisection, learned ceilings persisted; (b) secondary limits (900 REST pts/min, 100 concurrent) — handled by strict serialization (2000ms batch delay, serial requests per documented etiquette). ETag 304s are quota-free, so repeat/refresh research converges toward zero cost.

**Agent-visible tokens per session (honest numbers):** plan ~0.3k + G1 ~2.5k + G2 rank ~3k + G3 ~1.5-2k × 8 skims + health ~1k ≈ **12-20k total before digests**, every single call under the 25k tool-output ceiling with truncation steering ("showing 30 of 412; --limit or slice by created:").

---

## 5. Scoring Model

**Normalization:** Pike log-saturation per signal — `n(S,T) = log(1+S)/log(1+max(S,T))` — the OpenSSF criticality-score template (zero star inputs; contributors + dependents carry the highest weight there).

**Seven groups, each with fetch path and gate:**

- **A Maintenance** *(GATE 2, light batch)*: days-since-push inverted T=365; commits last 90d via `history(since:){totalCount}` T=250; release recency via `latestRelease.publishedAt` T=730d (**never `releases.totalCount`** — falsely returns 0).
- **B Real usage** *(GATE 2, zero GitHub quota)*: ecosyste.ms `dependent_repos_count` T=1000 → deps.dev `:dependents` aggregated over last 3 versions T=1000 → nodata; downloads percentile; `packaged` binary; forks T=2000. `dataAge` from `last_synced_at` in provenance AND in the compact row when >90d stale.
- **C Community** *(C-lite at GATE 2: `mentionableUsers.totalCount` T=100; completed at GATE 3)*: 1 − top-contributor commit share from `/contributors` (top-1 >0.8 → `single-maintainer` flag); org-owned bonus +0.1.
- **D Responsiveness** *(GATE 3 heavy)*: closed/(open+closed) issues 90d (GraphQL state-split, unlike REST's conflated `open_issues_count`); median close latency of last 20 closed issues T=14d inverted, `[bot]` filtered.
- **E Quality proxies** *(GATE 2 partial: description/topics/homepage present + Scorecard Maintained/CI-Tests/Code-Review via deps.dev, absent = unknown never bad; GATE 3 skim completes: CI workflow file, test dirs, README install/usage/example headings + code blocks)*.
- **F Popularity-validity** *(never raw stars)*: stars-per-month-of-age log-blend; at GATE 3, ClickHouse lifetime monthly histogram → burstiness (max-month share), velocity consistency, acceleration; starredAt-100 recent-span as secondary sample when the API is alive; forks/stars ratio sanity ∈ [0.005, 0.5].
- **License = CLASSIFICATION METADATA, never a filter**: permissive (MIT/Apache-2.0/BSD/ISC) / weak-copyleft (MPL/LGPL) / strong-copyleft (GPL/AGPL) / none / custom (`spdxId:NOASSERTION` + `pseudoLicense:true`, e.g. Zed); always reported in every row; weighted only where the profile says.

**Profiles (weights sum 100):**
- `build-on` (default): A25 B20 C15 D10 E10 F10 L10 (permissive=10, weak=7, strong=4, none=1 — reported, never excluded).
- `dissect`: E40 Structure15 (source-file share, tree depth sanity, diskUsage 1MB..500MB band, from skim) A5 B10 C10 D5 F10 L0.
- `ideas`: Recency30 (created<18mo + push recency) F25 E20 Novelty15 (not-fork, not-template, low topic overlap with corpus siblings) B+C10 L0.

**Missing data = renormalization + honesty, never zero:** absent groups renormalize remaining weights, appear in `nodata[]`, and every row carries **`coverage:"5/7"`** (both skeptics' demand) — app-type repos (the macOS-editor flagship) are never crushed for lacking dependents, and a 4/7 score is visibly not a 7/7 score.

**Fake-star handling (StarScout-derived, calibration-gated severity):**
- Flags always; penalties only when objective or corroborated:
  - archived/disabled ×0.2 + flag (objective)
  - deprecation marker in description/README ×0.5 + flag (objective)
  - burstiness >0.5 (age >6mo) **AND** (contributors+issues+PRs)≈0 with stars>500 → ×0.5 + `possible-fake-stars` (high-confidence combo)
  - burstiness >0.5 alone → `star-burst` flag, **no penalty**, and the viral-corroboration check (burst month coincides with a release + issue influx + fork growth → risk downgraded to `likely-viral`)
  - forks/stars outside [0.005,0.5] → `ratio-anomaly` flag
  - age<30d with stars>500 → `too-new-for-stars` flag only
- Raw stars never rank; they gate the wide net and feed derived signals only.
- **CUT:** stargazer-account profiling (empty-profile/default-avatar shares) and ClickHouse low-activity-actor self-joins — no costed fetch path / query-limit-hostile at exactly the repo sizes where it matters.

**Explainability contract:** every ranked row = `{r, s, subs:{A..F,L}, coverage, d (90-char description), st, vel, dep, lic, push, f[], nodata[]}` ≈ 50 tokens; full-fidelity `{raw, provenance:{signal→{source,fetchedAt}}, penalties[]}` lives in the corpus; `--explain owner/repo` prints the complete saturation + penalty trail. Re-rank with `--weights` = zero network, zero refetch.

**Calibration (v0.1, grafted from reposift):** `fixtures/calibration/` with ~30 hand-labeled known-good/known-junk repos per profile, run as ordering regression tests (known-good must outrank known-junk; flags must fire on the junk set). Real-world weight tuning after a week of use — documented as such.

---

## 6. The Agent Funnel

SKILL.md leads with the funnel and three golden rules: **"NEVER deep-read code during exploration"**, **"the agent expands intent; the tool executes slices"**, and **"for fuzzy intents, web-search first and `hydrate` what humans curated."**

- **GATE 0 — plan** (free / 6 pts with --probe, ~0.3k tokens): NL intent → 3-6 shards (`markdown editor language:swift stars:>50`, `topic:markdown topic:macos pushed:>2025-07-01`); validate + probe counts; RESULT_CAP caught pre-spend.
- **GATE 1 — wide net** (~9 pts, ~2.5k tokens): `batch` the shards + `search --source trending` + agent WebSearch → `hydrate` 10-30 curated ids + optional `code "NSTextLayoutManager("` probe → 100-500 deduped candidates in the corpus. Agent reads nothing but the summary.
- **GATE 2 — enrich + rank** (~2 pts + third parties, ~3k tokens): `enrich --top 50` then `rank --profile build-on --top 20` → 20 fifty-token rows with subscores, coverage, flags, and descriptions. Agent shortlists ~8 from scores + flags + descriptions, not code. Re-weights cost 0.
- **GATE 3 — verify** (1-2 pts + 26 REST + 1 CH POST, ~12-16k tokens): `health id1..id8` (completes C/D/F, burstiness, coverage→7/7), `skim` each survivor (tree + README head). Cut to 2-3.
- **GATE 4 — deep read** (1 request per survivor, ~0.2k tokens stdout): `digest --max-tokens 20000 --out digest.md` at pinned SHA; agent Reads only the slices it needs, or targeted `read` (repeat reads free, `cached:true`).

Registry cost hints steer at the moment of choice; every truncation carries a steering message.

---

## 7. Extraction Ladder (cheapest → dearest)

0. Local content-addressed cache hit (blob/commit SHA) — zero network.
1. ETag 304 revalidation — zero quota (the single biggest quota multiplier; default refresh path).
2. `trees?recursive=1` — full inventory (path/sha/size) in ONE call (100k entries/7MB, `truncated` flag → digest fallback) + 1 `/readme` raw = 2-request skim.
3. Per-file `contents` raw media type / `git/blobs/{sha}` (immutable → cache forever; refresh = diff tree SHAs, fetch only changed blobs).
4. `tarball/{ref}` — 302 → codeload, 1 API request for a whole-repo snapshot at pinned SHA.
5. `git clone --depth 1 --filter=blob:none` — 0 REST quota; fallback for >200MB or tarball failure, feature-detected.
- **Never:** raw.githubusercontent.com, HTML scraping, hosted gitingest/repomix.

---

## 8. Cache / Archive Design

`~/.ghrelay/` (`GHRELAY_CACHE_DIR` override), atomic temp-file+rename, load-never-throws:

- `etags.json` — URL → {etag, body-hash}; conditional GETs by default.
- `blobs/` — content-addressed by git blob SHA (immutable).
- `trees/` — keyed by commit SHA; staleness = 1 conditional ref re-resolve.
- `tarballs/` — by commit SHA (never by archive checksum — those changed Jan 2023).
- `budget.json` — per-pool sliding windows from live `x-ratelimit-*`/`rateLimit{}` headers + learned GraphQL batch ceilings per fragment weight.
- `corpora/*.json` — `{schema:'github-relay/corpus@1', intent, generatedAt, queries[], count, repos[]}`; the intent string is stored (repo-relay graft) so tomorrow's follow-up re-ranks yesterday's corpus; fresh-wins merge deduped by canonical full_name with `ghid` + `aliases[]` rename handling; **never persist cursors** — full_name watermarks only. Per-signal `{value, source, fetchedAt}` provenance in every record; rank surfaces `dataAge` when stale.
- TTLs: search ~1 day, metadata ~1 week, blobs/tarballs immutable; ETag revalidation makes TTL expiry near-free.

---

## 9. Error Codes (closed set)

`INVALID_INPUT` (no network spent) · `AUTH_FAILED` (terminal; hint: create zero-permission fine-grained PAT) · `RATE_LIMITED` (+`retryAfterMs` — "read it, don't guess") · `NOT_FOUND` · `QUERY_TOO_COMPLEX` (>5 operators/256 chars; hint: split into batch shards) · `RESULT_CAP` (1,000-cap; hint: slice by `stars:`/`created:` — ready-made shard string included) · `ABUSE_DETECTED` (secondary 403; hint: serialized retry after cooldown) · `SOURCE_DOWN` (no-SLA third party unreachable; signal degrades to nodata) · `CONFIRMATION_REQUIRED` · `UNKNOWN_COMMAND` · `FETCH_FAILED`. Dropped: `FEATURE_DRIFT` (stable API), `STATS_PENDING` (stats/* endpoints not used). Exit 0/1/2; FATAL envelope on top-level rejection.

---

## 10. MVP Cut

**v0.1 — milestone A (core funnel, ship first):** adapters gh-graphql + gh-rest + ecosystems + depsdev; commands search, batch, hydrate, enrich, rank (3 profiles, --weights, --explain, coverage, JSONL), skim, read, digest (tarball + clone fallback), budget, doctor, cache; ETag + blob-SHA + tarball caches; corpus schema @1 with provenance; objective penalties + Tier-0 flags; MCP shim + generated SKILL.md; calibration fixtures; full TDD suite.

**v0.1 — milestone B (forensics + lanes, same release, cut here if schedule slips):** plan (--dry/--probe), code (grep.app lane + circuit breaker), health (heavy fragment + ClickHouse velocity/burstiness + /contributors + viral-corroboration), trending source, starredAt doctor probe + graceful degrade, budget --forecast, learned-ceiling persistence.

**v0.2:** Exa + Firecrawl optional-key NL lanes (parse owner/repo from URLs → hydrate); REST code-search verification lane (9/min spacing); OSS Insight velocity fallback; snapshot-diff velocity (our own cached stargazerCount across sessions) for the post-starredAt world; weight calibration pass from real usage; `compare` side-by-side command if pulled.

**Later / never-unless-pulled:** awesome.ecosyste.ms curation prior; searchcode adapter (beta, circuit-breakered); BigQuery offline batch; stats/* endpoints; Libraries.io. **Never:** hosted gitingest/repomix/uithub calls, Sourcegraph adapter, embeddings/semantic index, any LLM dependency, HTML scraping.

---

## 11. Testing Approach

TDD mandatory (house DNA): 1:1 test files mirroring src; behavior-only ("if tsc or Biome would catch it, don't test it"). `makeFakeSources(cfg)` records calls + configurable throws; all network confined to `src/sources/`; shape-translation in exported pure normalizers tested on plain-object fixtures. Scoring is pure-function territory: normalizers, profiles, renormalization, flags, penalty trails all fixture-tested. Calibration fixtures = ordering regression suite (known-good > known-junk per profile; flags fire on junk). Bisection logic tested with a fake source that 502s above a configurable batch size. Envelope/exit-code contract tests per command. Live smoke script (doctor + 1-pt search + 1 skim) exists but stays out of CI. Toolchain: Bun test + tsup + Biome (cognitive-complexity 25 → split dispatch) + semantic-release + GitHub Actions.

---

## 12. Risks & Mitigations

1. **starredAt API contested** (reported admin-restricted 2026-06-30; worked live 2026-07-10) — doctor feature-probes; F degrades to ClickHouse histogram (primary anyway) + ratio checks; v0.2 snapshot-diffing is the API-independent endgame.
2. **ClickHouse playground / OSS Insight / grep.app are no-SLA goodwill services** — each is a single-endpoint adapter that degrades to `SOURCE_DOWN` + nodata + coverage drop; none is load-bearing for the core funnel (GATES 1-2-4 run entirely on GitHub + ecosyste.ms/deps.dev).
3. **deps.dev `:dependents` is v3alpha** — B-group primary is ecosyste.ms (stable), deps.dev is the fallback; doctor probes both; if both die, B → nodata with coverage honesty.
4. **ecosyste.ms coverage holes + stale syncs** (react 404'd live; 4-month-old syncs) — fallback chain + `dataAge` surfaced in the compact row (not just provenance) when >90d.
5. **GraphQL 10s-timeout penalty points** (undocumented) — 25-light/10-heavy defaults, adaptive bisection, learned ceilings persisted across sessions; first-502-of-a-new-fragment-shape remains unavoidable (conceded).
6. **Uncalibrated weights** — top/bottom separate reliably (priors from OpenSSF template); mid-field ordering may be wrong until the post-launch calibration pass; `coverage` + `--explain` keep it auditable rather than trusted blindly.
7. **Agent skips `health`** → 5-6/7 coverage rank — visible via coverage field and rank header; not enforceable (conceded).
8. **Fuzzy-intent recall** still bounded by agent skill + hydrate diligence until v0.2 NL lanes (conceded, mitigated by SKILL.md web-search-first recipe).
9. **GH Archive rename bias** — velocity undercounts renamed repos; `renamed:true` (from enrich-detected rename) marks velocity `partial`, no false penalty.
10. **Scope creep** — milestone A/B split inside v0.1 defines the panic-cut line in advance: forensics get cut before the funnel ever does.

---

## 13. Open Questions (for the human)

1. **Calibration labels:** the ~30 hand-labeled good/junk repos per profile need YOUR taste (especially `ideas`). Can you supply ~90 labeled repos, or should v0.1 ship with a smaller author-labeled set (~10/profile) and grow it from real sessions?
2. **Optional keys in v0.2:** are you willing to create free-tier Exa (1,000 searches/mo) and/or Firecrawl accounts for the NL discovery lane, or should v0.2 recall investment go to the agent-WebSearch+hydrate path exclusively?
3. **Penalty severity pre-calibration:** the ×0.5/×0.2 multipliers are research-derived priors. Ship them active (current plan), or ship v0.1 flags-only with penalties enabled by a `--penalties` flag until calibration lands?
4. **PAT policy:** zero-permission fine-grained PATs default to 30-day expiry. Accept a non-expiring PAT (one-time setup, mild security tradeoff), or should doctor nag on expiry-within-7-days?
5. **Name check:** `github-relay` / npm `github-relay-mcp` — confirm availability matters to you enough to pre-register on npm before implementation starts.

---

**Resolution note (2026-07-10):** all five open questions were decided by the author's delegate; the binding answers live in [`PLAN.md → Decisions`](../PLAN.md). Summary: seed calibration set (~10/profile) grown from real sessions; recall investment goes to WebSearch+`hydrate` only (Exa/Firecrawl remain optional-key specs); penalties ship active as designed; non-expiring zero-permission PAT recommended + doctor expiry warning; name is `github-relay` / npm `github-relay-mcp` / bins `ghrelay` + `github-relay-mcp` (all names verified free on npm).
