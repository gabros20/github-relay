import { describe, expect, test } from 'bun:test';
import { createNodeExec } from '../../src/sources/auth.ts';

// Every other test in this suite injects a fake `Exec`, so `createNodeExec`
// itself — the real node:child_process-based default (task 8b) — had zero
// direct coverage of its ENOENT and stderr-merge branches. These tests spawn
// REAL processes (safe: a definitely-missing binary name, and `node` itself,
// which is available by definition in this test runtime).

describe('createNodeExec — missing binary (ENOENT)', () => {
  test('resolves with a non-zero exit code rather than rejecting', async () => {
    const exec = createNodeExec();
    const result = await exec(['definitely-not-a-real-binary-xyzabc123']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  test('combineStderr:true also resolves cleanly (no stderr to merge, since the process never started)', async () => {
    const exec = createNodeExec({ combineStderr: true });
    const result = await exec(['definitely-not-a-real-binary-xyzabc123']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  test('an empty argv resolves with exitCode 1 rather than spawning', async () => {
    const exec = createNodeExec();
    const result = await exec([]);
    expect(result).toEqual({ stdout: '', exitCode: 1 });
  });
});

describe('createNodeExec — a real, successful process', () => {
  test('collects stdout and reports exitCode 0', async () => {
    const exec = createNodeExec();
    const result = await exec([process.execPath, '-e', "console.log('hello-from-node-smoke')"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello-from-node-smoke');
  });

  test('a non-zero process exit code is reported as-is', async () => {
    const exec = createNodeExec();
    const result = await exec([process.execPath, '-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });
});

describe('createNodeExec — combineStderr', () => {
  const script = "console.error('ERRTAG'); console.log('OUTTAG')";

  test('combineStderr:false (default) — stdout carries only stdout, stderr is discarded', async () => {
    const exec = createNodeExec();
    const result = await exec([process.execPath, '-e', script]);
    expect(result.stdout).toContain('OUTTAG');
    expect(result.stdout).not.toContain('ERRTAG');
  });

  test('combineStderr:true — stdout carries both streams merged', async () => {
    const exec = createNodeExec({ combineStderr: true });
    const result = await exec([process.execPath, '-e', script]);
    expect(result.stdout).toContain('OUTTAG');
    expect(result.stdout).toContain('ERRTAG');
  });
});
