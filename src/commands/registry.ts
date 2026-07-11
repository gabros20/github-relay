// Single source of truth for command definitions. Drives CLI help/dispatch and
// skill generation. Cost is a funnel hint string (design §3) — it tells the
// agent what a command spends BEFORE it runs it, so cheap discovery always
// happens before expensive extraction. Command logic itself lands in later
// tasks; this scaffold registers all 14 so help/skill generation is complete
// now, while dispatch (src/cli.ts) wires only the implemented ones.

export interface CommandDef {
  name: string;
  /** Funnel cost hint shown in help + skill (e.g. "cheap — the net"). */
  cost: string;
  summary: string;
  usage: string;
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'plan',
    cost: 'free local / --probe: 1 pt per slice, auto-sharding can multiply — capped by --max-probes (default 30)',
    summary:
      'Validate agent-written query slices against GitHub search limits before spending anything.',
    usage:
      'ghrelay plan <slices...> [--dry] [--probe] [--shard stars|created] [--max-probes 30] ' +
      '[--out queries.txt]',
  },
  {
    name: 'search',
    cost: 'cheap — 1 GraphQL point per 100 results',
    summary: 'The wide discovery net — pre-enriched repo search. Rank on this before enrich.',
    usage:
      'ghrelay search <query> [--source gh|rest|trending] [--limit 30] [--language X --topic Y ' +
      '--stars A..B --created R --pushed R --sort stars|updated] [--fields ...] [--out corpus.json]',
  },
  {
    name: 'batch',
    cost: 'N points, strictly serialized',
    summary:
      'Run many search queries from a file, serialized with a delay, merged into one corpus.',
    usage: 'ghrelay batch --file queries.txt --out corpus.json [--delay 2000] [--dry-run]',
  },
  {
    name: 'hydrate',
    cost: '~1 GraphQL point per 50 ids',
    summary:
      'Ingest candidate owner/repo ids the agent found elsewhere (web search, awesome lists).',
    usage: 'ghrelay hydrate <owner/repo...> [--out corpus.json] [-]',
  },
  {
    name: 'code',
    cost: 'free — grep.app lane',
    summary:
      'Code-token/regex evidence search across ~1M top repos. Not for natural-language intent.',
    usage: 'ghrelay code <pattern> [--lang X --repo o/r --path P] [--limit 20]',
  },
  {
    name: 'enrich',
    cost: '~2-4 GraphQL points per 50 repos + zero-quota third parties',
    summary:
      'Deepen a corpus with the ~15-signal fragment plus the ecosyste.ms/deps.dev fallback chain.',
    usage: 'ghrelay enrich --in corpus.json [ids...] [--top 50] [--skip-deps] [--stale-ok]',
  },
  {
    name: 'rank',
    cost: 'free — offline, zero network',
    summary:
      'Score a corpus offline on 7 signal groups; compact rows with coverage + explainability.',
    usage:
      'ghrelay rank <corpus.json> [--profile build-on|dissect|ideas] [--weights A=25,B=20,...] ' +
      '[--top 20] [--min-score N] [--explain owner/repo] [--jsonl]',
  },
  {
    name: 'health',
    cost: '1 heavy GraphQL point per <=10 ids + 1 ClickHouse POST + 1 REST call per id',
    summary:
      'Forensics on finalists — issue latency, star-velocity burstiness, bus factor. Re-scores C/D/F.',
    usage: 'ghrelay health <ids...>',
  },
  {
    name: 'skim',
    cost: '2 REST core calls (cached: 0)',
    summary: 'A repo tree inventory + README head — the cheap structural peek before a full read.',
    usage: 'ghrelay skim <owner/repo> [--max-chars 4000] [--tree-only] [--in corpus.json]',
  },
  {
    name: 'read',
    cost: '1 REST call per uncached file',
    summary:
      'Read specific files by path, content-addressed and cached; missing path is a clean ok:true.',
    usage: 'ghrelay read <owner/repo> <paths...> [--ref SHA] [--max-chars 6000]',
  },
  {
    name: 'digest',
    cost: 'expensive — 1 tarball request (or 0-quota blobless clone)',
    summary:
      'Full gitingest-style repo digest, filtered and token-capped. Only for confirmed finalists.',
    usage:
      'ghrelay digest <owner/repo> [--ref SHA] [--include/--exclude glob] [--max-tokens 20000] ' +
      '[--out digest.md] [--list]',
  },
  {
    name: 'budget',
    cost: 'free (+1 free GET /rate_limit)',
    summary:
      'Report remaining headroom across every pool (GraphQL, REST, ecosyste.ms, OSS Insight, grep.app).',
    usage: "ghrelay budget [--forecast 'enrich:2,skim:8,digest:3']",
  },
  {
    name: 'doctor',
    cost: 'free / <15s live',
    summary: 'Self-diagnosis: token validity, pool reachability, feature probes. Always ok:true.',
    usage: 'ghrelay doctor [--offline]',
  },
  {
    name: 'cache',
    cost: 'free, local',
    summary:
      'Inspect or clear the local ~/.ghrelay cache (etags, blobs, trees, tarballs, corpora).',
    usage: 'ghrelay cache stats|clear|gc [--older-than 30d] [--confirm]',
  },
];

export const commandNames: string[] = COMMANDS.map((c) => c.name);
