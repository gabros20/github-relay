import { describe, expect, test } from 'bun:test';
// `src/generated/skill.ts` is produced by `scripts/generate-skill.ts` from
// `.claude/skills/github-relay/SKILL.md` — every `bun test`/`bun run build`
// invocation runs `generate` first (package.json scripts), so this import
// always reflects the CURRENT SKILL.md, not a stale snapshot. This test pins
// that the pipeline inlines the real funnel-first content (task 8), not the
// task-1 placeholder it started as.
import { githubRelaySkill } from '../src/generated/skill.ts';

describe('generated skill.ts', () => {
  test('is not the task-1 placeholder', () => {
    expect(githubRelaySkill).not.toContain('placeholder');
    expect(githubRelaySkill).not.toContain('ships in a later task');
  });

  test('leads with the funnel and carries all three golden rules verbatim', () => {
    expect(githubRelaySkill).toContain('## Three golden rules');
    expect(githubRelaySkill).toContain('NEVER deep-read code during exploration');
    expect(githubRelaySkill).toContain('The agent expands intent; the tool executes slices');
    expect(githubRelaySkill).toContain(
      'For fuzzy intents, web-search first and `hydrate` what humans curated',
    );
  });

  test('documents every implemented command and marks milestone-B ones as roadmap', () => {
    for (const cmd of [
      'search',
      'batch',
      'hydrate',
      'enrich',
      'rank',
      'skim',
      'read',
      'digest',
      'budget',
      'doctor',
      'cache',
    ]) {
      expect(githubRelaySkill).toContain(`### \`${cmd}\``);
    }
    expect(githubRelaySkill).toContain('### Roadmap (v0.1 milestone B');
    expect(githubRelaySkill).toContain('`plan`');
    expect(githubRelaySkill).toContain('`code`');
    expect(githubRelaySkill).toContain('`health`');
  });

  test('carries the closed error-code set', () => {
    for (const code of [
      'INVALID_INPUT',
      'AUTH_FAILED',
      'RATE_LIMITED',
      'NOT_FOUND',
      'QUERY_TOO_COMPLEX',
      'RESULT_CAP',
      'ABUSE_DETECTED',
      'SOURCE_DOWN',
      'CONFIRMATION_REQUIRED',
      'UNKNOWN_COMMAND',
      'FETCH_FAILED',
    ]) {
      expect(githubRelaySkill).toContain(code);
    }
  });
});
