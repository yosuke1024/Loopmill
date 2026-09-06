// The RunSnapshot: its schema version, the initial (pre-`run-requested`-applied) shape
// (state-machine.md §5.6), and the small key-building/lookup helpers every other engine module
// shares so `nodeKey`/`attemptKey`/`terminalEventKey` are computed exactly one way.

import type { Envelope } from "../types/envelope.ts";
import type { ResolvedLoop } from "../types/loop.ts";
import type { AttemptRecord, NodeExecutionRecord, NodeExecutionState, RunSnapshot, RunState } from "../types/state.ts";

/** The snapshot's own schema version (independent of the envelope and loop-file schema
 * versions — this is a new artifact `engine/` introduces, docs/design/m1-plan.md §2 "engine/").
 * Decision (not in sheet), m1: no version is named in the spec for this field; "1.0.0" is
 * chosen following the same `x.y.z` convention `ENVELOPE_SCHEMA_VERSION` and loop-file
 * `schemaVersion` use. */
export const SNAPSHOT_SCHEMA_VERSION = "1.0.0";

/** state-machine.md §5.6: `Record<`${number}:${string}`, NodeExecutionRecord>` key. */
export function nodeKey(cycle: number, nodeId: string): `${number}:${string}` {
  return `${cycle}:${nodeId}`;
}

/** state-machine.md §5.6: `Record<`${number}:${string}:${number}`, AttemptRecord>` key. */
export function attemptKey(cycle: number, nodeId: string, attempt: number): `${number}:${string}:${number}` {
  return `${cycle}:${nodeId}:${attempt}`;
}

/** state-machine.md §5.6: `terminalEventKeys` entries, `"<cycle>:<nodeId>:<attempt>:<eventType>"`. */
export function terminalEventKey(cycle: number, nodeId: string, attempt: number, eventType: string): string {
  return `${cycle}:${nodeId}:${attempt}:${eventType}`;
}

/** The `approvals` record key (state-machine.md §8.2): `"<cycle>:<nodeId>:<attempt>:<digest>"`. */
export function approvalKey(cycle: number, nodeId: string, attempt: number, digest: string): string {
  return `${cycle}:${nodeId}:${attempt}:${digest}`;
}

/** The Attempt record matching `snapshot.current`, or `null` when there is no in-flight Attempt
 * (`snapshot.current === null`, or the current Node Execution never dispatched a real Attempt —
 * a control-plane-local node at `attempt: 0`, D-13). */
export function currentAttempt(snapshot: RunSnapshot): AttemptRecord | null {
  const cur = snapshot.current;
  if (!cur) return null;
  const key = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  return snapshot.attempts[key] ?? null;
}

/** The Node Execution record matching `snapshot.current`, or `null`. */
export function currentNodeExecution(snapshot: RunSnapshot): NodeExecutionRecord | null {
  const cur = snapshot.current;
  if (!cur) return null;
  return snapshot.nodes[nodeKey(cur.cycleIndex, cur.nodeId)] ?? null;
}

/** state-machine.md §2.1: the closed set of terminal Run states, cross-checked against
 * state-machine.json `enums.runStateTerminal`. */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "MAX_ITERATIONS_EXCEEDED",
  "BUDGET_EXCEEDED",
  "EXPIRED",
  "SKIPPED",
]);

export function isTerminalRun(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

/** state-machine.md §2.3: the closed set of terminal Node Execution states, cross-checked
 * against state-machine.json `enums.nodeExecutionStateTerminal`. */
export const TERMINAL_NODE_STATES: ReadonlySet<NodeExecutionState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "SKIPPED",
  "NO_PROGRESS",
]);

export function isTerminalNode(state: NodeExecutionState): boolean {
  return TERMINAL_NODE_STATES.has(state);
}

/**
 * The snapshot as it stands the instant before `run-requested` is applied (state-machine.md
 * §5.6, every field initialised): `∅ → PENDING` conceptually starts here, and R-01..R-04 apply
 * their own guard logic and event bookkeeping (`snapshotOf`, `appliedEventIds`, ...) on top —
 * `initialSnapshot` itself does not consume the event, so `snapshotOf`/`eventSeq` are 0 and
 * `appliedEventIds` is empty here even though `runRequested` is the reason this snapshot exists
 * at all. `ctx.loop.edges` seeds every `traversals`/`freeTraversals` entry at 0 (§5.6,
 * `traversals: Record<EdgeId, number>`).
 *
 * `loopDigest` is set equal to `loop.loopVersion`. Decision (not in sheet), m1: the spec
 * introduces both `loopVersion` and `loopDigest` on `RunSnapshot` (state-machine.md §5.6)
 * without ever distinguishing them — no other section of the spec reads or sets `loopDigest`
 * differently. Treated as the same sha256 digest under two names until the maintainer says
 * otherwise; **report**.
 */
export function initialSnapshot(runRequested: Envelope, ctx: { loop: ResolvedLoop; now: string }): RunSnapshot {
  const edgeIds = Object.keys(ctx.loop.edges);
  const traversals: Record<string, number> = {};
  const freeTraversals: Record<string, number> = {};
  for (const id of edgeIds) {
    traversals[id] = 0;
    freeTraversals[id] = 0;
  }

  const trigger = runRequested.trigger;
  const snapshot: RunSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotOf: 0,
    eventSeq: 0,

    runId: runRequested.runId,
    loopId: runRequested.loopId,
    loopVersion: runRequested.loopVersion,
    loopDigest: ctx.loop.loopVersion,
    trigger: {
      kind: trigger?.kind ?? "manual",
      requestedAt: ctx.now,
      ...(trigger?.source !== undefined ? { source: trigger.source } : {}),
      ...(trigger?.dedupeKey !== undefined ? { dedupeKey: trigger.dedupeKey } : {}),
    },

    status: "PENDING",
    outcome: null,
    startedAt: null,
    updatedAt: ctx.now,
    finishedAt: null,

    cycleIndex: 0,
    maxCycleIndex: 0,
    traversals,
    freeTraversals,
    noProgressStreak: 0,
    changeFingerprints: {},
    verdictFingerprints: {},

    current: null,
    nodes: {},
    attempts: {},
    chargedAttempts: {},

    quota: null,
    pendingApproval: null,
    approvals: {},
    observe: null,
    lease: null,
    interrupted: null,

    budget: {
      stepsUsed: 0,
      activeMs: 0,
      waitMs: 0,
      measuredTokens: 0,
      agentExecutions: 0,
      measuredExecutions: 0,
      unmeasuredExecutions: 0,
    },

    artifactRefs: [],
    appliedEventIds: [],
    ignoredEventIds: [],
    emittedEventIds: [],
    terminalEventKeys: [],
  };
  return snapshot;
}
