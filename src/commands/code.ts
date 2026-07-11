import type { GrepAppBreaker } from '../cache/budget.ts';
import { mergeCorpus, saveCorpus } from '../cache/corpus.ts';
// `code` — the code-token evidence lane (design §3 item 5, §12 risk 2): grep.app
// is a free, no-SLA goodwill service, so this command owns TWO client-side
// gates before it ever calls the network: NL-input rejection (grep.app is a
// literal/regex code search, not a keyword/intent search) and a circuit
// breaker persisted in `cache.budget.grepApp` so repeated failures degrade to
// SOURCE_DOWN without hammering an already-down service across invocations.
// The adapter itself (`sources/grep-app.ts`) is a pure, single-shot
// transport; breaker bookkeeping lives here, same split as
// `_shared.ts#updateBudgetFromGraphql` (adapters don't touch cache, command
// runners do). Output rows carry owner/repo so the agent can pipe survivors
// into `hydrate` — this command never auto-hydrates.
import { CORPUS_SCHEMA, type Cache, type Corpus, type CorpusRepo } from '../cache/index.ts';
import type { ParsedArgs } from '../cli.ts';
import type { GrepApp, GrepAppHit } from '../sources/grep-app.ts';
import { EngineError } from '../types.ts';
import { loadCorpusOrEmpty } from './_shared.ts';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes — a free goodwill service, cool down gently

export interface CodeOpts {
  /** Raw positionals, joined — the code pattern/regex to search for. */
  pattern: string;
  lang: string[];
  repo?: string;
  path?: string;
  limit?: string;
  out?: string;
  /** Bypasses the NL-rejection heuristic entirely (fix wave 1, IMP 2). */
  literal?: boolean;
}

export interface CodeHitRow {
  repo: string;
  path: string;
  line: number;
  snippet: string;
  lang?: string;
  license?: string;
}

export interface CodeResult {
  pattern: string;
  count: number;
  /** Compact hit rows — only when `--out` is absent. */
  hits?: CodeHitRow[];
  /** Distinct repos touched by the matches, sorted — hydrate-ready (design §3 item 5), always present. */
  repos: string[];
  merged?: number;
  out?: string;
}

/** Only the GrepApp surface `code` actually calls. */
export interface CodeSources {
  grepApp: Pick<GrepApp, 'search'>;
}

export function codeOptsFromArgs(parsed: ParsedArgs): CodeOpts {
  return {
    pattern: parsed.positionals.join(' '),
    lang: parsed.flags.lang ?? [],
    repo: parsed.flags.repo?.[0],
    path: parsed.flags.path?.[0],
    limit: parsed.flags.limit?.[0],
    out: parsed.flags.out?.[0],
    literal: parsed.bools.has('literal'),
  };
}

// ── NL-input rejection heuristic ────────────────────────────────────────
// grep.app is a literal/regex code search (like `grep`), not a keyword or
// intent search — feeding it natural language wastes a call and returns
// nothing useful. The heuristic is deliberately simple and documented rather
// than "smart", and deliberately biased toward PERMISSIVENESS (fix wave 1,
// IMP 2 — controller policy: a false accept costs one cheap grep.app call, a
// false reject blocks a legitimate literal-string search, so the asymmetric
// cost favors letting borderline cases through): ANY code-punctuation
// character anywhere in the pattern short-circuits straight to "code" (a
// single `(` or `.` is already strong evidence — `useState(`, `import React
// from 'react'`); a punctuation-free pattern is rejected as NL only when it
// has 6+ space-separated, purely-lowercase-alphabetic words (a genuinely
// long sentence) OR looks question-shaped (contains how/what/why/where/
// when/should/"best way"/"can i") — a real multi-word literal like "failed
// to connect to database" (5 words, no question shape) now passes straight
// through. `--literal` bypasses this heuristic entirely for anything the
// heuristic still gets wrong.
const CODE_PUNCTUATION_RE = /[{}()=>;._'"`/-]/;
const LOWERCASE_WORD_RE = /^[a-z]+$/;
const NL_WORD_THRESHOLD = 6;
const QUESTION_SHAPE_RE = /\b(?:how|what|why|where|when|should|best way|can i)\b/i;

/** Exported for direct testing (task-10 brief: tested on both sides of the line). */
export function looksLikeNaturalLanguage(pattern: string): boolean {
  if (CODE_PUNCTUATION_RE.test(pattern)) return false;
  const words = pattern.split(/\s+/).filter(Boolean);
  const lowercaseWords = words.filter((w) => LOWERCASE_WORD_RE.test(w));
  if (lowercaseWords.length >= NL_WORD_THRESHOLD) return true;
  return QUESTION_SHAPE_RE.test(pattern);
}

function validatePattern(pattern: string, literal: boolean): void {
  if (!pattern) {
    throw new EngineError('INVALID_INPUT', 'provide a code pattern to search for');
  }
  if (!literal && looksLikeNaturalLanguage(pattern)) {
    throw new EngineError(
      'INVALID_INPUT',
      `'${pattern}' looks like natural language, not a code token/pattern`,
    );
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new EngineError(
      'INVALID_INPUT',
      `--limit must be an integer between 1 and ${MAX_LIMIT} (got '${raw}')`,
    );
  }
  return n;
}

// ── circuit breaker (design §12 risk 2: goodwill service, degrade never load-bearing) ──

const CLOSED_BREAKER: GrepAppBreaker = { breakerState: 'closed', consecutiveFailures: 0 };

type BreakerPhase = 'closed' | 'blocked' | 'probe';

/** Pure — exported for direct testing. `open` with an elapsed (or absent) `retryAt` is treated as eligible for exactly one half-open probe. */
export function breakerPhase(breaker: GrepAppBreaker, now: number): BreakerPhase {
  if (breaker.breakerState !== 'open') return 'closed';
  if (breaker.retryAt !== undefined && now < Date.parse(breaker.retryAt)) return 'blocked';
  return 'probe';
}

/** Only 429/5xx (RATE_LIMITED/SOURCE_DOWN) count toward the breaker — a bad-query INVALID_INPUT or a transport FETCH_FAILED is the caller's or a one-off's fault, not evidence the service itself is unhealthy. */
export function isBreakerCountable(code: string): boolean {
  return code === 'RATE_LIMITED' || code === 'SOURCE_DOWN';
}

/**
 * Reducer form (fix wave 1, IMP 1): computes `failures` from whatever is
 * CURRENTLY persisted at write time (`cache.budget.updateGrepAppBreaker`'s
 * reducer overload), not from the `breaker` snapshot `runCode` captured
 * before the network call — closing the same stale-snapshot gap at the
 * store level that `withBreakerLock` closes at the command level.
 */
function recordBreakerFailure(cache: Cache, phase: BreakerPhase, now: number): void {
  cache.budget.updateGrepAppBreaker((prev) => {
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    if (phase === 'probe' || failures >= BREAKER_THRESHOLD) {
      return {
        breakerState: 'open',
        consecutiveFailures: failures,
        retryAt: new Date(now + BREAKER_COOLDOWN_MS).toISOString(),
      };
    }
    return { breakerState: 'closed', consecutiveFailures: failures };
  });
}

// ── single-flight lock (fix wave 1, IMP 1) ───────────────────────────────
// A module-level promise-chain mutex serializing the ENTIRE breaker-check ->
// network-call -> breaker-write critical section. Without this, two
// concurrent `code` invocations (e.g. the MCP shim's shared singleton Cache
// under two parallel tool calls) can each read the breaker before either
// writes anything: two failures collapse into consecutiveFailures:1 (the
// breaker never trips), or two calls both see "open, cooldown elapsed" and
// both fire as the half-open probe. Node's single-threaded event loop makes
// a promise-chain sufficient — `breakerLock` is reassigned synchronously
// (no `await` in between), so no other call can splice itself into the
// middle of an already-queued link. Deliberately IN-PROCESS only: this does
// NOT protect against two separate OS processes racing the same cache root
// (out of scope — single-user CLI, and budget.json's writes are individually
// atomic file replaces, so the worst a cross-process race can do is lose an
// update, never corrupt the file).
let breakerLock: Promise<unknown> = Promise.resolve();

function withBreakerLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = breakerLock.then(fn, fn);
  // Never let a rejection permanently wedge the queue for later callers —
  // the ORIGINAL rejection still propagates to whoever awaits `result`.
  breakerLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function searchWithBreaker(
  sources: CodeSources,
  cache: Cache,
  pattern: string,
  opts: CodeOpts,
  now: () => number,
): Promise<GrepAppHit[]> {
  const breaker = cache.budget.load().grepApp ?? CLOSED_BREAKER;
  const phase = breakerPhase(breaker, now());

  if (phase === 'blocked') {
    const retryAfterMs = breaker.retryAt
      ? Math.max(0, Date.parse(breaker.retryAt) - now())
      : undefined;
    throw new EngineError(
      'SOURCE_DOWN',
      `grep.app circuit breaker is open after ${breaker.consecutiveFailures} consecutive failures`,
      undefined,
      retryAfterMs,
    );
  }
  if (phase === 'probe') {
    cache.budget.updateGrepAppBreaker((prev) => ({
      ...(prev ?? CLOSED_BREAKER),
      breakerState: 'half-open',
    }));
  }

  try {
    const hits = await sources.grepApp.search({
      query: pattern,
      lang: opts.lang.length > 0 ? opts.lang : undefined,
      repo: opts.repo,
      path: opts.path,
    });
    cache.budget.updateGrepAppBreaker((prev) =>
      prev && prev.breakerState === 'closed' && prev.consecutiveFailures === 0
        ? prev
        : { breakerState: 'closed', consecutiveFailures: 0 },
    );
    return hits;
  } catch (e) {
    if (e instanceof EngineError && isBreakerCountable(e.code)) {
      recordBreakerFailure(cache, phase, now());
    }
    throw e;
  }
}

// ── corpus row (minimal — full enrichment stays enrich/hydrate's job) ───

function codeRow(fullName: string, hits: GrepAppHit[]): CorpusRepo {
  const license = hits.find((h) => h.repo === fullName)?.license;
  return {
    full_name: fullName,
    // No GraphQL node id available from a code-search hit — the merge layer
    // (cache/corpus.ts mergeRepoInto) treats '' the same as "not supplied"
    // so this never clobbers a real ghid a prior search/hydrate recorded.
    ghid: '',
    aliases: [],
    source: 'code',
    signals: {},
    license,
  };
}

export async function runCode(
  sources: CodeSources,
  cache: Cache,
  opts: CodeOpts,
  deps: { now?: () => number } = {},
): Promise<CodeResult> {
  const now = deps.now ?? Date.now;

  const pattern = opts.pattern.trim();
  validatePattern(pattern, opts.literal === true);
  const limit = parseLimit(opts.limit);

  const hits = await withBreakerLock(() => searchWithBreaker(sources, cache, pattern, opts, now));

  const limited = hits.slice(0, limit);
  const repos = Array.from(new Set(limited.map((h) => h.repo))).sort();

  const result: CodeResult = { pattern, count: limited.length, repos };

  if (opts.out) {
    const existing = loadCorpusOrEmpty(opts.out, pattern, now);
    const fresh: Corpus = {
      schema: CORPUS_SCHEMA,
      intent: existing.intent || pattern,
      generatedAt: new Date(now()).toISOString(),
      queries: [pattern],
      count: repos.length,
      repos: repos.map((fullName) => codeRow(fullName, limited)),
    };
    const merged = mergeCorpus(existing, fresh);
    saveCorpus(opts.out, merged, now);
    result.merged = merged.repos.length;
    result.out = opts.out;
  } else {
    result.hits = limited.map((h) => ({
      repo: h.repo,
      path: h.path,
      line: h.line,
      snippet: h.snippet,
      lang: h.lang,
      license: h.license,
    }));
  }

  return result;
}
