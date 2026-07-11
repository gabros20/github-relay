#!/usr/bin/env node
// ─── ghrelay CLI bin entry point ──────────────────────────────────────────
// The ONLY module tsup treats as the `cli` build entry (tsup.config.ts).
// `src/cli.ts` is a pure library module (run/dispatch/parseArgs, no top-level
// side effects) so it's safe to import from src/index.ts AND src/mcp-shim.ts
// without dragging a self-invoking "am I the entry point" check along —
// tsup's splitting:false inlines a whole imported module's top-level code
// into every bundle that imports it, so that check must live in exactly one
// place: here, the file tsup actually names `cli` in its entry map.
import { main } from './cli.ts';
import { shouldRunAsEntry } from './entry.ts';

// Fail-loud: when the runtime gives no definitive answer and the invocation
// looks like our binary, run anyway (after a stderr warning) — never silently
// exit 0 under the npm bin symlink.
const entry = shouldRunAsEntry(process.argv[1], import.meta.url, import.meta.main, [
  'ghrelay',
  'cli.js',
]);
if (entry.warning !== undefined) process.stderr.write(`${entry.warning}\n`);
if (entry.run) void main();
