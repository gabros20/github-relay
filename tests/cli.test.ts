import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/cli.ts';

describe('parseArgs', () => {
  test('first token is the command; rest are positionals', () => {
    const parsed = parseArgs(['search', 'react state management']);
    expect(parsed.command).toBe('search');
    expect(parsed.positionals).toEqual(['react state management']);
  });

  test('no argv → command undefined', () => {
    expect(parseArgs([]).command).toBeUndefined();
  });

  test('a value flag consumes the following token', () => {
    const parsed = parseArgs(['search', 'react', '--limit', '30']);
    expect(parsed.positionals).toEqual(['react']);
    expect(parsed.flags.limit).toEqual(['30']);
  });

  test('a bool flag consumes no token', () => {
    const parsed = parseArgs(['plan', 'foo', '--dry', 'bar']);
    expect(parsed.bools.has('dry')).toBe(true);
    // 'bar' is a positional, not swallowed as --dry's value.
    expect(parsed.positionals).toEqual(['foo', 'bar']);
  });

  test('a repeated value flag accumulates every occurrence, in order', () => {
    const parsed = parseArgs([
      'digest',
      'owner/repo',
      '--include',
      'src/**',
      '--include',
      'docs/**',
      '--exclude',
      '*.test.ts',
    ]);
    expect(parsed.flags.include).toEqual(['src/**', 'docs/**']);
    expect(parsed.flags.exclude).toEqual(['*.test.ts']);
  });

  test('an unrecognized flag name is ignored (not a value or bool flag)', () => {
    const parsed = parseArgs(['search', 'react', '--not-a-real-flag', 'x']);
    // Unknown flags are dropped entirely — not swallowed as positionals, not
    // recorded, so a typo fails loudly downstream rather than polluting args.
    expect(parsed.flags['not-a-real-flag']).toBeUndefined();
    expect(parsed.bools.has('not-a-real-flag')).toBe(false);
  });

  test('short flag alias -o maps to the "out" value flag', () => {
    const parsed = parseArgs(['search', 'react', '-o', 'corpus.json']);
    expect(parsed.flags.out).toEqual(['corpus.json']);
  });

  test('a trailing value flag with no following token is dropped, not crashed on', () => {
    const parsed = parseArgs(['search', 'react', '--limit']);
    expect(parsed.flags.limit).toBeUndefined();
  });

  test('global --quiet and --compact are recognized bool flags', () => {
    const parsed = parseArgs(['search', 'react', '--quiet', '--compact']);
    expect(parsed.bools.has('quiet')).toBe(true);
    expect(parsed.bools.has('compact')).toBe(true);
  });
});

describe('parseArgs — "--" end-of-flags sentinel', () => {
  test('flags before "--" still parse; everything after is a verbatim positional', () => {
    const parsed = parseArgs(['search', '--out', 'corpus.json', '--', '--force push workflows']);
    expect(parsed.command).toBe('search');
    expect(parsed.flags.out).toEqual(['corpus.json']);
    expect(parsed.positionals).toEqual(['--force push workflows']);
  });

  test('a positional that looks like a flag is preserved verbatim, not dropped', () => {
    const parsed = parseArgs(['search', '--', '--not-a-real-flag']);
    expect(parsed.positionals).toEqual(['--not-a-real-flag']);
  });

  test('multiple verbatim positionals after "--" keep their relative order', () => {
    const parsed = parseArgs(['read', '--ref', 'main', '--', 'o/r', '--weird-path', 'normal.md']);
    expect(parsed.flags.ref).toEqual(['main']);
    expect(parsed.positionals).toEqual(['o/r', '--weird-path', 'normal.md']);
  });

  test('a second "--" after the sentinel is itself a literal positional, not a repeat toggle', () => {
    const parsed = parseArgs(['read', '--', 'o/r', '--']);
    expect(parsed.positionals).toEqual(['o/r', '--']);
  });

  test('"--" as the very first token: the next token becomes the command, rest verbatim', () => {
    const parsed = parseArgs(['--', 'search', '--not-a-flag']);
    expect(parsed.command).toBe('search');
    expect(parsed.positionals).toEqual(['--not-a-flag']);
  });

  test('the single-dash "-" stdin sentinel is unaffected (still a plain positional)', () => {
    const parsed = parseArgs(['hydrate', '-']);
    expect(parsed.positionals).toEqual(['-']);
  });

  test('"-" still works as a positional even after the "--" sentinel', () => {
    const parsed = parseArgs(['hydrate', '--', '-']);
    expect(parsed.positionals).toEqual(['-']);
  });

  test('no "--" present: behavior is unchanged from before (regression guard)', () => {
    const parsed = parseArgs(['search', 'react', '--limit', '30']);
    expect(parsed.positionals).toEqual(['react']);
    expect(parsed.flags.limit).toEqual(['30']);
  });
});
