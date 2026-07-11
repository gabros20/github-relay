# ADR-002: Zero paid APIs; goodwill lanes degrade visibly, never abort

## Status
Accepted

## Date
2026-07-10 (design panel), hardened 2026-07-11 (enrich fix wave)

## Context
The tool is single-user and personal; recurring API bills are out. But GitHub's free tier alone
can't provide real-usage evidence (dependents, downloads) or lifetime star history — those live
in free community services: ecosyste.ms, deps.dev, the ClickHouse GH Archive playground,
OSS Insight, grep.app. These endpoints have no SLA, rate-limit unpredictably, and occasionally
return garbage. A naive integration makes them load-bearing; the first ecosyste.ms 429 then
destroys a whole enrichment run (this exact bug shipped and was caught in review: one 429
discarded all fetched work).

## Decision
1. **Zero paid APIs, one credential total** (a free zero-permission GitHub PAT). Optional-key
   lanes (Exa, Firecrawl) are specced for v0.2 but nothing depends on them.
2. **Two failure regimes.** Our own bugs and bad input **fail loud** (typed errors, actionable
   hints, no silent nulls). Goodwill-service failures **degrade per-repo, visibly**: the signal
   becomes `nodata`/`fCoverage:"partial"`, coverage drops on the affected row, the run
   continues, and completed work always persists. `INVALID_INPUT` is the one error that never
   degrades — that's our bug and must surface.
3. **Every goodwill lane is a single-endpoint adapter** with a documented downgrade path;
   grep.app additionally gets a persistent circuit breaker. None of GATES 1–2–4 depends on any
   of them — the core funnel runs on GitHub + the PAT alone.
4. **Politeness is engineering, not etiquette**: strict serialization everywhere, mailto UA for
   the polite pools, honored `retryAfterMs`, ETag revalidation as the default refresh path.

## Alternatives considered
### Paid tier of one aggregator (e.g. Libraries.io key)
- Pros: SLA, single dependency.
- Rejected because: recurring cost for a personal tool; key management friction; the free
  portfolio covers the same signals with redundancy.

### Fail-fast on any source failure
- Pros: simpler; no partial states.
- Rejected because: goodwill outages are *routine*, and discarding paid-for GraphQL work over a
  bonus lane's hiccup inverts the cost hierarchy. Coverage-honest partial results are strictly
  more useful.

## Consequences
- Scoring must renormalize over missing groups and expose `coverage` — honesty becomes a
  first-class output, not a nicety.
- `doctor` narrates the whole portfolio's health so degraded sessions are explainable.
- The B-group (real usage) needs a fallback chain (ecosyste.ms → deps.dev → `packaged:false`)
  and per-signal provenance so consumers can see which rung supplied a number and how stale it is.

Failure regimes in practice: [architecture.md — Failure philosophy](../architecture.md).
