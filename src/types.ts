// ─── github-relay shared types ───────────────────────────────────────────
// The JSON envelope (mirrors x-relay/youtube-relay-mcp) + the closed error-code
// set (design §9). Downstream adapters (later tasks) are the only modules that
// touch the network; everything else consumes these types.

// ── Error codes (closed set — design §9) ────────────────────────────────────

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'QUERY_TOO_COMPLEX'
  | 'RESULT_CAP'
  | 'ABUSE_DETECTED'
  | 'SOURCE_DOWN'
  | 'CONFIRMATION_REQUIRED'
  | 'UNKNOWN_COMMAND'
  | 'FETCH_FAILED';

/**
 * Thrown by adapters/engines on any failure that maps to one of the closed
 * ErrorCodes. `commands/runners.ts#guard` catches this and turns it into an
 * error envelope with a per-code hint. Anything else thrown is caught too, but
 * surfaces as a generic FETCH_FAILED — EngineError is the deliberate signal
 * that a caller already classified the failure.
 */
export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  /** For RATE_LIMITED: ms the caller should wait before retrying. */
  readonly retryAfterMs?: number;

  constructor(code: ErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

// ── Envelope ────────────────────────────────────────────────────────────────

export type Ok<T> = { ok: true; command: string; data: T };

export type Err = {
  ok: false;
  command: string;
  error: {
    // Not narrowed to ErrorCode: the CLI layer also emits UNKNOWN_COMMAND for
    // names outside the registry and a top-level FATAL for uncaught rejections,
    // neither of which flows through EngineError.
    code: string;
    message: string;
    hint?: string;
    /** HTTP status from the transport layer, when the error originated there. */
    status?: number;
    /** For RATE_LIMITED: ms the caller should wait before retrying. */
    retryAfterMs?: number;
  };
};

export type Envelope<T> = Ok<T> | Err;
