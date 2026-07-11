// The source factory + the narrowed `Sources` bag every command runner is
// injected with (design §2). Construction is lazy: each adapter is built on
// first access and the token is resolved once, on the first GitHub call, and
// memoized — so a keyless-only path (ecosyste.ms / deps.dev) never shells out
// for auth. Command dispatch is NOT wired here; runners land in tasks 4-7.
import type { Exec } from './auth.ts';
import { resolveToken } from './auth.ts';
import { type ClickhousePlay, createClickhousePlay } from './clickhouse-play.ts';
import { type DepsDev, createDepsDev } from './depsdev.ts';
import { type Ecosystems, createEcosystems } from './ecosystems.ts';
import { type GhGraphql, createGhGraphql } from './gh-graphql.ts';
import { type CreateSink, type GhRest, createGhRest } from './gh-rest.ts';
import { type GrepApp, createGrepApp } from './grep-app.ts';
import { type OssInsight, createOssInsight } from './ossinsight.ts';
import type { Seams } from './seams.ts';
import { withSeamDefaults } from './seams.ts';

export interface Sources {
  ghGraphql: GhGraphql;
  ghRest: GhRest;
  ecosystems: Ecosystems;
  depsdev: DepsDev;
  grepApp: GrepApp;
  clickhouse: ClickhousePlay;
  ossinsight: OssInsight;
}

export interface CreateSourcesOptions extends Partial<Seams> {
  /** Environment for token resolution (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Shell-out seam for `gh auth token`. */
  exec?: Exec;
  /** Streaming file-sink seam for gh-rest tarball downloads (defaults to a node:fs write stream). */
  createSink?: CreateSink;
}

export function createSources(opts: CreateSourcesOptions = {}): Sources {
  const seams = withSeamDefaults(opts);

  // Resolve the token at most once, and only when someone asks for it.
  let tokenPromise: Promise<string> | undefined;
  const getToken = (): Promise<string> => {
    tokenPromise ??= resolveToken({ env: opts.env, exec: opts.exec });
    return tokenPromise;
  };

  let ghGraphql: GhGraphql | undefined;
  let ghRest: GhRest | undefined;
  let ecosystems: Ecosystems | undefined;
  let depsdev: DepsDev | undefined;
  let grepApp: GrepApp | undefined;
  let clickhouse: ClickhousePlay | undefined;
  let ossinsight: OssInsight | undefined;

  return {
    get ghGraphql(): GhGraphql {
      ghGraphql ??= createGhGraphql({ ...seams, getToken });
      return ghGraphql;
    },
    get ghRest(): GhRest {
      ghRest ??= createGhRest({ ...seams, getToken, createSink: opts.createSink });
      return ghRest;
    },
    get ecosystems(): Ecosystems {
      ecosystems ??= createEcosystems(seams);
      return ecosystems;
    },
    get depsdev(): DepsDev {
      depsdev ??= createDepsDev(seams);
      return depsdev;
    },
    get grepApp(): GrepApp {
      grepApp ??= createGrepApp(seams);
      return grepApp;
    },
    get clickhouse(): ClickhousePlay {
      clickhouse ??= createClickhousePlay(seams);
      return clickhouse;
    },
    get ossinsight(): OssInsight {
      ossinsight ??= createOssInsight(seams);
      return ossinsight;
    },
  };
}
