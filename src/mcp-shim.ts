#!/usr/bin/env node
// ─── github-relay-mcp MCP shim ────────────────────────────────────────────
// Thin @modelcontextprotocol/sdk stdio server exposing one tool per
// IMPLEMENTED command (registry-driven — plan/code/health are milestone B
// roadmap items, registry-listed but excluded from the MCP surface). Zero
// business logic: each tool builds a CLI argv array and calls the SAME
// run() path the CLI dispatches through (forced --quiet so no stderr
// progress leaks into the stdio transport, forced --compact for the
// cheapest agent-facing JSON) — envelope shape, error codes, and dispatch
// semantics are identical between the CLI and MCP surfaces by construction,
// never re-implemented here. digest/search/batch write their corpus/digest
// output to disk rather than returning it inline — their zod schemas
// REQUIRE `out` so nothing large ever transits the model (design §2); digest
// additionally always requires it, even in --list mode.
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { type Cache, createCache } from './cache/index.ts';
import { run } from './cli.ts';
import { COMMANDS, type CommandDef } from './commands/registry.ts';
import { shouldRunAsEntry } from './entry.ts';
import { type Sources, createSources } from './sources/index.ts';

// ── lazy shared Sources/Cache (design §2: lazy memoized sources) ──────────
// Constructed on first tool call, not at module load — a keyless-only
// session never resolves a token, and the stdio server starts instantly.

let sharedSources: Sources | undefined;
function getSources(): Sources {
  sharedSources ??= createSources();
  return sharedSources;
}

let sharedCache: Cache | undefined;
function getCache(): Cache {
  sharedCache ??= createCache();
  return sharedCache;
}

// ── implemented-command filter (registry-driven) ──────────────────────────

const IMPLEMENTED_COMMAND_NAMES = new Set([
  'search',
  'batch',
  'hydrate',
  'enrich',
  'rank',
  'skim',
  'read',
  'digest',
  'budget',
  'doctor',
  'cache',
]);

/**
 * Only the registered commands that actually dispatch. plan/code/health are
 * milestone B (design §10) — registry-listed for CLI help/skill-generation
 * completeness, but they'd only ever return UNKNOWN_COMMAND ("not yet
 * implemented") over MCP, so they're filtered out of the tool surface here
 * rather than exposed as a broken tool.
 */
export function implementedCommands(): CommandDef[] {
  return COMMANDS.filter((c) => IMPLEMENTED_COMMAND_NAMES.has(c.name));
}

function findCommand(name: string): CommandDef {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) throw new Error(`registry missing command '${name}' — mcp-shim/registry drift`);
  return found;
}

/** Tool description: summary + the registry's funnel-cost hint, so the cost signal that steers the CLI funnel (design §3) also steers tool selection. */
function describe(name: string): string {
  const cmd = findCommand(name);
  return `${cmd.summary} COST: ${cmd.cost}.`;
}

// ── argv-building (pure, exported for direct testing) ─────────────────────

export type ToolArgs = Record<string, unknown>;

function pushFlag(argv: string[], name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  argv.push(`--${name}`, String(value));
}

function pushBool(argv: string[], name: string, present: unknown): void {
  if (present === true) argv.push(`--${name}`);
}

function pushRepeatable(argv: string[], name: string, values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const v of values) argv.push(`--${name}`, String(v));
}

export function buildSearchArgv(args: ToolArgs): string[] {
  // Flags first, then the standard "--" end-of-flags sentinel, then the
  // free-text query verbatim — a query that itself starts with "--" (e.g.
  // "--force push workflows") must never be misread as a flag attempt and
  // silently dropped (fix wave 1, Important 2). "--" must come LAST in the
  // argv (right before the positional it protects): parseArgs treats every
  // token after the first "--" as positional, so any flag placed after it
  // would stop being recognized as a flag too.
  const argv = ['search'];
  pushFlag(argv, 'source', args.source);
  pushFlag(argv, 'limit', args.limit);
  pushRepeatable(argv, 'language', args.language);
  pushRepeatable(argv, 'topic', args.topic);
  pushFlag(argv, 'stars', args.stars);
  pushFlag(argv, 'created', args.created);
  pushFlag(argv, 'pushed', args.pushed);
  pushFlag(argv, 'sort', args.sort);
  pushFlag(argv, 'out', args.out);
  argv.push('--', String(args.query ?? ''));
  return argv;
}

export function buildBatchArgv(args: ToolArgs): string[] {
  const argv = ['batch'];
  pushFlag(argv, 'file', args.file);
  pushFlag(argv, 'out', args.out);
  pushFlag(argv, 'delay', args.delay);
  return argv;
}

export function buildHydrateArgv(args: ToolArgs): string[] {
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  const argv = ['hydrate', ...ids];
  pushFlag(argv, 'out', args.out);
  return argv;
}

export function buildEnrichArgv(args: ToolArgs): string[] {
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  const argv = ['enrich', ...ids];
  pushFlag(argv, 'in', args.in);
  pushFlag(argv, 'top', args.top);
  pushBool(argv, 'skip-deps', args.skipDeps);
  pushBool(argv, 'stale-ok', args.staleOk);
  return argv;
}

export function buildRankArgv(args: ToolArgs): string[] {
  // Flags first, then "--", then the corpus path verbatim — see the note in
  // buildSearchArgv on why "--" must be last (fix wave 1, Important 2).
  const argv = ['rank'];
  pushFlag(argv, 'profile', args.profile);
  pushFlag(argv, 'weights', args.weights);
  pushFlag(argv, 'top', args.top);
  pushFlag(argv, 'min-score', args.minScore);
  pushFlag(argv, 'explain', args.explain);
  pushBool(argv, 'jsonl', args.jsonl);
  argv.push('--', String(args.corpusPath ?? ''));
  return argv;
}

export function buildSkimArgv(args: ToolArgs): string[] {
  const argv = ['skim'];
  pushFlag(argv, 'max-chars', args.maxChars);
  pushBool(argv, 'tree-only', args.treeOnly);
  pushFlag(argv, 'in', args.in);
  argv.push('--', String(args.repo ?? ''));
  return argv;
}

export function buildReadArgv(args: ToolArgs): string[] {
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
  const argv = ['read'];
  pushFlag(argv, 'ref', args.ref);
  pushFlag(argv, 'max-chars', args.maxChars);
  argv.push('--', String(args.repo ?? ''), ...paths);
  return argv;
}

export function buildDigestArgv(args: ToolArgs): string[] {
  const argv = ['digest'];
  pushFlag(argv, 'ref', args.ref);
  pushRepeatable(argv, 'include', args.include);
  pushRepeatable(argv, 'exclude', args.exclude);
  pushFlag(argv, 'max-tokens', args.maxTokens);
  pushFlag(argv, 'out', args.out);
  pushBool(argv, 'list', args.list);
  argv.push('--', String(args.repo ?? ''));
  return argv;
}

export function buildBudgetArgv(args: ToolArgs): string[] {
  const argv = ['budget'];
  pushFlag(argv, 'forecast', args.forecast);
  return argv;
}

export function buildDoctorArgv(args: ToolArgs): string[] {
  const argv = ['doctor'];
  pushBool(argv, 'offline', args.offline);
  return argv;
}

export function buildCacheArgv(args: ToolArgs): string[] {
  const argv = ['cache', String(args.subcommand ?? '')];
  pushFlag(argv, 'older-than', args.olderThan);
  pushBool(argv, 'confirm', args.confirm);
  return argv;
}

// ── zod input schemas (exported for require-out enforcement tests) ────────

const SOURCE_ENUM = z.enum(['gh', 'rest', 'trending']);
const SORT_ENUM = z.enum(['stars', 'updated']);
const PROFILE_ENUM = z.enum(['build-on', 'dissect', 'ideas']);
const CACHE_SUBCOMMAND_ENUM = z.enum(['stats', 'clear', 'gc']);

export const SEARCH_INPUT = {
  query: z
    .string()
    .describe('free-text query; language/topic/stars/created/pushed become qualifiers folded in'),
  source: SOURCE_ENUM.optional(),
  limit: z.number().int().positive().max(100).optional(),
  language: z.array(z.string()).optional(),
  topic: z.array(z.string()).optional(),
  stars: z.string().describe("range, e.g. '>100', '10..500', '50..*'").optional(),
  created: z.string().describe("ISO date/range, e.g. '>2024-01-01'").optional(),
  pushed: z.string().describe('ISO date/range').optional(),
  sort: SORT_ENUM.optional(),
  out: z.string().describe('REQUIRED — corpus.json path; nothing large transits the model'),
};

export const BATCH_INPUT = {
  file: z.string().describe('path to a newline-delimited query file (# comments skipped)'),
  out: z.string().describe('REQUIRED — corpus.json path; merges incrementally on re-runs'),
  delay: z.number().int().nonnegative().describe('ms between queries (default 2000)').optional(),
};

export const HYDRATE_INPUT = {
  ids: z
    .array(z.string())
    .min(1)
    .describe('owner/repo ids found elsewhere — web search, awesome lists, HN/Reddit threads'),
  out: z
    .string()
    .describe('corpus.json path to merge into (omit to get compact rows back)')
    .optional(),
};

export const ENRICH_INPUT = {
  in: z.string().describe('REQUIRED — corpus.json to deepen (written in place)'),
  ids: z
    .array(z.string())
    .describe('restrict to these owner/repo ids (default: --top selection)')
    .optional(),
  top: z
    .number()
    .int()
    .nonnegative()
    .describe('take the N highest-star unenriched rows')
    .optional(),
  skipDeps: z.boolean().describe('skip the ecosyste.ms/deps.dev B-group fallback chain').optional(),
  staleOk: z.boolean().describe('include rows already enriched within the last 7 days').optional(),
};

export const RANK_INPUT = {
  corpusPath: z.string().describe('REQUIRED — corpus.json to score (offline, zero network)'),
  profile: PROFILE_ENUM.optional(),
  weights: z.string().describe("override, e.g. 'A=25,B=20,C=15,...'").optional(),
  // Defaulted + capped over MCP (fix wave 1, Critical 1): a large corpus
  // ranked with no --top would otherwise return EVERY row in one tool
  // result (a 500-repo corpus was ~36,650 tokens, live-confirmed) — nothing
  // like this exists on the CLI side, where an unbounded --top-less rank is
  // a deliberate, explicit choice a human/script makes. The default (20)
  // matches the registry's own `[--top 20]` usage hint; the CLI itself
  // stays unbounded by default, since capping it would be a command-layer
  // behavior change outside this task's scope.
  top: z.number().int().nonnegative().max(100).default(20),
  minScore: z.number().optional(),
  explain: z
    .string()
    .describe("owner/repo — print that one row's full saturation + penalty trail")
    .optional(),
  jsonl: z.boolean().describe('emit one JSON row per line instead of a rows array').optional(),
};

export const SKIM_INPUT = {
  repo: z.string().describe('owner/repo'),
  maxChars: z.number().int().positive().describe('README head length cap').optional(),
  treeOnly: z.boolean().describe('skip the README fetch').optional(),
  in: z.string().describe('corpus.json to write the E-group skim signals into').optional(),
};

export const READ_INPUT = {
  repo: z.string().describe('owner/repo'),
  paths: z.array(z.string()).min(1).describe('file paths to read'),
  ref: z.string().describe('branch/tag/SHA (default: the default branch HEAD)').optional(),
  maxChars: z.number().int().positive().optional(),
};

export const DIGEST_INPUT = {
  repo: z.string().describe('owner/repo'),
  ref: z.string().describe('branch/tag/SHA (default: the default branch HEAD)').optional(),
  include: z
    .array(z.string())
    .describe('glob(s) to keep (default: everything not excluded)')
    .optional(),
  exclude: z
    .array(z.string())
    .describe('glob(s) to drop, in addition to the default excludes')
    .optional(),
  maxTokens: z
    .number()
    .int()
    .positive()
    .describe('hard token cap on the digest (default 20000)')
    .optional(),
  out: z
    .string()
    .describe('REQUIRED — digest.md path; a whole-repo digest never transits the model inline'),
  list: z.boolean().describe('dry-run: list the included paths only, write nothing').optional(),
};

export const BUDGET_INPUT = {
  forecast: z
    .string()
    .describe("e.g. 'enrich:2,skim:8,digest:3' — can I afford this plan now")
    .optional(),
};

export const DOCTOR_INPUT = {
  offline: z
    .boolean()
    .describe('skip live network checks (still resolves the token locally)')
    .optional(),
};

export const CACHE_INPUT = {
  subcommand: CACHE_SUBCOMMAND_ENUM,
  olderThan: z.string().describe("gc only: e.g. '30d', '12h', '90m' (default 30d)").optional(),
  confirm: z.boolean().describe('clear only: required to actually wipe the cache').optional(),
};

// ── execution ───────────────────────────────────────────────────────────

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/**
 * Run a built argv through the SAME run() path the CLI uses (`src/cli.ts`),
 * with the injected Sources/Cache — the pure, directly-testable seam.
 * `--quiet` and `--compact` are forced onto every call: quiet keeps stderr
 * progress out of the stdio transport, compact keeps the JSON cheap on
 * tokens. Error envelopes (ok:false) come back as ORDINARY tool results
 * (isError:true), never MCP protocol errors — the agent sees the full
 * {code, message, hint, retryAfterMs?} the CLI would print.
 */
export async function executeToolWith(
  sources: Sources,
  cache: Cache,
  argv: string[],
): Promise<ToolResult> {
  const full = [...argv, '--quiet', '--compact'];
  const { stdout, exitCode } = await run(full, sources, '', cache);
  return { content: [{ type: 'text', text: stdout }], isError: exitCode !== 0 };
}

async function executeTool(argv: string[]): Promise<ToolResult> {
  return executeToolWith(getSources(), getCache(), argv);
}

// ── MCP server construction ─────────────────────────────────────────────

function buildServer(): McpServer {
  const require = createRequire(import.meta.url);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require of package.json
  const pkg = require('../package.json') as any;
  const server = new McpServer({ name: 'github-relay-mcp', version: String(pkg.version) });

  server.registerTool(
    'search',
    { description: describe('search'), inputSchema: SEARCH_INPUT },
    async (args) => executeTool(buildSearchArgv(args)),
  );

  server.registerTool(
    'batch',
    { description: describe('batch'), inputSchema: BATCH_INPUT },
    async (args) => executeTool(buildBatchArgv(args)),
  );

  server.registerTool(
    'hydrate',
    { description: describe('hydrate'), inputSchema: HYDRATE_INPUT },
    async (args) => executeTool(buildHydrateArgv(args)),
  );

  server.registerTool(
    'enrich',
    { description: describe('enrich'), inputSchema: ENRICH_INPUT },
    async (args) => executeTool(buildEnrichArgv(args)),
  );

  server.registerTool(
    'rank',
    { description: describe('rank'), inputSchema: RANK_INPUT },
    async (args) => executeTool(buildRankArgv(args)),
  );

  server.registerTool(
    'skim',
    { description: describe('skim'), inputSchema: SKIM_INPUT },
    async (args) => executeTool(buildSkimArgv(args)),
  );

  server.registerTool(
    'read',
    { description: describe('read'), inputSchema: READ_INPUT },
    async (args) => executeTool(buildReadArgv(args)),
  );

  server.registerTool(
    'digest',
    { description: describe('digest'), inputSchema: DIGEST_INPUT },
    async (args) => executeTool(buildDigestArgv(args)),
  );

  server.registerTool(
    'budget',
    { description: describe('budget'), inputSchema: BUDGET_INPUT },
    async (args) => executeTool(buildBudgetArgv(args)),
  );

  server.registerTool(
    'doctor',
    { description: describe('doctor'), inputSchema: DOCTOR_INPUT },
    async (args) => executeTool(buildDoctorArgv(args)),
  );

  server.registerTool(
    'cache',
    { description: describe('cache'), inputSchema: CACHE_INPUT },
    async (args) => executeTool(buildCacheArgv(args)),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

// Fail-loud: when the runtime gives no definitive answer and the invocation
// looks like our binary, run anyway (after a stderr warning) — never silently
// exit 0 under the npm bin symlink.
const entry = shouldRunAsEntry(process.argv[1], import.meta.url, import.meta.main, [
  'github-relay-mcp',
  'mcp-shim.js',
]);
if (entry.warning !== undefined) process.stderr.write(`${entry.warning}\n`);
if (entry.run) void main();
