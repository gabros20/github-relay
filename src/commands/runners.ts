// Command runners — thin adapters from parsed options to Sources calls, each
// returning a JSON envelope. `guard` is the ONE place EngineError is mapped to
// a per-code hint (design §9), so every future command runner shares the same
// error contract. Command-specific runners land in later tasks as their
// adapters exist; this scaffold ships the shared guard() they'll all use.
import { err, ok } from '../output.ts';
import type { Envelope, ErrorCode } from '../types.ts';
import { EngineError } from '../types.ts';

/** Per-code hint text (design §9 — the closed error-code set). */
function hintFor(code: ErrorCode, message: string): string | undefined {
  switch (code) {
    case 'RATE_LIMITED':
      return "read retryAfterMs, don't guess";
    case 'AUTH_FAILED':
      return 'create a zero-permission fine-grained PAT';
    case 'RESULT_CAP':
      return message.includes('stars:') || message.includes('created:')
        ? 'a ready-made shard suggestion (stars:/created: range) is in the error message'
        : 'slice by stars:/created: date ranges and retry each shard';
    case 'QUERY_TOO_COMPLEX':
      return 'split into batch shards (max 5 AND/OR/NOT operators, 256 chars)';
    case 'ABUSE_DETECTED':
      return 'serialized retry after cooldown';
    case 'SOURCE_DOWN':
      return 'this signal degrades to nodata; other signals still apply';
    case 'CONFIRMATION_REQUIRED':
      return 're-run with --confirm to proceed';
    case 'INVALID_INPUT':
      // code's client-side NL-rejection gate (design §3 item 5) is the one
      // INVALID_INPUT that carries a specific, code-generated hint — same
      // message-sniffing pattern as RESULT_CAP above, since EngineError
      // itself has no hint field of its own. The hint always names the
      // --literal escape hatch (fix wave 1, IMP 2): the heuristic is
      // deliberately permissive but still imperfect, so every rejection
      // tells the caller exactly how to force it through.
      return message.includes('looks like natural language')
        ? 'code lanes need code tokens; use search for concepts — if this is a literal code string, re-run with --literal'
        : undefined;
    case 'NOT_FOUND':
    case 'UNKNOWN_COMMAND':
    case 'FETCH_FAILED':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Run a command's async body, mapping EngineError (and anything else thrown)
 * to a clean error envelope. Never rejects.
 */
export async function guard<T>(command: string, fn: () => Promise<T>): Promise<Envelope<T>> {
  try {
    return ok(command, await fn());
  } catch (e) {
    if (e instanceof EngineError) {
      return err(command, e.code, e.message, hintFor(e.code, e.message), e.status, e.retryAfterMs);
    }
    return err(command, 'FETCH_FAILED', e instanceof Error ? e.message : String(e));
  }
}
