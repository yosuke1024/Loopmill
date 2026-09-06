// Public API of `driver/` (docs/design/m1-plan.md `driver/` row). Re-exports only.

export {
  openRunContext,
  layoutFor,
  resolveLoopPath,
  resolveDryRunContext,
  type Clock,
  type RunContext,
  type OpenRunContextOptions,
  type DryRunLoopContext,
} from "./context.ts";

export { defaultDispatchers, type DefaultDispatchersOptions } from "./dispatchers.ts";

export { runSweep, type RunSweepOptions, type SweepOutcome } from "./sweep.ts";

export { newlyTerminalAttempts } from "./attempts.ts";

export { applyStep, type ApplyStepInput, type ApplyStepOutput } from "./step.ts";

export { runLoop, continueRun, printDryRun, type RunLoopOptions, type RunLoopResult, type ContinueRunInput, type Writer } from "./run.ts";

export { decideGate, type DecideGateInput } from "./gates.ts";

export { writeRunReport, type WriteRunReportInput, type WriteRunReportResult } from "./report.ts";

export {
  statusOf,
  listRunsView,
  logsOf,
  type StatusView,
  type RunsViewEntry,
  type LogsNodeView,
  type LogsAttemptView,
} from "./status.ts";

export {
  runDoctor,
  type DoctorCheck,
  type DoctorResult,
  type DoctorBinaries,
  type DoctorExec,
  type DoctorContext,
  type RunDoctorOptions,
} from "./doctor.ts";
