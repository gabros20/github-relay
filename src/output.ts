// Envelope construction — the ONE stdout contract every command honors:
// {ok:true,command,data} / {ok:false,command,error:{code,message,hint?,status?,retryAfterMs?}}.
import type { Err, Ok } from './types.ts';

export function ok<T>(command: string, data: T): Ok<T> {
  return { ok: true, command, data };
}

export function err(
  command: string,
  code: string,
  message: string,
  hint?: string,
  status?: number,
  retryAfterMs?: number,
): Err {
  const error: Err['error'] = { code, message };
  if (hint !== undefined) error.hint = hint;
  if (status !== undefined) error.status = status;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return { ok: false, command, error };
}

/** Pretty (2-space) by default; `compact:true` prints single-line JSON for MCP/agent contexts. */
export function toJson(envelope: unknown, compact = false): string {
  return compact ? JSON.stringify(envelope) : JSON.stringify(envelope, null, 2);
}
