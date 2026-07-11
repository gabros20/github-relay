import { describe, expect, test } from 'bun:test';
import { createSources } from '../../src/sources/index.ts';

// A fetch fake that answers everything with a trivial JSON body and records urls.
function anyFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json({ data: { rateLimit: {} } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('createSources — shape + injected seams', () => {
  test('exposes the four adapters', () => {
    const { fetchImpl } = anyFetch();
    const sources = createSources({ fetchImpl, env: { GH_TOKEN: 't' } });
    expect(typeof sources.ghGraphql.graphql).toBe('function');
    expect(typeof sources.ghRest.get).toBe('function');
    expect(typeof sources.ecosystems.repo).toBe('function');
    expect(typeof sources.depsdev.project).toBe('function');
    expect(typeof sources.grepApp.search).toBe('function');
    expect(typeof sources.clickhouse.monthlyEvents).toBe('function');
  });

  test('the injected fetchImpl is the one the adapters actually use', async () => {
    const { fetchImpl, urls } = anyFetch();
    const sources = createSources({ fetchImpl, env: { GH_TOKEN: 't' } });
    await sources.depsdev.project('a', 'b');
    expect(urls).toEqual(['https://api.deps.dev/v3/projects/github.com%2Fa%2Fb']);
  });
});

describe('createSources — lazy, memoized token', () => {
  test('token is resolved only when a GitHub adapter actually makes a call', async () => {
    let execCalls = 0;
    const exec = async () => {
      execCalls += 1;
      return { stdout: 'cli-token', exitCode: 0 };
    };
    const { fetchImpl } = anyFetch();
    const sources = createSources({ fetchImpl, env: {}, exec });

    // Constructing + a keyless adapter call must not touch auth.
    await sources.ecosystems.repo('a/b');
    expect(execCalls).toBe(0);

    // The first GitHub call resolves the token; a second reuses it (memoized).
    await sources.ghGraphql.graphql('query{rateLimit}');
    await sources.ghGraphql.graphql('query{rateLimit}');
    expect(execCalls).toBe(1);
  });

  test('the same adapter instance is returned on repeated access (lazy singleton)', () => {
    const { fetchImpl } = anyFetch();
    const sources = createSources({ fetchImpl, env: { GH_TOKEN: 't' } });
    expect(sources.ghGraphql).toBe(sources.ghGraphql);
    expect(sources.ghRest).toBe(sources.ghRest);
    expect(sources.grepApp).toBe(sources.grepApp);
  });
});
