import { describe, expect, test } from 'bun:test';
import { resolveToken, tokenExpiryWarning } from '../../src/sources/auth.ts';
import { EngineError } from '../../src/types.ts';

// A recording exec fake: captures the argv it was asked to run and returns a
// configurable {stdout, exitCode}. No real `gh` process is ever spawned.
function fakeExec(result: { stdout: string; exitCode: number } | Error) {
  const calls: string[][] = [];
  const exec = async (cmd: string[]): Promise<{ stdout: string; exitCode: number }> => {
    calls.push(cmd);
    if (result instanceof Error) throw result;
    return result;
  };
  return { exec, calls };
}

describe('resolveToken — resolution order', () => {
  test('GH_TOKEN wins and never shells out to gh', async () => {
    const { exec, calls } = fakeExec({ stdout: 'from-gh-cli', exitCode: 0 });
    const token = await resolveToken({ env: { GH_TOKEN: 'env-token' }, exec });
    expect(token).toBe('env-token');
    expect(calls).toHaveLength(0);
  });

  test('GITHUB_TOKEN is the second choice when GH_TOKEN is absent', async () => {
    const { exec, calls } = fakeExec({ stdout: 'from-gh-cli', exitCode: 0 });
    const token = await resolveToken({ env: { GITHUB_TOKEN: 'github-token' }, exec });
    expect(token).toBe('github-token');
    expect(calls).toHaveLength(0);
  });

  test('GH_TOKEN beats GITHUB_TOKEN when both are set', async () => {
    const { exec } = fakeExec({ stdout: '', exitCode: 1 });
    const token = await resolveToken({ env: { GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }, exec });
    expect(token).toBe('a');
  });

  test('whitespace-only env values are ignored, falling through to gh', async () => {
    const { exec, calls } = fakeExec({ stdout: '  cli-token\n', exitCode: 0 });
    const token = await resolveToken({ env: { GH_TOKEN: '   ', GITHUB_TOKEN: '' }, exec });
    expect(token).toBe('cli-token');
    expect(calls[0]).toEqual(['gh', 'auth', 'token']);
  });

  test('falls back to `gh auth token` and trims its stdout', async () => {
    const { exec, calls } = fakeExec({ stdout: 'gho_abc123\n', exitCode: 0 });
    const token = await resolveToken({ env: {}, exec });
    expect(token).toBe('gho_abc123');
    expect(calls).toEqual([['gh', 'auth', 'token']]);
  });
});

describe('resolveToken — loud failure', () => {
  test('a non-zero gh exit throws AUTH_FAILED (never degrades to unauth)', async () => {
    const { exec } = fakeExec({ stdout: '', exitCode: 1 });
    const err = (await resolveToken({ env: {}, exec }).catch((e) => e)) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('AUTH_FAILED');
  });

  test('empty gh stdout (exit 0) still throws AUTH_FAILED', async () => {
    const { exec } = fakeExec({ stdout: '   \n', exitCode: 0 });
    const err = (await resolveToken({ env: {}, exec }).catch((e) => e)) as EngineError;
    expect(err.code).toBe('AUTH_FAILED');
  });

  test('a thrown exec (gh not installed) is caught and mapped to AUTH_FAILED', async () => {
    const { exec } = fakeExec(new Error('ENOENT: gh not found'));
    const err = (await resolveToken({ env: {}, exec }).catch((e) => e)) as EngineError;
    expect(err.code).toBe('AUTH_FAILED');
  });
});

describe('tokenExpiryWarning', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-07-10T00:00:00Z');

  function headersWith(expiry?: string): Headers {
    const h = new Headers();
    if (expiry !== undefined) h.set('github-authentication-token-expiration', expiry);
    return h;
  }

  test('absent header → null (a non-expiring PAT never trips a warning)', () => {
    expect(tokenExpiryWarning(headersWith(), now)).toBeNull();
  });

  test('expiry more than 7 days out → null', () => {
    const expiry = new Date(now + 30 * DAY).toISOString();
    expect(tokenExpiryWarning(headersWith(expiry), now)).toBeNull();
  });

  test('expiry within 7 days → a warning string mentioning the window', () => {
    const expiry = new Date(now + 3 * DAY).toISOString();
    const warning = tokenExpiryWarning(headersWith(expiry), now);
    expect(warning).not.toBeNull();
    expect(warning).toContain('3 day');
  });

  test('already-expired token → a warning string', () => {
    const expiry = new Date(now - 1 * DAY).toISOString();
    expect(tokenExpiryWarning(headersWith(expiry), now)).not.toBeNull();
  });

  test("parses GitHub's space-separated header format, not just ISO", () => {
    // GitHub sends e.g. `2026-07-12 08:00:00 UTC` / with a numeric offset.
    const warning = tokenExpiryWarning(headersWith('2026-07-12 00:00:00 +0000'), now);
    expect(warning).not.toBeNull();
  });

  test('an unparseable expiry value → null (never throws)', () => {
    expect(tokenExpiryWarning(headersWith('not-a-date'), now)).toBeNull();
  });
});
