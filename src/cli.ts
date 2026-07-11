#!/usr/bin/env node
// ─── ghrelay CLI ──────────────────────────────────────────────────────────
// Parses args, dispatches a command against injected Sources, prints a JSON
// envelope to stdout. `run()` is pure and testable: it never touches
// process.exit itself — main() below owns that translation.
import { type Cache, createCache } from './cache/index.ts';
import { batchOptsFromArgs, runBatch } from './commands/batch.ts';
import { hydrateOptsFromArgs, runHydrate } from './commands/hydrate.ts';
import { commandNames } from './commands/registry.ts';
import { COMMANDS } from './commands/registry.ts';
import { guard } from './commands/runners.ts';
import { runSearch, searchOptsFromArgs } from './commands/search.ts';
import { shouldRunAsEntry } from './entry.ts';
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

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    const name = token.startsWith('--')
      ? token.slice(2)
      : token.startsWith('-') && token.length > 1
        ? SHORT_FLAGS[token.slice(1)]
        : undefined;
    if (name !== undefined) {
      if (BOOL_FLAGS.has(name)) {
        bools.add(name);
      } else if (VALUE_FLAGS.has(name)) {
        const value = argv[i + 1];
        if (value !== undefined) {
          const existing = flags[name] ?? [];
          existing.push(value);
          flags[name] = existing;
          i += 1;
        }
      }
      // Unrecognized flag names are dropped, not swallowed as positionals —
      // a typo should fail loudly downstream, not silently pollute args.
      continue;
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
 * Dispatch a parsed command against Sources. `search`/`batch`/`hydrate` are
 * wired to their runners (task 4), each wrapped in `guard()` so an
 * EngineError becomes a per-code envelope. Every other registered command
 * still falls through to a clear "not yet implemented" envelope (tasks
 * 5-13). A name outside the registry gets the same UNKNOWN_COMMAND code with
 * a different message, so the CLI's exit-code rule (`error.code ===
 * 'UNKNOWN_COMMAND' → exit 2`) covers both cases uniformly.
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
    case 'search':
      return guard('search', () => runSearch(sources, cache, searchOptsFromArgs(parsed)));
    case 'batch':
      return guard('batch', () => runBatch(sources, cache, batchOptsFromArgs(parsed)));
    case 'hydrate':
      return guard('hydrate', () => runHydrate(sources, cache, hydrateOptsFromArgs(parsed), stdin));
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

// Fail-loud: when the runtime gives no definitive answer and the invocation
// looks like our binary, run anyway (after a stderr warning) — never silently
// exit 0 under the npm bin symlink.
const entry = shouldRunAsEntry(process.argv[1], import.meta.url, import.meta.main, [
  'ghrelay',
  'cli.js',
]);
if (entry.warning !== undefined) process.stderr.write(`${entry.warning}\n`);
if (entry.run) void main();
