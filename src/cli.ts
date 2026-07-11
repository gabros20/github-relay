// ─── ghrelay CLI ──────────────────────────────────────────────────────────
// Parses args, dispatches a command against injected Sources, prints a JSON
// envelope to stdout. `run()` is pure and testable: it never touches
// process.exit itself — main() below owns that translation. This module is a
// pure library surface with NO top-level side effects (see the note below
// main()) — the actual `ghrelay` bin entry point is src/cli-entry.ts.
import { type Cache, createCache } from './cache/index.ts';
import { batchOptsFromArgs, runBatch } from './commands/batch.ts';
import { budgetOptsFromArgs, runBudget } from './commands/budget.ts';
import { cacheOptsFromArgs, runCache } from './commands/cache.ts';
import { digestOptsFromArgs, runDigest } from './commands/digest.ts';
import { doctorOptsFromArgs, runDoctor } from './commands/doctor.ts';
import { enrichOptsFromArgs, runEnrich } from './commands/enrich.ts';
import { hydrateOptsFromArgs, runHydrate } from './commands/hydrate.ts';
import { planOptsFromArgs, runPlan } from './commands/plan.ts';
import { rankOptsFromArgs, runRank } from './commands/rank.ts';
import { readOptsFromArgs, runRead } from './commands/read.ts';
import { commandNames } from './commands/registry.ts';
import { COMMANDS } from './commands/registry.ts';
import { guard } from './commands/runners.ts';
import { runSearch, searchOptsFromArgs } from './commands/search.ts';
import { runSkim, skimOptsFromArgs } from './commands/skim.ts';
import { err, toJson } from './output.ts';
import { type Sources, createSources } from './sources/index.ts';
import type { Envelope } from './types.ts';

// ── Sources ──────────────────────────────────────────────────────────────
// The injectable adapter bag is the concrete interface from
// src/sources/index.ts (gh-graphql/gh-rest/ecosystems/depsdev). Command
// runners narrow what they need from it. `search`/`batch`/`hydrate` are wired
// below (task 4); the rest still fall through to "not yet implemented"
// (tasks 5-13).

// ── Flag tables ──────────────────────────────────────────────────────────
// Value flags consume the following token (repeatable — each occurrence
// pushes onto flags[name]). Bool flags consume nothing. SHORT_FLAGS maps a
// single-letter alias to its full value-flag name.

const VALUE_FLAGS = new Set([
  'shard',
  'out',
  'source',
  'limit',
  'language',
  'topic',
  'stars',
  'created',
  'pushed',
  'sort',
  'fields',
  'file',
  'delay',
  'lang',
  'repo',
  'path',
  'in',
  'top',
  'profile',
  'weights',
  'min-score',
  'explain',
  'max-chars',
  'ref',
  'max-tokens',
  'include',
  'exclude',
  'forecast',
  'older-than',
]);

const BOOL_FLAGS = new Set([
  'dry',
  'probe',
  'dry-run',
  'skip-deps',
  'stale-ok',
  'jsonl',
  'tree-only',
  'list',
  'offline',
  'confirm',
  'quiet',
  'compact',
  'help',
]);

/** Single-dash aliases → full value-flag name. */
const SHORT_FLAGS: Record<string, string> = { o: 'out', q: 'quiet' };

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string[]>;
  bools: Set<string>;
}

/**
 * Try to read `argv[i]` as a flag, mutating `flags`/`bools` in place.
 * Returns how many tokens the flag consumed (1 for a bare flag name, 2 when
 * a value flag also consumed the following token as its value), or 0 when
 * `argv[i]` isn't a recognized flag at all — the caller then falls through
 * to treating it as a command/positional instead. Split out of parseArgs
 * purely to keep the loop's cognitive complexity down; no behavior change.
 */
function consumeFlagToken(
  argv: string[],
  i: number,
  flags: Record<string, string[]>,
  bools: Set<string>,
): number {
  const token = argv[i] as string;
  const name = token.startsWith('--')
    ? token.slice(2)
    : token.startsWith('-') && token.length > 1
      ? SHORT_FLAGS[token.slice(1)]
      : undefined;
  if (name === undefined) return 0;

  if (BOOL_FLAGS.has(name)) {
    bools.add(name);
    return 1;
  }
  if (VALUE_FLAGS.has(name)) {
    const value = argv[i + 1];
    if (value === undefined) return 1;
    const existing = flags[name] ?? [];
    existing.push(value);
    flags[name] = existing;
    return 2;
  }
  // Unrecognized flag names are dropped, not swallowed as positionals — a
  // typo should fail loudly downstream, not silently pollute args.
  return 1;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  let command: string | undefined;
  // Standard end-of-flags sentinel: a literal "--" token stops flag parsing
  // for every token after it — each becomes a positional verbatim, even one
  // that starts with "--" itself. Without this, a free-text positional like
  // an MCP-supplied search query beginning with "--" (e.g. "--force push
  // workflows") is misread as an attempt at an unrecognized flag and silently
  // dropped entirely (fix wave 1, Important 2) rather than reaching the
  // command as its actual text. Only the FIRST "--" toggles this — a second
  // one afterward is itself just an ordinary verbatim positional, matching
  // shell convention.
  let endOfFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (!endOfFlags && token === '--') {
      endOfFlags = true;
      continue;
    }

    if (!endOfFlags) {
      const consumed = consumeFlagToken(argv, i, flags, bools);
      if (consumed > 0) {
        i += consumed - 1;
        continue;
      }
    }

    if (command === undefined) command = token;
    else positionals.push(token);
  }

  return { command, positionals, flags, bools };
}

// ── help ─────────────────────────────────────────────────────────────────

function helpText(): string {
  const lines = ['ghrelay — research GitHub, not read GitHub', '', 'Commands:'];
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(9)} ${cmd.summary}  [${cmd.cost}]`);
  }
  lines.push('', 'Run a command with no args to see its usage in SKILL.md.');
  return lines.join('\n');
}

// ── dispatch ─────────────────────────────────────────────────────────────

/**
 * Dispatch a parsed command against Sources. search/batch/hydrate (task 4),
 * enrich/rank (task 5), skim/read/digest (task 6), budget/doctor/cache
 * (task 7), and plan (task 9) are wired to their runners, each wrapped in
 * `guard()` so an EngineError becomes a per-code envelope. Every other
 * registered command still falls through to a clear "not yet implemented"
 * envelope (code/health — milestone B). A name outside the registry gets the
 * same UNKNOWN_COMMAND code with a different message, so the CLI's exit-code
 * rule (`error.code === 'UNKNOWN_COMMAND' → exit 2`) covers both cases
 * uniformly.
 */
export function dispatch(
  parsed: ParsedArgs,
  sources: Sources,
  stdin: string,
  cache: Cache = createCache(),
): Promise<Envelope<unknown>> {
  const { command } = parsed;
  if (command === undefined || !commandNames.includes(command)) {
    return Promise.resolve(
      err(
        'cli',
        'UNKNOWN_COMMAND',
        `unknown command: ${command ?? '(none)'}`,
        'run `ghrelay --help`',
      ),
    );
  }
  switch (command) {
    case 'plan':
      return guard('plan', () => runPlan(sources, cache, planOptsFromArgs(parsed), stdin));
    case 'search':
      return guard('search', () => runSearch(sources, cache, searchOptsFromArgs(parsed)));
    case 'batch':
      return guard('batch', () => runBatch(sources, cache, batchOptsFromArgs(parsed)));
    case 'hydrate':
      return guard('hydrate', () => runHydrate(sources, cache, hydrateOptsFromArgs(parsed), stdin));
    case 'enrich':
      return guard('enrich', () => runEnrich(sources, cache, enrichOptsFromArgs(parsed)));
    case 'rank':
      // rank is offline: it never receives Sources — enforced by runRank's
      // signature taking only opts (design §3.7, zero network).
      return guard('rank', () => Promise.resolve(runRank(rankOptsFromArgs(parsed))));
    case 'skim':
      return guard('skim', () => runSkim(sources, cache, skimOptsFromArgs(parsed)));
    case 'read':
      return guard('read', () => runRead(sources, cache, readOptsFromArgs(parsed)));
    case 'digest':
      return guard('digest', () => runDigest(sources, cache, digestOptsFromArgs(parsed)));
    case 'budget':
      return guard('budget', () => runBudget(sources, cache, budgetOptsFromArgs(parsed)));
    case 'doctor':
      // doctor's own always-ok:true contract lives inside runDoctor (a failing
      // check is data, not a throw) — guard() here just wraps it like every
      // other command; there's no special case needed at dispatch level.
      return guard('doctor', () => runDoctor(sources, cache, doctorOptsFromArgs(parsed)));
    case 'cache':
      // cache is fully offline, like rank — no Sources involved.
      return guard('cache', () => Promise.resolve(runCache(cache, cacheOptsFromArgs(parsed))));
    default:
      return Promise.resolve(
        err(
          command,
          'UNKNOWN_COMMAND',
          `'${command}' is not yet implemented; see roadmap`,
          'this command is registered but its logic ships in a later task',
        ),
      );
  }
}

function exitCodeFor(envelope: Envelope<unknown>): 0 | 1 | 2 {
  if (envelope.ok) return 0;
  return envelope.error.code === 'UNKNOWN_COMMAND' ? 2 : 1;
}

/**
 * Wrap an envelope-producing thunk, turning any thrown error into a FATAL
 * envelope instead of letting it reject. This is the top-level-rejection
 * contract: no command can genuinely throw yet (dispatch is fully stubbed in
 * this scaffold), but every future command runner calls into async adapters
 * that can, so run() must never propagate an exception to its caller.
 * Exported so the contract is directly testable independent of a real
 * throwing command.
 */
export async function runGuarded(
  command: string,
  thunk: () => Promise<Envelope<unknown>>,
): Promise<Envelope<unknown>> {
  try {
    return await thunk();
  } catch (e) {
    return err(command, 'FATAL', e instanceof Error ? e.message : String(e));
  }
}

// ── run ──────────────────────────────────────────────────────────────────

export interface RunResult {
  stdout: string;
  exitCode: number;
}

/**
 * Pure, testable CLI core: argv in, {stdout, exitCode} out. Never throws —
 * any rejection from dispatch (or anything above it) is caught here and
 * turned into a FATAL error envelope on stdout with exit 1, so main() can
 * always trust its return value.
 */
export async function run(
  argv: string[],
  sources: Sources,
  stdin = '',
  cache: Cache = createCache(),
): Promise<RunResult> {
  const parsed = parseArgs(argv);

  if (parsed.command === undefined || parsed.bools.has('help')) {
    // The ONE exception to "stdout = envelope only" — plain-text help, like
    // youtube-context/x-relay.
    return { stdout: helpText(), exitCode: 0 };
  }

  const envelope = await runGuarded(parsed.command, () => dispatch(parsed, sources, stdin, cache));
  return { stdout: toJson(envelope, parsed.bools.has('compact')), exitCode: exitCodeFor(envelope) };
}

// ── main — only executed when this file is the direct entry point ────────

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** Injectable I/O seam for runMain, so the entry-level FATAL contract is testable. */
export interface MainIO {
  readStdin: () => Promise<string>;
  writeStdout: (s: string) => void;
}

const defaultIO: MainIO = {
  readStdin,
  writeStdout: (s) => {
    process.stdout.write(s);
  },
};

/**
 * The entry-level top-level-rejection boundary. Wraps the ENTIRE invocation —
 * including reading stdin, which happens before run() is even called — so any
 * rejection anywhere in the pipeline becomes a FATAL error envelope on stdout
 * with exit 1, never a raw stack trace / uncaught rejection. run() itself
 * stays pure and rejection-free; this is the outer layer main() delegates to.
 */
export async function runMain(argv: string[], io: MainIO = defaultIO): Promise<RunResult> {
  try {
    // Only touch stdin when the user explicitly asked for it (a `-` positional),
    // so normal invocations never block waiting on an open pipe.
    const stdin = argv.includes('-') ? await io.readStdin() : '';
    // Lazy: createSources constructs nothing and resolves no token until a
    // command actually calls an adapter; run()'s default cache is likewise
    // lazy (createCache() only resolves paths, touches disk on first use).
    const result = await run(argv, createSources(), stdin);
    io.writeStdout(`${result.stdout}\n`);
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stdout = toJson(err('cli', 'FATAL', message));
    io.writeStdout(`${stdout}\n`);
    return { stdout, exitCode: 1 };
  }
}

export async function main(): Promise<void> {
  const { exitCode } = await runMain(process.argv.slice(2));
  process.exitCode = exitCode;
}

// No self-invoking entry guard here — this module is a pure library surface
// (src/index.ts re-exports it, and src/mcp-shim.ts imports `run` directly).
// tsup's `splitting:false` inlines a whole imported module's top-level code
// into EVERY bundle that imports it, and `import.meta.main` is true for the
// bundle's actual entry file regardless of which source module the inlined
// code came from — so a self-invocation here would have also fired when
// dist/mcp-shim.js or dist/index.js were the ones actually executed (proved
// live: it printed the CLI's plain-text help onto the MCP stdio channel
// before the JSON-RPC handshake). The real bin-invocation decision lives in
// src/cli-entry.ts, the ONLY module tsup treats as the `cli` entry point.
