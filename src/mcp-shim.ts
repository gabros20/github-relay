#!/usr/bin/env node
// ─── github-relay-mcp MCP shim ────────────────────────────────────────────
// Stub entry point. The real thin @modelcontextprotocol/sdk stdio server
// (zod schemas, lazy Sources, forced --quiet, compact:true default) is out of
// scope for this scaffold — it ships alongside the command adapters
// (design §2, PLAN.md milestone A.8). This stub exists only so tsup has a
// real third bundle entry and the bin wires up correctly end to end.
import { shouldRunAsEntry } from './entry.ts';

export function stubMessage(): string {
  return 'github-relay-mcp: not yet implemented — command adapters + MCP server ship in a later task';
}

function main(): void {
  process.stderr.write(`${stubMessage()}\n`);
  process.exitCode = 1;
}

const entry = shouldRunAsEntry(process.argv[1], import.meta.url, import.meta.main, [
  'github-relay-mcp',
  'mcp-shim.js',
]);
if (entry.warning !== undefined) process.stderr.write(`${entry.warning}\n`);
if (entry.run) main();
