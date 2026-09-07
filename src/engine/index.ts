// Public API of `engine/` (docs/design/m1-plan.md §2 "engine/"). Re-exports only — no logic
// lives here.

export { DEFAULT_POLICY, DEFAULT_POLICY_FULL, STATE_MACHINE_JSON_PATH, loadStateMachineJson, type EnginePolicyFull, type StateMachineJson } from "./policy.ts";

export {
  SNAPSHOT_SCHEMA_VERSION,
  initialSnapshot,
  nodeKey,
  attemptKey,
  terminalEventKey,
  approvalKey,
  currentAttempt,
  currentNodeExecution,
  isTerminalRun,
  isTerminalNode,
  TERMINAL_RUN_STATES,
  TERMINAL_NODE_STATES,
} from "./snapshot.ts";

export { checkDuplicate, staleReasonFor, validateAgainstRun } from "./stale.ts";

export { classifyFailure, classificationOfError, errorPayloadFor, loadPatternTable } from "./classify.ts";

export { preDispatch, accrueClock, clockBucketFor, type PreDispatchResult, type ClockBucket } from "./budget.ts";

export { changeFingerprint, verdictFingerprint, progressFingerprint, noProgressFires } from "./fingerprint.ts";

export {
  route,
  conditionBranch,
  evaluateRetryEdgeWhen,
  referenceContextFor,
  type RouteResult,
  type RouteError,
  type ConditionBranchResult,
  type RunReferenceInfo,
} from "./route.ts";

export { transition, type EngineTransitionContext } from "./transition.ts";

export { fold, foldEnvelopes, type FoldRow, type FoldRowKind, type FoldContext, type FoldDiagnostic, type FoldResult } from "./fold.ts";
