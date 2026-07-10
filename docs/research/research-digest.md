# Research Digest — GitHub Deep-Research Tool (10 agents + X sweep, 2026-07-10)

All numbers verified against primary docs or live API probes on 2026-07-10 unless noted. Sources: prime:x-relay, prime:youtube-context, research:{github-rest-search, github-graphql, code-search-alternatives, bulk-datasets, quality-signals, extraction-antiblocking, gap-analysis, agent-tool-design}, plus x-findings.md (xrelay X sweep, 8 queries, 246 unique tweets).

---

## 1. GitHub REST API — endpoints, limits, quotas

### Rate-limit pools (all separate, all reported by free `GET /rate_limit` — costs nothing)
- **Core REST**: 5,000 req/hr authenticated (any free PAT); 60/hr unauthenticated per IP (unusable). Enterprise Cloud apps 15,000/hr.
- **Search** (`/search/repositories` etc.): 30 req/min authenticated; 10/min unauthenticated.
- **Code search** (`/search/code`): ~10 req/min, **auth required**; GitHub docs internally inconsistent (endpoint page 10/min, overview 9/min) — budget 9/min, read `x-ratelimit-*` at runtime.
- **GraphQL**: 5,000 points/hr (separate pool; see §2).
- **Secondary limits**: max 100 concurrent; 900 REST points/min (GET/HEAD=1pt, POST/PATCH/PUT/DELETE=5pt); 80 content-generating req/min and 500/hr; 90s CPU per 60s real time. Enforced adaptively, "may change without notice".
- Headers: `x-ratelimit-limit/-remaining/-used/-reset` (UTC epoch seconds), `x-ratelimit-resource` says which pool was consumed.
- Etiquette (documented, not just courtesy): make requests **serially**; if `retry-after` present wait exactly that; if remaining=0 wait until reset; else wait ≥60s then exponential backoff; ≥1s between mutating requests.
- **Conditional GETs with `If-None-Match` (ETag) returning 304 do NOT count against the primary limit** — the single biggest quota multiplier for a personal tool.

### Search endpoints
- `GET /search/repositories`: params `q` (required), `sort` (stars|forks|help-wanted-issues|updated; omitted = best-match score), `order` (desc default), `per_page` (max 100, default 30), `page`. Result items already embed: full_name, html_url, description, owner, fork, created_at, updated_at, pushed_at, size (KB), stargazers_count, watchers_count, forks_count, open_issues_count, language, topics[], license{key,name,spdx_id}, archived, disabled, visibility, default_branch, score — **zero enrichment calls needed for first-pass ranking**.
- **Hard cap: 1,000 results per query** (page×per_page>1000 → 422); repo search scans at most 4,000 matching repos; `incomplete_results:true` on timeout. Query limits: 256 chars, max 5 AND/OR/NOT operators. Beat the cap by **sharding**: `created:`/`pushed:` date windows, `stars:` ranges, language facets.
- Repo qualifiers: `in:name/description/topics/readme`, `user:`, `org:`, `repo:`, `language:`, `topic:`, `topics:>n`, `license:SPDX` (license:mit, license:apache-2.0), `stars:`/`forks:`/`size:`(KB)/`followers:`/`good-first-issues:>n`/`help-wanted-issues:>n` with `>,>=,<,<=,n..n`, `created:`/`pushed:YYYY-MM-DD` (ranges, optional THH:MM:SS+00:00), `archived:true/false`, `fork:true/only`, `mirror:`, `template:`, `is:public`, `is:sponsorable`, `has:funding-file`.
- `GET /search/code`: **legacy syntax only** (no regex, no `symbol:` — those are web-UI-only), default branch only, files <384 KB, must include ≥1 bare search term (`language:go` alone invalid), forks indexed only if more stars than parent; qualifiers `in:file/path`, `path:`, `filename:`, `extension:`, `language:`, `size:`. `sort` supports only deprecated `indexed`. At ~9-10/min it is the **scarcest resource** — shortlist-verification only, never discovery.
- gh CLI `gh search repos/code` are thin wrappers of the same API: 403s at 1,000-result requests (cli/cli#10426), can't paginate past 1,000 (#9734).

### Enrichment endpoints (core pool)
- `GET /repos/{o}/{r}` — adds subscribers_count, network_count, has_discussions, homepage; follows renames.
- `GET /repos/{o}/{r}/license` — license file + SPDX metadata.
- `GET /repos/{o}/{r}/community/profile` — health_percentage (% of recommended files: readme, license, contributing, code_of_conduct, issue/PR templates, docs); **404s/fails on forks**; content_reports_enabled only for org repos.
- `GET /repos/{o}/{r}/stats/*` — commit_activity (52 weekly counts), participation (owner vs all), contributors (per-contributor weekly adds/dels/commits), code_frequency (422 at 10k+ commits), punch_card. **All return 202 with empty body while a background job computes** — fire early, retry 1-3s, bounded retries; cache invalidates on default-branch push.
- `GET /repos/{o}/{r}/readme` (and `/readme/{dir}`) — raw via `Accept: application/vnd.github.raw+json`; one call, no path guessing, no base64.
- `GET /repos/{o}/{r}/contents/{path}` — base64 JSON ≤1 MB; 1-100 MB only via raw/object media type; >100 MB unsupported; directory listings capped at 1,000 entries (use trees API).
- `GET /repos/{o}/{r}/releases` (per_page max 100), `/releases/latest` (latest non-prerelease non-draft).
- `GET /repos/{o}/{r}/stargazers` with `Accept: application/vnd.github.star+json` → `starred_at` timestamps, 100/page, ~400-page practical depth (~40k stars). **CRITICAL CONFLICT: star-history.com reported GitHub restricted this who-starred-when API to repo admins/collaborators effective 2026-06-30** (gap-analysis agent), while the GraphQL agent fetched `stargazers(orderBy:STARRED_AT)` timestamps live on 2026-07-10 with an OAuth token. Must be re-verified at implementation; design assuming it can vanish (fallbacks: ClickHouse playground, OSS Insight, local snapshot-diffing).
- `GET /repos/{o}/{r}/contributors` — per-contributor commit counts, caps at 500 contributors; top-1 share ≈ bus-factor proxy.
- `GET /repos/{o}/{r}/dependency-graph/sbom` — REST SBOM, stabler than GraphQL's preview dependencyGraphManifests.
- **No official API for "Used by" dependents** — sources: deps.dev, ecosyste.ms, or scraping `github.com/{o}/{r}/network/dependents` (ToS-gray, markup-fragile).

### Auth
Fine-grained PAT with **zero permissions selected** = read-only on all public repos, full 5,000/hr, works with search + all listed endpoints (default expiry 30 days; non-expiring allowed). Resolution order for the tool: `GH_TOKEN`/`GITHUB_TOKEN` env → `gh auth token` shell-out → unauthenticated degraded fallback with hint "set GITHUB_TOKEN".

---

## 2. GitHub GraphQL — the cheap enrichment backbone (live-verified)

- **5,000 points/hr** per free PAT — a pool fully separate from REST core/search/code_search (confirmed live via /rate_limit). Secondary: 2,000 points/min, 100 concurrent, 90s CPU/60s.
- **Cost formula**: sum requests per unique connection (assume every first/last hits limit), ÷100, round; min 1 point; mutations 5. Node limit: first/last 1-100; ≤500,000 nodes/query.
- Live-measured: 25-repo aliased `repository(owner,name)` batch with ~15 signals = **1 point** (nodeCount 250); `nodes(ids:[100 ids])` light fragment = 1 point; `search(type:REPOSITORY, first:100)` with nested repo fields = 1 point. **Enriching 100 candidates = 2-4 points vs ~300-500 REST calls.**
- **The real constraint is the 10-second execution timeout**, not points: 75-100-repo heavy batches reliably 502; reliable ceilings measured: **50 repos/request light fragment, 10-25 heavy**; 100 ids only with a minimal ~5-field fragment. Timeouts deduct **undocumented penalty points for the next hour** — on 502/504, halve the batch (adaptive bisection), never blind-retry.
- Signals available in one 1-point batch: stargazerCount, forkCount, watchers.totalCount, diskUsage (KB), isArchived/isFork/isMirror, pushedAt/createdAt, licenseInfo{spdxId,name,pseudoLicense}, fundingLinks[] (plain list, free), repositoryTopics(first:N), primaryLanguage + languages(orderBy SIZE), latestRelease{tagName,publishedAt}, hasIssuesEnabled, homepageUrl, description, defaultBranchRef.target.history(since:ISO8601){totalCount} (commit velocity — e.g. tauri 142 commits/3mo), issues/pullRequests(states:OPEN|CLOSED|MERGED){totalCount} (cleanly separated, unlike REST open_issues_count which conflates), issues(states:CLOSED, first:20, orderBy CREATED_AT DESC){createdAt closedAt} (close-latency samples), mentionableUsers.totalCount (contributor proxy; tauri 554, react 1757 — timeout-expensive at scale), stargazers(first:100, orderBy STARRED_AT DESC){edges{starredAt}} (e.g. MarkEdit: 100 stars in 12 days).
- GraphQL `search(type:REPOSITORY)` draws from the GraphQL pool — **escapes REST's 30/min search throttle** and returns candidates pre-enriched (fuses find + first-pass rank into 1 point). Same hard 1,000-result cap (verified: endCursor stops at cursor:1000). **No sort argument** — encode `sort:stars` in the query string; no CODE search type (code search is REST-only).
- Gotchas: `releases.totalCount` can falsely return 0 (tauri: GraphQL 0 vs REST many) — use `latestRelease.publishedAt` for release recency. `dependencyGraphManifests` still works behind preview header `Accept: application/vnd.github.hawkgirl-preview+json` (next.js: 741 manifests) but returned dependenciesCount:0 — unreliable, don't build on it. Legacy node ids (MDEwOl...) trigger deprecation warnings — cache new-format `R_kgDO...` ids. Embed `rateLimit{cost remaining resetAt nodeCount}` in every query at no cost.

---

## 3. Extraction paths & anti-blocking

**Extraction ladder cheapest→dearest**: (0) local content-addressed cache hit (blob/commit SHA) — zero network; (1) ETag 304 revalidation — zero quota; (2) `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` — full file inventory (path, sha, size per entry) in ONE call, limits 100,000 entries / 7 MB, `truncated` flag → fall back to tarball/clone, not subtree paging; + 1 `/readme` call = full repo "skim" in 2 requests; (3) per-file `contents` with raw media type, or `GET /repos/{o}/{r}/git/blobs/{sha}` (≤100 MB base64, immutable SHA-addressed → content-addressed caching + fetch-only-changed-blobs refresh); (4) `GET /repos/{o}/{r}/tarball/{ref}` (or zipball) — 302 → codeload.github.com, **1 API request for a whole-repo snapshot**; public archives also directly at `https://codeload.github.com/{o}/{r}/tar.gz/{ref}` with no API call (per-IP limits); private links expire in 5 min; (5) git protocol shallow/partial clone `--depth 1 --filter=blob:none` + sparse-checkout — **does NOT consume REST quota at all**, no fixed limits, only reactive abuse response; `git fetch` = cheap incremental; (never) HTML-scrape github.com.

- **raw.githubusercontent.com**: ~5,000/hr per IP (community-reported, "not exact"), 429 beyond, **no rate-limit headers**, tokens ignored for public content — opportunistic overflow pool only, never core flow. May 8, 2025 GitHub changelog tightened all unauthenticated limits (HTTPS clone, anon REST, raw downloads) citing scraping; authenticated traffic unaffected.
- GitHub AUP: scraping = extraction outside the API; prohibits "excessive automated bulk activity"; web-UI scraping has triggered persistent 429 IP blocks from heuristics as trivial as an `Accept-Language: zh-CN` header.
- Pin every deep-read to a commit SHA (resolve ref→SHA once); staleness check = one conditional request re-resolving head. Don't key cache on tarball bytes (archive checksums changed Jan 2023); dedupe by content hash after download.
- gitingest / repomix / uithub are all just "tarball-or-clone → ignore-rule filter (.git, lockfiles, binaries, node_modules, minified) → concatenate tree+contents into one LLM blob" — **reimplement locally over our own cached tarball; never call their hosted services**.
- Repo `size` field (KB) pre-checks tarball viability; no documented archive size limit but multi-GB repos may fail; no reliable Range/resume support.

---

## 4. Candidate-generation sources beyond GitHub search

- **grep.app (Vercel-owned)**: free no-auth MCP at `https://mcp.grep.app`, ~1M top public repos; params query (literal or regex via useRegexp), language[], repo, path, matchCase, matchWholeWords; returns repo, path, blob URL, **license inline**, line-numbered snippets. Live-verified: NL queries return zero/noise; code-token queries (`NSTextLayoutManager(`) return high-quality hits — **code-pattern lane only**. Unofficial `grep.app/api/search` JSON endpoint 429'd on a single fetch — use MCP endpoint. No published limits/SLA; long-tail repos invisible.
- **searchcode.com**: pivoted 2025/26 to agent service — MCP `https://api.searchcode.com/v1/mcp`, REST `POST https://api.searchcode.com/api/v1/{tool}`; six tools (code_analyze, code_search, code_get_file, code_get_files, code_file_tree, code_get_findings); free during beta, no key; public GitHub index; run by Ben Boyter. Structural deep-reads without cloning — behind a feature flag + circuit breaker (beta risk).
- **Sourcegraph**: public web search survives (2M+ repos, regex+structural) but relicensed proprietary 2023-06-13, core repo private 2024-08-22, enterprise-only pivot 2025 (~$49/user/mo); free-account API-token viability **unverified** — browser-only escape hatch, no adapter.
- **Exa** (optional key): 1,000 free neural searches/month + $10 starter credits, no card; `category:"github"` filter; overage $7/1k (raised from $5, Mar 2026); best free NL→repo discovery lane.
- **Firecrawl** (optional key): 1,000 free credits/month; /v2/search = 2 credits per 10 results (≈500 free searches/mo); `categories:["github"]` covers repos/code/issues/docs; returns web pages, not repo objects — parse owner/repo from URLs, re-hydrate via GraphQL.
- **Dead ends**: Bing Search API retired Aug 2025; Google Custom Search JSON API closed to new customers (existing sunset 2027-01-01); Brave killed free tier Feb 2026 ($5/mo prepaid, ~$0.003-0.005/query, attribution required); publicwww API paid-only (~$33/mo); SERP dork scraping = CAPTCHA/ToS risk.
- **Two-lane router**: NL/conceptual → Exa/Firecrawl github-category (optional, degrade gracefully); exact code tokens/regex → grep.app MCP + REST code search (repo-scoped confirmation). Never send NL to grep-style engines.
- **Awesome/best-of lists**: awesome.ecosyste.ms indexes list membership (curation prior); best-of-lists projectrank = composite score but only over curated YAML, weekly batch; trackawesomelist.com tracks 500+ lists.

---

## 5. Bulk datasets & third-party signal APIs (all free, mostly keyless)

- **ecosyste.ms** (backbone): **5,000 req/hr/IP anonymous; 15,000/hr "polite pool" just by putting `mailto:you@example.com` in the User-Agent**; free API keys 10k-500k/hr on request; data CC BY-SA 4.0 (caching fine, attribute in output).
  - `repos.ecosyste.ms`: `GET /api/v1/repositories/lookup?url={repo_url}` or `/api/v1/hosts/GitHub/repositories/{owner}%2F{name}`; 286,080,680 GitHub repos indexed; schema: stargazers_count, forks_count, subscribers_count, open_issues_count, pushed_at, archived, fork, language, topics, license, latest_tag_published_at, commit_stats, **embedded OpenSSF scorecard**, last_synced_at. **Coverage holes verified live: facebook/react 404'd while sindresorhus/awesome (481,835 stars) returned fresh** — fallback chain mandatory.
  - `packages.ecosyste.ms`: `GET /api/v1/registries/{registry}/packages/{name}`, `lookup?repository_url=`, and **`POST /api/v1/packages/bulk_lookup` (100 purls/URLs per call)**; schema: downloads + period, dependent_packages_count, dependent_repos_count, docker_downloads_count, **percentile rankings** (downloads/dependents/stars/forks + average), critical flag. Live: npm react = 321,778,145 downloads/month, 2,830,385 dependent repos, 275,174 dependent packages (last_synced_at ~4 months stale — surface metadata age).
  - `summary.ecosyste.ms`: `GET /api/v1/projects/lookup?url=` → unified numeric score + repository/packages/commits/issues objects; un-synced repos return score-0 stubs (**sync-on-demand — enqueue-then-repoll**); score methodology opaque.
  - Anubis anti-bot fronts the HTML doc pages (API paths worked with plain UA) — polite UA is the mitigation.
- **deps.dev (Google)**: no auth, no key, no documented limits (Google API ToS); **"clients are expressly permitted to cache"**; ecosystems npm, Go, Maven, PyPI, Cargo, NuGet, RubyGems. `GET /v3/projects/github.com%2F{o}%2F{r}` → stars, forks, open issues, license, **full OpenSSF Scorecard per-check results**, OSS-Fuzz. **v3alpha `:dependents`**: `GET /v3alpha/systems/{sys}/packages/{name}/versions/{v}:dependents` → dependentCount/direct/indirect (live: react@18.2.0 = 13,420 / 5,210 / 8,457). Also PurlLookupBatch, GetSimilarlyNamedPackages (typosquats), GetProjectPackageVersions (repo→packages). BigQuery mirror `bigquery-public-data.deps_dev_v1` (DependentsLatest etc.) for offline bulk.
- **OSS Insight**: `https://api.ossinsight.io/v1` (v1beta), **no auth, 600 req/hr/IP, 1,000 req/min global**, x-ratelimit headers; collections, `/v1/trends/repos/?period=past_week` (live: 100 rows in 39ms with repo_name/stars/forks/PRs/pushes/total_score), stargazer-history endpoints; built on 10B+ GH Archive events in TiDB. No SLA, beta.
- **ClickHouse playground**: `POST SQL to https://play.clickhouse.com/?user=play` (basic auth play:empty, `&default_format=JSON`) against `github_events` — **7B+-row GH Archive mirror, ~hourly fresh, free, unauthenticated**; one query batch-scores star velocity for all finalists (`WHERE repo_name IN (...)`, WatchEvent counts per week). Vendor demo, no SLA — needs fallback.
- **GH Archive**: hourly gzipped JSON `https://data.gharchive.org/YYYY-MM-DD-HH.json.gz` (since 2011-02-12, 15+ event types incl. WatchEvent); BigQuery `githubarchive` dataset; BigQuery free tier = 1 TB query/month — offline batch only, keep out of runtime path.
- **OpenSSF Scorecard**: weekly scan of ~1M most-critical repos; free REST `https://api.securityscorecards.dev/projects/github.com/{o}/{r}`; BigQuery `openssf:scorecardcron.scorecard-v2(_latest)`; bulk scores omit CI-Tests, Contributors, Dependency-Update-Tool checks. Absent ≠ bad — treat as unknown.
- **OpenSSF criticality_score data**: BigQuery `openssf.criticality_score_cron.criticality-score-v0-latest` + GCS `gs://ossf-criticality-score/`; update cadence unverified — validate max(date) before relying.
- **Libraries.io**: SourceRank, free API key, **60 req/min hard limit**; Tidelift→Sonar acquisition (Dec 2024), scraped/uncurated — optional enrichment behind key config only.

---

## 6. Quality/ranking signals — formulas, weights, fake-star defense

### Established models
- **OpenSSF criticality score (Rob Pike)**: C = (1/Σαᵢ)·Σ αᵢ·log(1+Sᵢ)/log(1+max(Sᵢ,Tᵢ)). Weights/thresholds: created_since α=1 T=120mo; updated_since **α=−1** T=120mo (staleness penalty); **contributor_count α=2 T=5000**; org_count α=1 T=10; commit_frequency (avg/wk last yr) α=1 T=1000; recent_releases α=0.5 T=26; closed_issues (90d) α=0.5 T=5000; updated_issues (90d) α=0.5 T=5000; comment_frequency α=1 T=15; **dependents_count α=2 T=500000**. **Stars are NOT an input.**
- **OpenSSF Scorecard checks** (0-10 each): Maintained, CI-Tests, Code-Review, Contributors (multi-org), License, Packaging, Dependency-Update-Tool, SAST, Fuzzing — readable pre-computed via deps.dev GetProject.
- **CHAOSS Starter Project Health** = 4 metrics: time-to-first-response (~2 business days target), change-request closure ratio, contributor absence factor / bus factor (smallest set making 50% of contributions; ~5 healthy), release frequency (**consistency > rate**).
- **Borges & Valente (JSS 2018)**: stars correlate with forks and real third-party usage; no correlation with age; growth patterns slow/moderate/fast/viral; stars accelerate after releases; org-owned repos get more stars; 3 of 4 devs check stars before adopting.

### Fake stars (StarScout, He et al., ICSE 2026, arXiv:2412.13459)
- ~6.0M suspected fake stars, 18,617 campaign repos, 301K accounts (2019-2024). **15.84-16.66% of repos gaining ≥50 stars in July 2024 ran fake-star campaigns.** Market rate ≈ $0.45/star; "Series A-looking" count ≈ $2,241 on Fiverr (X sweep).
- Signatures: low-activity account = one WatchEvent + ≤1 other event ever (same repo, same day); lockstep = ≥50 accounts × ≥10 repos, ≥25 stars within 30 days; 83.9% of campaign repos had <10 days of activity; 90.4% later deleted; fake stars' promotion effect is 5× weaker than real, positive <2 months, then negative.
- Cheap local red flags: single-month star bursts (burstiness = max-month share of total stars; >0.5 with age >6mo ⇒ suspect); stargazers with empty profiles/default avatars; high stars with no substantive PRs/issues/releases; forks/stars outside [0.005, 0.5]; (contributors+issues+PRs)=0 with stars>500; age <30d with >500 stars.
- **Design law: never rank on raw stars.** Stars only as (a) wide-net threshold and (b) input to derived signals: velocity, burst shape, consistency ratios.

### Proposed composite model (quality-signals agent synthesis)
0-100, Pike log-saturation per signal, weighted groups:
- **A Maintenance**: days-since-push (T=365, inverted), commit-weeks active of last 52 (T=52), release recency (T=730d) — repo object + /releases, 1-2 calls.
- **B Real usage**: dependents_count (T=1000, log), package-published binary, forks (T=2000) — deps.dev/ecosyste.ms, zero GitHub quota.
- **C Community resilience**: contributor_count (T=100), 1 − top-contributor commit share (top-1 >0.8 ⇒ single-maintainer flag), org-owned bonus — 1 /contributors call.
- **D Responsiveness/hygiene**: closed/(open+closed) issues 90d, median first-response on 10 recent issues (filter `[bot]` logins), PR closure ratio.
- **E Quality proxies**: CI workflow present, test dirs, community-profile health_percentage, README section heuristics (install/usage/example headings, code blocks, sane badge count), Scorecard Maintained/CI-Tests/Code-Review via deps.dev — trees?recursive=1 + community/profile + deps.dev.
- **F Popularity-validity**: star velocity (stars/age blended with recent-90d sample), burstiness index, consistency checks.
- **Red-flag multiplicative penalties + human-readable flags (never silent exclusion)**: archived/disabled ×0.2; deprecation marker in README/description ×0.5; star-burst + low engagement ×0.5 + "possible fake stars" flag; age<30d + stars>500 flag.
- **License = classification metadata, never a filter**: permissive (MIT/Apache-2.0/BSD/ISC) / weak-copyleft (MPL/LGPL) / strong-copyleft (GPL/AGPL) / none / nonstandard; GraphQL spdxId NOASSERTION + pseudoLicense:true = custom (e.g. Zed). Always reported; weighted only where profile says.
- **Per-profile weights (sum 100)**: `build-on`: A25 B20 C15 D10 E10 F10 License10 (permissive=10, weak=7, strong=4, none=1 — still never filtered). `dissect`: E45 A5 B10 C10 D5 F10 License0, + code-size/structure sanity, recency ~irrelevant. `ideas`: recency-of-creation+push 30 (favor created<18mo), F25, E(docs clarity)20, novelty proxy (low topic overlap/not fork/not template) 15, B+C 10, License0.
- Missing data = "no data" with weight renormalization, NOT zero — app-type repos (macOS editors) lack dependents/downloads entirely. Plan a calibration pass: ~30 hand-labeled known-good/known-junk repos per profile.
- Output must be explainable: score + per-group subscores + raw values + flags[] + profile name in the envelope so the agent can re-weight offline without refetching.

---

## 7. Competitive gap analysis

- **No existing tool combines even three of**: intent → multi-source candidate gen → signal ranking → agent-cheap deep extraction.
- **DeepGit (zamalali)** — closest competitor: LangGraph pipeline (query expansion → ColBERT-v2 semantic retrieval → MiniLM cross-encoder rerank → hardware-aware filter → activity analysis → multi-factor ranking) but Python 3.11+/Gradio web app, **requires a Groq/MiniMax LLM key**, no CLI/MCP, no cache/archive, no envelope. Open source and evolving (DeepGit 2.0 on HF) — speed + cache/etiquette layer are the durable moats.
- **agent-reach** (~23K stars, trending; X sweep): one CLI, zero keys, reads Twitter/Reddit/GitHub/YouTube — but generic read/search, no ranking, no quality model, no funnel. Position against it as "**research** GitHub, not read GitHub".
- **last30days-skill** (mvanhorn): parallel reddit/x/youtube/hn search → one brief; validates "research funnel as a skill"; nobody does it GitHub-deep.
- GitHub official MCP server: search tools are direct wrappers of native search — keyword-only, no ranking. grep.app MCPs: pattern-only. OSS Insight/star-history/Trendshift: analytics on known repos, no intent discovery. best-of/awesome: curated-set-only, batch-updated. gitxray: single-repo security OSINT. Semantic-search projects (sturdy-dev etc.) only embed repos you already have. Firecrawl now ships `firecrawl_research_search_github` — commercial movement into the space, but credit-metered.
- A decade of HN complaints + GitHub community discussion #156390 document unmet demand for better GitHub search.
- Token economy is on-trend (RTK, Headroom; X sweep): compact JSONL ranking output + deep-read-only-finalists is a selling point. Karpathy: LLM-built personal knowledge bases = big token spend → archive/corpus feature has validated demand.
- **LLM-free constraint**: let the calling agent do query expansion (NL intent → concrete search slices) — keeps tool zero-paid-API; strategy lives in SKILL.md.

---

## 8. Design DNA from x-relay (prime read)

x-relay (~/Documents/Personal/Projects/x-relay, npm x-relay-mcp v1.5.0, Bun+TS):
- **Envelope**: `Ok<T> = {ok:true, command, data}`; `Err = {ok:false, command, error:{code, message, hint?, status?, retryAfterMs?}}`; status = upstream HTTP; retryAfterMs only on RATE_LIMITED; built by ok()/err() in src/output.ts; toJson = 2-space pretty print. Exit codes 0 ok / 1 command error / 2 unknown command; top-level rejection prints FATAL envelope, exits 1. **Stdout = envelope only; progress → stderr** (src/progress.ts; --quiet; forced quiet over MCP stdio).
- **Error codes** (closed set): INVALID_INPUT (no network call), AUTH_FAILED, RATE_LIMITED (carries retryAfterMs — "read it, don't guess"), FEATURE_DRIFT, NOT_FOUND, CONFIRMATION_REQUIRED (destructive write without --confirm), UNKNOWN_COMMAND, FETCH_FAILED, BAD_REQUEST. Central `guard(command, fn)` in runners.ts maps EngineError → envelope with per-code hint strings; single `resolveTweetIdOrErr()` so bad refs fail loudly as INVALID_INPUT, never masquerade as empty results.
- **Registry**: src/commands/registry.ts `CommandDef {name, cost, summary, usage}` — single source of truth for CLI help, unknown-command guard, and the skill; **cost is an explicit funnel hint per command** ("cheap — the net" / "1 call" / "expensive — full read" / "free — local files" / "N calls — serialized").
- **Backoff (engine/client.ts)**: on 429 sleep until `x-rate-limit-reset*1000 − Date.now()` else DEFAULT_BACKOFF_MS=1000; maxRetries=3 per status class; final 429 → RATE_LIMITED with retryAfterMs; 401/403 → AUTH_FAILED terminal; fetchImpl/sleep/maxRetries injectable seams.
- **Batch (src/commands/batch.ts)**: newline-delimited query file (# comments/blanks skipped); **strictly serialized, DEFAULT_DELAY_MS=2000** between queries (never after last); continue-on-error with per-query {code,message,retryAfterMs?}; a RATE_LIMITED query's retryAfterMs replaces the normal delay; cross-query dedupe via Map<id>; summary {queries, succeeded, failed, totalUnique, out?, perQuery[]}; **--out MERGES into existing archive** (incremental) while dedupe --out writes FRESH (documented asymmetry).
- **Archive**: `{schema:'x-relay/archive@1', source, generatedAt, count, newestId?, queries?, tweets[]}` — versioned schema tag; mergeArchive prepends newest-first, dedupes by id **fresh-wins** (refreshes mutable metrics); incremental capture: id-watermark stop for monotonic orderings, **MEMBERSHIP STOP (tolerance=3 consecutive known ids)** for non-monotonic; --full ignores knownIds; --prune replaces file.
- **Cache**: ~/.xrelay/<source>.json (XRELAY_CACHE_DIR override), atomic temp-file+rename write, loadCache never throws, DEFAULT_MAX=100000 per sync; lesson: cursors are opaque/short-lived — never persist cursors, use id watermarks. Cache search: pure substring-count relevance, sorts relevance|newest|oldest|likes|views|bookmarks, DEFAULT_LIMIT=20, no embeddings.
- **Context economy**: engagementScore = likes + replies×3 + bookmarks×2; --compact flattens (text ≤280 chars); --fields projection (mutually exclusive with --compact); **MCP defaults compact:true, CLI defaults full**.
- **MCP shim** (475 lines): thin stdio server, zod schemas, zero business logic, wraps same runners over one lazy Engine; isError when !ok; MCP surface read-only; **file-writing tools REQUIRE `out` over MCP** so nothing large streams through the model.
- **Skill gen**: 18-line scripts/generate-skill.ts inlines SKILL.md → src/generated/skill.ts; runs before every dev/build/typecheck/lint/test; SKILL.md ships in npm files[]. Structure: funnel first (GATE 1 cheap wide net → GATE 2 1-call enrich → GATE 3 expensive full read of finalists), then per-command reference with cost, composition notes, error-code table, setup/troubleshooting.
- **Doctor**: `doctor [--offline]` ALWAYS returns Ok with {healthy, checks:[{name,ok,detail}], summary} — failing check is data, not error; live checks under 15s Promise.race; all deps injectable. Motivation: cookie problems, rate limits, and npm-bin-symlink silent exits all looked identical.
- **Fail-loud entry** (src/entry.ts): trust import.meta.main when defined, else realpath comparison; ambiguous+basename match → force-run with stderr warning (naive argv[1] comparison breaks under npm bin symlink → silent exit 0).
- Resilience details: EMPTY_PAGE_TOLERANCE=3; per-record parse errors skipped; archive --full inter-page jitter 400+rand(400)ms; WRITE_DELAY_MS=500 after mutations; rotation only on ROTATE_CODES={RATE_LIMITED, AUTH_FAILED}.
- Lessons docs: rotating upstream values in externalized config with LOUD drift error; parse via deep key-search not hardcoded paths; ARCHIVE-PLAN §9.5's line-by-line second-pass review caught 9 gaps pre-build.
- **Do NOT port**: ~60% of x-relay's engine is X-specific scar tissue (cookie/Keychain decryption AES-128-CBC PBKDF2('saltysalt',1003,16,sha1), transaction-ids, proxies, account pools). Reusable DNA = the outer shell.
- Testing: TDD mandatory, 26 test files mirroring src; behavior-only ("if tsc or Biome would catch it, don't test it"); network confined to engine/; live smoke out of CI. Toolchain: Bun test + tsup (splitting:false) + Biome (cognitive-complexity 25 → split dispatch) + semantic-release/Conventional Commits + GitHub Actions; bins in package.json bin map.

---

## 9. Design DNA from youtube-context (prime read)

youtube-context (npm youtube-relay-mcp v1.2.0):
- **Single-engine rule**: src/youtube.ts is the ONLY module importing the network lib; tiny `Engine` interface {search, getInfo, getTranscript}; commands take Engine by injection; tests use makeFakeEngine(cfg) recording calls + configurable throws; all shape-translation in exported pure normalizers TDD'd on plain-object fixtures.
- **Three entry points, one command layer**: cli.ts (parseArgs → discriminated-union ParsedCommand → run(argv, engine, stdin) returning {stdout, exitCode}), mcp-shim.ts (pure exported runTool dispatcher testable without SDK, lazy memoized engine, zero business logic), index.ts (library exports).
- **Expected absence is ok:true** — no captions = {transcript:null, reason:'no captions'}, never an error envelope.
- **4-gate funnel** (DESIGN-v1.2): GATE1 cheap broad search ranked on free metadata, keep ~10-15; GATE2 1-call-per-candidate info enrich, drop to ~5-8; GATE3 peek (`--head SECONDS` / `--max-chars N`, sets truncated:true); GATE4 full read of survivors. **Golden rule: "NEVER read full transcripts during exploration."** Core rationale: "The tool stays atomic — it exposes signals, filters, and peek primitives. The agent composes the strategy." Dedupe across query fan-out is explicitly the agent's job.
- **Peek primitives are command-layer, not engine-layer**: applyHead/applyMaxChars pure functions over full engine results, compose, set truncated:true.
- **Batch ergonomics**: multi-id positionals → array of envelopes (single stays single, back-compatible); exitCode 0 only if all ok; literal `-` reads whitespace-separated ids from stdin **only when explicitly present** (never block on open pipe). youtube-context uses Promise.all (YouTube tolerates it) — **the GitHub tool must NOT copy this; use x-relay's serialization**.
- No cache/persistence at all (deferred to v1.3, never shipped) — cache DNA comes from x-relay.
- Discipline lesson: YTRELAY_PROXY documented-but-unwired — never describe unimplemented flags.
- Toolchain identical to x-relay; deps only @modelcontextprotocol/sdk + youtubei.js + zod; two bins; engines node>=18.3.

---

## 10. Agent-tool design best practices (Anthropic, mid-2026)

- **Claude Code caps tool output at 25,000 tokens** — every command needs default limits (e.g. search --limit 30), pagination/filtering/truncation with steering messages ("narrowed to top 30 by stars; use --limit or slice by created:").
- `response_format` concise/detailed switch cut Anthropic's Slack-example tokens to ~1/3; MCP → CLI/code-execution with progressive disclosure took one workflow **150,000 → 2,000 tokens (98.7%)**; skills load ~2,500 tokens of descriptions vs ~25,000 of MCP tool definitions — **CLI + generated SKILL.md primary, MCP shim parity only**.
- Errors must be actionable hints, not opaque codes; prefer human-readable ids — 'owner/repo' works as both id and name; avoid numeric node IDs in output.
- Multi-agent research lessons: start wide then narrow (agents default to overly specific queries); each subtask needs objective/output format/tool guidance/boundaries; effort-scaling rules (simple query = 3-10 tool calls); parallelism = 90% time cut at ~15× token cost.
- Industry (Sourcegraph Deep Search GA 6.9, Cursor, Claude Code) abandoned pre-built vector indexes for **just-in-time iterative retrieval over lightweight identifiers** — matches metadata-first funnel.
- Proposed error vocabulary additions for GitHub: RATE_LIMITED (hint: wait retryAfterMs or switch to GraphQL enrich — separate budget), QUERY_TOO_COMPLEX (max 5 operators/256 chars; split into batch variants), RESULT_CAP (hit 1000-cap; slice by stars:100..500 or created: ranges), STATS_PENDING (202; retry ~2s). Drop FEATURE_DRIFT (stable API); consider ABUSE_DETECTED for secondary-limit 403s.
- Proposed command set (agent-tool-design synthesis): `search`, `batch --file queries.txt --out corpus.json`, `rank <corpus> [--weights ...]` (pure offline), `enrich <ids...>` (1 GraphQL batch), `health <id>`, `deps <id>`, `code <query>`, `awesome <topic>`, `peek <id> [--head|--max-chars]`, `read <id> <path...>`, `tree <id> [--depth]`, `dedupe`, `doctor [--offline]`, `cache stats|clear`. Rank rows carry score-breakdown objects for offline re-weighting.

---

## 11. Funnel cost mapping (converged across agents)

- **GATE 1 wide net**: GraphQL `search(type:REPOSITORY, first:100)` (1 point, pre-enriched, escapes 30/min) and/or REST /search/repositories; multi-source union (Exa/Firecrawl NL lane, topics, awesome lists, OSS Insight trending, grep.app probes); shard past 1,000-cap; dedupe by full_name; rank on embedded metadata — **0 enrichment calls**.
- **GATE 2 enrich top ~50**: 1-2 GraphQL light-fragment batches (50/request, 1 pt each) + packages.ecosyste.ms bulk_lookup (100/call) + deps.dev — **~2-4 GitHub points + zero-quota third parties**.
- **GATE 3 peek finalists (~5-10)**: trees?recursive=1 + /readme raw = 2 REST calls per repo ("skim"); heavy GraphQL fragment (10-25/request) for issue latency, stargazer timestamps, mentionableUsers.
- **GATE 4 deep read (2-3 survivors)**: tarball at pinned SHA (1 request) or blobless shallow clone (0 REST quota); local gitingest-style digest; per-file contents/blobs raw.
- Golden rule for SKILL.md: **"NEVER deep-read code during exploration."**
- Per-source budget manager persisted in cache: GitHub search 30/min sliding window, code search 9/min (6s+ spacing), GraphQL points + timeout bisection, core 5,000/hr, ecosyste.ms 15k/hr polite, OSS Insight 600/hr, Exa 1,000/mo, Firecrawl 1,000 credits/mo, grep.app 429-triggered circuit breaker. Cache TTLs: search ~1 day, metadata ~1 week; ETag revalidation as default refresh.

---

## Top 15 design-decisive facts

1. **GraphQL enrichment is ~100-250× cheaper than REST**: 100 candidates fully hydrated in 2-4 points (of 5,000/hr) vs 300-500 REST calls; the binding constraint is the 10s execution timeout (50 light / 10-25 heavy repos per request, 502 → halve batch, never blind-retry — timeouts deduct penalty points for the next hour).
2. **GraphQL `search(type:REPOSITORY)` escapes the REST 30/min search pool** and returns ranking fields in the same 1-point call — the wide net should default to GraphQL, keeping REST search as fallback.
3. **Hard 1,000-results-per-query cap (both REST and GraphQL, verified) + 4,000-repo scan cap + 256-char/5-operator query limits** → breadth requires batch query-sharding (created:/pushed:/stars: slices) with local dedupe — x-relay's serialized batch pattern is essential, not optional.
4. **ETag 304s are rate-limit-free** — an ETag-keyed local cache makes repeat research nearly quota-free; content-address deep-read cache by blob/commit SHA (trees API gives sha+size per path; diff SHAs for incremental refresh).
5. **Raw stars are adversarial**: ~6M fake stars; 16.66% of repos gaining ≥50 stars in July 2024 were in campaigns; $0.45/star market — rank on velocity shape, burstiness (max-month share >0.5 suspect), forks/stars ∈ [0.005,0.5], engagement presence; flags + multiplicative penalties, never silent exclusion.
6. **OpenSSF criticality_score uses zero star inputs** — log-saturation normalization log(1+S)/log(1+max(S,T)) with contributors and dependents weighted highest (α=2) is the proven scoring template; ship named weight profiles (build-on / dissect / ideas) with per-group subscores in output for offline re-weighting.
7. **Stargazer-timestamp access is contested**: reported admin-restricted 2026-06-30 (broke star-history.com) yet GraphQL starredAt worked live 2026-07-10 — re-verify at build time; fallbacks: ClickHouse playground (one free SQL POST batch-scores velocity for all finalists), OSS Insight (600/hr), local snapshot-diffing.
8. **ecosyste.ms is the zero-GitHub-quota metadata backbone**: 5,000/hr anon → **15,000/hr just by putting a mailto in the User-Agent**; bulk_lookup 100 purls/call; embedded Scorecard + dependent_repos_count + download percentiles — but coverage holes are real (facebook/react 404'd live) so the fallback chain (→ deps.dev GetProject → GitHub one-shot) is mandatory.
9. **deps.dev v3alpha `:dependents` is the free "real usage" signal** (react@18.2.0 = 13,420 dependents; no key, caching expressly permitted); dependents exist only for packaged repos — missing data must renormalize weights, not score zero, or app-type repos (the macOS-editor use case) get crushed.
10. **REST code search is the scarcest resource** (~9-10/min, auth required, legacy syntax, default branch, <384 KB): shortlist verification only; wide code-pattern evidence goes to grep.app's free no-auth MCP (mcp.grep.app, ~1M repos, license inline; NL queries verified useless there — two-lane router required).
11. **Whole-repo deep read costs 1 API request (tarball at pinned SHA) or 0 (blobless shallow clone `--depth 1 --filter=blob:none` — git protocol is outside REST quota)**; reimplement gitingest/repomix locally (ignore rules → concatenated digest); never HTML-scrape github.com (AUP + 429 blocks from trivia like an Accept-Language header).
12. **A 2-request repo "skim" exists**: trees?recursive=1 (full inventory, 100k entries/7 MB, truncated flag) + /readme with raw media type — GATE-3 peek costs 2 core calls per finalist.
13. **The niche is empirically open**: no tool combines intent→multi-source→signal-ranking→cheap extraction; DeepGit (closest) needs a paid LLM key and has no CLI/MCP/cache; agent-reach (~23K stars) reads but doesn't rank — positioning is "research GitHub, not read GitHub"; keep the tool LLM-free by pushing query expansion to the agent via SKILL.md.
14. **House DNA transfers wholesale except the engine**: envelope {ok,command,data}/{ok:false,error:{code,message,hint,retryAfterMs}}, exit 0/1/2, stdout-JSON-only, registry with cost tags, guard() error mapping, serialized batch (2000ms default, retryAfterMs-aware), versioned archive with fresh-wins merge, doctor-always-Ok, injectable fetch/sleep seams, 18-line skill generation, entry-symlink detection; x-relay's engine internals (~60% of its code) are X-specific scar tissue — do not port. One deliberate DNA divergence: a free zero-permission fine-grained PAT is required (60/hr unauth is unusable).
15. **Token economy is a product feature**: 25k-token tool-output ceiling, compact rows default over MCP, --fields projection, peek tier (--head/--max-chars with truncated:true), score-breakdown objects enabling re-rank without refetch — and the 150k→2k progressive-disclosure result argues CLI+skill primary, MCP shim parity-only.
