#!/usr/bin/env node
// ─── Node-runtime portability smoke test (task 8b) ────────────────────────
// Proves the BUILT dist/ artifacts work under plain `node` — what every real
// npm/npx install gives users — not just under bun (the dev/test runtime).
// doctor/auth/digest's exec seam and gh-rest's tarball WriteSink used to
// default to Bun.spawn/Bun.file, which silently worked in `bun test` (bun
// provides those globals itself) but broke under node. This script exercises
// exactly the production code paths those defaults sit behind:
//   1. cli --help                        (bin entry loads + runs under node)
//   2. cli doctor --offline              (exec seam: node:child_process git check)
//   3. gh-rest downloadTarball           (WriteSink seam: node:fs sink)
//   4. mcp-shim stdio handshake          (bin entry + MCP SDK under node)
// Deliberately plain JavaScript, zero bun-specific APIs, zero TypeScript —
// `node scripts/node-smoke.mjs` needs nothing but Node itself, so a CI job
// with no bun on PATH can run it directly.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');
const cliPath = join(root, 'dist', 'cli.js');
const shimPath = join(root, 'dist', 'mcp-shim.js');
const indexPath = join(root, 'dist', 'index.js');

for (const p of [cliPath, shimPath, indexPath]) {
  if (!existsSync(p)) {
    console.error(`node-smoke: ${p} not found — run \`bun run build\` first`);
    process.exit(1);
  }
}

const failures = [];

function runNode(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

// ── 1. cli --help ───────────────────────────────────────────────────────
async function checkHelp() {
  const { stdout, stderr, exitCode } = await runNode([cliPath, '--help']);
  if (exitCode !== 0) failures.push(`cli --help: expected exit 0, got ${exitCode}\n${stderr}`);
  if (!stdout.includes('ghrelay')) {
    failures.push(`cli --help: stdout missing expected usage text:\n${stdout.slice(0, 300)}`);
  }
  console.log('node-smoke: cli --help ok');
}

// ── 2. doctor --offline — git check must be ok when git is present ─────────
async function checkDoctorOffline() {
  const { stdout, stderr, exitCode } = await runNode([cliPath, 'doctor', '--offline', '--compact']);
  if (exitCode !== 0) {
    failures.push(`doctor --offline: expected exit 0, got ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`);
    return;
  }
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    failures.push(`doctor --offline: stdout is not valid JSON: ${stdout.slice(0, 300)}`);
    return;
  }
  if (envelope.ok !== true) {
    failures.push(`doctor --offline: envelope.ok is not true: ${JSON.stringify(envelope)}`);
  }
  const gitCheck = envelope.data?.checks?.find((c) => c.name === 'git');
  if (!gitCheck) {
    failures.push('doctor --offline: no "git" check in the result');
  } else if (gitCheck.ok !== true) {
    // This is the exact regression task 8 caught live: {"ok":false,"detail":"Bun is not defined"}.
    failures.push(`doctor --offline: git check failed under plain node: ${JSON.stringify(gitCheck)}`);
  }
  console.log(`node-smoke: doctor --offline ok (git check: ${JSON.stringify(gitCheck)})`);
}

// ── 3. gh-rest downloadTarball — the WriteSink default's node:fs sink ──────
async function checkTarballWriteSink() {
  const { createSources } = await import(pathToFileURL(indexPath).href);

  const payloadText = 'node-smoke tarball fixture payload';
  const payload = gzipSync(Buffer.from(payloadText));
  const codeloadUrl = 'https://codeload.github.com/octocat/Hello-World/tar.gz/deadbeef';

  const fetchImpl = async (url) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.startsWith('https://api.github.com')) {
      return new Response(null, { status: 302, headers: { location: codeloadUrl } });
    }
    if (u === codeloadUrl) {
      return new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.byteLength) },
      });
    }
    throw new Error(`node-smoke: unexpected fetch to ${u}`);
  };

  // GH_TOKEN short-circuits resolveToken before it ever shells out to `gh` —
  // this check is about the WriteSink, not auth.
  const sources = createSources({ fetchImpl, env: { GH_TOKEN: 'node-smoke-fake-token' } });

  const dir = mkdtempSync(join(tmpdir(), 'ghrelay-node-smoke-'));
  const out = join(dir, 'fixture.tar.gz');
  try {
    const result = await sources.ghRest.downloadTarball('octocat', 'Hello-World', 'deadbeef', { out });
    if (result.bytes !== payload.byteLength) {
      failures.push(
        `downloadTarball: reported ${result.bytes} bytes, expected ${payload.byteLength}`,
      );
    }
    const written = readFileSync(out);
    if (Buffer.compare(written, Buffer.from(payload)) !== 0) {
      failures.push('downloadTarball: file written by the WriteSink default does not match the fixture bytes');
    } else {
      console.log(`node-smoke: gh-rest downloadTarball WriteSink ok (${result.bytes} bytes written to disk)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Failure-path probe (task 8b fix wave 2): under plain node, a Writable
  // with no 'error' listener throws an UNHANDLED exception and crashes the
  // whole process the moment the stream fails (ENOSPC/EACCES/a bad path) —
  // this is the ENOSPC-class propagation check. If defaultCreateSink's error
  // listener regresses, THIS PROCESS crashes right here rather than the
  // check merely failing, which is itself the signal.
  const badOut = join(dir, 'does', 'not', 'exist', 'fixture.tar.gz');
  try {
    await sources.ghRest.downloadTarball('octocat', 'Hello-World', 'deadbeef', { out: badOut });
    failures.push('downloadTarball: a write to a nonexistent directory unexpectedly succeeded');
  } catch (e) {
    const code = e && typeof e === 'object' ? e.code : undefined;
    if (code !== 'FETCH_FAILED') {
      failures.push(`downloadTarball: write failure did not surface as FETCH_FAILED (got: ${e})`);
    } else {
      console.log('node-smoke: gh-rest downloadTarball WriteSink failure-path ok (structured FETCH_FAILED, no crash)');
    }
  }
}

// ── 4. mcp-shim stdio handshake ─────────────────────────────────────────
function rpc(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

async function checkMcpHandshake() {
  const proc = spawn(process.execPath, [shimPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  proc.stdin.write(
    `${JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'node-smoke', version: '0.0.0' } }))}\n`,
  );
  await new Promise((r) => setTimeout(r, 300));
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  proc.stdin.write(`${JSON.stringify(rpc(2, 'tools/list'))}\n`);
  await new Promise((r) => setTimeout(r, 500));
  proc.kill();

  if (stderr.trim().length > 0) {
    failures.push(`mcp-shim handshake: unexpected stderr output:\n${stderr}`);
  }
  const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
  let toolCount;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2 && msg.result?.tools) toolCount = msg.result.tools.length;
    } catch {
      failures.push(`mcp-shim handshake: stdout line is not valid JSON-RPC: ${line.slice(0, 200)}`);
    }
  }
  if (toolCount === undefined || toolCount === 0) {
    failures.push(`mcp-shim handshake: tools/list returned no tools (raw stdout: ${stdout.slice(0, 300)})`);
  } else {
    console.log(`node-smoke: mcp-shim stdio handshake ok (${toolCount} tools listed)`);
  }
}

async function main() {
  await checkHelp();
  await checkDoctorOffline();
  await checkTarballWriteSink();
  await checkMcpHandshake();

  if (failures.length > 0) {
    console.error('\nnode-smoke: FAILED\n');
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('\nnode-smoke: OK — all checks passed under plain node, zero bun involvement');
}

void main();
