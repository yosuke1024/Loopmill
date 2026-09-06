// The pure `transition()` contract (state-machine.md §5, §4). This file implements every
// reachable row of the Run/Node Execution/Attempt tables (§4.1-§4.3): R-01..R-56, N-01..N-31,
// A-01..A-11, minus the `observed`-backend rows, which are reserved and unreachable in the MVP
// (R-07/R-11/R-43..R-47, N-02/N-22..N-25, A-04/A-05) — those return `invalid` with
// `code: 'reserved_backend'`.
//
// P-1/P-3: no I/O, no clock reads (`ctx.now` is the only time source), no randomness; every
// branch returns one of the four `TransitionResult` kinds and never throws (the outer
// `transition()` wraps `transitionInner` in try/catch as the P-3 "internal_invariant" backstop).

import { deterministicEventId } from "../util/ulid.ts";
import { LoopmillError } from "../util/errors.ts";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { ArtifactRef, Envelope, EventType, Producer } from "../types/envelope.ts";
import type {
  ResolvedAgentNode,
  ResolvedCommandNode,
  ResolvedHumanNode,
  ResolvedLoop,
  ResolvedNode,
  RetryEdge,
} from "../types/loop.ts";
import type {
  Action,
  AttemptRecord,
  AttemptState,
  ClassifyInput,
  FailureReason,
  NodeExecutionRecord,
  Outcome,
  RunSnapshot,
  Subject,
  TransitionContext,
  TransitionResult,
  ValidationError,
} from "../types/state.ts";
import type { UsageRecord } from "../types/usage.ts";
import { isMeasured } from "../usage/record.ts";
import { measuredTokens as sumMeasuredTokens } from "../usage/budget.ts";
import { classifyFailure, errorPayloadFor, loadPatternTable } from "./classify.ts";
import { changeFingerprint, noProgressFires } from "./fingerprint.ts";
import { preDispatch } from "./budget.ts";
import { route, evaluateRetryEdgeWhen, type RouteError, type RunReferenceInfo } from "./route.ts";
import {
  approvalKey,
  attemptKey,
  currentAttempt,
  initialSnapshot,
  isTerminalNode,
  nodeKey,
  terminalEventKey,
} from "./snapshot.ts";
import { accrueClock } from "./budget.ts";

// ---------------------------------------------------------------------------------------------
// Context extension (D-21/R-02/R-03 admission facts a pure function cannot fetch itself)
// ---------------------------------------------------------------------------------------------

/**
 * `TransitionContext` plus the admission facts R-02/R-03's guards need (`notDeduped`,
 * `withinRateLimits`) that a pure function cannot look up itself — they depend on the store's
 * view of other Runs. **Report**: `src/types/state.ts`'s `TransitionContext` should gain this
 * `admission` field directly so every caller shares one type.
 */
export interface EngineTransitionContext extends TransitionContext {
  admission?: {
    openChangeForDedupeKey?: string | null;
    minIntervalBreached?: boolean;
    runsPerWindowBreached?: boolean;
  };
}

const RESERVED_BACKEND_ERROR: ValidationError = {
  code: "reserved_backend",
  message: "the observed backend is reserved and unreachable in the MVP (ADR-002 D4, SPIKE-2 NO-GO)",
};

function invalidResult(snapshot: RunSnapshot, error: ValidationError): TransitionResult {
  return { kind: "invalid", snapshot, emitted: [], actions: [], error };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------

export function transition(snapshot: RunSnapshot | null, event: Envelope, ctx: EngineTransitionContext): TransitionResult {
  try {
    return transitionInner(snapshot, event, ctx);
  } catch (err) {
    const base = snapshot ?? initialSnapshot(event, ctx);
    return invalidResult(base, { code: "internal_invariant", message: messageOf(err) });
  }
}

function transitionInner(snapshot: RunSnapshot | null, event: Envelope, ctx: EngineTransitionContext): TransitionResult {
  if (snapshot === null) {
    return transitionFromNull(event, ctx);
  }

  // P-4 (R-54) outranks everything.
  if (dedupeSeen(snapshot, event)) {
    return { kind: "duplicate", snapshot, emitted: [], actions: [] };
  }

  // P-3 step 1: invalid before ignored-stale.
  const validationError = validateAgainstRunLocal(snapshot, event, ctx.loop);
  if (validationError) {
    return invalidResult(snapshot, validationError);
  }

  const staleReason = staleReasonForLocal(snapshot, event, ctx.loop) ?? clockDependentStaleReason(snapshot, event, ctx.now);
  if (staleReason) {
    return ignoredStaleResult(snapshot, event, ctx, staleReason);
  }

  return applyEvent(snapshot, event, ctx);
}

/**
 * `stale.ts`'s `staleReasonFor` takes no `now` (its signature, per this task's own spec, is
 * `(snapshot, event, loop)`), so the two stale reasons that genuinely need the clock —
 * `not_due` (R-42: `resumed{kind: 'due'}` before `quota.resumeDueAt`) and `lease_not_expired`
 * (§10.1: `lease-expired` delivered while `ctx.now < lease.expiresAt`) — are checked here
 * instead, after `stale.ts`'s own (clock-free) test has already passed. Both read `ctx.now` only
 * as an injected parameter (P-1: never the wall clock directly), so purity is unaffected.
 */
function clockDependentStaleReason(snapshot: RunSnapshot, event: Envelope, now: string): string | null {
  if (event.eventType === "resumed" && event.resume?.kind === "due") {
    if (snapshot.quota && parseRfc3339(now) < parseRfc3339(snapshot.quota.resumeDueAt)) {
      return "not_due";
    }
  }
  if (event.eventType === "lease-expired") {
    if (snapshot.lease && parseRfc3339(now) < parseRfc3339(snapshot.lease.expiresAt)) {
      return "lease_not_expired";
    }
  }
  return null;
}

// stale.ts re-imports avoided by re-declaring thin wrappers here would be silly — import directly.
import { checkDuplicate, staleReasonFor, validateAgainstRun } from "./stale.ts";
function dedupeSeen(snapshot: RunSnapshot, event: Envelope): boolean {
  return checkDuplicate(snapshot, event);
}
function validateAgainstRunLocal(snapshot: RunSnapshot, event: Envelope, loop: ResolvedLoop): ValidationError | null {
  return validateAgainstRun(snapshot, event, loop);
}
function staleReasonForLocal(snapshot: RunSnapshot, event: Envelope, loop: ResolvedLoop) {
  return staleReasonFor(snapshot, event, loop);
}

// ---------------------------------------------------------------------------------------------
// snapshot ∅ : R-01..R-04
// ---------------------------------------------------------------------------------------------

function transitionFromNull(event: Envelope, ctx: EngineTransitionContext): TransitionResult {
  if (event.eventType !== "run-requested") {
    // Decision (not in sheet), m1: no row in §4.1 addresses "∅, any event other than
    // run-requested" — nothing exists yet for this runId to fold against. Treated as `invalid`
    // (never a fabricated `ignored-stale`, which would need a snapshot to persist into).
    const base = initialSnapshot(
      { ...event, eventType: "run-requested", trigger: { kind: "manual" } } as Envelope,
      ctx,
    );
    return invalidResult(base, { code: "run_not_found", message: `no Run exists yet for ${event.runId}; the first event for a Run must be run-requested` });
  }

  const base = initialSnapshot(event, ctx);

  if (!producerAllowedLocal(event.eventType, event.producer)) {
    return invalidResult(base, { code: "producer_not_allowed", message: `producer ${JSON.stringify(event.producer)} is not allowed for run-requested`, path: "/producer" });
  }
  // R-04: the event's declared loopVersion must match the pinned loop this transition was
  // handed. Decision (not in sheet), m1: `ctx.loop` is already schema-validated by contract
  // (state.ts's own comment on `TransitionContext.loop`), so "the loop file fails validation"
  // cannot be re-observed here; the closest in-scope analogue — the event pinning a different
  // loopVersion than the one this call was actually given — is what this check catches.
  if (event.loopVersion !== ctx.loop.loopVersion) {
    return invalidResult(base, { code: "loop_invalid", message: `run-requested pins loopVersion ${event.loopVersion}, but ctx.loop resolves to ${ctx.loop.loopVersion}` });
  }

  const emitIdx = { n: 0 };
  const admission = ctx.admission;

  if (admission?.openChangeForDedupeKey !== undefined && admission.openChangeForDedupeKey !== null) {
    return finishFromScratch(base, event, ctx, emitIdx, {
      state: "SKIPPED",
      skipReason: "dedupe",
      ref: admission.openChangeForDedupeKey,
    });
  }
  if (admission?.minIntervalBreached) {
    return finishFromScratch(base, event, ctx, emitIdx, { state: "SKIPPED", skipReason: "min_interval" });
  }
  if (admission?.runsPerWindowBreached) {
    return finishFromScratch(base, event, ctx, emitIdx, { state: "SKIPPED", skipReason: "runs_per_window" });
  }

  // R-01: accept, emit run-started, then fold R-05..R-08's own dispatch decision into this same
  // call (see startRun's doc comment for why).
  let working = base;
  working = { ...working, budget: { ...working.budget, stepsUsed: working.budget.stepsUsed + 1 }, appliedEventIds: [...working.appliedEventIds, event.eventId] };
  const runStarted = emit(working, ctx, "run-started", {}, event.eventId, emitIdx);
  working = { ...working, emittedEventIds: [...working.emittedEventIds, runStarted.eventId] };

  const dispatchResult = startRun(working, ctx, event.eventId, emitIdx);
  if (dispatchResult.kind === "invalid") {
    return invalidResult(base, dispatchResult.error);
  }
  working = dispatchResult.snapshot;
  const allEmitted = [runStarted, ...dispatchResult.emitted];
  working = { ...working, emittedEventIds: [...working.emittedEventIds, ...dispatchResult.emitted.map((e) => e.eventId)] };
  working = finalizeCounts(working, 1, allEmitted.length);
  return { kind: "applied", snapshot: working, emitted: allEmitted, actions: dispatchResult.actions };
}

function producerAllowedLocal(eventType: EventType, producer: Producer | string): boolean {
  // envelope/policy.ts's producerAllowed, re-exposed without a second import line above.
  return producerAllowedImpl(eventType, producer);
}

import { producerAllowed as producerAllowedImpl } from "../envelope/policy.ts";

function finishFromScratch(
  base: RunSnapshot,
  event: Envelope,
  ctx: EngineTransitionContext,
  emitIdx: { n: number },
  outcome: Outcome,
): TransitionResult {
  let working = { ...base, budget: { ...base.budget, stepsUsed: base.budget.stepsUsed + 1 }, appliedEventIds: [...base.appliedEventIds, event.eventId] };
  const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
  working = applyFinish(working, ctx, outcome, finished.eventId);
  working = finalizeCounts(working, 1, 1);
  return { kind: "applied", snapshot: working, emitted: [finished], actions: [] };
}

// ---------------------------------------------------------------------------------------------
// Envelope construction helpers
// ---------------------------------------------------------------------------------------------

function nextEmitIndex(counter: { n: number }): number {
  const i = counter.n;
  counter.n += 1;
  return i;
}

interface EmitFields {
  cycle?: number;
  nodeId?: string;
  attempt?: number;
  result?: NonNullable<Envelope["result"]>;
  artifactRefs?: ArtifactRef[];
  usage?: UsageRecord;
  error?: NonNullable<Envelope["error"]>;
  reason?: string;
  quotaResetsAt?: string;
  trigger?: NonNullable<Envelope["trigger"]>;
  dispatch?: NonNullable<Envelope["dispatch"]>;
  retryEdge?: NonNullable<Envelope["retryEdge"]>;
  human?: NonNullable<Envelope["human"]>;
  outcome?: NonNullable<Envelope["outcome"]>;
  resume?: NonNullable<Envelope["resume"]>;
}

function emit(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  eventType: EventType,
  fields: EmitFields,
  causationEventId: string,
  emitIdx: { n: number },
  producer: Producer = "control-plane",
): Envelope {
  const eventId = deterministicEventId({
    nowRfc3339: ctx.now,
    runId: snapshot.runId,
    eventType,
    cycle: fields.cycle ?? null,
    nodeId: fields.nodeId ?? null,
    attempt: fields.attempt ?? null,
    emitIndex: nextEmitIndex(emitIdx),
    causationEventId,
  });
  const envelope: Envelope = {
    schemaVersion: "1.1.0",
    eventId,
    eventType,
    occurredAt: ctx.now,
    producer,
    loopId: snapshot.loopId,
    loopVersion: snapshot.loopVersion,
    runId: snapshot.runId,
    causationId: causationEventId,
    ...fields,
  };
  return envelope;
}

function emitRunFinished(snapshot: RunSnapshot, ctx: EngineTransitionContext, outcome: Outcome, causationEventId: string, emitIdx: { n: number }): Envelope {
  return emit(snapshot, ctx, "run-finished", { outcome: outcomeToPayloadLocal(outcome), artifactRefs: snapshot.artifactRefs }, causationEventId, emitIdx);
}

import { outcomeToPayload as outcomeToPayloadLocal } from "../envelope/outcome.ts";

function emitIgnoredStale(
  snapshot: RunSnapshot,
  event: Envelope,
  ctx: EngineTransitionContext,
  reason: string,
  emitIdx: { n: number },
): Envelope {
  const fields: EmitFields = { reason };
  if (event.cycle !== undefined) fields.cycle = event.cycle;
  if (event.nodeId !== undefined) fields.nodeId = event.nodeId;
  if (event.attempt !== undefined) fields.attempt = event.attempt;
  return emit(snapshot, ctx, "ignored-stale", fields, event.eventId, emitIdx);
}

// ---------------------------------------------------------------------------------------------
// ignored-stale (D-20, §5.4)
// ---------------------------------------------------------------------------------------------

function ignoredStaleResult(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, reason: string): TransitionResult {
  const emitIdx = { n: 0 };
  const ignoredEnvelope = emitIgnoredStale(snapshot, event, ctx, reason, emitIdx);

  let working: RunSnapshot = {
    ...snapshot,
    ignoredEventIds: [...snapshot.ignoredEventIds, event.eventId],
    emittedEventIds: [...snapshot.emittedEventIds, ignoredEnvelope.eventId],
  };

  // D-20: the one permitted non-control effect — append usage to an attempt that has none yet.
  // "None yet" includes this engine's own `unavailableUsage(node)` placeholder (a LOST/dispatch-
  // failed/timed-out attempt is auto-filled with one per I-26 the moment it terminates, before
  // any late report could possibly arrive) — that placeholder records the *absence* of data, not
  // real data, so a genuine late report must still be allowed to replace it.
  if (event.usage && event.cycle !== undefined && event.nodeId !== undefined && event.attempt !== undefined) {
    const key = attemptKey(event.cycle, event.nodeId, event.attempt);
    const existing = working.attempts[key];
    if (existing && (existing.usage === null || existing.usage.provenance === "unavailable")) {
      working = { ...working, attempts: { ...working.attempts, [key]: { ...existing, usage: event.usage } } };
    }
  }

  working = { ...working, snapshotOf: working.snapshotOf + 2, eventSeq: working.eventSeq + 2 };
  return { kind: "ignored-stale", snapshot: working, emitted: [ignoredEnvelope], actions: [], reason: reason as never };
}

// ---------------------------------------------------------------------------------------------
// applied-event scaffolding
// ---------------------------------------------------------------------------------------------

function finalizeCounts(snapshot: RunSnapshot, appliedCount: 0 | 1, emittedCount: number): RunSnapshot {
  const rows = appliedCount + emittedCount;
  return { ...snapshot, snapshotOf: snapshot.snapshotOf + rows, eventSeq: snapshot.eventSeq + rows };
}

function applyEvent(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext): TransitionResult {
  const clock = accrueClock(snapshot, ctx.now);
  let working: RunSnapshot = {
    ...snapshot,
    updatedAt: ctx.now,
    budget: { ...snapshot.budget, activeMs: clock.activeMs, waitMs: clock.waitMs, stepsUsed: snapshot.budget.stepsUsed + 1 },
    appliedEventIds: [...snapshot.appliedEventIds, event.eventId],
  };

  const emitIdx = { n: 0 };
  const result = dispatchByStatus(working, event, ctx, emitIdx);
  if (!result) {
    return invalidResult(snapshot, { code: "internal_invariant", message: `no handler for status ${snapshot.status} / eventType ${event.eventType}` });
  }
  if (result.kind === "invalid") {
    // A guard inside a handler decided this is actually invalid (e.g. a reserved backend) —
    // nothing is persisted; return the *original* snapshot, not the applied-in-progress one.
    return invalidResult(snapshot, result.error);
  }

  working = result.snapshot;
  const emitted = result.emitted;
  working = { ...working, emittedEventIds: [...working.emittedEventIds, ...emitted.map((e) => e.eventId)] };
  working = finalizeCounts(working, 1, emitted.length);
  return { kind: "applied", snapshot: working, emitted, actions: result.actions };
}

interface Applied {
  kind: "applied";
  snapshot: RunSnapshot;
  emitted: Envelope[];
  actions: Action[];
}
interface InvalidHandlerResult {
  kind: "invalid";
  error: ValidationError;
}
type HandlerResult = Applied | InvalidHandlerResult;

function ok(snapshot: RunSnapshot, emitted: Envelope[], actions: Applied["actions"] = []): Applied {
  return { kind: "applied", snapshot, emitted, actions };
}
function reserved(): InvalidHandlerResult {
  return { kind: "invalid", error: RESERVED_BACKEND_ERROR };
}
function internal(message: string): InvalidHandlerResult {
  return { kind: "invalid", error: { code: "internal_invariant", message } };
}

function dispatchByStatus(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult | null {
  switch (snapshot.status) {
    case "PENDING":
      return applyPending(snapshot, event, ctx, emitIdx);
    case "RUNNING":
      return applyRunning(snapshot, event, ctx, emitIdx);
    case "WAITING_HUMAN":
      return applyWaitingHuman(snapshot, event, ctx, emitIdx);
    case "WAITING_FOR_QUOTA":
      return applyWaitingForQuota(snapshot, event, ctx, emitIdx);
    case "WAITING_OBSERVED":
      return reserved();
    case "INTERRUPTED":
      return applyInterrupted(snapshot, event, ctx, emitIdx);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// PENDING: R-05..R-08
// ---------------------------------------------------------------------------------------------

function runInfoFor(snapshot: RunSnapshot): RunReferenceInfo {
  // RunSnapshot.trigger is a reduced subset (see route.ts's RunReferenceInfo doc); the full
  // trigger payload is not retained on the snapshot, so `trigger.<path>` references resolve
  // against the subset that is. Decision (not in sheet), m1 — see route.ts.
  return { trigger: snapshot.trigger as unknown as import("../types/loop.ts").JsonValue };
}

function applyPending(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  if (event.eventType !== "run-started") {
    return internal(`unexpected eventType ${event.eventType} while PENDING`);
  }
  return startRun(snapshot, ctx, event.eventId, emitIdx);
}

/**
 * R-05..R-08: the entry node's own dispatch decision. Shared by two callers:
 *
 * 1. `transitionFromNull`'s R-01 acceptance path, which folds this straight into the *same*
 *    `transition()` call that accepted `run-requested` — Decision (not in sheet), m1: `run-started`
 *    carries no side effect of its own (R-01's "Side effects: —"), and if it were independently
 *    re-submitted as its own inbound `event` in the ordinary case, its deterministic `eventId`
 *    (D-16) would already sit in `snapshot.emittedEventIds` from the very call that minted it,
 *    making it `duplicate` (P-4) on every subsequent attempt to apply it — an event that can
 *    never actually be applied is not a reachable row. Folding R-05..08 into the same
 *    `transition()` call that processes `run-requested` is the reading that keeps R-05..08
 *    reachable at all in ordinary operation, and mirrors D-13's "goes PENDING -> terminal inside
 *    one step" for condition chains and the settle loop's own handling of an ordinary
 *    node-completed -> node-dispatched hop (worked trace 13.5 row 1: one `applied` result for
 *    `node-completed(implement)` already reports `run-tests dispatched`, with no separate step in
 *    between).
 * 2. `applyPending`, reached when a *persisted* snapshot genuinely rests at `PENDING` (D-22: "fold-
 *    visible but not expected at rest") and the sweep re-emits `run-started` to un-stick it — the
 *    crash-recovery path this row exists for.
 */
function startRun(snapshot: RunSnapshot, ctx: EngineTransitionContext, causationEventId: string, emitIdx: { n: number }): HandlerResult {
  const entryNodeId = ctx.loop.entry;
  const entryNode = ctx.loop.nodes[entryNodeId];
  if (!entryNode) return internal(`entry node "${entryNodeId}" does not exist`);

  let working: RunSnapshot = { ...snapshot, startedAt: snapshot.startedAt ?? ctx.now };

  if (entryNode.kind === "human") {
    return startHumanGate(working, ctx, entryNode, 0, causationEventId, emitIdx);
  }
  if (backendOf(entryNode) === "observed-reserved") {
    return reserved();
  }
  if (entryNode.kind === "end") {
    // D-13: an end node is control-plane-local too, even as the loop's own entry — recorded the
    // same way any other control-plane-local completion is, then the Run finishes immediately.
    const { snapshot: withEndNode, emitted: endEmitted } = recordControlPlaneCompletion(working, ctx, entryNodeId, 0, "succeeded", causationEventId, emitIdx);
    const outcome: Outcome = { state: "SUCCEEDED", label: entryNode.outcome };
    const finished = emitRunFinished(withEndNode, ctx, outcome, causationEventId, emitIdx);
    const finishedSnapshot = applyFinish(withEndNode, ctx, outcome, finished.eventId);
    return ok(finishedSnapshot, [...endEmitted, finished]);
  }
  if (entryNode.kind === "condition") {
    // A condition entry node settles through the same routing chain a completion would.
    return settleAndFinalize(working, ctx, entryNodeId, 0, causationEventId, emitIdx, null);
  }

  const check = preDispatch(working, ctx.loop, entryNode, 0, null, ctx.policy);
  if (!check.ok) {
    const finished = emitRunFinished(working, ctx, check.outcome, causationEventId, emitIdx);
    working = applyFinish(working, ctx, check.outcome, finished.eventId);
    return ok(working, [finished]);
  }
  const { envelope, snapshot: dispatched } = dispatchEnvelope(working, ctx, entryNode, entryNodeId, 0, 1, causationEventId, emitIdx);
  return ok(dispatched, [envelope]);
}

/** `backend` capability is looked up via `loop.nodes[id]`'s own `backend` field for agent/command
 * nodes; condition/human/end nodes have no backend field (control-plane implicit, never
 * `observed`). Returns `"observed-reserved"` for the one MVP-unreachable case this engine must
 * still recognise and refuse cleanly. */
function backendOf(node: ResolvedNode): "observed-reserved" | "ordinary" {
  if (node.kind !== "agent" && node.kind !== "command") return "ordinary";
  const capabilities = capabilitiesForLocal(node.backend);
  return capabilities?.result === "observed" ? "observed-reserved" : "ordinary";
}

import { capabilitiesFor as capabilitiesForLocal } from "../backends/capabilities.ts";

/**
 * loop-file.md §12.2 / state-machine.md §6.2: "The first entry into a body — reached by an
 * ordinary forward edge — sets `cycleIndex` to 1. It does NOT emit `retry-edge-taken` and does
 * NOT consume the iteration budget." Every *subsequent* execution of a Retry Edge's `to` node is
 * reached only through `traverseRetryEdge` (which sets its own `cycleIndex` explicitly), so this
 * only ever fires once per Retry Edge, the first time ordinary `next` routing reaches its `to`
 * node while still in cycle 0 (I-17).
 */
function firstEntryCycleFor(loop: ResolvedLoop, nodeId: string, currentCycle: number): number {
  if (currentCycle !== 0) return currentCycle;
  const isBodyEntry = Object.values(loop.edges).some((e) => e.to === nodeId);
  return isBodyEntry ? 1 : currentCycle;
}

/**
 * D-13: a control-plane-local node (condition, end, or the synthetic completions this file
 * builds for onFailure-continue/skip/approve routing) "goes PENDING -> terminal inside one step,
 * with a synthetic `node-completed` whose producer is `control-plane` and whose `attempt` is 0".
 * Builds that envelope and its `NodeExecutionRecord`, both `SUCCEEDED`. `end` nodes get one too
 * (they are control-plane-local exactly like condition nodes) even though the Run terminates in
 * the very same step — otherwise `nodes["<cycle>:<endNodeId>"]` would never exist despite the
 * end node having, in every sense that matters, "run".
 */
function recordControlPlaneCompletion(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  nodeId: string,
  cycle: number,
  status: "succeeded" | "skipped",
  causationEventId: string,
  emitIdx: { n: number },
  structured: Record<string, import("../types/loop.ts").JsonValue> | null = null,
): { snapshot: RunSnapshot; emitted: Envelope[] } {
  const fields: EmitFields = { cycle, nodeId, attempt: 0, result: { status } };
  if (structured !== null) fields.result = { status, structured };
  const synthetic = emit(snapshot, ctx, "node-completed", fields, causationEventId, emitIdx);
  const key = nodeKey(cycle, nodeId);
  const nodeRecord: NodeExecutionRecord = {
    nodeId,
    cycleIndex: cycle,
    state: status === "skipped" ? "SKIPPED" : "SUCCEEDED",
    attemptsUsed: 0,
    startedAt: ctx.now,
    finishedAt: ctx.now,
    summary: null,
    filesChanged: 0,
    changeFingerprint: null,
    artifactRefs: [],
    structured,
    stdout: null,
    exitCode: null,
  };
  const updated: RunSnapshot = {
    ...snapshot,
    nodes: { ...snapshot.nodes, [key]: nodeRecord },
    terminalEventKeys: [...snapshot.terminalEventKeys, terminalEventKey(cycle, nodeId, 0, "node-completed")],
  };
  return { snapshot: updated, emitted: [synthetic] };
}

// ---------------------------------------------------------------------------------------------
// Dispatch / finish / node-execution record helpers
// ---------------------------------------------------------------------------------------------

function dedupeKeyFor(runId: string, cycle: number, nodeId: string, attempt: number): string {
  return sha256HexLocal(`${runId}|${cycle}|${nodeId}|${attempt}`);
}
import { sha256Hex as sha256HexLocal } from "../util/hash.ts";
import { parseIsoDuration } from "../util/duration.ts";
import { formatRfc3339, parseRfc3339 } from "../util/time.ts";

function deadlineAtFor(ctx: EngineTransitionContext, node: ResolvedNode): string {
  const timeoutMs = "timeoutMs" in node && node.timeoutMs !== undefined ? node.timeoutMs : parseIsoDuration("PT4H");
  const graceMs = ctx.policy.dispatchGraceSeconds * 1000;
  return formatRfc3339(parseRfc3339(ctx.now) + timeoutMs + graceMs);
}

function dispatchEnvelope(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  node: ResolvedNode,
  nodeId: string,
  cycle: number,
  attempt: number,
  causationEventId: string,
  emitIdx: { n: number },
): { envelope: Envelope; snapshot: RunSnapshot } {
  const backendId = "backend" in node ? node.backend : "control-plane";
  const deadlineAt = deadlineAtFor(ctx, node);
  const dedupeKey = dedupeKeyFor(snapshot.runId, cycle, nodeId, attempt);
  const envelope = emit(
    snapshot,
    ctx,
    "node-dispatched",
    {
      cycle,
      nodeId,
      attempt,
      dispatch: { backendId, transport: "process", expectedProducer: `backend:${backendId}`, deadline: deadlineAt, dedupeKey },
    },
    causationEventId,
    emitIdx,
  );

  const key = nodeKey(cycle, nodeId);
  const existingNode = snapshot.nodes[key];
  const nodeRecord: NodeExecutionRecord = existingNode
    ? { ...existingNode, state: "DISPATCHED", attemptsUsed: attempt }
    : {
        nodeId,
        cycleIndex: cycle,
        state: "DISPATCHED",
        attemptsUsed: attempt,
        startedAt: ctx.now,
        finishedAt: null,
        summary: null,
        filesChanged: 0,
        changeFingerprint: null,
        artifactRefs: [],
        structured: null,
        stdout: null,
        exitCode: null,
      };

  const attemptRecord: AttemptRecord = {
    cycleIndex: cycle,
    nodeId,
    attempt,
    state: "DISPATCHED",
    classification: null,
    dispatchedAt: ctx.now,
    finishedAt: null,
    deadlineAt,
    usage: null,
    artifactRefs: [],
    error: null,
    exitCode: null,
    signal: null,
  };

  const updated: RunSnapshot = {
    ...snapshot,
    status: "RUNNING",
    current: { nodeId, cycleIndex: cycle, attempt, nodeState: "DISPATCHED" },
    nodes: { ...snapshot.nodes, [key]: nodeRecord },
    attempts: { ...snapshot.attempts, [attemptKey(cycle, nodeId, attempt)]: attemptRecord },
    lease: { kind: "attempt", holder: `${cycle}:${nodeId}:${attempt}`, acquiredAt: ctx.now, heartbeatAt: ctx.now, expiresAt: deadlineAt },
  };
  return { envelope, snapshot: updated };
}

function startHumanGate(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  node: ResolvedHumanNode,
  cycle: number,
  causationEventId: string,
  emitIdx: { n: number },
): HandlerResult {
  const subjectResult = subjectFor(snapshot, ctx, node, cycle);
  if ("error" in subjectResult) return internal(subjectResult.error);
  const subject = subjectResult.subject;
  const timeoutMs = node.timeoutMs ?? parseIsoDuration("PT12H");
  const expiresAt = formatRfc3339(parseRfc3339(ctx.now) + timeoutMs);

  const envelope = emit(
    snapshot,
    ctx,
    "human-requested",
    { cycle, nodeId: node.id, attempt: 0, human: { mode: node.mode, subjectDigest: subject.digest, deadline: expiresAt } },
    causationEventId,
    emitIdx,
  );

  const key = nodeKey(cycle, node.id);
  const nodeRecord: NodeExecutionRecord = {
    nodeId: node.id,
    cycleIndex: cycle,
    state: "WAITING_HUMAN",
    attemptsUsed: 0,
    startedAt: ctx.now,
    finishedAt: null,
    summary: null,
    filesChanged: 0,
    changeFingerprint: null,
    artifactRefs: [],
    structured: null,
    stdout: null,
    exitCode: null,
  };

  const updated: RunSnapshot = {
    ...snapshot,
    status: "WAITING_HUMAN",
    current: { nodeId: node.id, cycleIndex: cycle, attempt: 0, nodeState: "WAITING_HUMAN" },
    nodes: { ...snapshot.nodes, [key]: nodeRecord },
    lease: null,
    pendingApproval: { nodeId: node.id, cycleIndex: cycle, attempt: 0, mode: node.mode, subject, requestedAt: ctx.now, expiresAt },
  };
  return ok(updated, [envelope]);
}

/** state-machine.md §8.2: the digest of what is being approved. For `human.subject` naming an
 * agent node, the digest is that execution's `changeFingerprint` (as the `diff` kind's digest,
 * per this task's own instruction); for anything reporting `structured` output, the sha256 of
 * its canonical JSON. */
function subjectFor(snapshot: RunSnapshot, ctx: EngineTransitionContext, node: ResolvedHumanNode, cycle: number): { subject: Subject } | { error: string } {
  // loop-file.md §8.4: `subject`/`target` are written `nodes.<id>` — a bare node reference, not
  // the full accessor grammar `parseReference` implements (that always requires an accessor
  // after the node id, which `nodes.<id>` alone never has).
  const subjectNodeId = bareNodeId(node.subject);
  const subjectNode = ctx.loop.nodes[subjectNodeId];
  if (!subjectNode) return { error: `human node "${node.id}" names unknown subject node "${subjectNodeId}"` };
  // §9.2: the most recent execution of the subject node — the highest recorded cycleIndex for
  // it (see route.ts's referenceContextFor for why "downward from the current cycle" is not
  // sufficient once the referencing node has left the body, e.g. approve-pr at cycle 0
  // referencing implement's last execution at cycle 3).
  void cycle;
  let record: NodeExecutionRecord | undefined;
  for (const candidate of Object.values(snapshot.nodes)) {
    if (candidate.nodeId !== subjectNodeId) continue;
    if (!record || candidate.cycleIndex > record.cycleIndex) record = candidate;
  }
  if (!record) return { error: `human node "${node.id}"'s subject "${subjectNodeId}" has not executed yet` };

  // envelope.schema.json's subjectDigest pattern requires the prefixed `sha256:<hex>` form
  // (matching loopVersion's own convention) — `changeFingerprint`'s bare hex (fingerprint.ts) is
  // an internal comparison value never itself put on the wire, so it is prefixed here at the one
  // point it becomes a `Subject.digest`.
  if (subjectNode.kind === "agent" && record.changeFingerprint !== null) {
    return { subject: { kind: "diff", ref: `${subjectNodeId}@${record.cycleIndex}`, digest: `sha256:${record.changeFingerprint}` } };
  }
  return { subject: { kind: "structured", ref: subjectNodeId, digest: sha256PrefixedLocal(canonicalJsonLocal(record.structured ?? null)) } };
}
import { canonicalJson as canonicalJsonLocal } from "../util/canonical-json.ts";
import { sha256Prefixed as sha256PrefixedLocal } from "../util/hash.ts";

/** `nodes.<id>` -> `<id>` (loop-file.md §8.4's `subject`/`target` grammar — not the full §9.1
 * reference accessor grammar, which always requires something after the node id). */
function bareNodeId(ref: string): string {
  return ref.startsWith("nodes.") ? ref.slice("nodes.".length) : ref;
}

function applyFinish(snapshot: RunSnapshot, ctx: EngineTransitionContext, outcome: Outcome, causationEventId: string): RunSnapshot {
  void causationEventId;
  return {
    ...snapshot,
    status: outcome.state,
    outcome,
    finishedAt: ctx.now,
    current: null,
    lease: null,
    observe: null,
    quota: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Settle/routing loop: resolves a chain of control-plane-local (condition) hops from a
// just-succeeded node down to a dispatch, a human gate, a retry-edge traversal, or a terminal
// Outcome — all inside one `transition()` call (D-13: "goes PENDING -> terminal inside one
// step"). `preDispatchOutcome` is the pre-computed preDispatch breach for the *starting* node
// (agent/command reached via a normal `next`, already checked by the caller before calling in —
// pass `null` when the caller has not pre-checked, in which case this loop checks it itself for
// every dispatch it reaches).
// ---------------------------------------------------------------------------------------------

function settleAndFinalize(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  startNodeId: string,
  cycleIndex: number,
  causationEventId: string,
  emitIdx: { n: number },
  _unused: null,
): HandlerResult {
  void _unused;
  const emitted: Envelope[] = [];
  let working = snapshot;
  let currentNodeId = startNodeId;
  let currentCycle = cycleIndex;
  const runInfo = runInfoFor(working);

  // Every hop after the first reaches a condition node as a *target* of the previous hop's own
  // routing, and gets recorded there (the `targetNode.kind === "condition"` branch inside the
  // loop below). `startNodeId` itself is the one exception: when the caller hands this function a
  // condition node directly (an entry node that is itself a condition, `startRun`; or an
  // `onFailure: continue` / `resume --decision skip` target that happens to be a condition,
  // `settleFromNext`), nothing has recorded *that* node's own completion yet. Handled once, here,
  // before the loop, rather than duplicating the in-loop branch's record-then-advance logic.
  const startNode = ctx.loop.nodes[startNodeId];
  if (startNode && startNode.kind === "condition" && !working.nodes[nodeKey(currentCycle, startNodeId)]) {
    const branch = routeConditionOnly(ctx.loop, working, startNode, currentCycle, runInfo);
    if ("error" in branch) {
      const outcome: Outcome = { state: "FAILED", failureReason: "condition_error", nodeId: startNodeId, cycleIndex: currentCycle };
      const finished = emitRunFinished(working, ctx, outcome, causationEventId, emitIdx);
      working = applyFinish(working, ctx, outcome, finished.eventId);
      return ok(working, [finished]);
    }
    const { snapshot: withStart, emitted: startEmitted } = recordControlPlaneCompletion(working, ctx, startNodeId, currentCycle, "succeeded", causationEventId, emitIdx, { branch: branch.branch });
    working = withStart;
    emitted.push(...startEmitted);
    // `currentNodeId` deliberately stays `startNodeId`, unchanged: `route()` (called on the very
    // first loop iteration below) re-evaluates the same condition and classifies its *target*
    // correctly (retryEdge / humanGate / end / next) — `conditionBranch`'s own `target` alone is
    // just a raw node/edge id with no such classification, and re-deriving it via `route()` is
    // pure and side-effect-free (this branch has already recorded the one side effect, `check`'s
    // own completion, that `route()` itself never performs).
  }

  for (let hop = 0; hop < 64; hop++) {
    const routed = route(ctx.loop, working, currentNodeId, currentCycle, undefined, runInfo);

    // §6.2: "Leaving the body (the edge's `from` node routes forward instead of backward) sets
    // `cycleIndex` back to 0 for subsequent nodes." Decision (not in sheet), m1: detected here as
    // "the node whose routing decision we just resolved is some Retry Edge's own `from`, and the
    // chosen route is not that edge" — sound for a `from` node with a single Retry Edge (the
    // reference loop's shape: `review-verdict` is `retry-implementation`'s only `from`, and its
    // `then` branch is the one path that leaves the body). A `from` shared by an edge whose body
    // has further forward nodes before really leaving would need real forward-reachability
    // analysis (`loop-file/graph.ts`, not part of this module's public API) to generalise
    // further — **report** if a future loop needs that.
    if (currentCycle > 0 && routed.kind !== "retryEdge") {
      const leavesSomeEdge = Object.values(ctx.loop.edges).some((e) => e.from === currentNodeId);
      if (leavesSomeEdge) {
        working = { ...working, cycleIndex: 0 };
        currentCycle = 0;
      }
    }

    if (routed.kind === "error") {
      const outcome = routeErrorToOutcome(routed.error, currentNodeId, currentCycle);
      const finished = emitRunFinished(working, ctx, outcome, causationEventId, emitIdx);
      working = applyFinish(working, ctx, outcome, finished.eventId);
      emitted.push(finished);
      return ok(working, emitted);
    }

    if (routed.kind === "end") {
      const { snapshot: withEndNode, emitted: endEmitted } = recordControlPlaneCompletion(working, ctx, routed.nodeId, currentCycle, "succeeded", causationEventId, emitIdx);
      working = withEndNode;
      emitted.push(...endEmitted);
      const outcome: Outcome = { state: "SUCCEEDED", label: routed.label };
      const finished = emitRunFinished(working, ctx, outcome, causationEventId, emitIdx);
      working = applyFinish(working, ctx, outcome, finished.eventId);
      emitted.push(finished);
      return ok(working, emitted);
    }

    if (routed.kind === "humanGate") {
      const node = ctx.loop.nodes[routed.nodeId];
      if (!node || node.kind !== "human") return internal(`route: humanGate target "${routed.nodeId}" is not a human node`);
      const result = startHumanGate(working, ctx, node, currentCycle, causationEventId, emitIdx);
      if (result.kind === "invalid") return result;
      return ok(result.snapshot, [...emitted, ...result.emitted], result.actions);
    }

    if (routed.kind === "retryEdge") {
      const edge = routed.edge;
      const whenCheck = evaluateRetryEdgeWhen(ctx.loop, working, edge, currentCycle, runInfo);
      if (!whenCheck.ok) {
        const outcome: Outcome = { state: "FAILED", failureReason: "condition_error", nodeId: edge.from, cycleIndex: currentCycle };
        const finished = emitRunFinished(working, ctx, outcome, causationEventId, emitIdx);
        working = applyFinish(working, ctx, outcome, finished.eventId);
        emitted.push(finished);
        return ok(working, emitted);
      }
      return traverseRetryEdge(working, ctx, edge, currentCycle, causationEventId, emitIdx, emitted, false);
    }

    // routed.kind === "next"
    const targetNode = ctx.loop.nodes[routed.nodeId];
    if (!targetNode) return internal(`route: next target "${routed.nodeId}" does not exist`);

    if (targetNode.kind === "condition") {
      const branch = routeConditionOnly(ctx.loop, working, targetNode, currentCycle, runInfo);
      if ("error" in branch) {
        const outcome: Outcome = { state: "FAILED", failureReason: "condition_error", nodeId: targetNode.id, cycleIndex: currentCycle };
        const finished = emitRunFinished(working, ctx, outcome, causationEventId, emitIdx);
        working = applyFinish(working, ctx, outcome, finished.eventId);
        emitted.push(finished);
        return ok(working, emitted);
      }
      const { snapshot: withCondition, emitted: conditionEmitted } = recordControlPlaneCompletion(
        working,
        ctx,
        targetNode.id,
        currentCycle,
        "succeeded",
        causationEventId,
        emitIdx,
        { branch: branch.branch },
      );
      working = withCondition;
      emitted.push(...conditionEmitted);
      currentNodeId = targetNode.id;
      continue;
    }

    // agent / command: a genuine dispatch.
    const node = targetNode;
    if (backendOf(node) === "observed-reserved") {
      return reserved();
    }
    const dispatchCycle = firstEntryCycleFor(ctx.loop, node.id, currentCycle);
    if (dispatchCycle !== currentCycle) {
      working = { ...working, cycleIndex: dispatchCycle, maxCycleIndex: Math.max(working.maxCycleIndex, dispatchCycle) };
    }
    const check = preDispatch(working, ctx.loop, node, dispatchCycle, null, ctx.policy);
    if (!check.ok) {
      const finished = emitRunFinished(working, ctx, check.outcome, causationEventId, emitIdx);
      working = applyFinish(working, ctx, check.outcome, finished.eventId);
      emitted.push(finished);
      return ok(working, emitted);
    }
    const { envelope, snapshot: dispatched } = dispatchEnvelope(working, ctx, node, node.id, dispatchCycle, 1, causationEventId, emitIdx);
    emitted.push(envelope);
    return ok(dispatched, emitted);
  }

  return internal(`routing did not settle after 64 hops starting from "${startNodeId}" (a cycle in the loop's forward graph?)`);
}

function routeConditionOnly(
  loop: ResolvedLoop,
  snapshot: RunSnapshot,
  node: import("../types/loop.ts").ResolvedConditionNode,
  cycle: number,
  runInfo: RunReferenceInfo,
) {
  return conditionBranchLocal(loop, snapshot, node, cycle, runInfo);
}
import { conditionBranch as conditionBranchLocal } from "./route.ts";

function routeErrorToOutcome(error: RouteError, nodeId: string, cycleIndex: number): Outcome {
  return { state: "FAILED", failureReason: (error.code === "condition_error" ? "condition_error" : "validation_error") as FailureReason, nodeId, cycleIndex };
}

/** R-13/R-21/R-36 and the NO_PROGRESS free-traversal rows R-15/R-17: takes an edge already
 * decided as the traversal target, runs `preDispatch` (covering both the edge's own iteration
 * budget and the resource checks, §11.2 steps 1-6 in one call), and either emits
 * `retry-edge-taken` + `node-dispatched` or finishes the Run on a breach — emitting
 * `retry-edge-taken` only when the traversal is actually taken (I-19: no Attempt, and per this
 * engine's reading no `retry-edge-taken` either, exists for a refused traversal). */
function traverseRetryEdge(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  edge: RetryEdge,
  fromCycle: number,
  causationEventId: string,
  emitIdx: { n: number },
  emittedSoFar: Envelope[],
  free: boolean,
): HandlerResult {
  const toNode = ctx.loop.nodes[edge.to];
  if (!toNode) return internal(`retry edge "${edge.id}"'s "to" node "${edge.to}" does not exist`);
  const toCycle = fromCycle + 1;

  const check = preDispatch(snapshot, ctx.loop, toNode, toCycle, edge, ctx.policy, free);
  if (!check.ok) {
    const finished = emitRunFinished(snapshot, ctx, check.outcome, causationEventId, emitIdx);
    const working = applyFinish(snapshot, ctx, check.outcome, finished.eventId);
    return ok(working, [...emittedSoFar, finished]);
  }

  const newTraversals = (snapshot.traversals[edge.id] ?? 0) + (free ? 0 : 1);
  const newFreeTraversals = (snapshot.freeTraversals[edge.id] ?? 0) + (free ? 1 : 0);
  const edgeTaken = emit(
    snapshot,
    ctx,
    "retry-edge-taken",
    {
      cycle: toCycle,
      retryEdge: {
        edgeId: edge.id,
        fromNodeId: edge.from,
        toNodeId: edge.to,
        fromCycle,
        toCycle,
        maxIterations: edge.maxIterations,
        traversals: free ? newFreeTraversals : newTraversals,
        budgetConsumed: !free,
      },
    },
    causationEventId,
    emitIdx,
  );

  let working: RunSnapshot = {
    ...snapshot,
    traversals: { ...snapshot.traversals, [edge.id]: newTraversals },
    freeTraversals: { ...snapshot.freeTraversals, [edge.id]: newFreeTraversals },
    cycleIndex: toCycle,
    maxCycleIndex: Math.max(snapshot.maxCycleIndex, toCycle),
    noProgressStreak: free ? snapshot.noProgressStreak : 0,
  };

  const { envelope: dispatchEnv, snapshot: dispatched } = dispatchEnvelope(working, ctx, toNode, edge.to, toCycle, 1, causationEventId, emitIdx);
  working = dispatched;
  return ok(working, [...emittedSoFar, edgeTaken, dispatchEnv]);
}

// ---------------------------------------------------------------------------------------------
// RUNNING: node-started, node-completed (incl. NO_PROGRESS), node-failed, node-timed-out,
// dispatch-failed, lease-expired.
// ---------------------------------------------------------------------------------------------

function applyRunning(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  switch (event.eventType) {
    case "node-started":
      return applyNodeStarted(snapshot, event, ctx);
    case "node-completed":
      return applyRunningNodeCompleted(snapshot, event, ctx, emitIdx);
    case "node-failed":
      return applyRunningNodeFailed(snapshot, event, ctx, emitIdx);
    case "node-timed-out":
      return applyRunningNodeTimedOut(snapshot, event, ctx, emitIdx);
    case "dispatch-failed":
      return applyRunningDispatchFailed(snapshot, event, ctx, emitIdx);
    case "lease-expired":
      return applyRunningLeaseExpired(snapshot, event, ctx, emitIdx);
    case "node-observed":
      return reserved();
    default:
      return internal(`unexpected eventType ${event.eventType} while RUNNING`);
  }
}

function applyNodeStarted(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext): HandlerResult {
  const cur = snapshot.current;
  if (!cur) return internal("node-started with no current attempt");
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const aKey = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  const nodeRecord = snapshot.nodes[nKey];
  const attemptRecord = snapshot.attempts[aKey];
  if (!nodeRecord || !attemptRecord) return internal("node-started: missing node/attempt record");

  const working: RunSnapshot = {
    ...snapshot,
    current: { ...cur, nodeState: "RUNNING" },
    nodes: { ...snapshot.nodes, [nKey]: { ...nodeRecord, state: "RUNNING" } },
    lease: snapshot.lease ? { ...snapshot.lease, heartbeatAt: ctx.now } : snapshot.lease,
  };
  return ok(working, []);
}

function filesChangedFrom(artifactRefs: ArtifactRef[] | undefined): Array<{ path: string; digest: string }> {
  if (!artifactRefs) return [];
  return artifactRefs.filter((r) => r.kind === "file").map((r) => ({ path: r.ref, digest: r.digest ?? "" }));
}

let ajvInstance: Ajv2020 | undefined;
const structuredValidatorCache = new WeakMap<object, ValidateFunction>();

function structuredOutputValid(node: ResolvedAgentNode, structured: unknown): boolean {
  if (!node.structuredOutput) return true;
  if (!ajvInstance) ajvInstance = new Ajv2020({ strict: false });
  let validator = structuredValidatorCache.get(node.structuredOutput);
  if (!validator) {
    validator = ajvInstance.compile(node.structuredOutput as object);
    structuredValidatorCache.set(node.structuredOutput, validator);
  }
  return validator(structured) === true;
}

function applyRunningNodeCompleted(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  const cur = snapshot.current!;
  const node = ctx.loop.nodes[cur.nodeId];
  if (!node) return internal(`current node "${cur.nodeId}" does not exist in the loop`);

  const result = event.result;
  const structured = result?.structured ?? null;
  const filesChanged = filesChangedFrom(event.artifactRefs);
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const aKey = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  const existingAttempt = snapshot.attempts[aKey];
  const existingNode = snapshot.nodes[nKey];
  if (!existingAttempt || !existingNode) return internal("node-completed: missing attempt/node record");

  // control-plane-local synthetic completions (N-04/N-05, D-13) never reach this branch — they
  // are produced by settleAndFinalize()/onFailure=continue helpers directly, not by an inbound
  // event, except for R-20/R-49/R-34-style completions which are handled by their own callers.

  if (node.kind === "agent" && node.structuredOutput && !structuredOutputValid(node, structured)) {
    return finishNodeWithFailure(snapshot, ctx, node, cur.cycleIndex, cur.nodeId, cur.attempt, "schema_invalid", event.eventId, emitIdx, existingNode, existingAttempt, event.usage ?? null, "FAILED", "FAILED", "node-completed");
  }

  if (node.kind === "agent" && noProgressFires(snapshot, ctx.loop, cur.cycleIndex, cur.nodeId, filesChanged)) {
    return handleNoProgress(snapshot, ctx, node, cur, event, emitIdx, existingNode, existingAttempt, filesChanged);
  }

  // Ordinary success (N-08, A-03).
  const changeFp = node.kind === "agent" || node.kind === "command" ? changeFingerprint(filesChanged) : null;
  const updatedAttempt: AttemptRecord = {
    ...existingAttempt,
    state: "COMPLETED",
    classification: "SUCCESS",
    finishedAt: ctx.now,
    usage: event.usage ?? existingAttempt.usage,
    artifactRefs: event.artifactRefs ?? [],
    exitCode: result?.exitCode ?? null,
  };
  const updatedNode: NodeExecutionRecord = {
    ...existingNode,
    state: "SUCCEEDED",
    finishedAt: ctx.now,
    summary: result?.summary ?? null,
    filesChanged: filesChanged.length,
    changeFingerprint: changeFp,
    artifactRefs: event.artifactRefs ?? [],
    structured,
    stdout: typeof structured?.stdout === "string" ? (structured.stdout as string) : null,
    exitCode: result?.exitCode ?? null,
  };

  let working: RunSnapshot = {
    ...snapshot,
    attempts: { ...snapshot.attempts, [aKey]: updatedAttempt },
    nodes: { ...snapshot.nodes, [nKey]: updatedNode },
    terminalEventKeys: [...snapshot.terminalEventKeys, terminalEventKey(cur.cycleIndex, cur.nodeId, cur.attempt, "node-completed")],
    noProgressStreak: 0,
  };
  if (changeFp !== null) {
    working = { ...working, changeFingerprints: { ...working.changeFingerprints, [nKey]: changeFp } };
  }
  working = accrueNodeExecutionUsage(working, node, cur.cycleIndex, cur.nodeId);

  return settleAndFinalize(working, ctx, cur.nodeId, cur.cycleIndex, event.eventId, emitIdx, null);
}

// usage-normalization.md §4.1, Amendment (m0+), 2026-09-07: a QUOTA-classified attempt is the CLI
// declining before any work started, not an execution that burned tokens and simply went
// unmeasured — it is excluded from the "every contributing attempt" set this function tests, so
// a quota park + resume that ends in a normal measured completion no longer drags the whole Node
// Execution into `unmeasuredExecutions`. Its own Attempt record still carries `usage.provenance:
// 'unavailable'` on the ledger (unchanged, for the audit) — this only changes what counts toward
// the Node Execution's aggregate.
function accrueNodeExecutionUsage(snapshot: RunSnapshot, node: ResolvedNode, cycle: number, nodeId: string): RunSnapshot {
  if (node.kind !== "agent") return snapshot;
  const attempts = Object.values(snapshot.attempts).filter((a) => a.cycleIndex === cycle && a.nodeId === nodeId);
  if (attempts.length === 0) return snapshot;
  const ranAttempts = attempts.filter((a) => a.classification !== "QUOTA");
  const usages = ranAttempts.map((a) => a.usage).filter((u): u is UsageRecord => u !== null);
  const measured = ranAttempts.length > 0 && ranAttempts.every((a) => a.usage !== null && isMeasured(a.usage));
  const tokenSum = sumMeasuredTokens(usages);
  return {
    ...snapshot,
    budget: {
      ...snapshot.budget,
      agentExecutions: snapshot.budget.agentExecutions + 1,
      measuredExecutions: snapshot.budget.measuredExecutions + (measured ? 1 : 0),
      unmeasuredExecutions: snapshot.budget.unmeasuredExecutions + (measured ? 0 : 1),
      measuredTokens: snapshot.budget.measuredTokens + tokenSum,
    },
  };
}

function handleNoProgress(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  node: ResolvedAgentNode,
  cur: NonNullable<RunSnapshot["current"]>,
  event: Envelope,
  emitIdx: { n: number },
  existingNode: NodeExecutionRecord,
  existingAttempt: AttemptRecord,
  filesChanged: Array<{ path: string; digest: string }>,
): HandlerResult {
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const aKey = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  const changeFp = changeFingerprint(filesChanged);
  const result = event.result;

  const updatedAttempt: AttemptRecord = {
    ...existingAttempt,
    state: "COMPLETED",
    classification: "SUCCESS",
    finishedAt: ctx.now,
    usage: event.usage ?? existingAttempt.usage,
    artifactRefs: event.artifactRefs ?? [],
    exitCode: result?.exitCode ?? null,
  };
  const updatedNode: NodeExecutionRecord = {
    ...existingNode,
    state: "NO_PROGRESS",
    finishedAt: ctx.now,
    summary: result?.summary ?? null,
    filesChanged: filesChanged.length,
    changeFingerprint: changeFp,
    artifactRefs: event.artifactRefs ?? [],
    structured: result?.structured ?? null,
    exitCode: result?.exitCode ?? null,
  };

  let working: RunSnapshot = {
    ...snapshot,
    attempts: { ...snapshot.attempts, [aKey]: updatedAttempt },
    nodes: { ...snapshot.nodes, [nKey]: updatedNode },
    changeFingerprints: { ...snapshot.changeFingerprints, [nKey]: changeFp },
    terminalEventKeys: [...snapshot.terminalEventKeys, terminalEventKey(cur.cycleIndex, cur.nodeId, cur.attempt, "node-completed")],
  };
  working = accrueNodeExecutionUsage(working, node, cur.cycleIndex, cur.nodeId);

  const newStreak = working.noProgressStreak + 1;
  working = { ...working, noProgressStreak: newStreak };

  const edge = Object.values(ctx.loop.edges).find((e) => e.to === cur.nodeId);
  if (!edge) return internal(`NO_PROGRESS fired for "${cur.nodeId}" but no Retry Edge targets it`);

  if (newStreak >= ctx.policy.convergenceLimit) {
    const outcome: Outcome = { state: "FAILED", failureReason: "no_progress_stalled" };
    const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
    working = applyFinish(working, ctx, outcome, finished.eventId);
    return ok(working, [finished]);
  }

  const freeTraversals = working.freeTraversals[edge.id] ?? 0;
  if (freeTraversals >= edge.maxIterations) {
    const outcome: Outcome = { state: "MAX_ITERATIONS_EXCEEDED", edgeId: edge.id, traversals: freeTraversals, maxIterations: edge.maxIterations };
    const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
    working = applyFinish(working, ctx, outcome, finished.eventId);
    return ok(working, [finished]);
  }

  return traverseRetryEdge(working, ctx, edge, cur.cycleIndex, event.eventId, emitIdx, [], true);
}

/** Shared onFailure routing for a node that has exhausted retries with a genuine failure
 * (`node-failed` classified FAILED, `node-timed-out`, `dispatch-failed`, `lease-expired` with no
 * safe auto-retry, and — Decision (not in sheet), m1 — `schema_invalid`, which classifyFailure
 * never produces but which the same fail_run/continue/retry_edge fan-out clearly applies to;
 * loop-file.md's node fields make no distinction between "why" a node failed for `onFailure`'s
 * purposes). Implements R-19/20/21/22 and, by the same shape, the timeout/dispatch-failed/
 * lease-expired rows that the tables list only for `fail_run` explicitly — `continue` and
 * `retry_edge:<id>` are read uniformly off `node.onFailure` for every failure event type,
 * **Decision (not in sheet), m1** (the R-table enumerates `continue`/`retry_edge` only for
 * `node-failed`; nothing in the loop-file schema or `mvp-design.md` §11 suggests `onFailure`
 * should behave differently for a timeout or a dispatch failure — report to the maintainer). */
function finishNodeWithFailure(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  node: ResolvedNode,
  cycle: number,
  nodeId: string,
  attempt: number,
  failureReason: FailureReason,
  causationEventId: string,
  emitIdx: { n: number },
  existingNode: NodeExecutionRecord,
  existingAttempt: AttemptRecord,
  usage: UsageRecord | null,
  attemptState: AttemptState = "FAILED",
  // N-15 vs N-12/N-18/N-21: a timed-out Node Execution's own terminal state is `TIMED_OUT`, a
  // distinct `NodeExecutionState` value from the generic `FAILED` every other exhausted-failure
  // row produces — parameterised here rather than hardcoded so this one shared helper covers
  // both without silently mislabelling a timeout as a plain failure.
  nodeState: "FAILED" | "TIMED_OUT" = "FAILED",
  // The eventType that actually caused this termination, for `terminalEventKeys` (P-5's
  // semantic-duplicate key must match the real eventType — node-failed, node-timed-out,
  // dispatch-failed or lease-expired — not always "node-failed").
  causationEventType: EventType = "node-failed",
): HandlerResult {
  const nKey = nodeKey(cycle, nodeId);
  const aKey = attemptKey(cycle, nodeId, attempt);
  const updatedAttempt: AttemptRecord = { ...existingAttempt, state: attemptState, finishedAt: ctx.now, usage: usage ?? existingAttempt.usage };
  const updatedNode: NodeExecutionRecord = { ...existingNode, state: nodeState, finishedAt: ctx.now };

  let working: RunSnapshot = {
    ...snapshot,
    attempts: { ...snapshot.attempts, [aKey]: updatedAttempt },
    nodes: { ...snapshot.nodes, [nKey]: updatedNode },
    chargedAttempts: { ...snapshot.chargedAttempts, [nKey]: (snapshot.chargedAttempts[nKey] ?? 0) + 1 },
    terminalEventKeys: [...snapshot.terminalEventKeys, terminalEventKey(cycle, nodeId, attempt, causationEventType)],
  };
  working = accrueNodeExecutionUsage(working, node, cycle, nodeId);

  const onFailure = "onFailure" in node ? node.onFailure : "fail_run";

  if (onFailure === "continue") {
    // §2.3's SKIPPED prose ("an onFailure: continue skip-forward"); Decision (not in sheet), m1
    // — see the file header comment near finishNodeWithFailure's own JSDoc for the reasoning.
    // R-20's own row lists `node-completed(SKIPPED, control-plane)` as an emitted envelope (matching
    // R-49's identical shape for `resume --decision skip`), not just a snapshot-only state change.
    const { snapshot: withSkip, emitted: skipEmitted } = recordControlPlaneCompletion(working, ctx, nodeId, cycle, "skipped", causationEventId, emitIdx);
    working = withSkip;
    if (!("next" in node) || node.next === undefined) {
      const outcome: Outcome = { state: "FAILED", failureReason, nodeId, cycleIndex: cycle };
      const finished = emitRunFinished(working, ctx, outcome, causationEventId, emitIdx);
      working = applyFinish(working, ctx, outcome, finished.eventId);
      return ok(working, [...skipEmitted, finished]);
    }
    const result = settleFromNext(working, ctx, node.next, cycle, causationEventId, emitIdx);
    if (result.kind === "invalid") return result;
    return ok(result.snapshot, [...skipEmitted, ...result.emitted], result.actions);
  }

  if (typeof onFailure === "string" && onFailure.startsWith("retry_edge:")) {
    const edgeId = onFailure.slice("retry_edge:".length);
    const edge = ctx.loop.edges[edgeId];
    if (!edge) return internal(`node "${nodeId}"'s onFailure names unknown edge "${edgeId}"`);
    const traversals = working.traversals[edge.id] ?? 0;
    if (traversals >= edge.maxIterations) {
      const outcome: Outcome = { state: "MAX_ITERATIONS_EXCEEDED", edgeId: edge.id, traversals, maxIterations: edge.maxIterations };
      const finished = emitRunFinished(working, ctx, outcome, causationEventId, emitIdx);
      working = applyFinish(working, ctx, outcome, finished.eventId);
      return ok(working, [finished]);
    }
    return traverseRetryEdge(working, ctx, edge, cycle, causationEventId, emitIdx, [], false);
  }

  const outcome: Outcome = { state: "FAILED", failureReason, nodeId, cycleIndex: cycle };
  const finished = emitRunFinished(working, ctx, outcome, causationEventId, emitIdx);
  working = applyFinish(working, ctx, outcome, finished.eventId);
  return ok(working, [finished]);
}

/** A synthesised routing continuation for onFailure=continue / resume --decision skip, where the
 * next hop is already a plain nodeId (not the result of evaluating the failed node's own
 * routing — it *is* the failed node's `next`). Delegates to `settleAndFinalize` starting from a
 * one-hop-ahead position by routing the *target* node directly rather than re-deriving it. */
function settleFromNext(snapshot: RunSnapshot, ctx: EngineTransitionContext, nextNodeId: string, cycle: number, causationEventId: string, emitIdx: { n: number }): HandlerResult {
  const target = ctx.loop.nodes[nextNodeId];
  if (!target) return internal(`routing target "${nextNodeId}" does not exist`);
  if (target.kind === "human") {
    return startHumanGate(snapshot, ctx, target, cycle, causationEventId, emitIdx);
  }
  if (target.kind === "end") {
    const { snapshot: withEndNode, emitted: endEmitted } = recordControlPlaneCompletion(snapshot, ctx, nextNodeId, cycle, "succeeded", causationEventId, emitIdx);
    const outcome: Outcome = { state: "SUCCEEDED", label: target.outcome };
    const finished = emitRunFinished(withEndNode, ctx, outcome, causationEventId, emitIdx);
    const working = applyFinish(withEndNode, ctx, outcome, finished.eventId);
    return ok(working, [...endEmitted, finished]);
  }
  if (target.kind === "condition") {
    return settleAndFinalize(snapshot, ctx, nextNodeId, cycle, causationEventId, emitIdx, null);
  }
  if (backendOf(target) === "observed-reserved") return reserved();
  const dispatchCycle = firstEntryCycleFor(ctx.loop, target.id, cycle);
  let working0 = snapshot;
  if (dispatchCycle !== cycle) {
    working0 = { ...working0, cycleIndex: dispatchCycle, maxCycleIndex: Math.max(working0.maxCycleIndex, dispatchCycle) };
  }
  const check = preDispatch(working0, ctx.loop, target, dispatchCycle, null, ctx.policy);
  if (!check.ok) {
    const finished = emitRunFinished(working0, ctx, check.outcome, causationEventId, emitIdx);
    const working = applyFinish(working0, ctx, check.outcome, finished.eventId);
    return ok(working, [finished]);
  }
  const { envelope, snapshot: dispatched } = dispatchEnvelope(working0, ctx, target, nextNodeId, dispatchCycle, 1, causationEventId, emitIdx);
  return ok(dispatched, [envelope]);
}

/**
 * `chargedAttempts[cycle:nodeId] < node.maxAttempts` (state-machine.json's own `retryable` guard
 * text) — but evaluated *as of after this failure is itself charged*, not against the count from
 * before it. `snapshot.chargedAttempts` at the point every caller here reads it is still the
 * *pre*-this-failure count (the charge is applied afterward, alongside whichever branch —
 * retry or exhaust — this function's answer selects), so the comparison adds the pending +1
 * itself: with `maxAttempts: 2`, attempt 1's failure (charged 0 -> 1) must still retry (one more
 * attempt is owed), attempt 2's failure (charged 1 -> 2) must not (2 of 2 already spent).
 * Decision (not in sheet), m1: state-machine.json's literal `chargedAttempts < maxAttempts`
 * reads naturally as comparing the *current* count, which — read that way — would permit a THIRD
 * attempt after the second failure (0<2 dispatches #2, 1<2 dispatches #3), one more than
 * `maxAttempts: 2` can sensibly mean ("2 total attempts, the original plus one retry" — matching
 * the reference loop's own comment, "maxAttempts: 2 # infra-level redispatch only", and I-23's
 * "chargedAttempts <= maxAttempts always"). **Report**: the guard text should probably read
 * `chargedAttempts + 1 <= maxAttempts` (equivalently, evaluated after the charge) to remove the
 * ambiguity.
 */
function retryable(snapshot: RunSnapshot, loop: ResolvedLoop, cycle: number, nodeId: string): boolean {
  const nKey = nodeKey(cycle, nodeId);
  const charged = snapshot.chargedAttempts[nKey] ?? 0;
  if (charged + 1 >= loop.budget.maxAttempts) return false;
  const node = loop.nodes[nodeId];
  if (!node || (node.kind !== "agent" && node.kind !== "command")) return false;
  const capabilities = capabilitiesForLocal(node.backend);
  return capabilities?.retryable === true;
}

function classifyInputFor(node: ResolvedNode, event: Envelope, extra: Partial<ClassifyInput> = {}): ClassifyInput {
  const runtimeId = node.kind === "agent" ? node.runtime : "claude-code";
  return {
    runtimeId,
    runtimeVersion: extra.runtimeVersion ?? "unknown",
    exitCode: event.result?.exitCode ?? null,
    signal: null,
    result: event.result?.structured ?? event.error ?? null,
    streamEvents: [],
    cancelRequested: false,
    timeoutFired: false,
    deadlineMissed: false,
    patterns: loadPatternTable(),
    ...extra,
  };
}

function applyRunningNodeFailed(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  const cur = snapshot.current!;
  const node = ctx.loop.nodes[cur.nodeId];
  if (!node) return internal(`current node "${cur.nodeId}" does not exist`);
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const aKey = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  const existingAttempt = snapshot.attempts[aKey];
  const existingNode = snapshot.nodes[nKey];
  if (!existingAttempt || !existingNode) return internal("node-failed: missing attempt/node record");

  const classified = event.error?.classified;
  const quotaResetsAt = event.quotaResetsAt;
  const classification =
    classified === "quota" ? (quotaResetsAt !== undefined ? "QUOTA" : "FAILED") : classified === "timeout" ? "TIMEOUT" : classified === "cancelled" ? "CANCELLED" : "FAILED";

  if (classification === "CANCELLED") {
    const updatedAttempt: AttemptRecord = { ...existingAttempt, state: "FAILED", classification: "CANCELLED", finishedAt: ctx.now, error: event.error ?? null, usage: event.usage ?? existingAttempt.usage ?? unavailableUsage(node) };
    const updatedNode: NodeExecutionRecord = { ...existingNode, state: "CANCELLED", finishedAt: ctx.now };
    let working: RunSnapshot = { ...snapshot, attempts: { ...snapshot.attempts, [aKey]: updatedAttempt }, nodes: { ...snapshot.nodes, [nKey]: updatedNode } };
    working = accrueNodeExecutionUsage(working, node, cur.cycleIndex, cur.nodeId);
    const outcome: Outcome = { state: "CANCELLED", by: "platform" };
    const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
    working = applyFinish(working, ctx, outcome, finished.eventId);
    return ok(working, [finished]);
  }

  if (classification === "QUOTA") {
    return enterQuotaPark(snapshot, ctx, node, cur, event, emitIdx, existingNode, existingAttempt);
  }

  // FAILED (or TIMEOUT arriving via node-failed, treated the same as FAILED for retry purposes).
  const canRetry = retryable(snapshot, ctx.loop, cur.cycleIndex, cur.nodeId);
  const updatedAttempt: AttemptRecord = {
    ...existingAttempt,
    state: "FAILED",
    classification: "FAILED",
    finishedAt: ctx.now,
    error: event.error ?? null,
    usage: event.usage ?? existingAttempt.usage ?? unavailableUsage(node),
    exitCode: event.result?.exitCode ?? null,
  };

  if (canRetry) {
    let working: RunSnapshot = {
      ...snapshot,
      attempts: { ...snapshot.attempts, [aKey]: updatedAttempt },
      chargedAttempts: { ...snapshot.chargedAttempts, [nKey]: (snapshot.chargedAttempts[nKey] ?? 0) + 1 },
    };
    const nextAttempt = cur.attempt + 1;
    const { envelope, snapshot: dispatched } = dispatchEnvelope(working, ctx, node, cur.nodeId, cur.cycleIndex, nextAttempt, event.eventId, emitIdx);
    working = dispatched;
    return ok(working, [envelope]);
  }

  return finishNodeWithFailure(snapshot, ctx, node, cur.cycleIndex, cur.nodeId, cur.attempt, "node_failed", event.eventId, emitIdx, existingNode, existingAttempt, event.usage ?? null, "FAILED", "FAILED", "node-failed");
}

function enterQuotaPark(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  node: ResolvedNode,
  cur: NonNullable<RunSnapshot["current"]>,
  event: Envelope,
  emitIdx: { n: number },
  existingNode: NodeExecutionRecord,
  existingAttempt: AttemptRecord,
): HandlerResult {
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const aKey = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  const quotaResetsAt = event.quotaResetsAt;

  const updatedAttempt: AttemptRecord = { ...existingAttempt, state: "FAILED", classification: "QUOTA", finishedAt: ctx.now, error: event.error ?? null, usage: event.usage ?? existingAttempt.usage ?? unavailableUsage(node) };
  let working: RunSnapshot = {
    ...snapshot,
    attempts: { ...snapshot.attempts, [aKey]: updatedAttempt },
    nodes: { ...snapshot.nodes, [nKey]: { ...existingNode, state: "PENDING" } },
  };
  // Counters are not accrued here (unlike every other terminal branch): a quota park sends the
  // Node Execution back to PENDING, not to one of its own terminal states — coverage/budget
  // counters are a per-Node-Execution fact (usage/coverage.ts: "Node Executions of kind agent...
  // in any state except SKIPPED") aggregated across *all* of that execution's attempts once it
  // actually finishes, not per-attempt as each one resolves.

  // R-24: `classificationOfError`'s wire mapping already degrades `classified: 'quota'` with no
  // `quotaResetsAt` at all to internal classification FAILED (never reaching this function) — the
  // scenario this function still has to guard against is a `quotaResetsAt` that is *present* but
  // that this engine cannot actually use (a malformed value a schema-valid envelope should never
  // carry, but P-3 requires `transition()` to degrade gracefully rather than throw regardless).
  let quotaResetsAtMs: number | undefined;
  if (quotaResetsAt !== undefined) {
    try {
      quotaResetsAtMs = parseRfc3339(quotaResetsAt);
    } catch {
      quotaResetsAtMs = undefined;
    }
  }
  if (quotaResetsAtMs === undefined) {
    const outcome: Outcome = { state: "FAILED", failureReason: "quota_unclassifiable", nodeId: cur.nodeId, cycleIndex: cur.cycleIndex };
    const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
    working = applyFinish(working, ctx, outcome, finished.eventId);
    return ok(working, [finished]);
  }

  // Decision (not in sheet), m1: counted from the Attempt ledger (every QUOTA-classified attempt
  // for this Node Execution recorded *before* this one, cumulative), not from
  // `snapshot.quota.parks` — `snapshot.quota` is cleared (`null`) on every resume (R-40/R-41), so
  // a park count read from it would silently reset to 0 each time the node resumes and
  // immediately hits quota again, making D-06's `maxQuotaParks` cap effectively unreachable. The
  // Attempt ledger only ever grows (P-6), so this count is stable across as many park/resume
  // cycles as actually happened. Read from the pre-this-park `snapshot`, not `working` (which
  // already carries this attempt's own QUOTA classification), so a park exactly at the cap (the
  // `maxQuotaParks`-th one) is still the one that's *allowed* — D-06: "Exceeding it is FAILED" —
  // and only the next one past it fails.
  const parksSoFar = Object.values(snapshot.attempts).filter((a) => a.cycleIndex === cur.cycleIndex && a.nodeId === cur.nodeId && a.classification === "QUOTA").length;
  if (parksSoFar >= ctx.policy.maxQuotaParks) {
    const outcome: Outcome = { state: "FAILED", failureReason: "quota_parks_exhausted", nodeId: cur.nodeId, cycleIndex: cur.cycleIndex };
    const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
    working = applyFinish(working, ctx, outcome, finished.eventId);
    return ok(working, [finished]);
  }

  const resumeDueAt = formatRfc3339(quotaResetsAtMs + ctx.policy.quotaJitterSeconds * 1000);
  const quotaResetsAtNormalised = formatRfc3339(quotaResetsAtMs);
  const quotaParked = emit(
    working,
    ctx,
    "quota-parked",
    { cycle: cur.cycleIndex, nodeId: cur.nodeId, attempt: cur.attempt, quotaResetsAt: quotaResetsAtNormalised, reason: "quota" },
    event.eventId,
    emitIdx,
  );

  working = {
    ...working,
    status: "WAITING_FOR_QUOTA",
    current: { ...cur, nodeState: "PENDING" },
    lease: null,
    quota: { parks: parksSoFar + 1, quotaResetsAt: quotaResetsAtNormalised, resumeDueAt, window: "unknown", source: "reported" },
  };
  return ok(working, [quotaParked]);
}

function applyRunningNodeTimedOut(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  const cur = snapshot.current!;
  const node = ctx.loop.nodes[cur.nodeId];
  if (!node) return internal(`current node "${cur.nodeId}" does not exist`);
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const aKey = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  const existingAttempt = snapshot.attempts[aKey];
  const existingNode = snapshot.nodes[nKey];
  if (!existingAttempt || !existingNode) return internal("node-timed-out: missing attempt/node record");

  const effectsNone = "effects" in node && node.effects === "none";
  const canRetry = retryable(snapshot, ctx.loop, cur.cycleIndex, cur.nodeId);
  const updatedAttempt: AttemptRecord = { ...existingAttempt, state: "FAILED", classification: "TIMEOUT", finishedAt: ctx.now, error: event.error ?? { code: "node_timeout", message: "node timeout", classified: "timeout" }, usage: existingAttempt.usage ?? unavailableUsage(node) };

  if (canRetry && effectsNone) {
    let working: RunSnapshot = {
      ...snapshot,
      attempts: { ...snapshot.attempts, [aKey]: updatedAttempt },
      chargedAttempts: { ...snapshot.chargedAttempts, [nKey]: (snapshot.chargedAttempts[nKey] ?? 0) + 1 },
    };
    const { envelope, snapshot: dispatched } = dispatchEnvelope(working, ctx, node, cur.nodeId, cur.cycleIndex, cur.attempt + 1, event.eventId, emitIdx);
    working = dispatched;
    return ok(working, [envelope]);
  }

  // N-15: a timed-out Node Execution's own terminal state is TIMED_OUT, not FAILED.
  return finishNodeWithFailure(snapshot, ctx, node, cur.cycleIndex, cur.nodeId, cur.attempt, "node_timed_out", event.eventId, emitIdx, existingNode, existingAttempt, null, "FAILED", "TIMED_OUT", "node-timed-out");
}

function applyRunningDispatchFailed(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  const cur = snapshot.current!;
  const node = ctx.loop.nodes[cur.nodeId];
  if (!node) return internal(`current node "${cur.nodeId}" does not exist`);
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const aKey = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  const existingAttempt = snapshot.attempts[aKey];
  const existingNode = snapshot.nodes[nKey];
  if (!existingAttempt || !existingNode) return internal("dispatch-failed: missing attempt/node record");

  const canRetry = retryable(snapshot, ctx.loop, cur.cycleIndex, cur.nodeId);
  const updatedAttempt: AttemptRecord = { ...existingAttempt, state: "FAILED", classification: "FAILED", finishedAt: ctx.now, error: event.error ?? { code: "dispatch_failed", message: "dispatch failed", classified: "backend_error" }, usage: existingAttempt.usage ?? unavailableUsage(node) };

  if (canRetry) {
    let working: RunSnapshot = {
      ...snapshot,
      attempts: { ...snapshot.attempts, [aKey]: updatedAttempt },
      chargedAttempts: { ...snapshot.chargedAttempts, [nKey]: (snapshot.chargedAttempts[nKey] ?? 0) + 1 },
    };
    const { envelope, snapshot: dispatched } = dispatchEnvelope(working, ctx, node, cur.nodeId, cur.cycleIndex, cur.attempt + 1, event.eventId, emitIdx);
    working = dispatched;
    return ok(working, [envelope]);
  }

  return finishNodeWithFailure(snapshot, ctx, node, cur.cycleIndex, cur.nodeId, cur.attempt, "dispatch_failed", event.eventId, emitIdx, existingNode, existingAttempt, null, "FAILED", "FAILED", "dispatch-failed");
}

function applyRunningLeaseExpired(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  const cur = snapshot.current!;
  const node = ctx.loop.nodes[cur.nodeId];
  if (!node) return internal(`current node "${cur.nodeId}" does not exist`);
  if (!snapshot.lease || parseRfc3339(ctx.now) < parseRfc3339(snapshot.lease.expiresAt)) {
    // Should already have been caught by stale.ts; defensive no-op.
    return internal("lease-expired delivered while the lease has not actually expired");
  }
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const aKey = attemptKey(cur.cycleIndex, cur.nodeId, cur.attempt);
  const existingAttempt = snapshot.attempts[aKey];
  const existingNode = snapshot.nodes[nKey];
  if (!existingAttempt || !existingNode) return internal("lease-expired: missing attempt/node record");

  const lostAttempt: AttemptRecord = { ...existingAttempt, state: "LOST", classification: "LOST", finishedAt: ctx.now, usage: existingAttempt.usage ?? unavailableUsage(node) };
  const effectsExternal = "effects" in node && node.effects === "external";
  const onInterruptedRetry = !effectsExternal; // D-11: effects:none -> retry, effects:external -> ask
  const canRetry = retryable(snapshot, ctx.loop, cur.cycleIndex, cur.nodeId);

  let working: RunSnapshot = {
    ...snapshot,
    attempts: { ...snapshot.attempts, [aKey]: lostAttempt },
    chargedAttempts: { ...snapshot.chargedAttempts, [nKey]: (snapshot.chargedAttempts[nKey] ?? 0) + 1 },
    lease: null,
  };

  if (onInterruptedRetry && canRetry) {
    const { envelope, snapshot: dispatched } = dispatchEnvelope(working, ctx, node, cur.nodeId, cur.cycleIndex, cur.attempt + 1, event.eventId, emitIdx);
    working = dispatched;
    return ok(working, [envelope]);
  }

  if (!onInterruptedRetry || !canRetry) {
    if (!canRetry && !effectsExternal) {
      return finishNodeWithFailure(working, ctx, node, cur.cycleIndex, cur.nodeId, cur.attempt, "attempts_exhausted", event.eventId, emitIdx, existingNode, lostAttempt, null, "LOST", "FAILED", "lease-expired");
    }
    working = {
      ...working,
      status: "INTERRUPTED",
      interrupted: { nodeId: cur.nodeId, cycleIndex: cur.cycleIndex, attempt: cur.attempt, reason: "attempt_deadline", at: ctx.now },
    };
    return ok(working, []);
  }

  return internal("lease-expired: unreachable branch");
}

function unavailableUsage(node: ResolvedNode): UsageRecord | null {
  if (node.kind !== "agent") return null;
  return {
    runtime: node.runtime,
    model: node.model ?? null,
    freshInputTokens: null,
    cacheWriteTokens: null,
    cacheReadTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalInputTokens: null,
    totalTokens: null,
    provenance: "unavailable",
    provenanceNote: "lease expired before a completion arrived; the sweep declared the attempt lost",
    source: { runtimeVersion: null, eventKind: null },
    complete: false,
    usageBasis: "none",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
}

// ---------------------------------------------------------------------------------------------
// WAITING_HUMAN: human-decided (R-34..R-38), node-timed-out (R-39)
// ---------------------------------------------------------------------------------------------

function applyWaitingHuman(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  if (event.eventType === "node-timed-out") {
    return applyHumanTimeout(snapshot, event, ctx, emitIdx);
  }
  if (event.eventType !== "human-decided") {
    return internal(`unexpected eventType ${event.eventType} while WAITING_HUMAN`);
  }
  const cur = snapshot.current!;
  const pending = snapshot.pendingApproval;
  if (!pending) return internal("human-decided with no pendingApproval");
  const node = ctx.loop.nodes[cur.nodeId];
  if (!node || node.kind !== "human") return internal(`current node "${cur.nodeId}" is not a human node`);

  const decision = event.human?.decision;
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const existingNode = snapshot.nodes[nKey];
  if (!existingNode) return internal("human-decided: missing node record");

  const digest = event.human?.subjectDigest ?? "";
  const approvalRecordKey = approvalKey(cur.cycleIndex, cur.nodeId, cur.attempt, digest);

  const structuredDecision = decision === "approve" ? "approve" : decision === "reject" ? "reject" : null;
  const updatedNode: NodeExecutionRecord = {
    ...existingNode,
    state: decision === "cancel" ? "CANCELLED" : "SUCCEEDED",
    finishedAt: ctx.now,
    structured: structuredDecision ? { decision: structuredDecision } : existingNode.structured,
  };

  let working: RunSnapshot = {
    ...snapshot,
    nodes: { ...snapshot.nodes, [nKey]: updatedNode },
    approvals: { ...snapshot.approvals, [approvalRecordKey]: { decision: decision ?? "unknown", actor: event.human?.decidedBy ?? "unknown", decidedAt: ctx.now } },
    pendingApproval: null,
    terminalEventKeys: [...snapshot.terminalEventKeys, terminalEventKey(cur.cycleIndex, cur.nodeId, cur.attempt, "node-completed")],
  };

  const synthetic = emit(working, ctx, "node-completed", { cycle: cur.cycleIndex, nodeId: cur.nodeId, attempt: 0, result: { status: decision === "cancel" ? "cancelled" : "succeeded", structured: structuredDecision ? { decision: structuredDecision } : {} } }, event.eventId, emitIdx);

  if (decision === "cancel") {
    const outcome: Outcome = { state: "CANCELLED", by: "human" };
    const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
    working = applyFinish(working, ctx, outcome, finished.eventId);
    return ok(working, [synthetic, finished]);
  }

  if (decision === "approve") {
    return settleFromNextViaEmitted(working, ctx, node, cur.cycleIndex, event.eventId, emitIdx, [synthetic]);
  }

  if (decision === "reject") {
    const onFailure = node.onFailure;
    if (onFailure === "fail_run") {
      const outcome: Outcome = { state: "FAILED", failureReason: "human_rejected", nodeId: cur.nodeId, cycleIndex: cur.cycleIndex };
      const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
      working = applyFinish(working, ctx, outcome, finished.eventId);
      return ok(working, [synthetic, finished]);
    }
    if (typeof onFailure === "string" && onFailure.startsWith("retry_edge:")) {
      const edgeId = onFailure.slice("retry_edge:".length);
      const edge = ctx.loop.edges[edgeId];
      if (!edge) return internal(`human node "${cur.nodeId}"'s onFailure names unknown edge "${edgeId}"`);
      const traversals = working.traversals[edge.id] ?? 0;
      if (traversals >= edge.maxIterations) {
        const outcome: Outcome = { state: "MAX_ITERATIONS_EXCEEDED", edgeId: edge.id, traversals, maxIterations: edge.maxIterations };
        const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
        working = applyFinish(working, ctx, outcome, finished.eventId);
        return ok(working, [synthetic, finished]);
      }
      return traverseRetryEdge(working, ctx, edge, cur.cycleIndex, event.eventId, emitIdx, [synthetic], false);
    }
    // continue (D-02, 8.5's third case — not its own R-row; the Node Execution is already
    // SUCCEEDED per N-27, so this is an ordinary forward branch like approve's).
    return settleFromNextViaEmitted(working, ctx, node, cur.cycleIndex, event.eventId, emitIdx, [synthetic]);
  }

  return internal(`human-decided: unrecognised decision ${JSON.stringify(decision)}`);
}

function settleFromNextViaEmitted(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  node: ResolvedHumanNode,
  cycle: number,
  causationEventId: string,
  emitIdx: { n: number },
  emittedSoFar: Envelope[],
): HandlerResult {
  if (node.next === undefined) return internal(`human node "${node.id}" has no "next"`);
  const result = settleFromNext(snapshot, ctx, node.next, cycle, causationEventId, emitIdx);
  if (result.kind === "invalid") return result;
  return ok(result.snapshot, [...emittedSoFar, ...result.emitted], result.actions);
}

function applyHumanTimeout(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  const pending = snapshot.pendingApproval;
  if (!pending) return internal("node-timed-out(human_timeout) with no pendingApproval");
  if (parseRfc3339(ctx.now) < parseRfc3339(pending.expiresAt)) {
    return internal("node-timed-out(human_timeout) delivered before the gate actually expired");
  }
  const cur = snapshot.current!;
  const nKey = nodeKey(cur.cycleIndex, cur.nodeId);
  const existingNode = snapshot.nodes[nKey];
  if (!existingNode) return internal("node-timed-out: missing node record");

  const updatedNode: NodeExecutionRecord = { ...existingNode, state: "TIMED_OUT", finishedAt: ctx.now };
  let working: RunSnapshot = { ...snapshot, nodes: { ...snapshot.nodes, [nKey]: updatedNode }, pendingApproval: null };
  const outcome: Outcome = { state: "EXPIRED", expiryReason: "human_timeout", nodeId: cur.nodeId };
  const finished = emitRunFinished(working, ctx, outcome, event.eventId, emitIdx);
  working = applyFinish(working, ctx, outcome, finished.eventId);
  return ok(working, [finished]);
}

// ---------------------------------------------------------------------------------------------
// WAITING_FOR_QUOTA: resumed (R-40..R-42)
// ---------------------------------------------------------------------------------------------

function applyWaitingForQuota(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  if (event.eventType !== "resumed") return internal(`unexpected eventType ${event.eventType} while WAITING_FOR_QUOTA`);
  const cur = snapshot.current!;
  const node = ctx.loop.nodes[cur.nodeId];
  if (!node) return internal(`current node "${cur.nodeId}" does not exist`);
  const nextAttempt = cur.attempt + 1;
  const check = preDispatch(snapshot, ctx.loop, node, cur.cycleIndex, null, ctx.policy);
  if (!check.ok) {
    const finished = emitRunFinished(snapshot, ctx, check.outcome, event.eventId, emitIdx);
    const working = applyFinish(snapshot, ctx, check.outcome, finished.eventId);
    return ok(working, [finished]);
  }
  let working: RunSnapshot = { ...snapshot, quota: null };
  const { envelope, snapshot: dispatched } = dispatchEnvelope(working, ctx, node, cur.nodeId, cur.cycleIndex, nextAttempt, event.eventId, emitIdx);
  working = dispatched;
  return ok(working, [envelope]);
}

// ---------------------------------------------------------------------------------------------
// INTERRUPTED: resumed (R-48..R-50)
// ---------------------------------------------------------------------------------------------

function applyInterrupted(snapshot: RunSnapshot, event: Envelope, ctx: EngineTransitionContext, emitIdx: { n: number }): HandlerResult {
  if (event.eventType !== "resumed") return internal(`unexpected eventType ${event.eventType} while INTERRUPTED`);
  const interrupted = snapshot.interrupted;
  if (!interrupted) return internal("INTERRUPTED with no snapshot.interrupted");
  const decision = event.resume?.decision;
  const node = ctx.loop.nodes[interrupted.nodeId];
  if (!node) return internal(`interrupted node "${interrupted.nodeId}" does not exist`);

  if (decision === "retry") {
    const check = preDispatch(snapshot, ctx.loop, node, interrupted.cycleIndex, null, ctx.policy);
    if (!check.ok) {
      const finished = emitRunFinished(snapshot, ctx, check.outcome, event.eventId, emitIdx);
      const working = applyFinish(snapshot, ctx, check.outcome, finished.eventId);
      return ok(working, [finished]);
    }
    let working: RunSnapshot = { ...snapshot, interrupted: null };
    const { envelope, snapshot: dispatched } = dispatchEnvelope(working, ctx, node, interrupted.nodeId, interrupted.cycleIndex, interrupted.attempt + 1, event.eventId, emitIdx);
    working = dispatched;
    return ok(working, [envelope]);
  }

  if (decision === "skip") {
    if (!("next" in node) || node.next === undefined) {
      const outcome: Outcome = { state: "FAILED", failureReason: "interrupted_abandoned", nodeId: interrupted.nodeId, cycleIndex: interrupted.cycleIndex };
      const finished = emitRunFinished(snapshot, ctx, outcome, event.eventId, emitIdx);
      const working = applyFinish(snapshot, ctx, outcome, finished.eventId);
      return ok(working, [finished]);
    }
    const nKey = nodeKey(interrupted.cycleIndex, interrupted.nodeId);
    const existingNode = snapshot.nodes[nKey];
    const skippedNode: NodeExecutionRecord = existingNode
      ? { ...existingNode, state: "SKIPPED", finishedAt: ctx.now }
      : {
          nodeId: interrupted.nodeId,
          cycleIndex: interrupted.cycleIndex,
          state: "SKIPPED",
          attemptsUsed: interrupted.attempt,
          startedAt: ctx.now,
          finishedAt: ctx.now,
          summary: null,
          filesChanged: 0,
          changeFingerprint: null,
          artifactRefs: [],
          structured: null,
          stdout: null,
          exitCode: null,
        };
    const synthetic = emit(snapshot, ctx, "node-completed", { cycle: interrupted.cycleIndex, nodeId: interrupted.nodeId, attempt: 0, result: { status: "skipped" } }, event.eventId, emitIdx);
    let working: RunSnapshot = { ...snapshot, nodes: { ...snapshot.nodes, [nKey]: skippedNode }, interrupted: null };
    return settleFromNextViaGeneric(working, ctx, node, interrupted.cycleIndex, event.eventId, emitIdx, [synthetic]);
  }

  if (decision === "fail") {
    const outcome: Outcome = { state: "FAILED", failureReason: "interrupted_abandoned", nodeId: interrupted.nodeId, cycleIndex: interrupted.cycleIndex };
    const finished = emitRunFinished(snapshot, ctx, outcome, event.eventId, emitIdx);
    const working = applyFinish(snapshot, ctx, outcome, finished.eventId);
    return ok(working, [finished]);
  }

  return internal(`resumed: unrecognised decision ${JSON.stringify(decision)}`);
}

function settleFromNextViaGeneric(
  snapshot: RunSnapshot,
  ctx: EngineTransitionContext,
  node: ResolvedNode,
  cycle: number,
  causationEventId: string,
  emitIdx: { n: number },
  emittedSoFar: Envelope[],
): HandlerResult {
  const next = "next" in node ? node.next : undefined;
  if (next === undefined) return internal(`node has no "next" to skip forward to`);
  const result = settleFromNext(snapshot, ctx, next, cycle, causationEventId, emitIdx);
  if (result.kind === "invalid") return result;
  return ok(result.snapshot, [...emittedSoFar, ...result.emitted], result.actions);
}

// ---------------------------------------------------------------------------------------------
// Unused imports kept for documentation/type-completeness of the file's public surface.
// ---------------------------------------------------------------------------------------------
void LoopmillError;
void isTerminalNode;
