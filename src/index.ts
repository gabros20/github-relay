// Public library surface. Command runners/adapters are added as they land.
export * from './types.ts';
export { ok, err, toJson } from './output.ts';
export { progressReporter, type ProgressReporter } from './progress.ts';
export { isMainModule, shouldForceEntry, shouldRunAsEntry, type EntryDecision } from './entry.ts';
export { COMMANDS, commandNames, type CommandDef } from './commands/registry.ts';
export { guard } from './commands/runners.ts';
export {
  parseArgs,
  dispatch,
  run,
  runGuarded,
  type ParsedArgs,
  type RunResult,
} from './cli.ts';
export { createSources, type Sources, type CreateSourcesOptions } from './sources/index.ts';
export { createCache, type Cache } from './cache/index.ts';
export type { CachePaths } from './cache/paths.ts';
export type { TreeEntry } from './cache/trees.ts';
export type { TarballRecord } from './cache/tarballs.ts';
export type {
  Budget,
  RateWindow,
  GraphqlPoints,
  GrepAppBreaker,
  SimplePool,
} from './cache/budget.ts';
export type { EtagRecord } from './cache/etags.ts';
export {
  CORPUS_SCHEMA,
  createCorpus,
  loadCorpus,
  saveCorpus,
  mergeCorpus,
  type Corpus,
  type CorpusRepo,
  type SignalProvenance,
} from './cache/corpus.ts';
