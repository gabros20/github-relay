# github-relay

[![CI](https://github.com/gabros20/github-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/gabros20/github-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**Research GitHub, not read GitHub.** A single-user, zero-paid-API, LLM-free Bun/TypeScript CLI
(`ghrelay`) + a thin MCP server (`github-relay-mcp`) + an auto-generated Claude Code skill. An
agent expands a natural-language intent into concrete inputs — query shards, candidate ids from
its own web research, code-token probes — and github-relay casts a wide GitHub discovery net,
ranks candidates **offline** on maintenance/real-usage/star-skeptical signals with explainable,
coverage-honest subscores, and deep-reads only the 2–3 finalists. One free zero-permission
fine-grained PAT. No paid API keys, ever.

Why it exists: GitHub search alone has poor recall for fuzzy intents, raw stars are a gameable
signal (fake-star campaigns are cheap and common), and dumping whole repos into an agent's
context wastes tokens. github-relay attacks all three: **five discovery lanes** (GitHub search,
serialized batches, agent-found ids, grep.app code tokens, OSS Insight trending), a **scoring
model that never ranks on raw stars** (star-velocity burstiness from GH Archive corroborates or
clears them instead), and a **gated funnel** where every step's cost is declared before it runs.

## Install

```bash
# Run without installing:
npx -p github-relay-mcp ghrelay doctor

# Or install globally:
npm i -g github-relay-mcp   # or: bun add -g github-relay-mcp
ghrelay doctor
```

`doctor` checks your token, pool reachability, and cache dir — run it once after install. Auth
resolves from `GH_TOKEN`/`GITHUB_TOKEN` or `gh auth token`; either way you need a
**zero-permission fine-grained PAT** (it can read nothing private, so a non-expiring one is
fine — no safety tradeoff, just less setup friction).

## Quickstart — the funnel in 6 commands

```bash
# GATE 1 — wide net: batch a few hand-written shards, and hydrate candidates
# your OWN web search already found (awesome lists, "best X" threads).
printf '%s\n' 'markdown editor language:swift stars:>50' 'topic:markdown topic:macos' > shards.txt
ghrelay batch --file shards.txt --out corpus.json
ghrelay hydrate zed-industries/zed helix-editor/helix --out corpus.json

# GATE 2 — enrich + rank, offline scoring on 7 signal groups.
ghrelay enrich --in corpus.json --top 50
ghrelay rank corpus.json --profile build-on --top 10

# GATE 3 — forensics on finalists (star burstiness, bus factor, issue latency).
ghrelay health lukakerr/Pine tw93/MiaoYan --in corpus.json

# GATE 4 — deep read only the survivor(s).
ghrelay digest lukakerr/Pine --max-tokens 20000 --out pine-digest.md
```

A full session costs roughly **18 GraphQL points of your 5,000/hr** — headroom for hundreds of
research sessions per hour. Repeat runs converge toward zero cost via ETag caching.

## Commands

Every command declares its cost before you run it. Cheap discovery first, expensive extraction
last — that ordering *is* the product.

| Command | Cost | What it does |
|---------|------|--------------|
| `plan` | free / `--probe` ~1 pt per slice (capped) | Validate query shards offline; probe counts and auto-shard past the 1,000-result cap |
| `search` | 1 GraphQL pt per 100 results | The wide net — pre-enriched repo search; `--source trending` for OSS Insight |
| `batch` | N pts, strictly serialized | Many queries from a file, delayed and deduped into one corpus |
| `hydrate` | ~1 pt per 50 ids | Ingest repos *you* found elsewhere — web search, awesome lists, HN threads |
| `code` | free (grep.app) | Code-token/regex evidence search across ~1M top repos |
| `enrich` | ~2–4 pts per 50 repos | The ~15-signal fragment + ecosyste.ms → deps.dev dependents chain |
| `rank` | free, offline | Score on 7 groups; ~50-token rows with coverage + `--explain` |
| `health` | 1–2 pts per ≤10 ids + 1 ClickHouse POST | Finalist forensics: burstiness, bus factor, issue latency |
| `skim` | 2 REST calls (cached: 0) | Tree inventory + README head — the cheap structural peek |
| `read` | 1 REST call per uncached file | Targeted file reads, content-addressed and cached |
| `digest` | 1 tarball request | Full gitingest-style digest, filtered and token-capped |
| `budget` | free | Remaining headroom across every pool, `--forecast` a session |
| `doctor` | free / <15 s live | Token, reachability, feature probes — always exits 0 |
| `cache` | free, local | Inspect/clear/gc `~/.ghrelay` |

Full per-command reference with flags, output shapes, and worked examples:
[`docs/commands.md`](./docs/commands.md).

## Output contract

Every command prints exactly one JSON envelope to stdout (progress goes to stderr):

```jsonc
{ "ok": true,  "command": "search", "data": { /* ... */ } }
{ "ok": false, "command": "enrich", "error": { "code": "RATE_LIMITED", "message": "...", "hint": "...", "retryAfterMs": 42000 } }
```

Exit codes: `0` success · `1` command error · `2` unknown command. Error codes are a closed set
(`INVALID_INPUT`, `AUTH_FAILED`, `RATE_LIMITED`, `NOT_FOUND`, `QUERY_TOO_COMPLEX`, `RESULT_CAP`,
`ABUSE_DETECTED`, `SOURCE_DOWN`, `CONFIRMATION_REQUIRED`, `UNKNOWN_COMMAND`, `FETCH_FAILED`) and
every error carries an actionable `hint`. On `RATE_LIMITED`, honor `retryAfterMs` — don't guess.

## Configuration

| Variable | Effect |
|----------|--------|
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub auth (falls back to `gh auth token`) |
| `GHRELAY_CACHE_DIR` | Cache root override (default `~/.ghrelay`) |

The cache holds ETags, content-addressed blobs, tree/tarball snapshots, rate-budget state, and
your corpora. `cache clear`/`gc` refuse to touch a directory that doesn't carry the `.ghrelay`
ownership marker, so a mispointed `GHRELAY_CACHE_DIR` can't delete unrelated files.

> [!NOTE]
> Third-party lanes (ecosyste.ms, deps.dev, ClickHouse playground, OSS Insight, grep.app) are
> free goodwill services. When one is down or rate-limits, the affected signal **degrades
> visibly** (`nodata`, reduced `coverage`) — a run never aborts because a bonus lane hiccuped.

## Use it as an MCP server

Add to your MCP client config (e.g. Claude Code, Claude Desktop):

```json
{
  "mcpServers": {
    "github-relay": {
      "command": "npx",
      "args": ["-y", "github-relay-mcp"]
    }
  }
}
```

The MCP surface exposes one tool per command — all 14 — as thin wrappers around the same CLI
dispatch path, zero extra business logic. Corpus/digest-writing tools (`search`, `batch`,
`digest`) require an `out` path in their schema and `rank` is capped at 100 rows, so nothing
large ever transits the model context.

## Use it as a Claude Code skill

The skill at [`.claude/skills/github-relay/SKILL.md`](.claude/skills/github-relay/SKILL.md) is
auto-inlined into the package at build time and shipped with the npm package. Point Claude Code
at this repo (or the installed package) and it's discoverable automatically. The skill teaches
the funnel's three golden rules — never deep-read during exploration; the agent expands intent,
the tool executes slices; for fuzzy intents, web-search first and `hydrate` what humans curated.

## Documentation

| Doc | What it answers |
|-----|-----------------|
| [`docs/commands.md`](./docs/commands.md) | Exact flags, output shapes, errors, examples — per command |
| [`docs/agent-workflow.md`](./docs/agent-workflow.md) | How to run a research session end to end |
| [`docs/architecture.md`](./docs/architecture.md) | How the system is shaped, and why |
| [`docs/decisions/`](./docs/decisions/) | ADRs for the hard-to-reverse calls |
| [`docs/DESIGN-v1.0.md`](./docs/DESIGN-v1.0.md) | The full v0.1 design (panel-reviewed spec) |
| [`PLAN.md`](./PLAN.md) | Build plan, milestones, and settled decisions |

## Development

```bash
git clone https://github.com/gabros20/github-relay && cd github-relay
bun install
bun run check        # typecheck (src + tests) + lint + full test suite
bun run build        # tsup → dist/ (cli, mcp-shim, index)
bun run smoke:mcp    # stdio round-trip against the built MCP server
bun run smoke:node   # built artifacts under plain Node (the npm consumer path)
```

868 tests, TDD throughout, no runtime dependencies beyond `@modelcontextprotocol/sdk` + `zod`.
Conventional Commits; releases via semantic-release on `main`.

## License

[MIT](./LICENSE)
