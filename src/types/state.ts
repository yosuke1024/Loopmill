// The three state machines (Run, Node Execution, Attempt) and the pure `transition()`
// contract. Transcribed from docs/spec/state-machine.md §2 (states), §5 (the `transition`
// contract), §7.1 (`classifyFailure`), §8.2 (`Subject`) and §10.1 (`Lease`); cross-checked
// against the enums in docs/spec/state-machine.json. No logic: `engine/` implements
// `transition`, `classifyFailure`, `fold` and the stale test against these shapes.

import type { RuntimeId } from "./capabilities.ts";
import type { ArtifactRef, Envelope, ErrorPayload } from "./envelope.ts";
import type { ResolvedLoop } from "./loop.ts";
import type { UsageRecord } from "./usage.ts";

// ---------------------------------------------------------------------------------------------
// 2. States
// ---------------------------------------------------------------------------------------------

/** state-machine.md §2.1; cross-checked against state-machine.json `enums.runState`. */
export type RunState =
  | "PENDING"
  | "RUNNING"
  | "WAITING_HUMAN"
  | "WAITING_FOR_QUOTA"
  | "WAITING_OBSERVED"
  | "INTERRUPTED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "MAX_ITERATIONS_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "EXPIRED"
  | "SKIPPED";

/** state-machine.md §2.3; cross-checked against state-machine.json `enums.nodeExecutionState`. */
export type NodeExecutionState =
  | "PENDING"
  | "DISPATCHED"
  | "RUNNING"
  | "OBSERVING"
  | "WAITING_HUMAN"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "SKIPPED"
  | "NO_PROGRESS";

/** state-machine.md §2.4; cross-checked against state-machine.json `enums.attemptState`. */
export type AttemptState = "DISPATCHED" | "COMPLETED" | "FAILED" | "LOST";

/** state-machine.md §2.2, `BudgetKey`. `maxIterations`, `maxRuntime` and `maxAttempts` have
 * their own terminal states or node-level handling and never appear here (invariant I-19). */
export type BudgetKey = "maxMeasuredTokens" | "maxUnmeasuredExecutions" | "maxStepsPerRun";

/** state-machine.md §2.2, `FailureReason` (closed enum, extendable only by a schema version bump). */
export type FailureReason =
  | "node_failed"
  | "node_timed_out"
  | "attempts_exhausted"
  | "dispatch_failed"
  | "artifact_invalid"
  | "observe_deadline"
  | "condition_error"
  | "schema_invalid"
  | "no_progress_stalled"
  | "quota_unclassifiable"
  | "quota_parks_exhausted"
  | "human_rejected"
  | "interrupted_abandoned"
  | "validation_error";

/**
 * state-machine.md §2.2: the discriminated payload every terminal Run state carries, written
 * once into the single `run-finished` event and copied into `snapshot.outcome`.
 */
export type Outcome =
  | { state: "SUCCEEDED"; label: string } // end node's outcome label
  | { state: "FAILED"; failureReason: FailureReason; nodeId?: string; cycleIndex?: number }
  | { state: "CANCELLED"; by: "human" | "platform" | "timeout-escalation"; actor?: string }
  | { state: "MAX_ITERATIONS_EXCEEDED"; edgeId: string; traversals: number; maxIterations: number }
  | { state: "BUDGET_EXCEEDED"; budgetKey: BudgetKey; limit: number; observed: number }
  | { state: "EXPIRED"; expiryReason: "max_runtime" | "human_timeout"; nodeId?: string }
  | { state: "SKIPPED"; skipReason: "dedupe" | "min_interval" | "runs_per_window"; ref?: string };

// ---------------------------------------------------------------------------------------------
// 5.3 Stale reasons
// ---------------------------------------------------------------------------------------------

/** state-machine.md §5.3, closed enum; cross-checked against state-machine.json `enums.staleReason`. */
export type StaleReason =
  | "duplicate_event_id" // returned as kind 'duplicate', not as an ignored-stale event
  | "semantic_duplicate"
  | "run_terminal"
  | "run_not_started"
  | "run_already_started"
  | "unknown_node"
  | "stale_cycle"
  | "future_cycle"
  | "stale_attempt"
  | "future_attempt"
  | "no_attempt_in_flight"
  | "node_terminal"
  | "approval_subject_mismatch"
  | "not_due"
  | "lease_not_expired"
  | "wrong_wait_state"
  | "producer_not_expected"
  | "unknown_event_type";

// ---------------------------------------------------------------------------------------------
// 5. The `transition` contract
// ---------------------------------------------------------------------------------------------

/** state-machine.md §5.1. */
export interface TransitionContext {
  loop: ResolvedLoop; // the pinned loopVersion, already schema-validated
  now: string; // RFC 3339 — the ONLY time source; injected, never read from the clock
  policy: EnginePolicy;
}

/** state-machine.md §5.1: `ValidationError`, transcribed. */
export interface ValidationError {
  code: string;
  message: string;
  path?: string;
}

export type TransitionResult =
  | { kind: "applied"; snapshot: RunSnapshot; emitted: Envelope[]; actions: Action[] }
  | { kind: "duplicate"; snapshot: RunSnapshot; emitted: []; actions: [] }
  | { kind: "ignored-stale"; snapshot: RunSnapshot; emitted: [Envelope]; actions: []; reason: StaleReason }
  | { kind: "invalid"; snapshot: RunSnapshot; emitted: []; actions: []; error: ValidationError };

export type Action =
  | {
      type: "dispatch";
      backendId: string;
      nodeId: string;
      cycle: number;
      attempt: number;
      deadlineAt: string;
      dedupeKey: string;
    }
  | {
      type: "request-approval";
      mode: GateMode;
      nodeId: string;
      cycle: number;
      subject: Subject;
      expiresAt: string;
    }
  | {
      type: "observe";
      matcher: Matcher;
      nodeId: string;
      cycle: number;
      attempt: number;
      deadlineAt: string;
    }
  | { type: "wait"; until: string | null }
  | { type: "finish"; outcome: Outcome };

/** state-machine.md §5.1 comment: engine defaults `transition()` is parameterised on. */
export interface EnginePolicy {
  maxAttempts: number;
  dispatchGraceSeconds: number;
  convergenceLimit: number;
  maxQuotaParks: number;
  maxStepsPerRun: number;
  quotaJitterSeconds: number;
}

// ---------------------------------------------------------------------------------------------
// 5.6 The snapshot
// ---------------------------------------------------------------------------------------------

/** A Retry Edge id, used as a `RunSnapshot.traversals`/`freeTraversals` record key. */
export type EdgeId = string;

/**
 * state-machine.md §5.6, transcribed. The original prose names the `current.nodeState` field's
 * type `NodeState`; that name is not defined anywhere else in the spec, so it is resolved here
 * to `NodeExecutionState`, the type §2.3 actually defines for exactly this purpose.
 */
export interface RunSnapshot {
  schemaVersion: string;
  snapshotOf: number; // last applied event number
  eventSeq: number;

  runId: string;
  loopId: string;
  loopVersion: string;
  loopDigest: string;
  trigger: { kind: "manual" | "schedule" | "event"; source?: string; dedupeKey?: string; requestedAt: string };

  status: RunState;
  outcome: Outcome | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;

  cycleIndex: number; // current cycle label (0 = outside every Retry Edge body)
  maxCycleIndex: number;
  traversals: Record<EdgeId, number>; // budget-consuming traversals
  freeTraversals: Record<EdgeId, number>; // NO_PROGRESS traversals (§6.6)
  noProgressStreak: number;
  changeFingerprints: Record<string, string>; // "<cycle>:<nodeId>" -> sha256
  verdictFingerprints: Record<number, string>; // cycleIndex -> sha256

  current: { nodeId: string; cycleIndex: number; attempt: number; nodeState: NodeExecutionState } | null;
  nodes: Record<`${number}:${string}`, NodeExecutionRecord>;
  attempts: Record<`${number}:${string}:${number}`, AttemptRecord>;
  chargedAttempts: Record<`${number}:${string}`, number>;

  quota: { parks: number; quotaResetsAt: string; resumeDueAt: string; window: string; source: string } | null;
  pendingApproval: {
    nodeId: string;
    cycleIndex: number;
    attempt: number;
    mode: GateMode;
    subject: Subject;
    requestedAt: string;
    expiresAt: string;
  } | null;
  approvals: Record<
    `${number}:${string}:${number}:${string}`,
    { decision: string; actor: string; decidedAt: string }
  >;
  observe: { nodeId: string; cycleIndex: number; attempt: number; matcher: Matcher; deadlineAt: string } | null;
  lease: Lease | null;
  interrupted: { nodeId: string; cycleIndex: number; attempt: number; reason: string; at: string } | null;

  budget: {
    stepsUsed: number;
    activeMs: number;
    waitMs: number;
    measuredTokens: number;
    agentExecutions: number;
    measuredExecutions: number;
    unmeasuredExecutions: number;
  };

  artifactRefs: ArtifactRef[];
  appliedEventIds: string[];
  ignoredEventIds: string[];
  emittedEventIds: string[];
  terminalEventKeys: string[]; // "<cycle>:<nodeId>:<attempt>:<eventType>"
}

/**
 * A Node Execution's persisted record. The spec never presents this as a single interface;
 * this field list is derived from prose across §2.3 (the states it cycles through), §2.4
 * ("Every Attempt carries..." — what the containing Node Execution rolls up), §5.6 (the shape
 * it must fit inside `RunSnapshot.nodes`) and §6.6 (`filesChanged`, `changeFingerprint`).
 */
export interface NodeExecutionRecord {
  nodeId: string;
  cycleIndex: number;
  state: NodeExecutionState;
  attemptsUsed: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** The last attempt's `result.summary`, if any. */
  summary: string | null;
  filesChanged: number;
  /** §6.6 `changeFingerprint(cycle, nodeId)`; null before the node has ever completed. */
  changeFingerprint: string | null;
  artifactRefs: ArtifactRef[];
}

/**
 * An Attempt's persisted record. Derived from prose in §2.4 ("Every Attempt carries
 * `classification`, `usage` ... and `artifactRefs[]`") and §10.1 (the lease fields an attempt
 * owns while dispatched).
 */
export interface AttemptRecord {
  cycleIndex: number;
  nodeId: string;
  attempt: number;
  state: AttemptState;
  classification: Classification | null;
  dispatchedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  usage: UsageRecord | null;
  artifactRefs: ArtifactRef[];
  error: ErrorPayload | null;
  exitCode: number | null;
  signal: string | null;
}

// ---------------------------------------------------------------------------------------------
// 7. Quota semantics / classifyFailure
// ---------------------------------------------------------------------------------------------

/** state-machine.md §7.1. Internal verdict; the wire form is the envelope's `error.classified`
 * (a fixed mapping is documented in §7.1's table, not encoded here — that is engine logic). */
export type Classification = "SUCCESS" | "FAILED" | "QUOTA" | "TIMEOUT" | "CANCELLED" | "LOST";

/** state-machine.md §7.1, `classifyFailure`'s parameter object. */
export interface ClassifyInput {
  runtimeId: RuntimeId;
  runtimeVersion: string;
  exitCode: number | null;
  signal: string | null;
  result: unknown | null; // claude-code result message / codex turn.completed|turn.failed
  streamEvents: unknown[]; // for leading indicators (system/api_retry, ThreadError)
  cancelRequested: boolean; // Loopmill itself asked for the cancel
  timeoutFired: boolean; // Loopmill's own node timeout fired
  deadlineMissed: boolean; // the sweep found no completion by deadlineAt
  patterns: PatternTable; // versioned, data-driven, shipped as a fixture
}

/** state-machine.md §7.1, `classifyFailure`'s return shape. */
export interface ClassifyOutput {
  classification: Classification;
  quotaResetsAt?: string;
  quotaWindow?: string;
  quotaSource?: string;
  code: string;
  message: string;
}

/** One runtime's positive/negative quota-detection patterns (state-machine.md §7.3). Kept as
 * free text (not compiled `RegExp`s) since the table ships as a versioned test fixture, not
 * code (§7.1: "pure, versioned and data-driven... the table is a test fixture, not code"). */
export interface QuotaPatternSet {
  positive: string[];
  negative: string[];
  resetSuffix?: string;
  resetSource?: string;
  derivedWindowSeconds?: Record<string, number>;
}

/**
 * `classifyFailure`'s pattern table (state-machine.md §7.1, §7.3): keyed by `runtimeId`, then
 * by the runtime-version range the pattern set was verified against. Decision (not in sheet):
 * the spec describes the table in prose ("keyed by runtimeId and a runtime-version range") and
 * ships a single-range JSON example (`state-machine.json` `quotaPatterns`) rather than an
 * interface; this is a reasonable JSON-serialisable generalisation that keeps room for more
 * than one verified range per runtime.
 */
export type PatternTable = Record<string, Array<{ versionRange: string; patterns: QuotaPatternSet }>>;

// ---------------------------------------------------------------------------------------------
// 8. Human gates
// ---------------------------------------------------------------------------------------------

/** state-machine.md §8.2, transcribed. */
export type Subject =
  | { kind: "diff"; ref: string /* branch@commit */; digest: string /* sha256 of the unified diff */ }
  | { kind: "structured"; ref: string /* nodeId */; digest: string /* sha256 of canonical JSON */ }
  | { kind: "pr"; ref: string /* owner/repo#n@headSha */; digest: string }
  | { kind: "command"; ref: string /* nodeId */; digest: string /* sha256 of resolved argv */ };

/** state-machine.md §8.1 table; same value set as `loop.ts`'s `HumanMode`. Cross-checked
 * against state-machine.json `enums.gateMode`. */
export type GateMode = "cli" | "pull-request-review" | "label";

// ---------------------------------------------------------------------------------------------
// 9. Observed backends (reserved, unreachable in the MVP)
// ---------------------------------------------------------------------------------------------

/** state-machine.md §9.2; envelope.schema.json `$defs.matcher`. Reserved: no MVP backend
 * declares `result: observed`. Kept minimal since nothing in the MVP constructs one. */
export interface Matcher {
  kind: "comment-block" | "file-in-diff" | "cloud-status";
  ref: string;
  outcome: "found_valid" | "found_invalid";
}

// ---------------------------------------------------------------------------------------------
// 10. Lease and interruption
// ---------------------------------------------------------------------------------------------

/** state-machine.md §10.1, the durable attempt lease. */
export interface Lease {
  kind: "attempt";
  holder: string; // "<cycle>:<nodeId>:<attempt>"
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  runHandle?: string; // a local pid + host name; a GitHub Actions run id under the reserved backend
}
