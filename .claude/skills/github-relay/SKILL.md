# github-relay

**"Research GitHub, not read GitHub."** A zero-paid-API, LLM-free CLI (`ghrelay`) + MCP server
(`github-relay-mcp`) + this skill. You expand a natural-language intent into concrete inputs
(query shards, candidate ids from your own web research, code-token probes); github-relay casts
a wide net across four discovery lanes, ranks offline on maintenance/real-usage/star-skeptical
signals with explainable, coverage-honest subscores, and deep-reads only the 2–3 finalists. One
free zero-permission fine-grained PAT. No paid API keys, ever.

## Three golden rules

1. **NEVER deep-read code during exploration.** Rank on cheap metadata first; `digest`/`read`
   only the finalists that survive `rank` and `health`.
2. **The agent expands intent; the tool executes slices.** You decompose "editor for markdown
   on macOS" into query shards, candidate ids, and code-token probes — github-relay never guesses
   intent for you, and never silently narrows a slice you didn't ask it to.
3. **For fuzzy intents, web-search first and `hydrate` what humans curated.** Keyword search
   loses on flagship/niche intents that "best X" threads, awesome lists, and blog posts already
   solved. Your own WebSearch is a first-class discovery lane — feed its owner/repo ids straight
   into `hydrate`.

---

## The funnel

```
GATE 0 — plan                     free local / --probe: 1 pt/slice, capped by --max-probes (30)
  ghrelay plan "topic:markdown language:swift stars:>50" "topic:notes topic:macos" --probe
  → validates each shard (256 chars / 5 AND·OR·NOT operators) before anything else runs;
  --probe spends 1 point per shard to check its result count and auto-splits anything over
  the 1,000-result cap into stars:/created: shards, RE-PROBING each one until every leaf
  fits (or is reported with a manual-narrowing hint — never silently dropped). Auto-sharding
  can multiply "1 point per slice" into many more — the whole call is capped by a total
  probe-point budget (default 30, override with --max-probes N); hitting it stops probing
  and reports the unprobed remainder the same hint-bearing way, never silently.

GATE 1 — wide net                 cheap: search / batch / hydrate / code
  ghrelay batch --file shards.txt --out corpus.json
  ghrelay hydrate <owner/repo...> --out corpus.json     # from YOUR web search — see rule 3
  ghrelay code "NSTextLayoutManager(" --lang Swift       # optional: code-token evidence probe
  → 100-500 deduped, pre-enriched candidates in the corpus. Read nothing but counts yet.

GATE 2 — enrich + rank            ~2-4 GraphQL pts + zero-quota third parties, then free
  ghrelay enrich --in corpus.json --top 50
  ghrelay rank corpus.json --profile build-on --top 20
  → 20 fifty-token rows: score, 7 subscores, coverage, flags, truncated description. Shortlist
  ~8 from THIS, not from code. Re-weighting (`--weights`) costs 0 — refetches nothing.

GATE 3 — verify                   1-2 GraphQL pts + 1 ClickHouse POST + N REST, then skim
  ghrelay health <ids...> --in corpus.json  # completes C/D/F: latency, burstiness, bus factor
  ghrelay skim <owner/repo>       # tree inventory + README head, 2 REST calls (cached: 0)
  Run `health` on the ~8 shortlisted finalists (coverage → 7/7 where B is present), then `skim`
  the survivors. Cut to 2-3 on structure + README signal + the completed C/D/F subscores.

GATE 4 — deep read                expensive: digest / read
  ghrelay digest <owner/repo> --max-tokens 20000 --out digest.md
  ghrelay read <owner/repo> <path...>     # targeted; repeat reads are free (cached:true)
  → Read only the digest slices you actually need.
```

Every command's help/registry cost hint tells you what it spends BEFORE you run it — cheap
discovery always happens before expensive extraction. Every truncation carries a steering
message (e.g. "showing 30 of 412 — use --limit or slice by created:").

---

## Commands (atomic reference)

All commands print a JSON envelope to stdout: `{ok, command, data}` on success,
`{ok:false, command, error:{code, message, hint, status?, retryAfterMs?}}` on failure.
Exit codes: 0 ok, 1 command error, 2 unknown command. Over MCP, every tool forces `--quiet`
(no stderr progress) and `--compact` (single-line JSON) — you never need to pass either.

### `plan` — free local / --probe: 1 pt/slice, capped by --max-probes. GATE 0, validate before you spend.
```
ghrelay plan <slices...> [--dry] [--probe] [--shard stars|created] [--max-probes 30]
       [--out queries.txt]
```
- Positional slices (also `-` for newline-separated stdin, `#` comments skipped). Default (and
  `--dry`, an alias) validates every slice OFFLINE — the same 256-char / 5-`AND`/`OR`/`NOT`-
  operator limits `search`/`batch` enforce — zero network, so bad shards are caught before
  anything is spent.
- `--probe` spends 1 GraphQL point per slice on a `repositoryCount`-only probe (serialized,
  500ms apart by default — a `RATE_LIMITED` probe's own `retryAfterMs` REPLACES that delay
  before the next one, same as `batch`). A slice over the 1,000-result cap is auto-sharded on
  `--shard` (default `stars`, else `created`) and EVERY shard is re-probed — a shard still over
  the cap recurses again (up to 5 levels deep), never a naive one-shot split. A slice that
  already carries a `stars:`/`created:` qualifier is narrowed WITHIN that range (never a
  contradictory second qualifier); if the active dimension can't be split further, plan falls
  back to the other one; if both are exhausted (or the depth cap is hit), the leftover shard is
  still returned with a `count` and a manual-narrowing `hint` — never silently dropped.
- **Total probe-point budget**: auto-sharding can multiply "1 point per slice" into far more —
  the whole `--probe` call is capped at `--max-probes` points (default 30). Hitting it stops
  probing immediately; everything already completed (including a paid-for top-level count)
  stands, and the unprobed remainder — whole slices or mid-recursion shards alike — comes back
  as hint-bearing leaves (`"probe budget exhausted at N points; re-run with --max-probes or
  narrow slices"`), never silently dropped, never spent past the cap.
- **Per-probe failure isolation**: a single probe failing (`RATE_LIMITED`, transient network,
  ...) never discards the rest of the slice. It isolates to its own leaf (carrying `error:
  {code, message, retryAfterMs?}` plus a retry hint); every sibling/ancestor shard that already
  completed — the slice's own top-level count included — stays in the result and in `queries[]`.
  The slice stays `ok:true`; `failures[]` lists every probe that failed this way.
- Output: `{slices: [{slice, ok, count?, shards?: [{query, count?, hint?, error?}], error?,
  failures?}], queries, estimatedPoints, pointsSpent}` — `queries` is the flat, batch-ready list
  (valid slices as-is offline, or their probed/sharded leaves with `--probe`, budget-cutoffs and
  failed shards included); `estimatedPoints` forecasts what running `queries` through `batch`
  would cost, `pointsSpent` is what `plan` itself actually spent probing (failed probes don't
  count — they never spent a real point). `--out queries.txt` writes that list batch-compatible
  (one query per line, `#` header) — feed it straight into `batch --file queries.txt --out
  corpus.json`.

### `search` — cheap, 1 GraphQL point per 100 results (1 OSS Insight GET for trending). The wide net.
```
ghrelay search <query> [--source gh|rest|trending] [--period 24h|week|month] [--limit 30]
       [--language X --topic Y --stars A..B --created R --pushed R --sort stars|updated]
       [--fields a,b,c] [--out corpus.json]
```
- One `search(type:REPOSITORY, first:100)` page (or `--source rest` fallback), pre-enriched —
  stars, forks, pushedAt, createdAt, license, topics, language, archived, description — zero
  extra calls.
- `--source trending`: OSS Insight's currently-trending repos (`--period`, default `week`;
  `--language` accepts at most one, since OSS Insight filters by a single language). No free-text
  query or GH qualifier flags (`--topic`/`--stars`/`--created`/`--pushed`/`--sort`) apply here —
  those are `INVALID_INPUT` for this source; use `--source gh` for query-shaped search. Rows tag
  `source:"trending"` with no GraphQL node id yet (same as `code`'s hits) — `hydrate` them for a
  real `ghid`. Counts against the `ossinsight` pool (600/hr/IP), visible in `budget`.
- Without `--out`: prints compact rows (or `--fields` projects just those columns). With
  `--out`: merges into the corpus (fresh-wins) and returns a `{count, merged, out}` summary
  instead — **over MCP, `out` is REQUIRED**, so a big result page never transits the model.
- `RESULT_CAP` (>1,000 results) carries a ready-made `stars:`/`created:` shard-split hint
  (`--source gh`/`rest` only — trending has no result-count cap to hit).

### `batch` — N points, strictly serialized. Many shards → one deduped corpus.
```
ghrelay batch --file queries.txt --out corpus.json [--delay 2000] [--dry-run]
```
- One query per line (`#` comments and blank lines skipped). Runs serialized with `--delay`
  ms between queries (a `RATE_LIMITED` `retryAfterMs` REPLACES the delay for that gap),
  continue-on-error with a `perQuery[]` ledger, cross-query dedupe by `full_name`, incremental
  merge into `--out` (safe to re-run to top up the same file). `--dry-run` validates every
  query's shape offline (256 chars / 5 operators) — zero network, no `--out` needed.

### `hydrate` — ~1 GraphQL point per 50 ids. The multi-source lane (golden rule 3).
```
ghrelay hydrate <owner/repo...> [--out corpus.json] [-]
```
- Ingest candidate ids YOU found anywhere — your own WebSearch over HN/Reddit "best X" threads,
  awesome lists, blog posts — hydrated via one aliased GraphQL batch, tagged `source:"agent"`
  in the corpus. `-` reads newline-separated ids from stdin (only when explicitly present).
  Per-id failures are soft (`failed[]`); shape validation is a hard `INVALID_INPUT` pre-flight.

### `code` — free, grep.app lane. Code-token/regex evidence, GATE 1 (optional).
```
ghrelay code <pattern> [--lang X --repo o/r --path P] [--limit 20] [--literal] [--out corpus.json]
```
- `pattern` must be an actual code token or regex, NOT natural language — `useState(`,
  `import React from`, `(?s)try {.*await`. The rejection heuristic is deliberately biased toward
  letting things through (a false accept just costs one cheap grep.app call; a false reject
  blocks a legitimate search): a punctuation-free pattern is rejected client-side with
  `INVALID_INPUT` only when it has 6+ plain lowercase words, OR looks question-shaped (contains
  how/what/why/where/when/should/"best way"/"can i") — a real multi-word literal like `failed to
  connect to database` (5 words, no question shape) passes straight through. The hint always
  names the escape: `"code lanes need code tokens; use search for concepts — if this is a
  literal code string, re-run with --literal"`. `--literal` bypasses the heuristic entirely for
  anything it still gets wrong — zero network spent either way when rejected. `--lang`
  (repeatable), `--repo`, `--path` filter grep.app's index (~1M top repos, license inline);
  `--limit` defaults to 20, capped at 100 (grep.app's own tool has no server-side limit, so this
  command truncates client-side).
- Without `--out`: prints hit rows `{repo, path, line, snippet (truncated ~200 chars), lang?,
  license?}` plus a `repos` footer — the distinct, sorted owner/repo ids the matches touched.
  **Hydrate-ready, never auto-hydrated**: pipe `repos` straight into `hydrate` yourself. With
  `--out`: merges one MINIMAL row per distinct repo (`source:"code"`, license when grep.app
  supplied one — nothing else; full enrichment stays `hydrate`/`enrich`'s job) into the corpus.
- **Circuit breaker** (grep.app is a free, no-SLA goodwill service, design §12): after 2
  consecutive 429/5xx failures, the breaker opens and persists in `budget.json` — further calls
  fail fast with `SOURCE_DOWN` and a `retryAfterMs` hint, WITHOUT spending a network call, until
  a cooldown elapses; the next call after that is a single half-open probe that closes the
  breaker on success or reopens it on failure. `doctor` reports both grep.app reachability and
  the current breaker state.

### `enrich` — ~2-4 GraphQL points per 50 repos + zero-quota third parties. GATE 2.
```
ghrelay enrich --in corpus.json [ids...] [--top 50] [--skip-deps] [--stale-ok]
```
- Aliased batches of 25: the ~15-signal light fragment (commits-last-90d, state-split
  issue/PR totals, `latestRelease.publishedAt`, license, funding links, watchers,
  `mentionableUsers.totalCount`, diskUsage, fork/template/archived/disabled, org-owned).
  Then the ONE mandatory B-group (real-usage) fallback chain per repo: ecosyste.ms
  `bulk_lookup` → deps.dev `:dependents` (aggregated over the last 3 versions) →
  `packaged:false` + nodata. Every signal lands with `{value, source, fetchedAt}` provenance.
  `--top 50` (default selection) takes the highest-star unenriched rows; `--stale-ok` re-covers
  rows enriched >7 days ago; `--skip-deps` skips the B-chain (GraphQL signals only).

### `rank` — free, offline, zero network. GATE 2 scoring.
```
ghrelay rank <corpus.json> [--profile build-on|dissect|ideas] [--weights A=25,B=20,...]
       [--top 20] [--min-score N] [--explain owner/repo] [--jsonl]
```
- Scores from cached signals on 7 groups (A Maintenance, B Real usage, C Community,
  D Responsiveness, E Quality proxies, F Popularity-validity, L License class). Compact rows
  (~50 tokens): `{r, s, subs, coverage, d (90-char description), st, vel, dep, lic, push, f[],
  nodata[]}`. Header states average/min coverage and which command completes missing groups.
  `--explain owner/repo` prints the full saturation + penalty trail for one row. Re-ranking
  with a different `--profile`/`--weights` refetches NOTHING.
- Profiles: `build-on` (default, general "is this solid to depend on") — A25 B20 C15 D10 E10
  F10 L10. `dissect` (study internals) — E40 Structure20 A5 B10 C10 D5 F10. `ideas`
  (novelty/inspiration) — Recency30 F25 E20 Novelty15 B+C10.
- **License is classification metadata, never a filter** — always reported (`lic`), weighted
  only where the active profile says. **Raw stars never rank** — they gate the wide net and
  feed derived signals (velocity, burstiness) only; a repo's `f[]` flags (e.g. `star-burst`,
  `possible-fake-stars`, `ratio-anomaly`) tell you WHY a star count might be misleading, not
  just that it's high.

### `health` — 1-2 GraphQL pts per ≤10 ids + 1 ClickHouse POST + 1 REST call per id. GATE 3 forensics.
```
ghrelay health <ids...> --in corpus.json
```
- One command completes the C/D/F groups on the finalists (design's GATE-3 consolidation), then
  re-scores and reports each repo's new C/D/F subscores + flags + coverage. Writes signals into
  the corpus in place; run it AFTER `enrich`, on the ~8 you shortlisted from `rank`.
- **D (responsiveness)** — a heavy GraphQL fragment (aliased, ≤10 ids/batch): median close
  latency of the last ~20 non-bot closed issues + a 90-day open/closed issue split.
- **F (popularity-validity)** — ONE ClickHouse playground POST for the whole id set: lifetime
  monthly WatchEvent histograms → **burstiness** (max-month share), plus Issues/Fork events for
  the viral-corroboration downgrade. If ClickHouse is down, F degrades to `f_coverage:"partial"`
  (never silent). A renamed repo's velocity is undercounted upstream → `partial-renamed`, no
  false fake-star penalty. `starredAt` is a secondary first:100 sample, gated on a live probe of
  the contested field — restricted/null shapes degrade the sample to absent, F leans on ClickHouse.
- **C (community)** — serialized `/contributors?per_page=5` per id → top-1 commit share (bus
  factor); a top-1 > 0.8 raises the `single-maintainer` flag.
- Flags fire through the SAME scoring rules `rank` uses — a star burst alone only flags; a
  penalty needs the corroborated combo (burst + engagement-zero + >500 stars + >6mo age).

### `skim` — 2 REST core calls (cached: 0). The cheap structural peek, GATE 3.5.
```
ghrelay skim <owner/repo> [--max-chars 4000] [--tree-only] [--in corpus.json]
```
- `trees?recursive=1` (full path/sha/size inventory; `truncated:true` → hint to use `digest`)
  + `/readme` raw. Returns a tree summary (top-level dirs, extension counts), CI/test/docs/
  examples/license-file booleans, and a README head with heading-derived install/usage/example
  booleans. `--in` writes those E-group signals into a corpus row (creates the row if absent).
  A missing README is expected absence (`readme: null`), never a hard error.

### `read` — 1 REST call per uncached file. Targeted reads, cached forever.
```
ghrelay read <owner/repo> <paths...> [--ref SHA] [--max-chars 6000]
```
- Content-addressed: once a tree is cached for a resolved ref, path→blob-sha is local and the
  blob is immutable — repeat reads of the same file are free (`cached:true`). Multi-path reads
  are serialized; each result is `ok:true` even for a missing path
  (`{content:null, reason:'not in tree', nearest:[...]}` — up to 5 nearest-name suggestions).
  A genuinely hard error (bad ref, directory path) aborts the whole call.

### `digest` — 1 tarball request (or 0-quota blobless clone). GATE 4, the full read.
```
ghrelay digest <owner/repo> [--ref SHA] [--include glob] [--exclude glob]
       [--max-tokens 20000] [--out digest.md] [--list]
```
- Pins ref→commit SHA once (reused from `skim`), fetches a tarball snapshot (cached forever
  by that SHA) — or, if the tarball fails and `git` is available, a blobless shallow clone.
  Filters out `.git`, lockfiles, binaries, minified files, and anything >1MB by default;
  `--include`/`--exclude` narrow further. Produces gitingest-style markdown (tree + fenced
  per-file sections), hard-stopped under `--max-tokens` with a steering message naming how
  many files/tokens were dropped and how to narrow. `--list` dry-runs the inclusion set (paths
  only, no content, no `--out` write). **Over MCP, `out` is ALWAYS required** — a whole-repo
  digest never transits the model inline, even in `--list` mode.

### `budget` — free (+1 free GET /rate_limit). Pool visibility.
```
ghrelay budget [--forecast 'enrich:2,skim:8,digest:3']
```
- Reports every pool (GraphQL points, REST core/search, ecosyste.ms, OSS Insight, grep.app
  breaker state) exactly as last recorded, refreshed by one free `/rate_limit` call every
  invocation. `--forecast 'command:count,...'` answers "can I afford this plan right now" —
  `affordable:false` means at least one pool would go negative; an unobserved pool reports
  `remaining:null` rather than fabricating a number.

### `doctor` — free (or <15s live). Self-diagnosis — run this FIRST when something looks off.
```
ghrelay doctor [--offline]
```
- ALWAYS returns `ok:true` with `{healthy, checks[], summary}` — a failing check is DATA, never
  a thrown error. Checks: token present + valid (with a PAT-expiry nag inside 7 days), GraphQL
  round-trip, ecosyste.ms/deps.dev/grep.app reachability, cache dir writable, `git` binary
  presence, a `starredAt` feature probe (this API was reported admin-restricted 2026-06-30 —
  doctor tells you live whether it's currently available, since F-group scoring degrades
  gracefully either way), and a local `grepAppBreaker` row reporting `code`'s circuit-breaker
  state (always runs, even `--offline` — it's a cache read, not a network call). `--offline`
  skips the live network checks but still resolves the token locally.

### `cache` — free, local. Inspect or reclaim `~/.ghrelay`.
```
ghrelay cache stats
ghrelay cache clear --confirm
ghrelay cache gc [--older-than 30d]
```
- `stats`: etag/blob/tree/tarball(/corpora, if this is the true default root) counts + byte
  sizes. `clear` wipes everything except `budget.json` (rate-limit state, not a content cache)
  — refuses without `--confirm` (`CONFIRMATION_REQUIRED`, zero deletion attempted). `gc` prunes
  etags older than `--older-than` (default 30d) plus tarballs and now-orphaned etag bodies.

### Deferred to v0.2 (registry-stable, spec'd but not in this release)

- NL discovery lanes (Exa / Firecrawl, optional-key), a REST code-search verification lane, and
  snapshot-diff velocity (our own cached stargazerCount across sessions) for the post-`starredAt`
  world. Every v0.1 command above is implemented — nothing in the funnel returns "not yet".

---

## Corpus / budget / doctor workflow notes

- A corpus file (`corpus.json`) is the shared state across a whole research session:
  `search`/`batch`/`hydrate` build it, `enrich` deepens it in place, `rank` reads it read-only.
  Re-running any writer against the same `--out`/`--in` path merges fresh-wins — safe to top up
  incrementally rather than starting over.
- Run `doctor` first whenever a call errors oddly or returns unexpectedly empty — it tells you
  what's actually wrong (token, network, cache dir) instead of leaving you to guess.
- Check `budget` before a big `batch`/`enrich`/`digest` sweep, and `--forecast` a plan you're
  unsure you can afford — GraphQL and REST core pools are separate, so a `search`-heavy session
  can starve `digest`'s REST-core budget without you noticing.

---

## Error codes

The `error` object is always `{code, message}` plus, when relevant, `hint`, `status` (upstream
HTTP status), and `retryAfterMs`. **Read `retryAfterMs` and back off by exactly that much —
never guess a shorter wait.**

- `INVALID_INPUT` — bad flag/shape (empty query, malformed owner/repo id, bad `--stars` range).
  No network call spent.
- `AUTH_FAILED` — terminal; create a zero-permission fine-grained PAT (`GH_TOKEN`/`GITHUB_TOKEN`,
  or have `gh auth token` resolve one) — github-relay deliberately never degrades to 60/hr
  unauthenticated access.
- `RATE_LIMITED` — read `error.retryAfterMs` and wait exactly that long; `batch` handles this
  pacing for you automatically mid-run.
- `NOT_FOUND` — the repo/resource doesn't exist or isn't visible to your token.
- `QUERY_TOO_COMPLEX` — >256 chars or >5 `AND`/`OR`/`NOT` operators; split into `batch` shards
  (the hint suggests how).
- `RESULT_CAP` — the search hit GitHub's 1,000-result cap; the hint includes a ready-made
  `stars:`/`created:` shard split.
- `ABUSE_DETECTED` — GitHub's secondary rate limit; back off and retry serialized, not in a burst.
- `SOURCE_DOWN` — a no-SLA third party (ecosyste.ms, deps.dev, ClickHouse, OSS Insight, grep.app)
  is unreachable; the affected signal degrades to `nodata` — other signals still apply, and
  `coverage` reflects the gap honestly.
- `CONFIRMATION_REQUIRED` — a destructive op (`cache clear`) needs `--confirm`; nothing was
  touched.
- `UNKNOWN_COMMAND` — a name outside the registry (every registered command is implemented).
- `FETCH_FAILED` — a generic transport/parse failure not covered by a more specific code.

---

## Setup

Requires a zero-permission fine-grained GitHub PAT — it can read nothing private, so a
non-expiring one is fine (no safety tradeoff, just less friction). Resolution order:
`GH_TOKEN`/`GITHUB_TOKEN` env → `gh auth token` shell-out → loud `AUTH_FAILED` with a hint if
neither resolves. Run `ghrelay doctor` after setup to confirm everything (token, pools, cache
dir, `git` presence) is reachable.
