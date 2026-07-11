import { describe, expect, test } from 'bun:test';
import { createEcosystems } from '../../src/sources/ecosystems.ts';
import type { EngineError } from '../../src/types.ts';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function recordingFetch(handler: (call: Call) => Response): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('ecosystems — repo lookup', () => {
  test('looks up a repo by full_name on repos.ecosyste.ms with the polite-pool mailto UA', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      Response.json({ full_name: 'facebook/react' }),
    );
    const eco = createEcosystems({ fetchImpl });
    const data = await eco.repo('facebook/react');
    expect(calls[0]?.url).toBe(
      'https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/facebook/react',
    );
    expect(calls[0]?.headers.get('user-agent')).toBe(
      'github-relay (mailto:t.gabor880312@gmail.com)',
    );
    expect(data).toEqual({ full_name: 'facebook/react' });
  });

  test('a 404 → NOT_FOUND (the caller decides whether that is nodata)', async () => {
    const { fetchImpl } = recordingFetch(() =>
      Response.json({ error: 'not found' }, { status: 404 }),
    );
    const eco = createEcosystems({ fetchImpl });
    const err = (await eco.repo('ghost/repo').catch((e) => e)) as EngineError;
    expect(err.code).toBe('NOT_FOUND');
  });

  test('upstream 5xx → SOURCE_DOWN (degrades a signal to nodata visibly)', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('down', { status: 503 }));
    const eco = createEcosystems({ fetchImpl });
    const err = (await eco.repo('a/b').catch((e) => e)) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
  });

  test('a network throw is also SOURCE_DOWN, never a leaked exception', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const eco = createEcosystems({ fetchImpl });
    const err = (await eco.repo('a/b').catch((e) => e)) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
  });
});

describe('ecosystems — bulkLookupPackages', () => {
  test('chunks purls at 100 per POST and concatenates the results in order', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      const purls = (call.body as { purls: string[] }).purls;
      return Response.json(purls.map((p) => ({ purl: p })));
    });
    const eco = createEcosystems({ fetchImpl });
    const purls = Array.from({ length: 250 }, (_, i) => `pkg:npm/p${i}`);
    const results = await eco.bulkLookupPackages(purls);

    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (c.body as { purls: string[] }).purls.length)).toEqual([100, 100, 50]);
    expect(calls[0]?.url).toBe('https://packages.ecosyste.ms/api/v1/packages/bulk_lookup');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('content-type')).toContain('application/json');
    expect(results).toHaveLength(250);
    expect(results[0]).toEqual({ purl: 'pkg:npm/p0' });
    expect(results[249]).toEqual({ purl: 'pkg:npm/p249' });
  });

  test('an empty purl list makes no request and returns []', async () => {
    const { fetchImpl, calls } = recordingFetch(() => Response.json([]));
    const eco = createEcosystems({ fetchImpl });
    expect(await eco.bulkLookupPackages([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
