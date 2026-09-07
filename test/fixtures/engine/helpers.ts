// Shared test plumbing for `test/engine/*.test.ts`: envelope builders (via `makeEnvelope`, so
// every test envelope is schema- and producer-valid unless a test deliberately wants otherwise),
// a small driver that threads a snapshot through a scripted sequence of `transition()` calls, and
// the reference-loop constants.

import assert from "node:assert/strict";
import { makeEnvelope, type MakeEnvelopeInput } from "../../../src/envelope/build.ts";
import type { Envelope, Producer } from "../../../src/types/envelope.ts";
import type { ResolvedLoop } from "../../../src/types/loop.ts";
import type { RunSnapshot, TransitionResult } from "../../../src/types/state.ts";
import { DEFAULT_POLICY } from "../../../src/engine/policy.ts";
import { transition, type EngineTransitionContext } from "../../../src/engine/transition.ts";
import { newRunId } from "../../../src/util/ulid.ts";
import { REFERENCE_LOOP } from "./reference-loop.ts";

export const RUN_ID: string = newRunId(Date.parse("2026-09-06T06:00:00.000Z"));
export const LOOP_ID: string = REFERENCE_LOOP.slug;
export const LOOP_VERSION: string = REFERENCE_LOOP.loopVersion;

export function ctxAt(now: string, loop: ResolvedLoop = REFERENCE_LOOP, admission?: EngineTransitionContext["admission"]): EngineTransitionContext {
  const ctx: EngineTransitionContext = { loop, policy: DEFAULT_POLICY, now };
  if (admission) ctx.admission = admission;
  return ctx;
}

export interface EnvelopeInput extends Omit<MakeEnvelopeInput, "loopId" | "loopVersion" | "runId"> {
  loopId?: string;
  loopVersion?: string;
  runId?: string;
}

/** Builds a schema- and producer-valid Envelope for `RUN_ID`/`LOOP_ID`/`LOOP_VERSION` unless
 * overridden, stamped `occurredAt: now`. Throws (via `makeEnvelope`) if the result would not
 * validate — this is deliberate: a test fixture that is not itself a legal envelope would prove
 * nothing about `transition()`. */
export function env(now: string, input: EnvelopeInput): Envelope {
  const full: MakeEnvelopeInput = {
    loopId: LOOP_ID,
    loopVersion: LOOP_VERSION,
    runId: RUN_ID,
    ...input,
  };
  return makeEnvelope(full, { now });
}

interface LoopTarget {
  loopId?: string;
  loopVersion?: string;
  runId?: string;
}

export function runRequested(now: string, opts: { producer?: Producer; source?: string; dedupeKey?: string } & LoopTarget = {}): Envelope {
  return env(now, {
    eventType: "run-requested",
    producer: opts.producer ?? "trigger",
    trigger: { kind: "schedule", source: opts.source ?? "cron", ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}) },
    ...(opts.loopId ? { loopId: opts.loopId } : {}),
    ...(opts.loopVersion ? { loopVersion: opts.loopVersion } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
  });
}

export function nodeCompleted(
  now: string,
  fields: { cycle: number; nodeId: string; attempt: number; producer?: Producer; result?: Envelope["result"]; artifactRefs?: Envelope["artifactRefs"]; usage?: Envelope["usage"] } & LoopTarget,
): Envelope {
  const input: EnvelopeInput = {
    eventType: "node-completed",
    producer: fields.producer ?? "backend:local",
    cycle: fields.cycle,
    nodeId: fields.nodeId,
    attempt: fields.attempt,
    result: fields.result ?? { status: "succeeded" },
  };
  if (fields.artifactRefs) input.artifactRefs = fields.artifactRefs;
  if (fields.usage) input.usage = fields.usage;
  if (fields.loopId) input.loopId = fields.loopId;
  if (fields.loopVersion) input.loopVersion = fields.loopVersion;
  if (fields.runId) input.runId = fields.runId;
  return env(now, input);
}

export function nodeFailed(
  now: string,
  fields: {
    cycle: number;
    nodeId: string;
    attempt: number;
    producer?: Producer;
    error: NonNullable<Envelope["error"]>;
    quotaResetsAt?: string;
    usage?: Envelope["usage"];
    /** A command node's own observed output (state-machine.md §3.1 row 6: `result{status,
     *  exitCode?}` — `structured` is additionally allowed by the generic `result` shape, and is
     *  how a command's stdout travels per `src/types/state.ts`'s `NodeExecutionRecord.structured`
     *  doc comment). Lets a test build the exact envelope shape `local/executor.ts` produces for a
     *  failing `npm test`, without every call site re-deriving `result` by hand. */
    exitCode?: number;
    structured?: Record<string, import("../../../src/types/loop.ts").JsonValue>;
  } & LoopTarget,
): Envelope {
  const input: EnvelopeInput = {
    eventType: "node-failed",
    producer: fields.producer ?? "backend:local",
    cycle: fields.cycle,
    nodeId: fields.nodeId,
    attempt: fields.attempt,
    result: {
      status: fields.error.classified === "cancelled" ? "cancelled" : "failed",
      ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
      ...(fields.structured !== undefined ? { structured: fields.structured } : {}),
    },
    error: fields.error,
  };
  if (fields.quotaResetsAt) input.quotaResetsAt = fields.quotaResetsAt;
  if (fields.usage) input.usage = fields.usage;
  if (fields.loopId) input.loopId = fields.loopId;
  if (fields.loopVersion) input.loopVersion = fields.loopVersion;
  if (fields.runId) input.runId = fields.runId;
  return env(now, input);
}

export function nodeTimedOut(now: string, fields: { cycle: number; nodeId: string; attempt: number; code: "node_timeout" | "observe_deadline" | "human_timeout"; producer?: Producer } & LoopTarget): Envelope {
  return env(now, {
    eventType: "node-timed-out",
    producer: fields.producer ?? "control-plane",
    cycle: fields.cycle,
    nodeId: fields.nodeId,
    attempt: fields.attempt,
    error: { code: fields.code, message: `timed out (${fields.code})`, classified: "timeout" },
    ...(fields.loopId ? { loopId: fields.loopId } : {}),
    ...(fields.loopVersion ? { loopVersion: fields.loopVersion } : {}),
    ...(fields.runId ? { runId: fields.runId } : {}),
  });
}

export function dispatchFailed(now: string, fields: { cycle: number; nodeId: string; attempt: number } & LoopTarget): Envelope {
  return env(now, {
    eventType: "dispatch-failed",
    producer: "control-plane",
    cycle: fields.cycle,
    nodeId: fields.nodeId,
    attempt: fields.attempt,
    dispatch: { backendId: "local", transport: "process", expectedProducer: "backend:local" },
    error: { code: "dispatch_failed", message: "could not spawn the runtime CLI", classified: "backend_error" },
    ...(fields.loopId ? { loopId: fields.loopId } : {}),
    ...(fields.loopVersion ? { loopVersion: fields.loopVersion } : {}),
    ...(fields.runId ? { runId: fields.runId } : {}),
  });
}

export function leaseExpired(now: string, fields: { cycle: number; nodeId: string; attempt: number; reason?: "attempt_deadline" | "control_plane_lease" | "observe_deadline" } & LoopTarget): Envelope {
  return env(now, {
    eventType: "lease-expired",
    producer: "control-plane",
    cycle: fields.cycle,
    nodeId: fields.nodeId,
    attempt: fields.attempt,
    reason: fields.reason ?? "attempt_deadline",
    ...(fields.loopId ? { loopId: fields.loopId } : {}),
    ...(fields.loopVersion ? { loopVersion: fields.loopVersion } : {}),
    ...(fields.runId ? { runId: fields.runId } : {}),
  });
}

export function humanDecided(now: string, fields: { cycle: number; nodeId: string; decision: "approve" | "reject" | "cancel"; subjectDigest: string; decidedBy?: string } & LoopTarget): Envelope {
  return env(now, {
    eventType: "human-decided",
    producer: "human",
    cycle: fields.cycle,
    nodeId: fields.nodeId,
    attempt: 0,
    human: { decision: fields.decision, subjectDigest: fields.subjectDigest, decidedBy: fields.decidedBy ?? "octocat" },
    ...(fields.loopId ? { loopId: fields.loopId } : {}),
    ...(fields.loopVersion ? { loopVersion: fields.loopVersion } : {}),
    ...(fields.runId ? { runId: fields.runId } : {}),
  });
}

export function resumed(now: string, fields: { kind: "due" | "manual" | "interrupted"; decision?: "retry" | "skip" | "fail"; producer?: Producer } & LoopTarget = { kind: "due" }): Envelope {
  const input: EnvelopeInput = {
    eventType: "resumed",
    producer: fields.producer ?? (fields.kind === "interrupted" || fields.kind === "manual" ? "human" : "control-plane"),
    resume: fields.decision ? { kind: fields.kind, decision: fields.decision } : { kind: fields.kind },
    reason: "resume",
  };
  if (fields.loopId) input.loopId = fields.loopId;
  if (fields.loopVersion) input.loopVersion = fields.loopVersion;
  if (fields.runId) input.runId = fields.runId;
  return env(now, input);
}

/** A plausible fully-`reported`, `complete` usage record for a `local` agent attempt — every
 * MVP backend (`local`, `fake`) declares `usage: "full"` (backends/capabilities.ts), so a
 * realistic test attempt always carries one of these rather than `usage: undefined`. */
export function fullUsage(overrides: Partial<import("../../../src/types/usage.ts").UsageRecord> = {}): import("../../../src/types/usage.ts").UsageRecord {
  return {
    runtime: "claude-code",
    model: "sonnet",
    freshInputTokens: 1000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 500,
    reasoningTokens: null,
    totalInputTokens: 1000,
    totalTokens: 1500,
    provenance: "reported",
    provenanceNote: "result.usage",
    source: { runtimeVersion: "2.1.263", eventKind: "result" },
    complete: true,
    usageBasis: "result.usage",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
    ...overrides,
  };
}

/**
 * `envelope.schema.json`'s `usage` $def (`additionalProperties: false`) only allows the *core*
 * `Usage` fields — `types/envelope.ts`'s `Envelope.usage?: UsageRecord` types it against the
 * *extended* `UsageRecord` shape (`usageBasis`, `sessionRef`, `usageAtAttemptStart`,
 * `listPriceEquivalentUsd`, `perModel` besides), which is a pre-existing type/schema mismatch
 * (`src/types/envelope.ts` and `docs/spec/envelope.schema.json` are both out of this agent's
 * scope to correct — **report**). Envelope construction in these tests therefore strips a
 * `fullUsage()` record down to what the schema actually accepts before handing it to
 * `makeEnvelope`, and casts back to satisfy the (over-wide) TS type.
 */
export function wireUsage(record: import("../../../src/types/usage.ts").UsageRecord): import("../../../src/types/usage.ts").UsageRecord {
  const { usageBasis: _usageBasis, sessionRef: _sessionRef, usageAtAttemptStart: _usageAtAttemptStart, listPriceEquivalentUsd: _listPriceEquivalentUsd, perModel: _perModel, ...core } = record;
  void _usageBasis;
  void _sessionRef;
  void _usageAtAttemptStart;
  void _listPriceEquivalentUsd;
  void _perModel;
  return core as unknown as import("../../../src/types/usage.ts").UsageRecord;
}

// -------------------------------------------------------------------------------------------
// The driver
// -------------------------------------------------------------------------------------------

export interface Step {
  event: Envelope;
  now: string;
  admission?: EngineTransitionContext["admission"];
  expectKind?: TransitionResult["kind"];
}

/** Applies a scripted sequence of inbound envelopes through `transition()`, threading the
 * snapshot from one call to the next, and asserting each step's `kind` when `expectKind` is
 * given. Returns every `TransitionResult` in order plus the final snapshot, for the caller to
 * assert deltas against. */
export function drive(steps: Step[], loop: ResolvedLoop = REFERENCE_LOOP): { results: TransitionResult[]; snapshot: RunSnapshot } {
  let snapshot: RunSnapshot | null = null;
  const results: TransitionResult[] = [];
  for (const step of steps) {
    const ctx = ctxAt(step.now, loop, step.admission);
    const result = transition(snapshot, step.event, ctx);
    if (step.expectKind) {
      assert.equal(
        result.kind,
        step.expectKind,
        `expected ${step.expectKind} for ${step.event.eventType} (${step.event.nodeId ?? "run-level"}), got ${result.kind}` +
          (result.kind === "invalid" ? `: ${result.error.code} ${result.error.message}` : ""),
      );
    }
    results.push(result);
    snapshot = result.snapshot;
  }
  return { results, snapshot: snapshot! };
}

export function lastEmitted(result: TransitionResult): Envelope[] {
  return result.kind === "applied" || result.kind === "ignored-stale" ? result.emitted : [];
}

// -------------------------------------------------------------------------------------------
// Action assertions (state-machine.md §5.1's Action union; the "Side effects" column of §4.1).
// Item 1 of the m1 follow-up: `TransitionResult.actions` must now carry exactly the Action the
// row's own "Side effects" column names — `dispatch` alongside a `node-dispatched`, `request-
// approval` alongside a `human-requested`, `wait` on `quota-parked`/`INTERRUPTED`, `finish`
// alongside `run-finished`, or nothing at all for a row whose column reads "—". `expectedAction`
// derives what that Action *should* be from the result's own `emitted`/`snapshot` — the same
// coordinates the row's own text and `transition.ts`'s side-effect column agree on — independent
// of transition.ts's own call sites, so this is a real cross-check, not a restatement of the
// implementation.
// -------------------------------------------------------------------------------------------

import type { Action } from "../../../src/types/state.ts";

/** The single Action `result` should carry, or `null` for a row with side effect "—" (a plain
 * snapshot-only change: heartbeat, a digest-mismatch ignored-stale is never `applied` at all). */
export function expectedAction(result: Extract<TransitionResult, { kind: "applied" }>): Action | null {
  const dispatched = result.emitted.find((e) => e.eventType === "node-dispatched" && e.dispatch);
  if (dispatched) {
    const d = dispatched.dispatch!;
    return {
      type: "dispatch",
      backendId: d.backendId,
      nodeId: dispatched.nodeId!,
      cycle: dispatched.cycle!,
      attempt: dispatched.attempt!,
      deadlineAt: d.deadline!,
      dedupeKey: d.dedupeKey!,
    };
  }
  const requested = result.emitted.find((e) => e.eventType === "human-requested");
  if (requested) {
    const pending = result.snapshot.pendingApproval;
    assert.ok(pending, "human-requested was emitted but snapshot.pendingApproval is null");
    return { type: "request-approval", mode: pending.mode, nodeId: pending.nodeId, cycle: pending.cycleIndex, subject: pending.subject, expiresAt: pending.expiresAt };
  }
  const finished = result.emitted.find((e) => e.eventType === "run-finished");
  if (finished) {
    assert.ok(result.snapshot.outcome, "run-finished was emitted but snapshot.outcome is null");
    return { type: "finish", outcome: result.snapshot.outcome };
  }
  const quotaParked = result.emitted.find((e) => e.eventType === "quota-parked");
  if (quotaParked) {
    assert.ok(result.snapshot.quota, "quota-parked was emitted but snapshot.quota is null");
    return { type: "wait", until: result.snapshot.quota.resumeDueAt };
  }
  if (result.snapshot.status === "INTERRUPTED") {
    return { type: "wait", until: null };
  }
  return null;
}

/** Asserts `result.actions` is exactly `[expectedAction(result)]`, or `[]` when there is none. */
export function assertActions(result: TransitionResult, message?: string): void {
  assert.equal(result.kind, "applied", `assertActions: expected an applied result${message ? ` (${message})` : ""}, got ${result.kind}`);
  if (result.kind !== "applied") return;
  const expected = expectedAction(result);
  if (message !== undefined) {
    assert.deepEqual(result.actions, expected ? [expected] : [], message);
  } else {
    assert.deepEqual(result.actions, expected ? [expected] : []);
  }
}

// -------------------------------------------------------------------------------------------
// Baselines for the per-row test suite (test/engine/rows.test.ts): fast, reusable starting
// points reached via the real event log rather than hand-built snapshots, so every row test
// still exercises `transition()` end to end.
// -------------------------------------------------------------------------------------------

const T0 = "2026-09-06T06:00:00.000Z";

/** One event: run-requested -> PENDING -> RUNNING with review-content (cycle 0, attempt 1)
 * dispatched, folded into the same applied step (see transition.ts's startRun doc comment). */
export function baselineAtEntry(): { steps: Step[]; snapshot: RunSnapshot } {
  const steps: Step[] = [{ now: T0, event: runRequested(T0) }];
  return { steps, snapshot: drive(steps).snapshot };
}

/** Three events: run-requested, review-content completes (then-branch), create-issue completes
 * -> RUNNING with implement (cycle 1, attempt 1) dispatched — the common starting point for the
 * Retry-Edge-body rows (R-13..R-22, N-08..N-21, A-01..A-09). */
export function baselineAtImplement(): { steps: Step[]; snapshot: RunSnapshot } {
  const steps: Step[] = [{ now: T0, event: runRequested(T0) }];
  steps.push({
    now: "2026-09-06T06:05:00.000Z",
    event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "review-content", attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
  });
  steps.push({
    now: "2026-09-06T06:10:00.000Z",
    event: nodeCompleted("2026-09-06T06:10:00.000Z", { cycle: 0, nodeId: "create-issue", attempt: 1, result: { status: "succeeded", exitCode: 0 } }),
  });
  return { steps, snapshot: drive(steps).snapshot };
}
