# Command reference

> **Mode: reference.** Exact flags, costs, output shapes, and failure modes for all 14 commands.
> For the end-to-end research recipe see [`agent-workflow.md`](./agent-workflow.md); for why the
> system is shaped this way see [`architecture.md`](./architecture.md).

Conventions that hold for **every** command:

- stdout carries exactly one JSON envelope — `{ok:true, command, data}` or
  `{ok:false, command, error:{code, message, hint?, status?, retryAfterMs?}}`. Progress lines go
  to stderr (silence with `--quiet`; the MCP server forces it).
- Exit codes: `0` ok · `1` command error · `2` unknown command.
- `--compact` prints the envelope on a single line.
- A literal `--` ends flag parsing; everything after it is positional (use it when a query or
  pattern starts with a dash). A bare `-` reads ids from stdin where documented.
- On `RATE_LIMITED`, back off for `error.retryAfterMs` — never guess.

---

## plan — validate and shard query slices

```
ghrelay plan <slices...> [--dry] [--probe] [--shard stars|created] [--max-probes 30] [--out queries.txt]
```

**Cost:** free locally; `--probe` spends 1 GraphQL point per slice, and auto-sharding can
multiply that — hard-capped by `--max-probes` (default 30).

Offline (default / `--dry`): checks each slice against GitHub's limits (256 chars, ≤5
`AND/OR/NOT` operators) → per-slice `ok` or `QUERY_TOO_COMPLEX` detail. With `--probe`: fetches
each slice's `repositoryCount` (1 pt, serialized, 500 ms apart) and recursively splits any slice
over the 1,000-result cap along `--shard` (default `stars`, log-scale; `created` = yearly→monthly
windows), re-probing each shard, to depth 5. Splits narrow *within* existing `stars:`/`created:`
qualifiers — never contradict them.

**Output** `data`: `slices[]` (per-slice count/shard tree/errors), `queries[]` (flat,
batch-ready), `estimatedPoints` (cost to *run* those queries), `pointsSpent` (what the probe
itself cost). `--out` writes a `batch`-compatible `queries.txt`.

**Degradation:** budget exhausted or a probe failing mid-tree never discards completed work —
affected shards become hint-bearing leaves and the rest of the tree survives.

```bash
ghrelay plan 'markdown editor language:swift' 'topic:markdown stars:>100' --probe --out queries.txt
```

---

## search — the wide discovery net

```
ghrelay search <query> [--source gh|rest|trending] [--period 24h|week|month] [--limit 30]
  [--language X --topic Y --stars A..B --created R --pushed R --sort stars|updated]
  [--fields ...] [--out corpus.json]
```

**Cost:** 1 GraphQL point per 100 results (`--source gh`, default); REST fallback
(`--source rest`) uses the separate 30/min search pool; `--source trending` is 1 OSS Insight GET.

One page, pre-enriched: every hit already carries stars, forks, pushedAt, createdAt, license
SPDX id, topics, language, archived flag, description — enough to shortlist without any
enrichment calls. Flags are validated **before** any network call (`INVALID_INPUT` names the
offending flag). `--topic` is repeatable. Range grammar: `10..50`, `>100`, `10..*`, `*..50`.
`--period` is only legal with `--source trending`.

**Output** `data`: `{query, count, merged, out}` when writing a corpus (`--out` merges,
never clobbers — rows are keyed by case-insensitive `owner/repo`), or result rows otherwise
(`--fields` narrows them). If the query exceeds GitHub's 1,000-result cap the data carries a
`warning` with a ready-made `stars:`/`created:` shard hint — results are still returned.

```bash
ghrelay search "markdown editor" --language swift --stars '>100' --limit 20 --out corpus.json
ghrelay search --source trending --period week --language rust --out corpus.json
```

---

## batch — many queries, one corpus

```
ghrelay batch --file queries.txt --out corpus.json [--delay 2000] [--dry-run]
```

**Cost:** N GraphQL points, strictly serialized — 2,000 ms between queries by default; a
`RATE_LIMITED` reply's `retryAfterMs` **replaces** the next delay.

`queries.txt`: one query per line, `#` comments and blank lines skipped. Failures don't abort
the run (`continue-on-error`); results are deduped across queries and merged into `--out`
incrementally, so re-running tops up the same corpus. `--dry-run` validates every line offline
with zero network.

**Output** `data`: `{queries, succeeded, failed, totalUnique, out, perQuery[]}` — `perQuery`
carries each query's count or its `{code, message, retryAfterMs?}`.

---

## hydrate — ingest repos you found elsewhere

```
ghrelay hydrate <owner/repo...> [--out corpus.json] [-]
```

**Cost:** ~1 GraphQL point per 50 ids (one aliased batch).

The multi-source lane: pipe in candidates from your own web research — awesome lists, "best X"
threads, blog posts. `-` reads newline-separated ids from stdin. Ids are shape-validated up
front (the offending token is named) and deduped case-insensitively. Per-id failures land in
`failed[]` without sinking the batch. Rows merge into the corpus tagged `source:"agent"`.

**Output** `data`: `{requested, hydrated, failed[], out}`.

```bash
ghrelay hydrate zed-industries/zed helix-editor/helix --out corpus.json
grep -o '[a-zA-Z0-9_.-]*/[a-zA-Z0-9_.-]*' awesome-list.md | ghrelay hydrate - --out corpus.json
```

---

## code — code-token evidence search

```
ghrelay code <pattern> [--lang X --repo o/r --path P] [--limit 20] [--literal] [--out corpus.json]
```

**Cost:** free (grep.app's public MCP endpoint; ~1M top repos indexed).

For code tokens and literal strings, **not** concepts: a pattern that looks like a
natural-language question is rejected with `INVALID_INPUT` (the hint names the escape —
`--literal` bypasses the heuristic entirely). Results carry `{repo, path, line, snippet, lang,
license?}` plus a deduped `repos` list ready to pipe into `hydrate`. `--out` merges minimal
rows tagged `source:"code"`.

A persistent circuit breaker (2 consecutive upstream failures → cooldown) protects the goodwill
endpoint; an open breaker returns `SOURCE_DOWN` immediately with a retry hint, no network spent.

```bash
ghrelay code 'NSTextLayoutManager(' --lang Swift --limit 10
ghrelay code 'failed to connect to database' --literal
```

---

## enrich — deepen the corpus (GATE 2)

```
ghrelay enrich --in corpus.json [ids...] [--top 50] [--skip-deps] [--stale-ok]
```

**Cost:** ~2–4 GraphQL points per 50 repos (aliased 25-repo batches of a ~15-signal fragment) +
zero-GitHub-quota third parties.

Fetches the signal set scoring needs: 90-day commit count, state-split issue/PR totals, latest
release date, license detail, contributor pool size, funding, disk usage — then the **B-group
fallback chain** for real-usage evidence: ecosyste.ms (dependents, downloads) → deps.dev
(dependents across the last 3 versions) → `packaged:false` with visible `nodata`. Any upstream
failure of a goodwill source degrades to the next rung **for that repo only**; a run is never
aborted by a third-party hiccup, and GraphQL-stage successes always persist. `--top N` enriches
the N highest-star unenriched rows; `--stale-ok` skips rows fresher than 7 days.

**Output** `data`: `{enriched, skipped, failed[], pointsSpent, out}`. Every signal lands in the
corpus with provenance `{value, source, fetchedAt}`.

---

## rank — offline scoring

```
ghrelay rank <corpus.json> [--profile build-on|dissect|ideas] [--weights A=25,B=20,...]
  [--top 20] [--min-score N] [--explain owner/repo] [--jsonl]
```

**Cost:** free — zero network, ever. Re-ranking with different weights refetches nothing.

Scores each repo 0–100 across seven groups — **A** maintenance, **B** real usage, **C**
community, **D** responsiveness, **E** quality proxies, **F** popularity-validity (never raw
stars), **L** license class (metadata, never a filter). Missing groups renormalize the remaining
weights and appear in `nodata[]`; every row carries `coverage:"N/7"` so a thin score is visibly
thin. Penalties apply only for objective conditions (archived ×0.2, deprecation marker ×0.5) or
the corroborated fake-star combination; a star burst alone flags, never punishes.

**Output** `data`: `{profile, header, count, coverage, rows[]}` (or `jsonl` — one compact row
per line, ~50 tokens each). A real row:

```json
{"r":"I7T5/Edmund","s":88.8,"subs":{"A":0.98,"B":null,"C":null,"D":null,"E":0.67,"F":0.76,"L":1},
 "coverage":"4/7","d":"A native, lightweight macOS markdown editor with Live Preview",
 "st":105,"lic":"permissive","f":[],"nodata":["B","C","D"],"push":"2026-07-11"}
```

The `header` states average/minimum coverage and *which command completes the missing groups*.
`--explain owner/repo` prints one repo's raw values, per-signal saturation, penalty trail, and
provenance. Profiles: `build-on` (default), `dissect` (dissecting for parts), `ideas` (novelty
and recency). `--weights` overrides must sum to 100.

---

## health — finalist forensics (GATE 3)

```
ghrelay health <ids...> --in corpus.json
```

**Cost:** 1–2 GraphQL points per ≤10 ids (heavy fragment + a one-time starredAt probe) + **one**
ClickHouse POST for the whole set + 1 REST call per id.

Completes C/D/F for the shortlist: median issue close-latency (bots filtered), 90-day
open/closed ratio (kept on distinct `*90d` signal keys so re-enriching can't silently change
D's meaning), contributor bus factor, and — the differentiator — **lifetime monthly star
histograms** from the public ClickHouse GH Archive mirror, yielding burstiness (max-month
share), velocity consistency, and the viral-corroboration check that separates a launch spike
from a bought spike. Renamed repos get `velocity: partial-renamed` instead of a false penalty.
If ClickHouse is down, F degrades visibly (`fCoverage:"partial"`) and everything else proceeds.

**Output** `data.repos[]`: `{id, coverage, subs:{C,D,F}, flags[], fCoverage?, starredAt?}`;
the corpus is re-scored and saved.

```bash
ghrelay health lukakerr/Pine tw93/MiaoYan --in corpus.json
```

---

## skim — cheap structural peek

```
ghrelay skim <owner/repo> [--max-chars 4000] [--tree-only] [--in corpus.json]
```

**Cost:** 2 REST core calls cold; **0** on repeat (ETag 304s are quota-free).

One recursive tree call + the README head. Reports total files, top-level dirs, extension
counts, CI/test/docs/examples presence, and README-heading booleans; with `--in` those
E-group booleans are written into the corpus (provenance `source:"skim"`). Pins the commit SHA
that `digest` will reuse. A repo without a README is a clean partial result, not an error.

**Output** `data`: `{repo, sha, truncatedTree, tree:{totalFiles, topLevelDirs,
extensionCounts}, signals, readme}`.

---

## read — targeted cached file reads

```
ghrelay read <owner/repo> <paths...> [--ref SHA] [--max-chars 6000]
```

**Cost:** 1 REST call per uncached file; repeat reads are free (`cached:true`, blob store is
content-addressed by git SHA).

Missing paths follow the **expected-absence contract**: `ok:true` with `content:null`, a
reason, and up to 5 `nearest` path suggestions — exit 0 as long as nothing *hard-failed*.
Multi-path requests return one result per path, fetched serially.

```bash
ghrelay read lukakerr/Pine Pine/AppDelegate.swift README.md --max-chars 4000
```

---

## digest — whole-repo digest (GATE 4)

```
ghrelay digest <owner/repo> [--ref SHA] [--include/--exclude glob] [--max-tokens 20000]
  [--out digest.md] [--list]
```

**Cost:** expensive — 1 tarball request (302 → codeload), or a 0-quota blobless `git clone`
fallback for very large repos. Tarballs cache by commit SHA.

Produces a gitingest-style markdown digest — tree section + fenced file contents — with default
excludes (`.git`, `node_modules`, lockfiles, binaries, minified, >1 MB) plus your
`--include`/`--exclude` globs. `--max-tokens` is a **genuine hard stop** including the tree
section; whatever was dropped is named with a steering hint. `--list` dry-runs the file list
and token estimate. Output above ~8,000 tokens requires `--out` (and the MCP tool always does).

**Output** `data`: `{files, tokens, out, dropped:{files, estimatedTokens, hint}}`.

```bash
ghrelay digest lukakerr/Pine --include 'Pine/**/*.swift' --include 'README*' --max-tokens 12000 --out pine.md
```

---

## budget — pool visibility

```
ghrelay budget [--forecast 'enrich:2,skim:8,digest:3']
```

**Cost:** free (one quota-free GET `/rate_limit` refreshes the GitHub pools).

Reports every pool from live headers — GraphQL points, REST core/search windows, third-party
counters, learned batch ceilings — never trusted constants. `--forecast` answers "can I afford
this session right now" against documented per-command costs for all 14 commands.

**Output** `data.pools`: `{graphqlPoints, restCore, restSearch, learnedCeilings, ...}`.

---

## doctor — self-diagnosis

```
ghrelay doctor [--offline]
```

**Cost:** free; live mode completes in <15 s (each check individually timeout-raced).

**Always exits 0 with `ok:true`** — a failing check is data, not an error:
`{healthy, checks:[{name, ok, detail}], summary}`. Live checks: token validity (with PAT-expiry
warning), GraphQL round-trip, ecosyste.ms / deps.dev / ClickHouse / OSS Insight / grep.app
reachability, cache-dir writability, git binary, the starredAt feature probe (detects GitHub's
field-level restriction shapes), and circuit-breaker state. `--offline` skips network checks
(marked *skipped*, not failed).

> [!TIP]
> Goodwill endpoints cold-start slowly; a first-run timeout on `ecosystems`/`grepApp` usually
> clears on the next invocation.

---

## cache — local storage management

```
ghrelay cache stats|clear|gc [--older-than 30d] [--confirm]
```

**Cost:** free, local.

`stats` reports per-store sizes/counts. `clear` requires `--confirm` (else
`CONFIRMATION_REQUIRED`) and only ever touches a directory carrying the `.ghrelay` ownership
marker — a mispointed `GHRELAY_CACHE_DIR` refuses rather than deleting unrelated files. `gc`
prunes aged ETags/tarballs and orphaned bodies; `--older-than` accepts `30d`/`12h`/`45m`
(case-insensitive). Corpora at arbitrary paths are never touched.

---

## Error codes

| Code | Meaning | What to do |
|------|---------|-----------|
| `INVALID_INPUT` | Bad flag/argument — nothing was spent | Fix the input; the hint names it |
| `AUTH_FAILED` | No usable token | Create a zero-permission fine-grained PAT |
| `RATE_LIMITED` | Primary rate limit | Wait `retryAfterMs`, exactly |
| `ABUSE_DETECTED` | Secondary limit | Serialized retry after cooldown |
| `QUERY_TOO_COMPLEX` | >5 operators / 256 chars | Split into batch shards (`plan` helps) |
| `RESULT_CAP` | Query exceeds 1,000 results | Use the embedded shard hint or `plan --probe` |
| `NOT_FOUND` | Repo/path/resource gone | — |
| `SOURCE_DOWN` | Goodwill service unreachable | Signal degrades to `nodata`; retry later |
| `CONFIRMATION_REQUIRED` | Destructive op without `--confirm` | Re-run with `--confirm` |
| `FETCH_FAILED` | Transport/malformed response | Loud by design — inspect, retry |
| `UNKNOWN_COMMAND` | Typo or unimplemented | `ghrelay --help` |
