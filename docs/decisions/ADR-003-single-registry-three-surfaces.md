# ADR-003: One command registry drives three surfaces (CLI, MCP, skill)

## Status
Accepted

## Date
2026-07-10 (inherited from the x-relay/youtube-context lineage), recorded 2026-07-11

## Context
The tool ships three agent-facing surfaces: a CLI (`ghrelay`), an MCP stdio server
(`github-relay-mcp`), and a Claude Code skill (SKILL.md). Three surfaces describing 14 commands
independently would drift — a flag renamed in the CLI but not the skill, an MCP tool whose
schema promises an option the dispatcher dropped. Drift in agent-facing docs is worse than in
human docs: agents follow instructions literally and don't improvise around stale text.

## Decision
`src/commands/registry.ts` is the single source of truth: `{name, cost, summary, usage}` per
command. It drives CLI help and the unknown-command guard; the MCP server derives its tool list
from it (filtered to implemented commands) and builds argv for the **same `run()` dispatch
path** the CLI uses — MCP tools contain zero business logic; the skill is generated from
SKILL.md at build time (`scripts/generate-skill.ts` → `src/generated/skill.ts`) and tests pin
skill/registry consistency (cost hints, command coverage).

Two deliberate consequences of "MCP = argv wrapper":
- MCP-specific safety lives in the *schemas*, not in forked logic: corpus/digest-writing tools
  require `out`, `rank` defaults/caps `top`, `--quiet --compact` are forced — the underlying
  commands stay identical.
- Free-text positionals are passed after a `--` sentinel so patterns/queries beginning with
  dashes survive the shared parser.

## Alternatives considered
### Native MCP implementation (tools call internal functions directly)
- Pros: richer streaming, typed returns without envelope-in-text.
- Rejected because: two dispatch paths = two behavior surfaces to test and keep honest; the
  envelope-through-argv path means every MCP behavior is automatically covered by CLI tests.

### Registry-generated zod schemas (full automation)
- Pros: zero schema drift by construction.
- Rejected for v0.1 because: usage strings don't carry enough type information; hand-written
  schemas with consistency tests were cheaper than a schema DSL. Revisit if the command set
  grows. (Known cost: the implemented-command filter is a hardcoded list kept in sync by tests.)

## Consequences
- Adding a command is a checklist: registry entry → dispatch case → MCP list + schema → SKILL.md
  section — each step has a test that fails if skipped.
- The skill can promise costs truthfully because the hints come from the same registry the CLI
  prints.
- The `--` sentinel became part of the public CLI contract (useful beyond MCP).

Shape and diagram: [architecture.md](../architecture.md).
