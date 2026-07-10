import { describe, expect, test } from 'bun:test';
import { createDepsDev } from '../../src/sources/depsdev.ts';
import type { EngineError } from '../../src/types.ts';

function recordingFetch(handler: () => Response): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return handler();
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('depsdev — project (Scorecard)', () => {
  test('url-encodes the github.com/owner/repo project key', async () => {
    const { fetchImpl, urls } = recordingFetch(() => Response.json({ scorecard: {} }));
    const deps = createDepsDev({ fetchImpl });
    await deps.project('facebook', 'react');
    expect(urls[0]).toBe('https://api.deps.dev/v3/projects/github.com%2Ffacebook%2Freact');
  });

  test('404 → NOT_FOUND', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('no', { status: 404 }));
    const deps = createDepsDev({ fetchImpl });
    const err = (await deps.project('a', 'b').catch((e) => e)) as EngineError;
    expect(err.code).toBe('NOT_FOUND');
  });

  test('5xx → SOURCE_DOWN', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('boom', { status: 502 }));
    const deps = createDepsDev({ fetchImpl });
    const err = (await deps.project('a', 'b').catch((e) => e)) as EngineError;
    expect(err.code).toBe('SOURCE_DOWN');
  });
});

describe('depsdev — projectPackageVersions (repo→purl mapping)', () => {
  test('appends the :packageversions verb to the encoded project key', async () => {
    const { fetchImpl, urls } = recordingFetch(() => Response.json({ versions: [] }));
    const deps = createDepsDev({ fetchImpl });
    await deps.projectPackageVersions('vercel', 'next.js');
    expect(urls[0]).toBe(
      'https://api.deps.dev/v3/projects/github.com%2Fvercel%2Fnext.js:packageversions',
    );
  });
});

describe('depsdev — dependents (v3alpha)', () => {
  test('builds the v3alpha systems/packages/versions :dependents path with encoding', async () => {
    const { fetchImpl, urls } = recordingFetch(() => Response.json({ dependentCount: 42 }));
    const deps = createDepsDev({ fetchImpl });
    await deps.dependents({ system: 'npm', name: '@scope/pkg' }, '1.2.3');
    expect(urls[0]).toBe(
      'https://api.deps.dev/v3alpha/systems/npm/packages/%40scope%2Fpkg/versions/1.2.3:dependents',
    );
  });
});
