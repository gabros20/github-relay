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
