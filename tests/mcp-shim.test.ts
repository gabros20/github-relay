import { describe, expect, test } from 'bun:test';
import { stubMessage } from '../src/mcp-shim.ts';

describe('mcp-shim stub', () => {
  test('stubMessage explains the shim is not yet implemented', () => {
    expect(stubMessage()).toContain('not yet implemented');
    expect(stubMessage()).toContain('github-relay-mcp');
  });
});
