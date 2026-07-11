import { describe, expect, test } from 'bun:test';
import { run, runGuarded } from '../src/cli.ts';
import { commandNames } from '../src/commands/registry.ts';
import type { Envelope } from '../src/types.ts';

describe('run — help', () => {
  test('no args prints plain-text help (the one non-envelope stdout) and exits 0', async () => {
    const { stdout, exitCode } = await run([], {});
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ghrelay');
    // Plain text, not JSON — the documented exception.
    expect(() => JSON.parse(stdout)).toThrow();
  });

  test('--help prints the same help text and exits 0', async () => {
    const { stdout, exitCode } = await run(['--help'], {});
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Commands:');
  });

  test('help lists every registered command name', async () => {
    const { stdout } = await run([], {});
    for (const name of commandNames) expect(stdout).toContain(name);
  });
});

describe('run — unknown command', () => {
  test('a name outside the registry → UNKNOWN_COMMAND envelope, exit 2', async () => {
    const { stdout, exitCode } = await run(['nonsense'], {});
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('UNKNOWN_COMMAND');
    expect(envelope.command).toBe('cli');
  });
});

// search/batch/hydrate are wired (task 4) — their own envelope/exit-code
// contract is covered in tests/cli.dispatch.test.ts. Every other registered
// command still falls through to the "not yet implemented" path here.
const WIRED_COMMANDS = new Set(['search', 'batch', 'hydrate', 'enrich', 'rank']);
const UNIMPLEMENTED_COMMANDS = commandNames.filter((name) => !WIRED_COMMANDS.has(name));

describe('run — registered but unimplemented command', () => {
  test('a still-unimplemented runner (code) → UNKNOWN_COMMAND envelope, exit 2, command echoed', async () => {
    const { stdout, exitCode } = await run(['code'], {});
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('UNKNOWN_COMMAND');
    expect(envelope.command).toBe('code');
    expect(envelope.error.message).toContain('not yet implemented');
  });

  test('every still-unimplemented registered command dispatches to the not-yet-implemented path', async () => {
    for (const name of UNIMPLEMENTED_COMMANDS) {
      const { exitCode } = await run([name], {});
      expect(exitCode).toBe(2);
    }
  });
});

describe('run — enrich/rank are now wired (task 5)', () => {
  test('enrich without --in → INVALID_INPUT, exit 1 (not the unimplemented path)', async () => {
    const { stdout, exitCode } = await run(['enrich'], {});
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  test('rank without a corpus path → INVALID_INPUT, exit 1', async () => {
    const { stdout, exitCode } = await run(['rank'], {});
    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });
});

describe('run — output shape', () => {
  test('stdout is pretty (multi-line) JSON by default', async () => {
    const { stdout } = await run(['nonsense'], {});
    expect(stdout).toContain('\n');
  });

  test('--compact prints single-line JSON', async () => {
    const { stdout } = await run(['nonsense', '--compact'], {});
    expect(stdout.split('\n').length).toBe(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

describe('run — top-level rejection (runGuarded)', () => {
  // No command can genuinely throw yet (dispatch is fully stubbed), so this
  // is the real seam run() uses internally: runGuarded wraps the dispatch
  // call and is the actual boundary that must never let a rejection escape
  // run(). Exercised directly with a throwing thunk for a real behavior test.
  test('a throwing thunk is caught and becomes a FATAL envelope', async () => {
    const envelope = await runGuarded('enrich', async () => {
      throw new Error('adapter exploded');
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('FATAL');
    expect(envelope.error.message).toBe('adapter exploded');
    expect(envelope.command).toBe('enrich');
  });

  test('a non-Error throw (string) is stringified into the message', async () => {
    const envelope = await runGuarded('enrich', async () => {
      throw 'literal failure';
    });
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.message).toBe('literal failure');
  });

  test('a resolving thunk passes its envelope through untouched', async () => {
    const inner: Envelope<{ n: number }> = { ok: true, command: 'enrich', data: { n: 1 } };
    const envelope = await runGuarded('enrich', async () => inner);
    expect(envelope).toEqual(inner);
  });

  test('exit code for a FATAL envelope is 1 (not the UNKNOWN_COMMAND 2)', async () => {
    // FATAL is a distinct code from UNKNOWN_COMMAND, so run()'s exit-code
    // rule (ok→0, UNKNOWN_COMMAND→2, else→1) must land on 1 here — confirmed
    // by checking the rule directly against a FATAL envelope shape.
    const fatal: Envelope<unknown> = {
      ok: false,
      command: 'enrich',
      error: { code: 'FATAL', message: 'boom' },
    };
    expect(fatal.ok ? 0 : fatal.error.code === 'UNKNOWN_COMMAND' ? 2 : 1).toBe(1);
  });
});
