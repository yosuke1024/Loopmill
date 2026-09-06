// Public API of `backends/local/` (docs/design/mvp-design.md §6.2 "local"; docs/design/m1-plan.md
// §2 "backends/"). Re-exports only.

export { LocalDispatcher, type LocalDispatcherOptions, type LocalDispatcherLayout } from "./executor.ts";
export { buildChildEnv, type BuildChildEnvResult } from "./env.ts";
export {
  ensureWorktree,
  resetToCycleBase,
  changedFiles,
  commitCycle,
  headCommit,
  type EnsureWorktreeInput,
  type EnsureWorktreeResult,
  type ChangedFile,
} from "./worktree.ts";
export { runProcess, type CancelStep, type RunProcessInput, type RunProcessResult } from "./spawn.ts";
export { openCapturedStreams, tail, type CapturedStreams } from "./logs.ts";
export {
  runCommand,
  resolveCommandCwd,
  toScalarInputs,
  truncateStdout,
  type RunCommandInput,
  type RunCommandResult,
} from "./command.ts";
export { buildClaudeArgv, parseClaudeResult, claudeCompletion, type ClaudeCompletionInput } from "./adapters/claude-code.ts";
export {
  buildCodexArgv,
  parseCodexStream,
  codexCompletion,
  type CodexCompletionInput,
} from "./adapters/codex.ts";
export { classificationToCompletion, type RuntimeCompletion, type ClassificationToCompletionInput } from "./completion.ts";
export { loadDefaultPatternTable } from "./patterns.ts";
