// The Envelope: the single machine-readable record exchanged between the control plane,
// execution backends, humans and GitHub. Transcribed from docs/spec/envelope.schema.json and
// docs/spec/envelope.md §3-§5. No logic: schema validation, producer policy, `eventId`
// derivation and the size rule belong to the `envelope/` module.

import type { FailureReason } from "./state.ts";
import type { JsonValue } from "./loop.ts";
import type { UsageRecord } from "./usage.ts";

/** envelope.schema.json `$defs.eventType`: the 17 catalogued types (envelope.md §5). */
export type EventType =
  | "run-requested"
  | "run-started"
  | "node-dispatched"
  | "node-started"
  | "node-completed"
  | "node-failed"
  | "node-timed-out"
  | "node-observed" // reserved, unreachable in the MVP (SPIKE-2 NO-GO)
  | "human-requested"
  | "human-decided"
  | "quota-parked"
  | "retry-edge-taken"
  | "run-finished"
  | "ignored-stale"
  | "dispatch-failed"
  | "resumed"
  | "lease-expired";

/** envelope.schema.json `$defs.producer`. */
export type Producer = "control-plane" | "human" | "trigger" | `backend:${string}`;

// ---------------------------------------------------------------------------------------------
// Event-scoped payload objects (envelope.md §4)
// ---------------------------------------------------------------------------------------------

/** envelope.md §4.1. Only on `run-requested`. */
export interface TriggerPayload {
  kind: "manual" | "schedule" | "event";
  source?: string;
  actor?: string;
  ref?: string;
  dedupeKey?: string;
  scheduledFor?: string;
}

/** envelope.md §4.2; envelope.schema.json `$defs.result`. `status` is the full 6-value schema
 * enum (the schema, not envelope.md's prose list, is normative for the exact set — it also
 * carries `timed_out`, alongside the values envelope.md calls out by name). */
export interface ResultPayload {
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "skipped" | "no_progress";
  exitCode?: number;
  structured?: Record<string, JsonValue>;
  summary?: string;
}

/** envelope.md §4.3; envelope.schema.json `$defs.artifactRef`. */
export interface ArtifactRef {
  kind: "commit" | "branch" | "pr" | "issue" | "comment" | "actions-artifact" | "file";
  ref: string;
  digest?: string;
  url?: string;
}

/** envelope.md §4.4. Only on `node-dispatched` and `dispatch-failed`. */
export interface DispatchPayload {
  backendId: string;
  runtimeId?: string;
  transport: "repository_dispatch" | "workflow_dispatch" | "comment" | "process" | "api";
  expectedProducer: Producer;
  dedupeKey?: string;
  deadline?: string;
  target?: string;
}

/** envelope.md §4.5. Only on `retry-edge-taken`. */
export interface RetryEdgePayload {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  fromCycle: number;
  toCycle: number;
  maxIterations: number;
  traversals: number;
  budgetConsumed: boolean;
}

/** envelope.md §4.7; envelope.schema.json `$defs.error`. */
export interface ErrorPayload {
  code: string;
  message: string;
  classified:
    | "quota"
    | "auth"
    | "timeout"
    | "transient"
    | "invalid_input"
    | "artifact_invalid"
    | "backend_error"
    | "runtime_error"
    | "cancelled"
    | "unknown";
}

/** envelope.md §4.8; envelope.schema.json `$defs.humanGate`. Fields are optional here exactly
 * as in the raw schema $def; per-eventType requiredness (`human-requested` needs `mode` and
 * `subjectDigest`, `human-decided` needs `decision` and `subjectDigest`) is a validation rule,
 * not a type-level distinction. */
export interface HumanPayload {
  mode?: "cli" | "pull-request-review" | "label";
  subjectDigest?: string;
  decision?: "approve" | "reject" | "cancel";
  decidedBy?: string;
  deadline?: string;
  note?: string;
}

/**
 * envelope.md §4.9; envelope.schema.json `$defs.outcome` (schema 1.1.0). Decision (not in
 * sheet): this does NOT re-export `state.ts`'s `Outcome` — the shapes do not coincide.
 * `state.ts`'s `Outcome` is a discriminated union with a distinct payload per Run state
 * (`label`, `by`, `edgeId`, ...); the wire form is a single flatter object with every field
 * optional except `state`, matching the schema's `allOf` conditionals (`SUCCEEDED` requires
 * `endLabel`, `FAILED` requires `failureReason`, and so on per state) rather than TypeScript's
 * discriminated-union narrowing.
 *
 * Amendment (m0+), schema 1.1.0: `nodeId` through `ref` below are additive — `$defs.outcome`
 * gained them so a `run-finished` envelope can carry `state.ts`'s `Outcome` in full (envelope.md
 * §4.9, §12). A schema-1.0.0 record (`state`/`endLabel`/`failureReason`/`cycles`/`summary` only)
 * is still valid.
 */
export interface OutcomePayload {
  state:
    | "SUCCEEDED"
    | "FAILED"
    | "CANCELLED"
    | "MAX_ITERATIONS_EXCEEDED"
    | "BUDGET_EXCEEDED"
    | "EXPIRED"
    | "SKIPPED";
  endLabel?: string;
  failureReason?: FailureReason;
  cycles?: number;
  summary?: string;
  /** FAILED: the node the failure is attributed to, where known. */
  nodeId?: string;
  /** FAILED: the cycle the failure is attributed to, where known. */
  cycleIndex?: number;
  /** CANCELLED: who or what cancelled the Run. */
  by?: "human" | "platform" | "timeout-escalation";
  /** CANCELLED: the authenticated identity that cancelled the Run, where one applies. */
  actor?: string;
  /** MAX_ITERATIONS_EXCEEDED: the Retry Edge that exhausted its budget. */
  edgeId?: string;
  /** MAX_ITERATIONS_EXCEEDED: the edge's budget-consuming traversal count. */
  traversals?: number;
  /** MAX_ITERATIONS_EXCEEDED: the edge's configured iteration budget. */
  maxIterations?: number;
  /** BUDGET_EXCEEDED: which budget was exhausted. */
  budgetKey?: "maxMeasuredTokens" | "maxUnmeasuredExecutions" | "maxStepsPerRun";
  /** BUDGET_EXCEEDED: the configured limit of `budgetKey`. */
  limit?: number;
  /** BUDGET_EXCEEDED: the observed value that exceeded `limit`. */
  observed?: number;
  /** EXPIRED: which deadline elapsed. */
  expiryReason?: "max_runtime" | "human_timeout";
  /** SKIPPED: why the Run was skipped without dispatching anything. */
  skipReason?: "dedupe" | "min_interval" | "runs_per_window";
  /** SKIPPED: a reference for `skipReason`, e.g. the `dedupeKey` or the open change it matched. */
  ref?: string;
}

/** envelope.md §4.11; envelope.schema.json `$defs.matcher`. Reserved, unreachable in the MVP
 * (node-observed / SPIKE-2 NO-GO). Same shape as `state.ts`'s `Matcher`, kept as a separate
 * type here because this one is the wire payload, not the engine-internal record. */
export interface MatcherPayload {
  kind: "comment-block" | "file-in-diff" | "cloud-status";
  ref: string;
  outcome: "found_valid" | "found_invalid";
}

/** envelope.md §4.12. Only on `resumed`. */
export interface ResumePayload {
  kind: "due" | "manual" | "interrupted";
  decision?: "retry" | "skip" | "fail";
  actor?: string;
}

// ---------------------------------------------------------------------------------------------
// The Envelope itself (envelope.md §3)
// ---------------------------------------------------------------------------------------------

/**
 * The Envelope. `cycle`/`nodeId`/`attempt` are required together for node-level event types and
 * forbidden on run-level ones (envelope.md §3.2); that conditional requirement is a validation
 * rule (`envelope/`), so at the type level all three stay optional. Every event-scoped object is
 * likewise optional here; which ones are legal (and required) for a given `eventType` is
 * envelope.md §3.4 and the schema's `allOf` conditionals, not a type-level distinction.
 * `additionalProperties: false` in the schema means no `[key: string]` index signature here.
 */
export interface Envelope {
  schemaVersion: string;
  eventId: string;
  eventType: EventType;
  occurredAt: string;
  producer: Producer;
  loopId: string;
  loopVersion: string;
  runId: string;

  cycle?: number;
  nodeId?: string;
  attempt?: number;

  causationId?: string;
  correlationId?: string;

  result?: ResultPayload;
  artifactRefs?: ArtifactRef[];
  usage?: UsageRecord;
  error?: ErrorPayload;
  /** RESERVED. Not used by envelope schema 1.x: receivers MUST ignore it. */
  signature?: string;
  reason?: string;
  quotaResetsAt?: string;

  trigger?: TriggerPayload;
  dispatch?: DispatchPayload;
  retryEdge?: RetryEdgePayload;
  matcher?: MatcherPayload;
  resume?: ResumePayload;
  human?: HumanPayload;
  outcome?: OutcomePayload;
}

// ---------------------------------------------------------------------------------------------
// Pure type helper
// ---------------------------------------------------------------------------------------------

/** envelope.schema.json `$defs.nodeLevelEventType`: event types that require `cycle`, `nodeId`
 * and `attempt` together (envelope.md §3.2). */
export const NODE_LEVEL_EVENT_TYPES = [
  "node-dispatched",
  "node-started",
  "node-completed",
  "node-failed",
  "node-timed-out",
  "node-observed",
  "human-requested",
  "human-decided",
  "quota-parked",
  "dispatch-failed",
  "lease-expired",
] as const;

export type NodeLevelEventType = (typeof NODE_LEVEL_EVENT_TYPES)[number];

/** True iff `eventType` is one of the node-level event types (envelope.md §3.2). Pure. */
export function isNodeLevelEvent(eventType: EventType): eventType is NodeLevelEventType {
  return (NODE_LEVEL_EVENT_TYPES as readonly string[]).includes(eventType);
}
