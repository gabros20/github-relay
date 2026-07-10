// The ONLY module that speaks GitHub's GraphQL surface (design §2). It POSTs
// queries with the fine-grained PAT, embeds/reads the free rateLimit block on
// every query, and does aliased-batch enrichment with adaptive bisection —
// GraphQL timeouts deduct undocumented penalty points, so we halve a failing
// batch instead of blind-retrying the same size. It throws EngineError; it
// never builds envelopes.
import type { ErrorCode } from '../types.ts';
import { EngineError } from '../types.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const RATE_LIMIT_SELECTION = 'rateLimit { cost remaining resetAt nodeCount }';

export interface RateLimitInfo {
  cost: number;
  remaining: number;
  resetAt: string;
  nodeCount: number;
}

export interface GraphqlError {
  type?: string;
  message?: string;
  path?: (string | number)[];
}

/** One repository slot in a batch result: its data, or a per-name isolated error. */
export interface RepoResult<T> {
  name: string;
  data: T | null;
  error?: { code: ErrorCode; message: string };
}

export interface BatchOptions {
  /** Repos per aliased query before bisection (design default 25). */
  batchSize?: number;
  /** Called with each sub-batch size that succeeded — Task 12 persists learned ceilings. */
  onEffectiveSize?: (size: number) => void;
}

export interface GhGraphql {
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  lastRateLimit(): RateLimitInfo | null;
  batchRepositories<T = unknown>(
    names: string[],
    fragment: string,
    opts?: BatchOptions,
  ): Promise<RepoResult<T>[]>;
}

export type GhGraphqlDeps = Partial<Seams> & { getToken: () => Promise<string> };

interface PostResult {
  data: Record<string, unknown> | null | undefined;
  errors: GraphqlError[] | undefined;
  res: Response;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

/** GraphQL timeouts arrive as a 200 carrying a "something went wrong / timeout" error. */
function isTimeoutErrors(errors: GraphqlError[] | undefined): boolean {
  if (!errors) return false;
  return errors.some(
    (e) => typeof e.message === 'string' && /timeout|something went wrong/i.test(e.message),
  );
}

/**
 * Throw for the transport-level statuses GraphQL surfaces distinctly: 401/403
 * auth, 403 secondary-limit (retry-after), and 502/504 gateway (which the batch
 * layer catches to bisect). Returns for anything else — the body is inspected
 * by the caller.
 */
function guardTransportStatus(res: Response): void {
  const { status } = res;
  if (status === 401) throw new EngineError('AUTH_FAILED', 'GitHub rejected the token (401).', 401);
  if (status === 403) {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter !== null) {
      throw new EngineError(
        'ABUSE_DETECTED',
        'GitHub secondary rate limit (403).',
        403,
        Number(retryAfter) * 1000,
      );
    }
    throw new EngineError('AUTH_FAILED', 'GitHub returned 403 (token scope/permission).', 403);
  }
  if (status === 502 || status === 504) {
    throw new EngineError('SOURCE_DOWN', `GitHub GraphQL gateway ${status}.`, status);
  }
}

/**
 * Adapter-level invariant: EVERY GraphQL request carries the free rateLimit
 * block so budget tracking never depends on a caller remembering it (design
 * §2). Deterministic string injection — no GraphQL-parser dependency: if the
 * document already selects rateLimit we leave it alone; otherwise we splice the
 * selection in right after the first `{`, which is the operation's top-level
 * selection-set opener for every shape our callers build (`{…}`, `query {…}`,
 * `query Name($v: T) {…}`). Constraint: this assumes no `{` appears before that
 * opener (e.g. an input-object default value in the variable definitions) —
 * none of our queries use one.
 */
function ensureRateLimit(query: string): string {
  if (/\brateLimit\b/.test(query)) return query;
  const brace = query.indexOf('{');
  if (brace === -1) return query;
  return `${query.slice(0, brace + 1)} ${RATE_LIMIT_SELECTION} ${query.slice(brace + 1)}`;
}

function parseRateLimit(rl: Record<string, unknown>): RateLimitInfo {
  return {
    cost: Number(rl.cost ?? 0),
    remaining: Number(rl.remaining ?? 0),
    resetAt: String(rl.resetAt ?? ''),
    nodeCount: Number(rl.nodeCount ?? 0),
  };
}

export function createGhGraphql(deps: GhGraphqlDeps): GhGraphql {
  const { fetchImpl, now } = withSeamDefaults(deps);
  const { getToken } = deps;
  let rateLimit: RateLimitInfo | null = null;

  /** ms until the primary-limit reset: from the header, else the rateLimit.resetAt. */
  function resetMs(
    res: Response,
    data: Record<string, unknown> | null | undefined,
  ): number | undefined {
    const header = res.headers.get('x-ratelimit-reset');
    if (header) {
      const ms = Number(header) * 1000 - now();
      return ms > 0 ? ms : 0;
    }
    const rl = data && isRecord(data.rateLimit) ? data.rateLimit : undefined;
    const resetAt = rl?.resetAt;
    if (typeof resetAt === 'string') {
      const ms = Date.parse(resetAt) - now();
      return Number.isNaN(ms) ? undefined : ms > 0 ? ms : 0;
    }
    return undefined;
  }

  async function post(query: string, variables?: Record<string, unknown>): Promise<PostResult> {
    const token = await getToken();
    let res: Response;
    try {
      res = await fetchImpl(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'github-relay',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query: ensureRateLimit(query), variables }),
      });
    } catch (e) {
      throw new EngineError('FETCH_FAILED', e instanceof Error ? e.message : String(e));
    }

    guardTransportStatus(res);
    const { status } = res;

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const data = isRecord(body)
      ? (body.data as Record<string, unknown> | null | undefined)
      : undefined;
    const rawErrors = isRecord(body) ? body.errors : undefined;
    const errors = Array.isArray(rawErrors) ? (rawErrors as GraphqlError[]) : undefined;

    const primaryLimit = errors?.find((e) => e.type === 'RATE_LIMITED');
    if (primaryLimit) {
      throw new EngineError(
        'RATE_LIMITED',
        primaryLimit.message ?? 'GraphQL rate limit exceeded.',
        status,
        resetMs(res, data),
      );
    }
    if (!res.ok && data == null) {
      throw new EngineError('FETCH_FAILED', `GitHub GraphQL failed with status ${status}.`, status);
    }

    if (data && isRecord(data.rateLimit)) rateLimit = parseRateLimit(data.rateLimit);
    return { data, errors, res };
  }

  function mapQueryErrors(errors: GraphqlError[]): EngineError {
    const message = errors.map((e) => e.message ?? '').join('; ');
    if (/node limit|complexity|too complex|MAX_NODE/i.test(message)) {
      return new EngineError('QUERY_TOO_COMPLEX', message);
    }
    return new EngineError('FETCH_FAILED', message || 'GraphQL query failed.');
  }

  async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const { data, errors } = await post(query, variables);
    if (data == null && errors && errors.length > 0) throw mapQueryErrors(errors);
    return data as T;
  }

  function buildBatchQuery(chunk: string[], fragment: string): string {
    const aliases = chunk
      .map((full, i) => {
        const slash = full.indexOf('/');
        const owner = full.slice(0, slash);
        const name = full.slice(slash + 1);
        return `  r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fragment} }`;
      })
      .join('\n');
    return `query {\n${aliases}\n  ${RATE_LIMIT_SELECTION}\n}`;
  }

  function mapChunk<T>(
    chunk: string[],
    data: Record<string, unknown> | null | undefined,
    errors: GraphqlError[] | undefined,
  ): RepoResult<T>[] {
    return chunk.map((name, i) => {
      const alias = `r${i}`;
      const value = data ? data[alias] : undefined;
      if (value != null) return { name, data: value as T };
      const aliasError = errors?.find((e) => e.path?.[0] === alias);
      if (aliasError) {
        const code: ErrorCode = aliasError.type === 'NOT_FOUND' ? 'NOT_FOUND' : 'FETCH_FAILED';
        return {
          name,
          data: null,
          error: { code, message: aliasError.message ?? 'GraphQL error' },
        };
      }
      // Null with no matching error: an expected absence, surfaced as nodata.
      return { name, data: null };
    });
  }

  async function fetchChunk<T>(
    chunk: string[],
    fragment: string,
    onEffectiveSize?: (size: number) => void,
  ): Promise<RepoResult<T>[]> {
    let result: PostResult;
    try {
      result = await post(buildBatchQuery(chunk, fragment));
    } catch (e) {
      if (e instanceof EngineError && (e.status === 502 || e.status === 504)) {
        return bisect(chunk, fragment, onEffectiveSize, 'GitHub GraphQL gateway error');
      }
      throw e; // auth / rate-limit: fail the whole batch, never bisect.
    }
    if (isTimeoutErrors(result.errors)) {
      return bisect(chunk, fragment, onEffectiveSize, 'GitHub GraphQL timeout');
    }
    onEffectiveSize?.(chunk.length);
    return mapChunk<T>(chunk, result.data, result.errors);
  }

  async function bisect<T>(
    chunk: string[],
    fragment: string,
    onEffectiveSize: ((size: number) => void) | undefined,
    reason: string,
  ): Promise<RepoResult<T>[]> {
    if (chunk.length <= 1) {
      // Floor: a single repo still failing degrades to a per-name SOURCE_DOWN
      // rather than looping forever.
      return chunk.map((name) => ({
        name,
        data: null,
        error: { code: 'SOURCE_DOWN' as const, message: reason },
      }));
    }
    const mid = Math.ceil(chunk.length / 2);
    const left = await fetchChunk<T>(chunk.slice(0, mid), fragment, onEffectiveSize);
    const right = await fetchChunk<T>(chunk.slice(mid), fragment, onEffectiveSize);
    return [...left, ...right];
  }

  async function batchRepositories<T>(
    names: string[],
    fragment: string,
    opts: BatchOptions = {},
  ): Promise<RepoResult<T>[]> {
    const batchSize = opts.batchSize ?? 25;
    const out: RepoResult<T>[] = [];
    for (let i = 0; i < names.length; i += batchSize) {
      const chunk = names.slice(i, i + batchSize);
      out.push(...(await fetchChunk<T>(chunk, fragment, opts.onEffectiveSize)));
    }
    return out;
  }

  return {
    graphql,
    lastRateLimit: () => rateLimit,
    batchRepositories,
  };
}
