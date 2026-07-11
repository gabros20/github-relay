import { describe, expect, test } from 'bun:test';
import { runMain } from '../src/cli.ts';
import type { Envelope } from '../src/types.ts';

describe('runMain — entry-level top-level-rejection guard', () => {
  test('a rejecting stdin reader is caught -> FATAL envelope on stdout, exit 1', async () => {
    let written = '';
    const io = {
      readStdin: async (): Promise<string> => {
        throw new Error('stream error');
      },
      writeStdout: (s: string) => {
        written += s;
      },
    };
    // A bare `-` positional is what triggers the stdin read in the first place.
    const result = await runMain(['read', 'owner/repo', '-'], io);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(written.trim()) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('FATAL');
    expect(envelope.error.message).toBe('stream error');
    expect(envelope.command).toBe('cli');
  });

  test('a non-Error stdin rejection (string) is stringified into the FATAL message', async () => {
    let written = '';
    const io = {
      readStdin: async (): Promise<string> => {
        throw 'literal failure';
      },
      writeStdout: (s: string) => {
        written += s;
      },
    };
    const result = await runMain(['read', 'owner/repo', '-'], io);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(written.trim()) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.message).toBe('literal failure');
  });

  test('no `-` positional never touches readStdin, and the normal envelope is written', async () => {
    let readStdinCalls = 0;
    let written = '';
    const io = {
      readStdin: async (): Promise<string> => {
        readStdinCalls += 1;
        return '';
      },
      writeStdout: (s: string) => {
        written += s;
      },
    };
    const result = await runMain(['nonsense'], io);
    expect(readStdinCalls).toBe(0);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(written.trim()) as Envelope<unknown>;
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('UNKNOWN_COMMAND');
  });

  test('help path writes plain text via the injected writer and exits 0', async () => {
    let written = '';
    const io = {
      readStdin: async (): Promise<string> => '',
      writeStdout: (s: string) => {
        written += s;
      },
    };
    const result = await runMain([], io);
    expect(result.exitCode).toBe(0);
    expect(written).toContain('ghrelay');
  });
});
