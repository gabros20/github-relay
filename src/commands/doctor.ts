// `doctor` — self-diagnosis (design §3 item 13, §12 risk 1): the x-relay DNA
// contract is ALWAYS `ok:true` with `{healthy, checks[], summary}` — a
// failing check is DATA, never a thrown error, so an agent can always parse
// the result even when everything is down. Checks run strictly sequentially
// (never Promise.all — house DNA never bursts concurrent load at a live
// service) with each individually raced against a timeout; the tradeoff is a
// worst-case total time of sum(timeouts) rather than max(timeouts), so
// DEFAULT_CHECK_TIMEOUT_MS is sized to keep that worst case under the
// design's <15s budget even if every one of the 11 checks times out (task 10
// added grepApp + grepAppBreaker; task 11 added clickhouse; task 12 added
// ossinsight, so the per-check budget tightened again from the prior
// 10-check/1400ms sizing: 11 * 1.3s = 14.3s < 15s).
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Cache } from '../cache/index.ts';
import { writeFileAtomic } from '../cache/store.ts';
import type { ParsedArgs } from '../cli.ts';
import { type Exec, createNodeExec, resolveToken, tokenExpiryWarning } from '../sources/auth.ts';
import type { ClickhousePlay } from '../sources/clickhouse-play.ts';
import type { DepsDev } from '../sources/depsdev.ts';
import type { Ecosystems } from '../sources/ecosystems.ts';
import type { GhGraphql } from '../sources/gh-graphql.ts';
import type { GhRest } from '../sources/gh-rest.ts';
import type { GrepApp } from '../sources/grep-app.ts';
import type { OssInsight } from '../sources/ossinsight.ts';
import { EngineError } from '../types.ts';

// WATCH-ITEM: 14.3s of a 15s budget is a ~5% margin — the next check added
// here (sequential-by-design, never Promise.all) needs DEFAULT_CHECK_TIMEOUT_MS
// retuned downward at the same time, or the worst case silently blows past 15s.
const DEFAULT_CHECK_TIMEOUT_MS = 1300; // 11 checks * 1.3s worst case = 14.3s < design's 15s budget

// A small, well-known public repo used purely as a reachability/feature
// probe target — never written to, never assumed to carry real research
// signal.
const PROBE_OWNER = 'octocat';
const PROBE_REPO = 'Hello-World';
const PROBE_FULL_NAME = `${PROBE_OWNER}/${PROBE_REPO}`;

// grep.app is a code-token search, not a keyword search — "license" is a
// single, common, cheap-to-index token, never natural language, so it can't
// ever trip the code command's own NL-rejection heuristic.
const GREP_APP_PROBE_QUERY = 'license';

const STARRED_AT_PROBE_QUERY = `query {
  repository(owner: "${PROBE_OWNER}", name: "${PROBE_REPO}") {
    stargazers(first: 1) {
      edges { starredAt }
    }
  }
}`;

export interface DoctorOpts {
  offline?: boolean;
}

export interface DoctorSources {
  ghRest: Pick<GhRest, 'get'>;
  ghGraphql: Pick<GhGraphql, 'graphql'>;
  ecosystems: Pick<Ecosystems, 'repo'>;
  depsdev: Pick<DepsDev, 'project'>;
  grepApp: Pick<GrepApp, 'search'>;
  clickhouse: Pick<ClickhousePlay, 'monthlyEvents'>;
  ossinsight: Pick<OssInsight, 'trending'>;
}

export interface DoctorDeps {
  now?: () => number;
  exec?: Exec;
  /** Injectable token-presence probe — defaults to the real `resolveToken` (env → `gh auth token`, no network). */
  resolveToken?: () => Promise<string>;
  timeoutMs?: number;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** True only for a network check skipped under --offline — never counted as a failure. */
  skipped?: boolean;
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
  summary: string;
}

export function doctorOptsFromArgs(parsed: ParsedArgs): DoctorOpts {
  return { offline: parsed.bools.has('offline') };
}

const defaultExec: Exec = createNodeExec();

/**
 * Races `promise` against `ms`; a timeout rejects (never hangs the whole run)
 * and leaves no dangling timer once either side settles. `onTimeout`, when
 * given, fires the moment the timer wins — used to actually cancel the
 * underlying work (e.g. kill a spawned child) instead of leaving it running
 * after this function has already moved on and reported a timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`check timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Never throws: any failure (including a timeout) becomes `{ok:false,
 * detail:message}` — the "failing check = data" contract. `fn` receives an
 * `AbortSignal` tied to this check's own timeout (most checks ignore it —
 * only the `git` check's exec-backed probe uses it) so a timed-out check
 * actually kills whatever it started rather than leaving it running after
 * the timeout has already been reported.
 */
async function runCheck(
  name: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<{ ok: boolean; detail: string }>,
): Promise<DoctorCheck> {
  const controller = new AbortController();
  try {
    const { ok, detail } = await withTimeout(fn(controller.signal), timeoutMs, () =>
      controller.abort(),
    );
    return { name, ok, detail };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function skippedCheck(name: string): DoctorCheck {
  return { name, ok: true, detail: 'skipped (--offline)', skipped: true };
}

/** A third-party NOT_FOUND still means the service answered — only SOURCE_DOWN (or anything unexpected) fails a reachability probe. */
async function reachabilityCheck(fn: () => Promise<unknown>): Promise<{
  ok: boolean;
  detail: string;
}> {
  try {
    await fn();
    return { ok: true, detail: 'reachable' };
  } catch (e) {
    if (e instanceof EngineError && e.code === 'NOT_FOUND') {
      return { ok: true, detail: 'reachable (probe target not found)' };
    }
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function runDoctor(
  sources: DoctorSources,
  cache: Cache,
  opts: DoctorOpts,
  deps: DoctorDeps = {},
): Promise<DoctorResult> {
  const now = deps.now ?? Date.now;
  const exec = deps.exec ?? defaultExec;
  const getToken = deps.resolveToken ?? (() => resolveToken());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const offline = opts.offline === true;

  const checks: DoctorCheck[] = [];

  // token: live mode validates against GitHub (GET /rate_limit) and surfaces
  // a PAT-expiry nag (PLAN Decisions §4); --offline only confirms a token
  // resolves locally (env var or `gh auth token`, no network) without
  // asserting it's actually valid.
  checks.push(
    await runCheck('token', timeoutMs, async () => {
      if (offline) {
        await getToken();
        return { ok: true, detail: 'token present' };
      }
      const res = await sources.ghRest.get('/rate_limit');
      const warning = tokenExpiryWarning(res.headers, now());
      return { ok: true, detail: warning ?? 'token valid' };
    }),
  );

  checks.push(
    offline
      ? skippedCheck('graphql')
      : await runCheck('graphql', timeoutMs, async () => {
          await sources.ghGraphql.graphql('{ viewer { login } }');
          return { ok: true, detail: 'graphql round-trip ok' };
        }),
  );

  checks.push(
    offline
      ? skippedCheck('ecosystems')
      : await runCheck('ecosystems', timeoutMs, () =>
          reachabilityCheck(() => sources.ecosystems.repo(PROBE_FULL_NAME)),
        ),
  );

  checks.push(
    offline
      ? skippedCheck('depsdev')
      : await runCheck('depsdev', timeoutMs, () =>
          reachabilityCheck(() => sources.depsdev.project(PROBE_OWNER, PROBE_REPO)),
        ),
  );

  // task 11: ClickHouse playground reachability — health.ts owns the adapter,
  // so this is its doctor row. A one-repo monthly-histogram probe (a valid,
  // injection-safe name) is enough to confirm the endpoint answers; a
  // SOURCE_DOWN fails it, an empty result is still "reachable".
  checks.push(
    offline
      ? skippedCheck('clickhouse')
      : await runCheck('clickhouse', timeoutMs, () =>
          reachabilityCheck(() => sources.clickhouse.monthlyEvents([PROBE_FULL_NAME])),
        ),
  );

  // task 12: this adapter's own doctor row, since search.ts owns the adapter.
  // A cheap 24h trending probe (no repo target needed — it's a sitewide list).
  checks.push(
    offline
      ? skippedCheck('ossinsight')
      : await runCheck('ossinsight', timeoutMs, () =>
          reachabilityCheck(() => sources.ossinsight.trending('past_24_hours')),
        ),
  );

  // task 10: this adapter's own doctor row, since code.ts owns the adapter.
  checks.push(
    offline
      ? skippedCheck('grepApp')
      : await runCheck('grepApp', timeoutMs, () =>
          reachabilityCheck(() => sources.grepApp.search({ query: GREP_APP_PROBE_QUERY })),
        ),
  );

  // Local checks (cache dir, git binary) always run, even --offline.
  checks.push(
    await runCheck('cacheDir', timeoutMs, async () => {
      const probe = join(cache.paths.root, `.doctor-probe-${randomUUID()}`);
      writeFileAtomic(probe, 'ok');
      unlinkSync(probe);
      return { ok: true, detail: cache.paths.root };
    }),
  );

  checks.push(
    await runCheck('git', timeoutMs, async (signal) => {
      const { stdout, exitCode } = await exec(['git', '--version'], { signal });
      if (exitCode !== 0) throw new Error('git binary not found');
      return { ok: true, detail: stdout.trim() || 'git present' };
    }),
  );

  // Feature probe (design §12 risk 1): starredAt access was reported
  // admin-restricted 2026-06-30, live 2026-07-10 — record ok/restricted here
  // so task 11's F-group scoring can degrade gracefully instead of guessing.
  // Hardened (task 11): the restriction can arrive as a 200 with a NULL
  // stargazers connection or null edge values — neither throws — so the probe
  // inspects the returned data, not just "did it throw". Only a real starredAt
  // value counts as available; the null shapes report restricted (a failing
  // check the agent can see, same "failing check = data" contract).
  checks.push(
    offline
      ? skippedCheck('starredAt')
      : await runCheck('starredAt', timeoutMs, async () => {
          const data = await sources.ghGraphql.graphql<{
            repository?: {
              stargazers?: { edges?: ({ starredAt?: string | null } | null)[] } | null;
            } | null;
          }>(STARRED_AT_PROBE_QUERY);
          const conn = data?.repository?.stargazers;
          if (conn == null) {
            return {
              ok: false,
              detail: 'restricted (null stargazers connection — partial-error shape)',
            };
          }
          const first = conn.edges?.[0];
          if (typeof first?.starredAt !== 'string') {
            return { ok: false, detail: 'restricted (null starredAt edge values)' };
          }
          return { ok: true, detail: 'available' };
        }),
  );

  // Local, always-on (even --offline) — the code command's circuit breaker
  // is persisted state, not a network probe, and reading it back is never a
  // failure in its own right (an open breaker is DATA the agent should see,
  // same "failing check = data" contract as everything else in doctor).
  checks.push(
    await runCheck('grepAppBreaker', timeoutMs, async () => {
      const breaker = cache.budget.load().grepApp;
      if (!breaker) return { ok: true, detail: 'closed (never tripped)' };
      const retry = breaker.retryAt ? `, retry at ${breaker.retryAt}` : '';
      return {
        ok: true,
        detail: `${breaker.breakerState} (${breaker.consecutiveFailures} consecutive failures${retry})`,
      };
    }),
  );

  const healthy = checks.every((c) => c.ok);
  const summary = `${checks.filter((c) => c.ok).length}/${checks.length} checks ok`;
  return { healthy, checks, summary };
}
