# github-relay — Implementation Plan

> **"Research GitHub, not read GitHub."** A single-user, zero-paid-API, LLM-free Bun/TypeScript
> CLI + thin MCP shim + auto-generated Claude skill that turns natural-language intent into a
> ranked, explainable, star-skeptical shortlist of repos, then deep-reads only finalists.
>
> Full design: [`docs/DESIGN-v1.0.md`](docs/DESIGN-v1.0.md) (consensus of a 3-architect panel +
> 2 adversarial skeptics; every fatal flaw resolved or conceded in its §1 ledger).
> Research provenance: [`docs/research/`](docs/research/) (digest of 10 research agents +
> X sweep findings).

## The one-paragraph summary

The agent expands intent into query shards and web-found candidate ids; github-relay casts a
1-point GraphQL wide net across **four discovery lanes** (GraphQL search shards · `hydrate`
of agent-web-found ids · OSS Insight trending · grep.app code tokens), enriches 50 candidates
for ~2 GraphQL points via aliased batches + zero-GitHub-quota third parties (ecosyste.ms
15k/hr polite pool → deps.dev fallback), ranks **offline** on 7 signal groups with
per-row `coverage`, flags, and 50-token compact rows, verifies finalists with `health`
(ClickHouse lifetime star histograms → burstiness/fake-star flags), and deep-reads 2–3
survivors via 1-request tarball `digest`. A full session costs ~18 GraphQL points of
5,000/hr — headroom for 250+ sessions/hr. License is **classification metadata, never a
filter**. Raw stars never rank.

## Non-negotiables (inherited DNA + panel-hardened)

- Envelope `{ok,command,data}` / `{ok:false,command,error:{code,message,hint,status?,retryAfterMs?}}`; exit 0/1/2; stdout = JSON only, progress → stderr.
- Command registry as single source of truth with per-command funnel-cost hints.
- Strictly serialized batches (2000ms delay, `retryAfterMs` overrides), x-relay backoff, adaptive GraphQL bisection with learned batch ceilings.
- Never: raw.githubusercontent.com, HTML scraping, hosted gitingest/repomix, embeddings/LLM deps, `stats/*` endpoints, cursor persistence.
- Missing data = renormalize + `coverage:"5/7"` honesty, never zero. Penalties only for objective/corroborated conditions; bursts alone flag, never punish.
- Fail loud: `AUTH_FAILED` with PAT hint instead of degrading to 60/hr unauth; `SOURCE_DOWN` degrades a signal to nodata visibly.
- TDD, fake sources, calibration fixtures as ordering regression tests.

## Milestones (v0.1 ships A+B; panic-cut line is between them)

### Milestone A — core funnel (build in this order)

1. **Scaffold** — clone youtube-context shell: Bun + tsup(splitting:false) + Biome + bun test;
   `cli.ts` parseArgs → `ParsedCommand` → `run()`; `output.ts` envelope + exit codes;
   `progress.ts`; `registry.ts`; error-code set (§9 of design); `scripts/generate-skill.ts`.
2. **Adapters** — `sources/gh-graphql.ts` (embedded `rateLimit{}`, bisection, learned ceilings),
   `sources/gh-rest.ts` (backoff, trees/readme/contents/tarball), `sources/ecosystems.ts`
   (mailto UA, bulk_lookup), `sources/depsdev.ts` (project→purl mapping, Scorecard,
   `:dependents`). Injectable `{fetchImpl, sleep, now, maxRetries}` seams. Auth resolution:
   env → `gh auth token` → loud fail.
3. **Cache layer** — `~/.ghrelay/`: etags.json, blobs/ (SHA-addressed), trees/, tarballs/
   (by commit SHA), budget.json, corpora/ (`github-relay/corpus@1`, intent stored, provenance
   per signal, ghid + aliases rename handling). Atomic writes, load-never-throws.
4. **Discovery** — `search` (GraphQL net, pre-enriched, RESULT_CAP hints; `--source rest`),
   `batch` (x-relay semantics), `hydrate` (aliased batch of agent-found ids, `source:"agent"`).
5. **Enrich + rank** — `enrich` (25-repo light fragments + B-chain
   ecosyste.ms → deps.dev → `packaged:false`), `score/` pure modules (Pike log-saturation,
   3 profiles, flags, renormalization), `rank` (offline, compact 50-token rows with 90-char
   description, `--explain`, `--weights`, coverage header). Calibration fixtures (~10/profile
   to start).
6. **Extraction** — `skim` (tree+readme, 2 calls), `read` (blob-cached, expected-absence
   `{content:null, nearest:[]}`), `digest` (tarball 302, blobless-clone fallback, gitingest-style
   filters, `--max-tokens` hard stop, `--out` required over MCP).
7. **Ops** — `budget`, `doctor` (always ok:true, feature probes incl. starredAt), `cache`.
8. **Surfaces** — MCP shim (zod, compact default, lazy sources), SKILL.md (funnel-first, three
   golden rules), generated skill inlining; envelope/exit contract tests per command.

### Milestone B — forensics + lanes (same release, cut here if it slips)

9. `plan` (`--dry` validation, `--probe` iterative shard expansion under the 1,000 cap).
10. `code` — grep.app MCP-over-HTTP lane + circuit breaker + NL rejection.
11. `health` — heavy GraphQL fragment (issue latency, starredAt-100 when alive),
    one ClickHouse POST per finalist set (lifetime monthly histograms → burstiness,
    viral-corroboration downgrade), `/contributors` bus factor; auto re-score + coverage 7/7.
12. `search --source trending` (OSS Insight), `budget --forecast`, learned-ceiling persistence.

### v0.2 (deferred by decision, not accident)

Exa/Firecrawl optional-key NL lanes → hydrate; REST code-search verification lane (9/min);
snapshot-diff star velocity (API-independent); weight calibration from real usage; `compare`.

## Risks (top 5 of 10 — full list in design §12)

1. starredAt API contested (2026-06-30 report) → doctor probe + ClickHouse is primary anyway.
2. ClickHouse/OSS Insight/grep.app = goodwill services → single-endpoint adapters, degrade to nodata.
3. ecosyste.ms coverage holes/stale syncs → deps.dev fallback + `dataAge` surfaced in rows.
4. GraphQL 10s timeout penalty points → conservative ceilings + bisection + persistence.
5. Uncalibrated weights → coverage + `--explain` keep scores auditable, fixtures pin ordering.

## Decisions (panel's open questions, resolved 2026-07-10)

1. **Calibration labels**: ship v0.1 with ~10 author-labeled good/junk repos per profile and
   grow the fixture set from real sessions. The fixtures test ordering stability, not absolute
   truth, so a small seed set suffices and nothing blocks on hand-labeling 90 repos.
2. **v0.2 recall investment**: WebSearch + `hydrate` path exclusively. The zero-key ethos is
   the product identity; Exa/Firecrawl stay specced as optional-key adapters for whenever a
   key exists, but no roadmap item depends on them.
3. **Penalties at ship**: active, as designed. The panel already made them conservative —
   objective conditions (archived, deprecated) and corroborated fake-star combos only; bursts
   alone never penalize. A flags-only default would let known junk rank above honest repos.
4. **PAT policy**: docs and the doctor hint recommend a non-expiring zero-permission
   fine-grained PAT (it can read nothing private, so expiry is friction without safety);
   doctor also reads the `github-authentication-token-expiration` header and warns at <7 days.
   Both behaviors ship — it was never really either/or.
5. **Name**: `github-relay`, following the x-relay convention — repo `github-relay`, npm
   `github-relay-mcp`, bins `ghrelay` (CLI) + `github-relay-mcp` (shim), cache `~/.ghrelay`
   (`GHRELAY_CACHE_DIR`). Verified free on npm 2026-07-10 (`github-relay-mcp`, `github-relay`,
   `ghrelay` all E404). Register with the first semantic-release publish; no pre-squat needed
   for a personal tool.
