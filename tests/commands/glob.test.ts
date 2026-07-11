import { describe, expect, test } from 'bun:test';
import { globMatch } from '../../src/commands/glob.ts';

describe('globMatch', () => {
  test('a literal pattern matches only the exact path', () => {
    expect(globMatch('README.md', 'README.md')).toBe(true);
    expect(globMatch('README.md', 'src/README.md')).toBe(false);
  });

  test('* matches within one path segment, never across /', () => {
    expect(globMatch('*.md', 'README.md')).toBe(true);
    expect(globMatch('*.md', 'docs/README.md')).toBe(false);
  });

  test('** matches across any number of path segments, including zero', () => {
    expect(globMatch('src/**/*.ts', 'src/index.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', 'src/a/b/index.ts')).toBe(true);
    expect(globMatch('src/**', 'src/a/b/index.ts')).toBe(true);
    expect(globMatch('src/**', 'other/index.ts')).toBe(false);
  });

  test('? matches exactly one character within a segment', () => {
    expect(globMatch('file?.ts', 'file1.ts')).toBe(true);
    expect(globMatch('file?.ts', 'file12.ts')).toBe(false);
  });

  test('a bare directory-style pattern matches everything under it', () => {
    expect(globMatch('node_modules/**', 'node_modules/x/index.js')).toBe(true);
    expect(globMatch('node_modules/**', 'node_modules')).toBe(false);
  });

  test('regex metacharacters in the pattern are escaped, not interpreted', () => {
    expect(globMatch('a.b', 'aXb')).toBe(false);
    expect(globMatch('a.b', 'a.b')).toBe(true);
  });
});
