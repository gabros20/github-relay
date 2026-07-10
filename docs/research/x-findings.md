# X sweep findings (xrelay, 8 queries, 246 unique tweets, 2026-07-10)

## Load-bearing facts
1. **Fake stars are rampant and cheap** — Carnegie Mellon study: ~6M fake stars across 18,617
   repos; market rate ≈ $0.45/star; a "Series A-looking" star count costs ~$2,241 on Fiverr.
   Majority of fake-star campaigns tied to spam/phishing/malware repos, not growth hacking.
   → Raw star count must NEVER be a primary ranking signal. Star VELOCITY anomalies +
   corroborating signals (dependents, contributors, release cadence) are the real test.
   (@DataChaz, @himanshustwts)
2. **Closest existing competitor: `agent-reach` (~23K stars, trending)** — one CLI, zero API keys,
   lets agents read Twitter/Reddit/GitHub/YouTube free. BUT its GitHub surface is generic
   read/search — no signal ranking, no repo-quality model, no extraction funnel. The gap we fill
   is: intent → multi-source candidate gen → signal scoring → agent-cheap deep extraction.
3. **`last30days-skill` (mvanhorn)** — searches reddit/x/youtube/hn in parallel, synthesizes one
   brief. Validates the "research funnel as a skill" pattern; nobody does this GitHub-deep.
4. **Token economy is a selling point** (RTK, Headroom trends): tools that compress what agents
   read are hot. Our tool's compact JSONL ranking output + deep-read-only-finalists is on-trend.
5. Karpathy: LLM-built personal knowledge bases = large share of his token spend → an
   `archive`/corpus feature (like x-relay's) for GitHub research sessions has real demand.

## Design implications
- Ship a **fake-star / star-anomaly heuristic** as a first-class signal (velocity spikes,
  stargazer quality if cheap) — differentiator nobody in the CLI space has.
- Position vs agent-reach: not "read GitHub" but "**research** GitHub" (rank + explain scores).
- Keep the x-relay archive/batch/dedupe pattern — corpus building is validated demand.
