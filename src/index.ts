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
  type Sources,
} from './cli.ts';
