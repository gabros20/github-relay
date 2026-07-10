// Shared transport helper for the no-SLA third-party sources (ecosyste.ms,
// deps.dev). It is host-agnostic on purpose — each adapter still owns its host
// and URL construction — and only centralizes the one mapping those goodwill
// services share: 404 → NOT_FOUND, 5xx / network failure → SOURCE_DOWN (so the
// signal degrades to nodata visibly), anything else non-2xx → FETCH_FAILED.
import { EngineError } from '../types.ts';

export interface ThirdPartyRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export async function thirdPartyJson(
  fetchImpl: typeof fetch,
  source: string,
  req: ThirdPartyRequest,
): Promise<unknown> {
  let res: Response;
  try {
    const init: RequestInit = { method: req.method ?? 'GET' };
    if (req.headers) init.headers = req.headers;
    if (req.body !== undefined) init.body = req.body;
    res = await fetchImpl(req.url, init);
  } catch (e) {
    throw new EngineError(
      'SOURCE_DOWN',
      `${source} unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (res.status === 404) throw new EngineError('NOT_FOUND', `${source}: not found`, 404);
  if (res.status >= 500)
    throw new EngineError('SOURCE_DOWN', `${source} is down (${res.status})`, res.status);
  if (!res.ok)
    throw new EngineError('FETCH_FAILED', `${source} failed with status ${res.status}`, res.status);

  try {
    return await res.json();
  } catch {
    return null;
  }
}
