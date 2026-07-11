#!/usr/bin/env node
// ─── MCP stdio smoke test ─────────────────────────────────────────────────
// Spawns the BUILT dist/mcp-shim.js under plain `node` (not `bun run`) and
// drives a real JSON-RPC handshake over stdio — the same way a real MCP
// client (Claude Desktop, Claude Code) invokes a published npm bin via
// `npx`/`node`. This is the proof task 8's acceptance criteria calls for
// ("prove with a scripted stdio round-trip test"), and it runs under plain
// Node deliberately: `bun test` alone would never catch a Bun-only API
// (Bun.spawn/Bun.file) breaking the published artifact, since Bun provides
// those globals itself. Deliberately written with zero Bun-specific APIs so
// it exercises exactly the runtime real users get.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const shimPath = join(root, 'dist', 'mcp-shim.js');

if (!existsSync(shimPath)) {
  console.error(`mcp-smoke: ${shimPath} not found — run \`bun run build\` first`);
  process.exit(1);
}

function rpc(id: number, method: string, params: unknown = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

async function main(): Promise<void> {
  const proc = spawn('node', [shimPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  proc.stdin.write(
    `${JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '0.0.0' } }))}\n`,
  );
  await new Promise((r) => setTimeout(r, 300));
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  proc.stdin.write(`${JSON.stringify(rpc(2, 'tools/list'))}\n`);
  await new Promise((r) => setTimeout(r, 500));
  proc.kill();

  const lines = stdout
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);

  const failures: string[] = [];
  if (stderr.trim().length > 0) {
    failures.push(`unexpected stderr output:\n${stderr}`);
  }
  if (lines.length !== 2) {
    failures.push(`expected exactly 2 stdout lines (initialize + tools/list), got ${lines.length}`);
  }

  let toolNames: string[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
      if (msg.id === 2 && msg.result?.tools) {
        toolNames = msg.result.tools.map((t) => t.name).sort();
      }
    } catch {
      failures.push(`stdout line ${i} is not valid JSON-RPC (protocol channel is corrupted): ${line.slice(0, 200)}`);
    }
  }

  const expected = [
    'batch',
    'budget',
    'cache',
    'code',
    'digest',
    'doctor',
    'enrich',
    'health',
    'hydrate',
    'plan',
    'rank',
    'read',
    'search',
    'skim',
  ];
  if (JSON.stringify(toolNames) !== JSON.stringify(expected)) {
    failures.push(`tool list mismatch.\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(toolNames)}`);
  }

  if (failures.length > 0) {
    console.error('mcp-smoke: FAILED\n');
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }

  console.log(`mcp-smoke: OK — clean stdio handshake, ${toolNames.length} tools listed: ${toolNames.join(', ')}`);
}

void main();
