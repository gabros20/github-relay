# ADR-001: Raw stars never rank; license classifies but never filters

## Status
Accepted

## Date
2026-07-10 (design panel), recorded 2026-07-11

## Context
Star counts are the industry-default quality proxy and the most gameable signal on GitHub: a
Carnegie Mellon study found ~6M fake stars across 18,000+ repos at a market rate of ~$0.45/star,
with most campaigns attached to spam/malware repos. Meanwhile, tools that filter by license
silently hide repos a researcher may legitimately want to *study or dissect* — for a personal
research tool, remixing and learning are always in scope regardless of license.

## Decision
1. **Raw star counts are never a scoring input.** Stars may gate enrichment *order* (`--top`
   selects highest-star unenriched rows) and feed *derived* signals (stars-per-month,
   forks/stars ratio, burstiness of the star time-series), but no scoring group reads the raw
   count.
2. **Fake-star detection needs corroboration to punish.** A star burst alone produces a flag
   (`star-burst`); the `possible-fake-stars` penalty (×0.5) fires only when burstiness > 0.5
   coincides with near-zero engagement on a non-trivial, non-new repo — and a
   viral-corroboration check (release + issue influx + fork growth in the burst window)
   downgrades the verdict to `likely-viral`.
3. **License is classification metadata** (permissive / weak-copyleft / strong-copyleft / none /
   custom), reported on every row, weighted only where a profile says (L=10 max in `build-on`,
   L=0 in `dissect`/`ideas`) — **no code path may drop a repo by license**.

## Alternatives considered
### Rank on stars with a dampening curve
- Pros: simple, matches user intuition.
- Rejected because: dampening doesn't fix a *purchasable* input; it just discounts honest repos
  equally with dishonest ones.

### Filter by permissive licenses by default
- Pros: "safe to build on" out of the box.
- Rejected because: hides study/dissection targets; license risk is a *decision for the human*,
  not the ranking layer. Classification + visibility serves both use cases.

### Stargazer-account forensics (bot-profile detection)
- Pros: strongest fraud signal in the literature.
- Rejected because: no costed fetch path exists within free-tier rate limits at the repo sizes
  where it matters (cut in the design panel's fatal-flaw ledger).

## Consequences
- The tool needs a star-history source: lifetime monthly WatchEvent histograms from the public
  ClickHouse GH Archive mirror (one POST per finalist set) became a load-bearing lane.
- Rankings can disagree with GitHub's own popularity ordering — by design; `--explain` exists so
  the disagreement is auditable.
- Every rank row reports the license class even in L=0 profiles, so the information is never
  hidden, only unweighted.

Full scoring model: [DESIGN-v1.0.md §5](../DESIGN-v1.0.md).
