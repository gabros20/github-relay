// Token resolution + PAT-expiry warning. github-relay deliberately diverges
// from the "degrade to unauthenticated" DNA: 60 requests/hr is unusable for
// research, so a missing token is a LOUD AUTH_FAILED (design §2 Auth), not a
// silent downgrade. The only credential is one free zero-permission
// fine-grained PAT (non-expiring recommended — see doctor).
import { EngineError } from '../types.ts';

/** Runs an argv and returns its stdout + exit code. Injected in tests. */
export type Exec = (cmd: string[]) => Promise<{ stdout: string; exitCode: number }>;

export interface ResolveTokenDeps {
  /** Environment to read GH_TOKEN / GITHUB_TOKEN from (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Shell-out seam for `gh auth token` (defaults to a Bun.spawn runner). */
  exec?: Exec;
}

const defaultExec: Exec = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
};

const AUTH_HINT =
  'set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login`. A free zero-permission ' +
  'fine-grained PAT (non-expiring recommended) is all github-relay needs.';

/**
 * Resolve a GitHub token in the documented order: GH_TOKEN → GITHUB_TOKEN →
 * `gh auth token`. Anything short of a real token throws AUTH_FAILED — the
 * tool never falls back to the unauthenticated 60/hr pool.
 */
export async function resolveToken(deps: ResolveTokenDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const fromEnv = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout, exitCode } = await exec(['gh', 'auth', 'token']);
    const token = stdout.trim();
    if (exitCode === 0 && token) return token;
  } catch {
    // gh not installed / spawn failed — fall through to the loud failure below.
  }
  throw new EngineError('AUTH_FAILED', `no GitHub token found — ${AUTH_HINT}`);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize the `github-authentication-token-expiration` value. GitHub emits a
 * space-separated `YYYY-MM-DD HH:MM:SS ±HHMM` / ` UTC` form that Date.parse
 * doesn't reliably accept, so fall back to an ISO-ish rewrite. Returns null on
 * anything unparseable — a warning helper must never throw.
 */
function parseExpiry(value: string): number | null {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const normalized = value
    .replace(' ', 'T')
    .replace(' UTC', 'Z')
    .replace(/ ([+-]\d{4})$/, '$1');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Given response headers and a clock, return a human warning when the token
 * expires within 7 days (or already has), else null. Used by `doctor` (task 7)
 * to nag before a fine-grained PAT lapses; a non-expiring PAT sends no header
 * and so never warns.
 */
export function tokenExpiryWarning(headers: Headers, now: number): string | null {
  const raw = headers.get('github-authentication-token-expiration');
  if (raw === null) return null;
  const expiry = parseExpiry(raw);
  if (expiry === null) return null;

  const remaining = expiry - now;
  if (remaining >= SEVEN_DAYS_MS) return null;
  if (remaining <= 0)
    return `GitHub token has expired (${raw}); create a non-expiring fine-grained PAT.`;

  const days = Math.ceil(remaining / ONE_DAY_MS);
  return `GitHub token expires in ${days} day${days === 1 ? '' : 's'} (${raw}); create a non-expiring fine-grained PAT to avoid interruptions.`;
}
