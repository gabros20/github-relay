# Orchestrate run — GitHub repo-scout research & design

- **Date**: 2026-07-10
- **Task**: Research + design plan for a new GitHub/public-repo search & signal-ranking tool
  (in the spirit of x-relay and youtube-context: CLI + MCP shim + generated skill, funnel workflow,
  JSON envelope, local cache, free/no-paid-API, agent-first).
- **Deliverable**: implementation plan document (no code yet).

## Resolved dimensions
- strategy=workflow (research fan-out) → adversarial judge-panel (design) → synthesis, controller in the loop between runs
- planning=plan-first · review=adversarial-verify on design (skeptic attack) · engine=claude
- models: inherit session model for all agents (research + judging both need strong reasoning)
- isolation=none (read-only research, no file mutation)
- trigger=once · budget: ≤24 agents total (≈10 research + ≤8 panel/skeptic/synthesis + slack)

## Phases
1. **Prime** — deep-read x-relay + youtube-context for reusable design DNA (workflow 1)
2. **Research** — GitHub APIs, code-search alternatives, bulk datasets, quality signals, anti-blocking, gap analysis, agent-tool design (workflow 1); X sweep via xrelay done inline by controller (serialized tool, must not run in fleet)
3. **Design debate** — judge panel of 3 architect lenses + skeptic refutation + synthesis (workflow 2)
4. **Plan** — controller writes final implementation plan

## Ledger
- [x] workflow 1: prime + research — wf_2fd50f2f-6f2, 10/10 agents ok, 549K tokens; raw results:
      /private/tmp/claude-501/-Users-tamas/0e57fac1-58ba-414b-a0cd-e6c6b3480bc8/tasks/w42qozm7l.output
      + journal at subagents/workflows/wf_2fd50f2f-6f2/journal.jsonl
- [x] inline: xrelay X sweep — 8 queries, 246 tweets → x-findings.md (fake-star CMU study, agent-reach gap)
- [ ] workflow 2 (wf_a1d6097e-eea): digest → research-digest.md, 3 architects (pragmatist /
      ranking-engine / agent-interface), 2 skeptics (feasibility / value), synthesis
- [ ] final plan written (deliverable location TBD — likely new project folder under
      ~/Documents/Personal/Projects/)
