import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKER_FILENAME,
  ensureMarker,
  hasMarker,
  looksLikeExistingGhrelayRoot,
} from '../../src/cache/marker.ts';
import { resolveCachePaths } from '../../src/cache/paths.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghrelay-marker-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hasMarker / ensureMarker', () => {
  test('a fresh root has no marker', () => {
    expect(hasMarker(dir)).toBe(false);
  });

  test('ensureMarker writes a schema-tagged, timestamped marker file', () => {
    const now = () => Date.parse('2026-07-11T00:00:00Z');
    ensureMarker(dir, now);
    expect(hasMarker(dir)).toBe(true);
    const raw = readFileSync(join(dir, MARKER_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as { schema: string; createdAt: string };
    expect(parsed.schema).toContain('github-relay');
    expect(parsed.createdAt).toBe('2026-07-11T00:00:00.000Z');
  });

  test('ensureMarker is idempotent — a second call never overwrites the original createdAt', () => {
    ensureMarker(dir, () => Date.parse('2026-01-01T00:00:00Z'));
    ensureMarker(dir, () => Date.parse('2026-12-31T00:00:00Z'));
    const raw = readFileSync(join(dir, MARKER_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as { createdAt: string };
    expect(parsed.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('looksLikeExistingGhrelayRoot — the one-time adoption signal (must be schema-specific, never a bare "some file exists" check)', () => {
  test('an empty root does not look like ours', () => {
    expect(looksLikeExistingGhrelayRoot(resolveCachePaths(dir))).toBe(false);
  });

  test('a root with our budget.json shape ({learnedCeilings:...}) looks like ours', () => {
    const paths = resolveCachePaths(dir);
    writeFileSync(paths.budgetFile, '{"learnedCeilings":{}}');
    expect(looksLikeExistingGhrelayRoot(paths)).toBe(true);
  });

  test('a JSON file at the budget.json path that does NOT have our shape does not look like ours', () => {
    const paths = resolveCachePaths(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.budgetFile, '{"someone":"elses config"}');
    expect(looksLikeExistingGhrelayRoot(paths)).toBe(false);
  });

  test('a root with a plain-object etags.json looks like ours', () => {
    const paths = resolveCachePaths(dir);
    writeFileSync(paths.etagsFile, '{"https://api.github.com/x":{"etag":"e1"}}');
    expect(looksLikeExistingGhrelayRoot(paths)).toBe(true);
  });

  test('a root with a bare 40-hex or 64-hex filename under blobs/ looks like ours (our content-addressing convention)', () => {
    const paths = resolveCachePaths(dir);
    mkdirSync(paths.blobsDir, { recursive: true });
    writeFileSync(join(paths.blobsDir, 'a'.repeat(40)), 'content');
    expect(looksLikeExistingGhrelayRoot(paths)).toBe(true);
  });

  test('the reviewer repro: an unrelated file under a directory named blobs/ does NOT look like ours — the mere directory name is not evidence', () => {
    const paths = resolveCachePaths(dir);
    mkdirSync(paths.blobsDir, { recursive: true });
    writeFileSync(join(paths.blobsDir, 'some-unrelated-file.txt'), 'not ours');
    expect(looksLikeExistingGhrelayRoot(paths)).toBe(false);
  });

  test('unrelated files under directories named blobs/trees/corpora (operator misconfiguration) never look like ours', () => {
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    mkdirSync(join(dir, 'trees'), { recursive: true });
    mkdirSync(join(dir, 'corpora'), { recursive: true });
    writeFileSync(join(dir, 'blobs', 'photo.png'), 'binary-ish');
    writeFileSync(join(dir, 'trees', 'family-tree.txt'), 'grandpa');
    writeFileSync(join(dir, 'corpora', 'linguistics-notes.md'), '# notes');
    expect(looksLikeExistingGhrelayRoot(resolveCachePaths(dir))).toBe(false);
  });
});
