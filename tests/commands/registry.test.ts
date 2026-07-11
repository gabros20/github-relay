import { describe, expect, test } from 'bun:test';
import { COMMANDS, commandNames } from '../../src/commands/registry.ts';

const EXPECTED_NAMES = [
  'plan',
  'search',
  'batch',
  'hydrate',
  'code',
  'enrich',
  'rank',
  'health',
  'skim',
  'read',
  'digest',
  'budget',
  'doctor',
  'cache',
];

describe('COMMANDS registry', () => {
  test('lists exactly the 14 commands from design §3, in order', () => {
    expect(commandNames).toEqual(EXPECTED_NAMES);
  });

  test('every command has a non-empty cost hint, summary, and usage', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.cost.length).toBeGreaterThan(0);
      expect(cmd.summary.length).toBeGreaterThan(0);
      expect(cmd.usage.length).toBeGreaterThan(0);
    }
  });

  test('usage strings start with the command name (ghrelay <name> ...)', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.usage.startsWith(`ghrelay ${cmd.name}`)).toBe(true);
    }
  });

  test('names are unique', () => {
    expect(new Set(commandNames).size).toBe(commandNames.length);
  });
});
