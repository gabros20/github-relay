# github-relay

**Research GitHub, not read GitHub.** A single-user, zero-paid-API, LLM-free Bun/TypeScript CLI
(`ghrelay`) + a thin MCP server (`github-relay-mcp`) + an auto-generated Claude Code skill. An
agent expands a natural-language intent into concrete inputs — query shards, candidate ids from
its own web research, code-token probes — and github-relay casts a wide GitHub discovery net,
ranks candidates **offline** on maintenance/real-usage/star-skeptical signals with explainable,
coverage-honest subscores, and deep-reads only the 2–3 finalists. One free zero-permission
fine-grained PAT. No paid API keys, ever.

See [`docs/DESIGN-v1.0.md`](./docs/DESIGN-v1.0.md) for the full design and
[`PLAN.md`](./PLAN.md) for the build plan and decisions.

## Install

```bash
# Run without installing:
bunx github-relay-mcp doctor

# Or install globally:
npm i -g github-relay-mcp   # or: bun add -g github-relay-mcp
ghrelay doctor
```

`doctor` checks your token, pool reachability, and cache dir — run it once after install. It
resolves auth from `GH_TOKEN`/`GITHUB_TOKEN` or `gh auth token`; either way you need a
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

# GATE 3.5 — cheap structural peek on your shortlist.
ghrelay skim zed-industries/zed

# GATE 4 — deep read only the survivor(s).
ghrelay digest zed-industries/zed --max-tokens 20000 --out zed-digest.md
```

Every command prints a JSON envelope: `{ok, command, data}` on success,
`{ok:false, command, error:{code, message, hint}}` on failure. Full command reference, the
funnel golden rules, and error-code guidance live in
[`.claude/skills/github-relay/SKILL.md`](.claude/skills/github-relay/SKILL.md) — that's the deep
reference this README intentionally stays out of.

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

The MCP surface exposes one tool per **implemented** command (`search`, `batch`, `hydrate`,
`enrich`, `rank`, `skim`, `read`, `digest`, `budget`, `doctor`, `cache`) — thin wrappers around
the same CLI dispatch path, zero extra business logic. Corpus/digest-writing tools (`search`,
`batch`, `digest`) require an `out` path in their schema, so nothing large ever transits the
model context.

## Use it as a Claude Code skill

The skill at [`.claude/skills/github-relay/SKILL.md`](.claude/skills/github-relay/SKILL.md) is
auto-inlined into the package at build time (`scripts/generate-skill.ts` →
`src/generated/skill.ts`) and shipped alongside the npm package. Point Claude Code at this repo
(or the installed package) and it's discoverable as a skill automatically.

## Status

**v0.1 — milestone A shipped**: search, batch, hydrate, enrich, rank, skim, read, digest,
budget, doctor, cache, MCP shim, generated skill. `plan`, `code`, and `health` are milestone B —
registered in the CLI/skill but not yet implemented (they return a clear
`UNKNOWN_COMMAND`/"not yet implemented" envelope, never a silent no-op).

## License

MIT
