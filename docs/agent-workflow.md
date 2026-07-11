# How to run a research session

> **Mode: how-to.** The recipe for turning an intent like *"best performant macOS markdown
> editor implementations with modern stack"* into 2–3 deeply-understood finalist repos, on a
> few GraphQL points. Command details live in [`commands.md`](./commands.md).

## The three golden rules

1. **Never deep-read code during exploration.** Rank on metadata; `digest`/`read` only
   finalists. Reading a repo you'll discard is the most expensive mistake in this workflow.
2. **You expand intent; the tool executes slices.** github-relay is deliberately LLM-free — it
   won't turn "modern stack" into qualifiers. That decomposition is your job (or your agent's).
3. **For fuzzy intents, web-search first and `hydrate` what humans curated.** "Best X" threads,
   awesome lists, and HN comments have better recall for subjective qualities than any keyword
   query. Keyword search finds what's *named* like your intent; humans curate what's *good at* it.

## GATE 0 — plan (free, or ~6 pts probed)

Decompose the intent into 3–6 concrete slices, then validate before spending:

```bash
ghrelay plan \
  'markdown editor language:swift stars:>50' \
  'topic:markdown topic:macos pushed:>2025-07-01' \
  'markdown editor language:rust' \
  --probe --out queries.txt
```

Over-cap slices come back pre-sharded; syntactic problems (`QUERY_TOO_COMPLEX`) surface here,
not mid-batch. Skip probing when your slices are obviously narrow.

## GATE 1 — the wide net (~9 pts, several lanes)

Run every lane that fits the intent — they're blind to each other's misses:

```bash
ghrelay batch --file queries.txt --out corpus.json         # your shards, serialized
ghrelay search --source trending --period week --language swift --out corpus.json
ghrelay code 'NSTextLayoutManager(' --lang Swift           # implementation-evidence lane
ghrelay hydrate lukakerr/Pine coteditor/CotEditor --out corpus.json   # what YOUR web search found
```

Everything dedupes into one corpus keyed by `owner/repo`. Don't read anything yet — 100–500
candidates is a fine haul.

## GATE 2 — enrich + rank (~2 pts + free)

```bash
ghrelay enrich --in corpus.json --top 50
ghrelay rank corpus.json --profile build-on --top 20 --jsonl
```

Twenty ~50-token rows with subscores, flags, `coverage`, and descriptions. Shortlist ~8 from
scores + flags + descriptions — still no code reading. Two things to use aggressively:

- **Re-weighting is free.** `--profile dissect` for parts-harvesting, `--profile ideas` for
  novelty, or `--weights` for anything custom — zero network either way.
- **Coverage is honest.** A `4/7` score isn't a `7/7` score; the header names the command that
  completes the missing groups. Don't compare scores across different coverage without noting it.

Read a suspicious row's reasoning before trusting it: `ghrelay rank corpus.json --explain owner/repo`.

## GATE 3 — verify finalists (~2 pts + 1 ClickHouse POST)

```bash
ghrelay health repo1 repo2 ... --in corpus.json   # up to ~10 survivors
ghrelay skim repo1                                 # 2 REST calls each, free on repeat
```

`health` is where star-skepticism becomes evidence: lifetime star histograms expose bursts, and
the corroboration check separates "got popular on HN" from "bought 20k stars" —
`possible-fake-stars` only fires when a burst coincides with zero engagement. `skim` gives the
structural picture (tests? CI? examples? real docs?) for the cost of two cached calls. Cut to 2–3.

## GATE 4 — deep read (1 request per survivor)

```bash
ghrelay digest winner/repo --include 'src/**' --include 'README*' --max-tokens 20000 --out winner.md
ghrelay read winner/repo src/core/editor.swift --max-chars 6000   # targeted follow-ups, cached
```

Read the digest file selectively. `--list` first if you want to negotiate the include set
before spending the tarball request.

## Budget discipline

```bash
ghrelay budget --forecast 'enrich:2,skim:8,digest:3'   # can I afford this session?
ghrelay doctor                                          # anything degraded today?
```

A full session ≈ 18 GraphQL points of 5,000/hr. The binding constraints are *not* points —
they're serialization (built in: batches are strictly sequential) and the GraphQL execution
timeout (built in: adaptive bisection with learned ceilings). ETags make repeat research nearly
free: a re-run of yesterday's session mostly 304s.

## Iterating across sessions

The corpus is the session memory. It stores the intent, every query, and per-signal provenance —
so tomorrow's follow-up is:

```bash
ghrelay batch --file new-shards.txt --out corpus.json   # top-up, merge not clobber
ghrelay enrich --in corpus.json --stale-ok              # only refresh what's stale
ghrelay rank corpus.json --profile dissect --top 10     # same data, new lens
```

## Failure playbook

| Symptom | Move |
|---------|------|
| `RATE_LIMITED` | Sleep `retryAfterMs` exactly; `batch` already does this between queries |
| `RESULT_CAP` warning on search | Use the embedded shard hint, or `plan --probe` the query |
| `SOURCE_DOWN` on a third party | Proceed — the signal degraded visibly; retry that lane later |
| Coverage stuck below 7/7 | Run the command the rank header names (usually `enrich` or `health`) |
| Everything failing | `ghrelay doctor` — token, pools, and feature probes in one shot |
