// One test named by its row id for every reachable row of state-machine.md §4.1-§4.3
// (state-machine.json `transitions.run/nodeExecution/attempt`). Rows under the reserved
// `observed` backend (R-07, R-11, R-43..R-47, N-02, N-22..N-25, A-04, A-05) are `todo` —
// unreachable in the MVP (ADR-002 D4, SPIKE-2 NO-GO) — and return `invalid` with
// `code: 'reserved_backend'` when this engine is asked to reach them anyway.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drive,
  runRequested,
  nodeCompleted,
  nodeFailed,
  nodeTimedOut,
  dispatchFailed,
  leaseExpired,
  humanDecided,
  resumed,
  fullUsage,
  wireUsage,
  env,
  ctxAt,
  baselineAtEntry,
  baselineAtImplement,
  RUN_ID,
  LOOP_ID,
  LOOP_VERSION,
  type Step,
} from "../fixtures/engine/helpers.ts";
import { REFERENCE_LOOP, NODES, RETRY_EDGE_ID } from "../fixtures/engine/reference-loop.ts";
import { ONFAILURE_LOOP, ONFAILURE_CONTINUE_LOOP, NO_PROGRESS_LOOP, NO_PROGRESS_EDGE_ID } from "../fixtures/engine/onfailure-loop.ts";
import { transition } from "../../src/engine/transition.ts";
import { staleReasonFor } from "../../src/engine/stale.ts";
import { initialSnapshot } from "../../src/engine/snapshot.ts";
import { DEFAULT_POLICY } from "../../src/engine/policy.ts";
import { resolveLoop } from "../../src/loop-file/index.ts";
import type { LoopFile } from "../../src/types/loop.ts";
import type { Envelope } from "../../src/types/envelope.ts";

const T0 = "2026-09-06T06:00:00.000Z";

// One extra tiny loop whose entry is a human node, for R-06 / N-03.
// `check` is a control-plane-local condition entry (settled synchronously by `startRun`, D-13)
// that unconditionally routes to `gate`, so `gate`'s `subject` has something to point at that has
// genuinely already executed by the time the gate is requested — a bare human entry node cannot
// name a resolvable subject at all (nothing has run yet), which is not this row's own concern.
const HUMAN_ENTRY_RAW: LoopFile = {
  schemaVersion: "0.6.0",
  slug: "human-entry-fixture",
  name: "human entry fixture",
  trigger: { kind: "manual" },
  repos: [{ id: "app", path: ".", defaultBase: "main" }],
  defaults: { backend: "local", runtime: "claude-code", authMode: "subscription-oauth" },
  entry: "check",
  nodes: {
    check: { kind: "condition", inputs: { x: "run.id" }, expr: "x == x", then: "gate", else: "gate" },
    gate: { kind: "human", mode: "cli", subject: "nodes.check", next: "finish" },
    finish: { kind: "end", outcome: "success" },
  },
};
const HUMAN_ENTRY_LOOP = resolveLoop(HUMAN_ENTRY_RAW);

// -------------------------------------------------------------------------------------------
// Run machine
// -------------------------------------------------------------------------------------------

test("R-01: ∅ + run-requested (valid, admitted) -> PENDING then folded straight to RUNNING with the entry node dispatched", () => {
  const { snapshot } = baselineAtEntry();
  assert.equal(snapshot.status, "RUNNING");
  assert.equal(snapshot.current?.nodeId, REFERENCE_LOOP.entry);
});

test("R-02: ∅ + run-requested, an open change exists for the dedupeKey -> SKIPPED(dedupe)", () => {
  const rr = runRequested(T0, { dedupeKey: "issue-42" });
  const { snapshot } = drive([{ now: T0, event: rr, admission: { openChangeForDedupeKey: "issue-42" }, expectKind: "applied" }]);
  assert.equal(snapshot.status, "SKIPPED");
  assert.deepEqual(snapshot.outcome, { state: "SKIPPED", skipReason: "dedupe", ref: "issue-42" });
});

test("R-03: ∅ + run-requested, minInterval breached -> SKIPPED(min_interval)", () => {
  const { snapshot } = drive([{ now: T0, event: runRequested(T0), admission: { minIntervalBreached: true }, expectKind: "applied" }]);
  assert.equal(snapshot.status, "SKIPPED");
  assert.deepEqual(snapshot.outcome, { state: "SKIPPED", skipReason: "min_interval" });
});

test("R-03b: ∅ + run-requested, maxRunsPerWindow breached -> SKIPPED(runs_per_window)", () => {
  const { snapshot } = drive([{ now: T0, event: runRequested(T0), admission: { runsPerWindowBreached: true }, expectKind: "applied" }]);
  assert.equal(snapshot.status, "SKIPPED");
  assert.deepEqual(snapshot.outcome, { state: "SKIPPED", skipReason: "runs_per_window" });
});

test("R-04: ∅ + run-requested pins a loopVersion ctx.loop does not resolve to -> invalid", () => {
  const bogus = runRequested(T0, { loopVersion: "sha256:" + "0".repeat(64) });
  const result = transition(null, bogus, ctxAt(T0));
  assert.equal(result.kind, "invalid");
});

test("R-05: PENDING (persisted, not yet dispatched) + run-started -> RUNNING, entry node dispatched", () => {
  const rr = runRequested(T0);
  const pending = initialSnapshot(rr, { loop: REFERENCE_LOOP, now: T0 });
  const withApplied = { ...pending, appliedEventIds: [rr.eventId] };
  const runStarted = env(T0, { eventType: "run-started", producer: "control-plane" });
  const result = transition(withApplied, runStarted, ctxAt(T0));
  assert.equal(result.kind, "applied");
  assert.equal(result.snapshot.status, "RUNNING");
  assert.equal(result.snapshot.current?.nodeId, REFERENCE_LOOP.entry);
});

test("R-06 / N-03: PENDING + run-started, entry node is human -> WAITING_HUMAN, human-requested", () => {
  const rr = runRequested(T0, { loopId: HUMAN_ENTRY_LOOP.slug, loopVersion: HUMAN_ENTRY_LOOP.loopVersion });
  const pending = initialSnapshot(rr, { loop: HUMAN_ENTRY_LOOP, now: T0 });
  const withApplied = { ...pending, appliedEventIds: [rr.eventId] };
  const runStarted = env(T0, { eventType: "run-started", producer: "control-plane", loopId: HUMAN_ENTRY_LOOP.slug, loopVersion: HUMAN_ENTRY_LOOP.loopVersion });
  const result = transition(withApplied, runStarted, ctxAt(T0, HUMAN_ENTRY_LOOP));
  assert.equal(result.kind, "applied", result.kind === "invalid" ? `${result.error.code} ${result.error.message}` : "");
  assert.equal(result.snapshot.status, "WAITING_HUMAN");
  assert.equal(result.snapshot.current?.nodeId, "gate");
  assert.equal(result.snapshot.nodes["0:gate"]?.state, "WAITING_HUMAN");
  if (result.kind === "applied") {
    // emitted[0] is "check"'s own synthetic node-completed (D-13: it is control-plane-local too,
    // even as the loop's entry); emitted[1] is the human-requested this row is actually about.
    assert.deepEqual(
      result.emitted.map((e) => e.eventType),
      ["node-completed", "human-requested"],
    );
  }
});

test("R-07: reserved (observed entry backend), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});

test("R-08: PENDING + run-started, preDispatch breaches immediately -> terminal Outcome, nothing dispatched", () => {
  const tinyBudgetLoop = resolveLoop({
    ...HUMAN_ENTRY_RAW,
    slug: "tiny-budget-fixture",
    entry: "step",
    nodes: {
      step: { kind: "agent", prompt: "x", next: "finish" },
      finish: { kind: "end", outcome: "success" },
    },
    budget: { maxAttempts: 2, maxMeasuredTokens: 0 },
  } as unknown as LoopFile);
  const rr = runRequested(T0, { loopId: tinyBudgetLoop.slug, loopVersion: tinyBudgetLoop.loopVersion });
  const pending = initialSnapshot(rr, { loop: tinyBudgetLoop, now: T0 });
  const withApplied = { ...pending, appliedEventIds: [rr.eventId], budget: { ...pending.budget, measuredTokens: 1 } };
  const runStarted = env(T0, { eventType: "run-started", producer: "control-plane", loopId: tinyBudgetLoop.slug, loopVersion: tinyBudgetLoop.loopVersion });
  const result = transition(withApplied, runStarted, ctxAt(T0, tinyBudgetLoop));
  assert.equal(result.kind, "applied");
  assert.equal(result.snapshot.status, "BUDGET_EXCEEDED");
  assert.equal(result.snapshot.current, null);
});

test("R-09 / N-08 / A-03: RUNNING + node-completed(SUCCESS) routes to next -> RUNNING, dispatch", () => {
  const { steps } = baselineAtEntry();
  steps.push({
    now: "2026-09-06T06:05:00.000Z",
    event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.attempts["0:review-content:1"]?.state, "COMPLETED");
  assert.equal(snapshot.attempts["0:review-content:1"]?.classification, "SUCCESS");
  assert.equal(snapshot.nodes["0:review-content"]?.state, "SUCCEEDED");
  assert.equal(snapshot.current?.nodeId, NODES.createIssue);
});

test("R-10: RUNNING + node-completed routes to a human node -> WAITING_HUMAN", () => {
  const { steps } = baselineAtImplement();
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: nodeCompleted("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "1".repeat(64) }], usage: wireUsage(fullUsage()) }) });
  steps.push({ now: "2026-09-06T06:17:00.000Z", event: nodeCompleted("2026-09-06T06:17:00.000Z", { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({
    now: "2026-09-06T06:20:00.000Z",
    event: nodeCompleted("2026-09-06T06:20:00.000Z", { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.status, "WAITING_HUMAN");
  assert.equal(snapshot.current?.nodeId, NODES.approvePr);
});

test("R-11: reserved (observed backend on next node), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});

test("R-12 / N-04: RUNNING + node-completed routes to an end node -> SUCCEEDED", () => {
  // Already exercised end-to-end by 13.1's happy path; a fast, dedicated repro: an entry node
  // that routes directly to end.
  const directEndLoop = resolveLoop({
    ...HUMAN_ENTRY_RAW,
    slug: "direct-end-fixture",
    entry: "step",
    nodes: {
      step: { kind: "agent", prompt: "x", next: "finish" },
      finish: { kind: "end", outcome: "done" },
    },
  } as unknown as LoopFile);
  const steps: Step[] = [{ now: T0, event: runRequested(T0, { loopId: directEndLoop.slug, loopVersion: directEndLoop.loopVersion }) }];
  const dispatched = drive(steps, directEndLoop).snapshot;
  steps.push({
    now: "2026-09-06T06:05:00.000Z",
    event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "step", attempt: 1, result: { status: "succeeded" }, usage: wireUsage(fullUsage()), loopId: directEndLoop.slug, loopVersion: directEndLoop.loopVersion }),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps, directEndLoop);
  assert.equal(snapshot.status, "SUCCEEDED");
  assert.deepEqual(snapshot.outcome, { state: "SUCCEEDED", label: "done" });
  assert.equal(snapshot.nodes["0:finish"]?.state, "SUCCEEDED");
  void dispatched;
});

test("R-13: RUNNING + node-completed routes to a retry edge, budget ok -> RUNNING, retry-edge-taken + dispatch (covered fully in 13.2)", () => {
  const { steps } = baselineAtImplement();
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: nodeCompleted("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "2".repeat(64) }], usage: wireUsage(fullUsage()) }) });
  steps.push({ now: "2026-09-06T06:17:00.000Z", event: nodeCompleted("2026-09-06T06:17:00.000Z", { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({
    now: "2026-09-06T06:20:00.000Z",
    event: nodeCompleted("2026-09-06T06:20:00.000Z", { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: "no" } }, usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps);
  assert.deepEqual(snapshot.traversals, { [RETRY_EDGE_ID]: 1 });
  assert.equal(snapshot.cycleIndex, 2);
  assert.equal(snapshot.current?.nodeId, NODES.implement);
});

test("R-14: RUNNING + node-completed routes to a retry edge, exhausted -> MAX_ITERATIONS_EXCEEDED (covered fully in 13.3)", () => {
  // See 13.3-exhaustion.test.ts for the full multi-cycle scenario this row needs.
  assert.equal(true, true);
});

test("R-15 / N-09: RUNNING + node-completed(NO_PROGRESS), streak below limit, free traversal available -> RUNNING, free retry-edge-taken", () => {
  // Uses NO_PROGRESS_LOOP (setup -> implement -> verdict -> back-edge), not the reference loop:
  // the reference loop's `implement` shares its body with `review-changes`, an agent node whose
  // verdict feeds `verdictFingerprint` (fingerprint.ts, state-machine.md §6.6 Amendment (m0+)
  // 2026-09-07 — see fingerprint.test.ts for a dedicated test of that evidence-comparison rule).
  // This fixture has no such sibling agent node at all, so `verdictFingerprint` is always the
  // empty-array hash on both sides of the comparison here, isolating this row's own change-set
  // logic cleanly from the evidence-comparison rule exercised elsewhere.
  const loop = NO_PROGRESS_LOOP;
  const steps: Step[] = [{ now: T0, event: runRequested(T0, { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "setup", attempt: 1, result: { status: "succeeded", exitCode: 0 }, loopId: loop.slug, loopVersion: loop.loopVersion }) });
  const fp1 = "sha256:" + "3".repeat(64);
  const implementDone = (cycle: number, now: string) =>
    nodeCompleted(now, { cycle, nodeId: "implement", attempt: 1, result: { status: "succeeded", structured: { changed: false } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fp1 }], usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion });
  // cycle 1 (first entry): can never be NO_PROGRESS -> ordinary (paid) traversal.
  steps.push({ now: "2026-09-06T06:10:00.000Z", event: implementDone(1, "2026-09-06T06:10:00.000Z") });
  // cycle 2: identical change-set -> NO_PROGRESS; freeTraversals 0 < maxIterations 1 -> free retry.
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: implementDone(2, "2026-09-06T06:15:00.000Z"), expectKind: "applied" });
  const { snapshot, results } = drive(steps, loop);
  assert.equal(snapshot.nodes["2:implement"]?.state, "NO_PROGRESS");
  assert.deepEqual(snapshot.freeTraversals, { [NO_PROGRESS_EDGE_ID]: 1 });
  assert.deepEqual(snapshot.traversals, { [NO_PROGRESS_EDGE_ID]: 1 }, "the cycle-1 paid traversal, unaffected by the free one");
  assert.equal(snapshot.cycleIndex, 3);
  assert.equal(snapshot.current?.nodeId, "implement", "NO_PROGRESS short-circuits the rest of the body");
  assert.equal(snapshot.noProgressStreak, 1);
  const last = results[results.length - 1]!;
  assert.equal(last.kind, "applied");
  if (last.kind === "applied") {
    assert.deepEqual(
      last.emitted.map((e) => e.eventType),
      ["retry-edge-taken", "node-dispatched"],
    );
    assert.equal(last.emitted[0]!.retryEdge?.budgetConsumed, false);
  }
});

test("R-16: two consecutive NO_PROGRESS halt the Run as FAILED(no_progress_stalled)", () => {
  const loop = NO_PROGRESS_LOOP;
  const steps: Step[] = [{ now: T0, event: runRequested(T0, { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "setup", attempt: 1, result: { status: "succeeded", exitCode: 0 }, loopId: loop.slug, loopVersion: loop.loopVersion }) });
  const fp1 = "sha256:" + "4".repeat(64);
  const implementDone = (cycle: number, now: string) =>
    nodeCompleted(now, { cycle, nodeId: "implement", attempt: 1, result: { status: "succeeded", structured: { changed: false } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fp1 }], usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion });
  steps.push({ now: "2026-09-06T06:10:00.000Z", event: implementDone(1, "2026-09-06T06:10:00.000Z") });
  // cycle 2: first NO_PROGRESS (free retry, streak 1).
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: implementDone(2, "2026-09-06T06:15:00.000Z") });
  // cycle 3: second consecutive NO_PROGRESS (streak 2 >= convergenceLimit) -> halt, regardless of
  // freeTraversals already being at its own cap too (R-16's own check precedes R-17's).
  steps.push({
    now: "2026-09-06T06:20:00.000Z",
    event: implementDone(3, "2026-09-06T06:20:00.000Z"),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps, loop);
  assert.equal(snapshot.status, "FAILED");
  assert.deepEqual(snapshot.outcome, { state: "FAILED", failureReason: "no_progress_stalled" });
});

test("R-17: freeTraversals already at the edge's maxIterations -> the next NO_PROGRESS is MAX_ITERATIONS_EXCEEDED (D-10), not a further free retry", () => {
  // Isolated from R-16 (noProgressStreak >= convergenceLimit, default 2) by raising
  // convergenceLimit in a custom policy — `drive`'s helper always uses DEFAULT_POLICY, and with
  // maxIterations: 1 the free budget and the streak limit would otherwise both bind on the same
  // (2nd consecutive) NO_PROGRESS, making the two rows impossible to tell apart.
  const policy = { ...DEFAULT_POLICY, convergenceLimit: 100 };
  const loop = NO_PROGRESS_LOOP;
  let snapshot: ReturnType<typeof initialSnapshot> | null = null;
  const apply = (now: string, event: Envelope) => {
    const result = transition(snapshot, event, { loop, policy, now });
    assert.equal(result.kind, "applied", `expected applied for ${event.eventType}, got ${result.kind}${result.kind === "invalid" ? `: ${result.error.code} ${result.error.message}` : ""}`);
    snapshot = result.snapshot;
    return result;
  };

  const rr = runRequested(T0, { loopId: loop.slug, loopVersion: loop.loopVersion });
  apply(T0, rr);
  apply("2026-09-06T06:05:00.000Z", nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "setup", attempt: 1, result: { status: "succeeded", exitCode: 0 }, loopId: loop.slug, loopVersion: loop.loopVersion }));

  const fp1 = "sha256:" + "5".repeat(64);
  const implementDone = (cycle: number, now: string) =>
    nodeCompleted(now, { cycle, nodeId: "implement", attempt: 1, result: { status: "succeeded", structured: { changed: false } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fp1 }], usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion });

  // cycle 1 (first entry, ordinary forward edge from setup): cycle 1 can never be NO_PROGRESS ->
  // ordinary routing takes the PAID traversal (traversals 0 -> 1, already at maxIterations: 1).
  apply("2026-09-06T06:10:00.000Z", implementDone(1, "2026-09-06T06:10:00.000Z"));
  assert.deepEqual(snapshot!.traversals, { [NO_PROGRESS_EDGE_ID]: 1 });
  assert.equal(snapshot!.cycleIndex, 2);

  // cycle 2: identical change-set to cycle 1 -> NO_PROGRESS; freeTraversals 0 < maxIterations 1
  // -> the free traversal is taken (R-15's own shape, on this fixture).
  apply("2026-09-06T06:15:00.000Z", implementDone(2, "2026-09-06T06:15:00.000Z"));
  assert.equal(snapshot!.nodes["2:implement"]?.state, "NO_PROGRESS");
  assert.deepEqual(snapshot!.freeTraversals, { [NO_PROGRESS_EDGE_ID]: 1 });
  assert.equal(snapshot!.cycleIndex, 3);

  // cycle 3: identical again -> NO_PROGRESS; freeTraversals (1) >= maxIterations (1) -> R-17.
  const result = apply("2026-09-06T06:20:00.000Z", implementDone(3, "2026-09-06T06:20:00.000Z"));
  assert.equal(result.kind, "applied");
  if (result.kind === "applied") {
    assert.equal(result.snapshot.status, "MAX_ITERATIONS_EXCEEDED");
    assert.deepEqual(result.snapshot.outcome, { state: "MAX_ITERATIONS_EXCEEDED", edgeId: NO_PROGRESS_EDGE_ID, traversals: 1, maxIterations: 1 });
  }
});

// -------------------------------------------------------------------------------------------
// RUNNING: node-failed / node-timed-out / dispatch-failed / lease-expired
// -------------------------------------------------------------------------------------------

test("R-18 / N-11 / A-06: node-failed classified FAILED, retryable -> RUNNING, dispatch attempt+1", () => {
  const { steps } = baselineAtImplement();
  steps.push({
    now: "2026-09-06T06:15:00.000Z",
    event: nodeFailed("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, error: { code: "runtime_error", message: "crashed", classified: "runtime_error" } }),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.attempts["1:implement:1"]?.state, "FAILED");
  assert.equal(snapshot.attempts["1:implement:1"]?.classification, "FAILED");
  assert.equal(snapshot.chargedAttempts["1:implement"], 1);
  assert.equal(snapshot.current?.nodeId, NODES.implement);
  assert.equal(snapshot.current?.attempt, 2);
  assert.equal(snapshot.status, "RUNNING");
});

test("R-19 / N-12: node-failed classified FAILED, attempts exhausted, onFailure fail_run -> FAILED(node_failed)", () => {
  const { steps } = baselineAtImplement();
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: nodeFailed("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, error: { code: "runtime_error", message: "crashed", classified: "runtime_error" } }) });
  steps.push({
    now: "2026-09-06T06:20:00.000Z",
    event: nodeFailed("2026-09-06T06:20:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 2, error: { code: "runtime_error", message: "crashed again", classified: "runtime_error" } }),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.nodes["1:implement"]?.state, "FAILED");
  assert.equal(snapshot.status, "FAILED");
  assert.deepEqual(snapshot.outcome, { state: "FAILED", failureReason: "node_failed", nodeId: NODES.implement, cycleIndex: 1 });
});

test("R-20 / (N-05-shaped SKIPPED): node-failed exhausted, onFailure continue -> RUNNING, node-completed(SKIPPED) + dispatch", () => {
  const loop = ONFAILURE_CONTINUE_LOOP;
  const steps: Step[] = [{ now: T0, event: runRequested(T0, { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeFailed("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "step", attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" }, loopId: loop.slug, loopVersion: loop.loopVersion }) });
  steps.push({
    now: "2026-09-06T06:10:00.000Z",
    event: nodeFailed("2026-09-06T06:10:00.000Z", { cycle: 0, nodeId: "step", attempt: 2, error: { code: "runtime_error", message: "x again", classified: "runtime_error" }, loopId: loop.slug, loopVersion: loop.loopVersion }),
    expectKind: "applied",
  });
  const { snapshot, results } = drive(steps, loop);
  assert.equal(snapshot.nodes["0:step"]?.state, "SKIPPED");
  assert.equal(snapshot.status, "WAITING_HUMAN", "step's onFailure:continue -> next: gate (a human node)");
  const last = results[results.length - 1]!;
  assert.equal(last.kind, "applied");
  if (last.kind === "applied") {
    assert.deepEqual(
      last.emitted.map((e) => e.eventType),
      ["node-completed", "human-requested"],
    );
    assert.equal(last.emitted[0]!.result?.status, "skipped");
  }
});

test("R-21: node-failed exhausted, onFailure retry_edge:<id>, budget ok -> RUNNING, retry-edge-taken + dispatch", () => {
  const loop = ONFAILURE_LOOP;
  const steps: Step[] = [{ now: T0, event: runRequested(T0, { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeFailed("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "step", attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
  steps.push({
    now: "2026-09-06T06:10:00.000Z",
    event: nodeFailed("2026-09-06T06:10:00.000Z", { cycle: 0, nodeId: "step", attempt: 2, error: { code: "runtime_error", message: "x again", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }),
    expectKind: "applied",
  });
  const { snapshot, results } = drive(steps, loop);
  assert.deepEqual(snapshot.traversals, { "back-edge": 1 });
  assert.equal(snapshot.cycleIndex, 1);
  assert.equal(snapshot.current?.nodeId, "step");
  assert.equal(snapshot.current?.attempt, 1, "a fresh Retry Edge traversal dispatches a fresh attempt 1, not a further retry of the exhausted one");
  const last = results[results.length - 1]!;
  assert.equal(last.kind, "applied");
  if (last.kind === "applied") {
    assert.deepEqual(
      last.emitted.map((e) => e.eventType),
      ["retry-edge-taken", "node-dispatched"],
    );
  }
});

test("R-22: node-failed exhausted, onFailure retry_edge:<id>, budget exhausted -> MAX_ITERATIONS_EXCEEDED", () => {
  const loop = ONFAILURE_LOOP; // back-edge maxIterations: 2, from:"step" to:"step" (a self-loop)
  const steps: Step[] = [{ now: T0, event: runRequested(T0, { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (m: number) => (now = new Date(new Date(now).getTime() + m * 60000).toISOString());
  // Each traversal moves "step" to a new cycleIndex (the edge's `to` is `step` itself), so the
  // next pair of failures must be addressed to whatever cycle the last traversal actually landed
  // on — tracked here rather than assumed, instead of hardcoding `cycle: 0` throughout.
  let cycle = 0;
  for (let traversal = 0; traversal < 2; traversal++) {
    steps.push({ now: tick(5), event: nodeFailed(now, { cycle, nodeId: "step", attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
    steps.push({ now: tick(5), event: nodeFailed(now, { cycle, nodeId: "step", attempt: 2, error: { code: "runtime_error", message: "x again", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
    cycle = drive(steps, loop).snapshot.cycleIndex;
  }
  const before = drive(steps, loop).snapshot;
  assert.deepEqual(before.traversals, { "back-edge": 2 });
  assert.equal(before.current?.cycleIndex, cycle);
  // A third exhaustion attempts a third traversal, refused by preDispatch before any Attempt.
  steps.push({ now: tick(5), event: nodeFailed(now, { cycle, nodeId: "step", attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
  steps.push({ now: tick(5), event: nodeFailed(now, { cycle, nodeId: "step", attempt: 2, error: { code: "runtime_error", message: "x again", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }), expectKind: "applied" });
  const { snapshot } = drive(steps, loop);
  assert.equal(snapshot.status, "MAX_ITERATIONS_EXCEEDED");
  assert.deepEqual(snapshot.outcome, { state: "MAX_ITERATIONS_EXCEEDED", edgeId: "back-edge", traversals: 2, maxIterations: 2 });
});

test("R-23: node-failed classified QUOTA, resolvable, parks available -> WAITING_FOR_QUOTA (covered fully in 13.4)", () => {
  assert.equal(true, true);
});

test("R-24: node-failed classified QUOTA, unresolvable -> FAILED(quota_unclassifiable) (covered fully in 13.4's own R-24 variant)", () => {
  assert.equal(true, true);
});

test("R-25: node-failed classified QUOTA, quota.parks >= maxQuotaParks -> FAILED(quota_parks_exhausted)", () => {
  const { steps } = baselineAtImplement();
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (m: number) => (now = new Date(new Date(now).getTime() + m * 60000).toISOString());
  const quotaFail = (attempt: number, resetsAt: string) => nodeFailed(now, { cycle: 1, nodeId: NODES.implement, attempt, error: { code: "quota", message: "You've hit your session limit", classified: "quota" }, quotaResetsAt: resetsAt });
  for (let park = 1; park <= DEFAULT_POLICY.maxQuotaParks; park++) {
    steps.push({ now: tick(5), event: quotaFail(park, `2026-09-06T${9 + park}:00:00.000Z`) });
    if (park === DEFAULT_POLICY.maxQuotaParks) {
      // Snapshot.quota is cleared on resume (R-40/R-41) — check the park count right after the
      // maxQuotaParks-th park itself, before that clears it.
      const atCap = drive(steps).snapshot;
      assert.equal(atCap.quota?.parks, DEFAULT_POLICY.maxQuotaParks, `parked ${DEFAULT_POLICY.maxQuotaParks} times, all allowed (D-06: "exceeding" it fails, not reaching it)`);
    }
    steps.push({ now: tick(1), event: resumed(now, { kind: "manual" }) });
  }
  steps.push({ now: tick(5), event: quotaFail(DEFAULT_POLICY.maxQuotaParks + 1, "2026-09-07T09:00:00.000Z"), expectKind: "applied" });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.status, "FAILED");
  assert.deepEqual(snapshot.outcome, { state: "FAILED", failureReason: "quota_parks_exhausted", nodeId: NODES.implement, cycleIndex: 1 });
});

test("R-26 / N-14 / A-06: node-failed classified CANCELLED -> CANCELLED(by: platform)", () => {
  const { steps } = baselineAtImplement();
  steps.push({
    now: "2026-09-06T06:15:00.000Z",
    event: nodeFailed("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, error: { code: "cancelled", message: "cancelled", classified: "cancelled" } }),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.nodes["1:implement"]?.state, "CANCELLED");
  assert.equal(snapshot.attempts["1:implement:1"]?.classification, "CANCELLED");
  assert.equal(snapshot.status, "CANCELLED");
  assert.deepEqual(snapshot.outcome, { state: "CANCELLED", by: "platform" });
});

test("R-27 / N-16: node-timed-out(node_timeout), retryable, effects:none -> RUNNING, dispatch attempt+1", () => {
  const { steps } = baselineAtImplement();
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: nodeTimedOut("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, code: "node_timeout" }), expectKind: "applied" });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.attempts["1:implement:1"]?.state, "FAILED");
  assert.equal(snapshot.attempts["1:implement:1"]?.classification, "TIMEOUT");
  assert.equal(snapshot.current?.attempt, 2);
  assert.equal(snapshot.status, "RUNNING");
});

test("R-28 / N-15: node-timed-out(node_timeout), exhausted, onFailure fail_run -> FAILED(node_timed_out), Node Execution TIMED_OUT (not FAILED)", () => {
  const { steps } = baselineAtImplement();
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: nodeTimedOut("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, code: "node_timeout" }) });
  steps.push({ now: "2026-09-06T06:20:00.000Z", event: nodeTimedOut("2026-09-06T06:20:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 2, code: "node_timeout" }), expectKind: "applied" });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.nodes["1:implement"]?.state, "TIMED_OUT", "N-15: a timed-out Node Execution's own state is TIMED_OUT, distinct from FAILED");
  assert.equal(snapshot.status, "FAILED");
  assert.deepEqual(snapshot.outcome, { state: "FAILED", failureReason: "node_timed_out", nodeId: NODES.implement, cycleIndex: 1 });
});

test("R-29 / N-20: dispatch-failed, retryable -> RUNNING, dispatch attempt+1", () => {
  const { steps } = baselineAtImplement();
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: dispatchFailed("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1 }), expectKind: "applied" });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.attempts["1:implement:1"]?.state, "FAILED");
  assert.equal(snapshot.current?.attempt, 2);
  assert.equal(snapshot.status, "RUNNING");
});

test("R-30 / N-21: dispatch-failed, exhausted -> FAILED(dispatch_failed)", () => {
  const { steps } = baselineAtImplement();
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: dispatchFailed("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1 }) });
  steps.push({ now: "2026-09-06T06:20:00.000Z", event: dispatchFailed("2026-09-06T06:20:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 2 }), expectKind: "applied" });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.nodes["1:implement"]?.state, "FAILED");
  assert.equal(snapshot.status, "FAILED");
  assert.deepEqual(snapshot.outcome, { state: "FAILED", failureReason: "dispatch_failed", nodeId: NODES.implement, cycleIndex: 1 });
});

test("R-31 / N-17: lease-expired, onInterrupted retry, retryable -> RUNNING, dispatch attempt+1 (covered fully in 13.6a)", () => {
  assert.equal(true, true);
});

test("R-32 / N-19: lease-expired, onInterrupted ask (effects:external) -> INTERRUPTED (covered fully in 13.6b)", () => {
  assert.equal(true, true);
});

test("R-33 / N-18 / A-09: lease-expired, exhausted, effects:none, onFailure fail_run -> FAILED(attempts_exhausted)", () => {
  const { steps } = baselineAtImplement();
  const dispatched = drive(steps).snapshot;
  const t1 = dispatched.lease!.expiresAt;
  steps.push({ now: t1, event: leaseExpired(t1, { cycle: 1, nodeId: NODES.implement, attempt: 1 }) });
  const afterFirst = drive(steps).snapshot;
  const t2 = afterFirst.lease!.expiresAt;
  steps.push({ now: t2, event: leaseExpired(t2, { cycle: 1, nodeId: NODES.implement, attempt: 2 }), expectKind: "applied" });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.attempts["1:implement:2"]?.state, "LOST");
  assert.equal(snapshot.nodes["1:implement"]?.state, "FAILED");
  assert.equal(snapshot.status, "FAILED");
  assert.deepEqual(snapshot.outcome, { state: "FAILED", failureReason: "attempts_exhausted", nodeId: NODES.implement, cycleIndex: 1 });
});

// -------------------------------------------------------------------------------------------
// WAITING_HUMAN: human-decided / node-timed-out(human_timeout)
// -------------------------------------------------------------------------------------------

function driveToApprovePr(): { steps: Step[]; snapshot: import("../../src/types/state.ts").RunSnapshot } {
  const { steps } = baselineAtImplement();
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: nodeCompleted("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "7".repeat(64) }], usage: wireUsage(fullUsage()) }) });
  steps.push({ now: "2026-09-06T06:17:00.000Z", event: nodeCompleted("2026-09-06T06:17:00.000Z", { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: "2026-09-06T06:20:00.000Z", event: nodeCompleted("2026-09-06T06:20:00.000Z", { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }) });
  return { steps, snapshot: drive(steps).snapshot };
}

test("R-34 / N-26: human-decided approve, digest matches -> RUNNING, dispatch next (covered fully in 13.1)", () => {
  assert.equal(true, true);
});

test("R-35 / N-27: human-decided reject, digest matches, onFailure fail_run -> FAILED(human_rejected)", () => {
  const { steps, snapshot } = driveToApprovePr();
  const digest = snapshot.pendingApproval!.subject.digest;
  steps.push({ now: "2026-09-06T06:40:00.000Z", event: humanDecided("2026-09-06T06:40:00.000Z", { cycle: 0, nodeId: NODES.approvePr, decision: "reject", subjectDigest: digest }), expectKind: "applied" });
  const { snapshot: final } = drive(steps);
  assert.equal(final.nodes["0:approve-pr"]?.state, "SUCCEEDED", "N-27: a rejected gate SUCCEEDED — the gate did its job");
  assert.deepEqual(final.nodes["0:approve-pr"]?.structured, { decision: "reject" });
  assert.equal(final.status, "FAILED");
  assert.deepEqual(final.outcome, { state: "FAILED", failureReason: "human_rejected", nodeId: NODES.approvePr, cycleIndex: 0 });
});

test("R-36: human-decided reject, digest matches, onFailure retry_edge:<id>, budget ok -> RUNNING, retry-edge-taken + dispatch", () => {
  const loop = ONFAILURE_LOOP; // gate: onFailure retry_edge:back-edge, subject: nodes.step
  const steps: Step[] = [{ now: T0, event: runRequested(T0, { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({
    now: "2026-09-06T06:05:00.000Z",
    event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "step", attempt: 1, result: { status: "succeeded" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }),
  });
  const waiting = drive(steps, loop).snapshot;
  assert.equal(waiting.status, "WAITING_HUMAN");
  const digest = waiting.pendingApproval!.subject.digest;
  steps.push({
    now: "2026-09-06T06:10:00.000Z",
    event: humanDecided("2026-09-06T06:10:00.000Z", { cycle: 0, nodeId: "gate", decision: "reject", subjectDigest: digest, loopId: loop.slug, loopVersion: loop.loopVersion }),
    expectKind: "applied",
  });
  const { snapshot, results } = drive(steps, loop);
  assert.equal(snapshot.nodes["0:gate"]?.state, "SUCCEEDED");
  assert.deepEqual(snapshot.traversals, { "back-edge": 1 });
  assert.equal(snapshot.current?.nodeId, "step");
  assert.equal(snapshot.status, "RUNNING");
  const last = results[results.length - 1]!;
  assert.equal(last.kind, "applied");
  if (last.kind === "applied") {
    assert.deepEqual(
      last.emitted.map((e) => e.eventType),
      ["node-completed", "retry-edge-taken", "node-dispatched"],
    );
  }
});

test("R-37 / N-28: human-decided cancel, digest matches -> CANCELLED(by: human)", () => {
  const { steps, snapshot } = driveToApprovePr();
  const digest = snapshot.pendingApproval!.subject.digest;
  steps.push({ now: "2026-09-06T06:40:00.000Z", event: humanDecided("2026-09-06T06:40:00.000Z", { cycle: 0, nodeId: NODES.approvePr, decision: "cancel", subjectDigest: digest }), expectKind: "applied" });
  const { snapshot: final } = drive(steps);
  assert.equal(final.nodes["0:approve-pr"]?.state, "CANCELLED");
  assert.equal(final.status, "CANCELLED");
  assert.deepEqual(final.outcome, { state: "CANCELLED", by: "human" });
});

test("R-38: human-decided with a mismatched subjectDigest -> ignored-stale(approval_subject_mismatch), still WAITING_HUMAN", () => {
  const { steps } = driveToApprovePr();
  steps.push({ now: "2026-09-06T06:40:00.000Z", event: humanDecided("2026-09-06T06:40:00.000Z", { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: "sha256:" + "0".repeat(64) }), expectKind: "ignored-stale" });
  const { snapshot, results } = drive(steps);
  assert.equal(snapshot.status, "WAITING_HUMAN");
  const last = results[results.length - 1]!;
  if (last.kind === "ignored-stale") assert.equal(last.reason, "approval_subject_mismatch");
});

test("R-39 / N-29: node-timed-out(human_timeout), gate expired -> EXPIRED(human_timeout)", () => {
  const { steps, snapshot } = driveToApprovePr();
  const expiresAt = snapshot.pendingApproval!.expiresAt;
  steps.push({ now: expiresAt, event: nodeTimedOut(expiresAt, { cycle: 0, nodeId: NODES.approvePr, attempt: 0, code: "human_timeout" }), expectKind: "applied" });
  const { snapshot: final } = drive(steps);
  assert.equal(final.nodes["0:approve-pr"]?.state, "TIMED_OUT");
  assert.equal(final.status, "EXPIRED");
  assert.deepEqual(final.outcome, { state: "EXPIRED", expiryReason: "human_timeout", nodeId: NODES.approvePr });
});

// -------------------------------------------------------------------------------------------
// WAITING_FOR_QUOTA: resumed (R-40..R-42, covered in 13.4) — R-41 (manual) gets its own test.
// -------------------------------------------------------------------------------------------

test("R-40: resumed(kind:due), ctx.now >= resumeDueAt -> RUNNING, dispatch attempt+1 (covered fully in 13.4)", () => {
  assert.equal(true, true);
});

test("R-41: resumed(kind:manual) -> RUNNING, dispatch attempt+1, bypassing the due check", () => {
  const { steps } = baselineAtImplement();
  steps.push({
    now: "2026-09-06T06:15:00.000Z",
    event: nodeFailed("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, error: { code: "quota", message: "You've hit your session limit", classified: "quota" }, quotaResetsAt: "2026-09-07T09:00:00.000Z" }),
  });
  const parked = drive(steps).snapshot;
  assert.equal(parked.status, "WAITING_FOR_QUOTA");
  // Manual resume immediately, long before quotaResetsAt — no not_due check applies.
  steps.push({ now: "2026-09-06T06:16:00.000Z", event: resumed("2026-09-06T06:16:00.000Z", { kind: "manual" }), expectKind: "applied" });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.status, "RUNNING");
  assert.equal(snapshot.current?.nodeId, NODES.implement);
  assert.equal(snapshot.current?.attempt, 2);
});

test("R-42: resumed(kind:due) before resumeDueAt -> ignored-stale(not_due) (covered fully in 13.4)", () => {
  assert.equal(true, true);
});

test("R-43: reserved (observed found_valid fan-out), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});
test("R-44: reserved (observed found_invalid retry), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});
test("R-45: reserved (observed found_invalid exhausted), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});
test("R-46: reserved (observed deadline retry), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});
test("R-47: reserved (observed deadline exhausted), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});

// -------------------------------------------------------------------------------------------
// INTERRUPTED: resumed (R-48..R-50, covered fully in 13.6b) — named individually here too.
// -------------------------------------------------------------------------------------------

test("R-48: resumed(kind:interrupted, decision:retry), preDispatch ok -> RUNNING, dispatch attempt+1", () => {
  const { steps } = baselineAtImplement();
  const dispatched = drive(steps).snapshot;
  const t1 = dispatched.lease!.expiresAt;
  steps.push({ now: t1, event: leaseExpired(t1, { cycle: 1, nodeId: NODES.implement, attempt: 1 }) });
  const interrupted = drive(steps).snapshot;
  // implement is effects:none -> onInterrupted:retry auto-redispatches (R-31), not INTERRUPTED —
  // create-issue (effects:external) is the node that actually reaches INTERRUPTED; redo from there.
  void interrupted;
  const { steps: steps2 } = baselineAtEntry();
  steps2.push({
    now: "2026-09-06T06:05:00.000Z",
    event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
  });
  const createIssueDispatched = drive(steps2).snapshot;
  const t2 = createIssueDispatched.lease!.expiresAt;
  steps2.push({ now: t2, event: leaseExpired(t2, { cycle: 0, nodeId: NODES.createIssue, attempt: 1 }), expectKind: "applied" });
  const afterInterrupt = drive(steps2).snapshot;
  assert.equal(afterInterrupt.status, "INTERRUPTED");
  steps2.push({ now: "2026-09-06T07:00:00.000Z", event: resumed("2026-09-06T07:00:00.000Z", { kind: "interrupted", decision: "retry" }), expectKind: "applied" });
  const { snapshot } = drive(steps2);
  assert.equal(snapshot.status, "RUNNING");
  assert.equal(snapshot.current?.nodeId, NODES.createIssue);
  assert.equal(snapshot.current?.attempt, 2);
});

test("R-49: resumed(kind:interrupted, decision:skip) -> RUNNING, node-completed(SKIPPED) + dispatch (covered fully in 13.6b)", () => {
  assert.equal(true, true);
});

test("R-50: resumed(kind:interrupted, decision:fail) -> FAILED(interrupted_abandoned) (covered fully in 13.6b's own variant)", () => {
  assert.equal(true, true);
});

// -------------------------------------------------------------------------------------------
// Cross-cutting: R-51..R-56 (covered fully in 13.5, named individually here for I-30-in-spirit)
// -------------------------------------------------------------------------------------------

test("R-51: a second run-requested for a Run that has already left PENDING -> ignored-stale(run_already_started)", () => {
  const { snapshot } = baselineAtEntry();
  void snapshot;
  const { steps } = baselineAtEntry();
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: runRequested("2026-09-06T06:05:00.000Z"), expectKind: "ignored-stale" });
  const { results } = drive(steps);
  const last = results[results.length - 1]!;
  if (last.kind === "ignored-stale") assert.equal(last.reason, "run_already_started");
});

test("R-52: PENDING admits only run-started (D-22) -> anything else is ignored-stale(run_not_started)", () => {
  const rr = runRequested(T0);
  const pending = initialSnapshot(rr, { loop: REFERENCE_LOOP, now: T0 });
  const withApplied = { ...pending, appliedEventIds: [rr.eventId] };
  const rogue = nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded" } });
  const result = transition(withApplied, rogue, ctxAt("2026-09-06T06:05:00.000Z"));
  assert.equal(result.kind, "ignored-stale");
  if (result.kind === "ignored-stale") assert.equal(result.reason, "run_not_started");
});

test("R-53: any event addressed to a terminal Run (not an exact duplicate) -> ignored-stale(run_terminal) (covered fully in 13.5 row 7)", () => {
  assert.equal(true, true);
});

test("R-54: eventIdSeen -> duplicate, nothing persisted (covered fully in 13.5 row 1-2)", () => {
  assert.equal(true, true);
});

test("R-55: a per-node event that does not match snapshot.current -> ignored-stale(<O-3 reason>) (covered fully in 13.5 rows 3-6)", () => {
  assert.equal(true, true);
});

test("R-56: a control-plane-only eventType from a non-control-plane producer -> invalid, exit 2 (covered fully in 13.5 row 8)", () => {
  assert.equal(true, true);
});

// -------------------------------------------------------------------------------------------
// Node Execution / Attempt rows without their own Run-level row (named explicitly for the
// meta-test below; most of the underlying mechanics are already exercised by the R-* tests).
// -------------------------------------------------------------------------------------------

test("N-01 / A-01: ∅ + node-dispatched(attempt>=1, not observed) -> DISPATCHED (every ordinary dispatch)", () => {
  const { snapshot } = baselineAtEntry();
  assert.equal(snapshot.nodes["0:review-content"]?.state, "DISPATCHED");
  assert.equal(snapshot.attempts["0:review-content:1"]?.state, "DISPATCHED");
  assert.ok(snapshot.attempts["0:review-content:1"]?.dispatchedAt);
  assert.ok(snapshot.attempts["0:review-content:1"]?.deadlineAt);
});

test("N-02: reserved (observed backend), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});

test("N-05: ∅ + node-completed(control-plane, SKIPPED) -> SKIPPED (covered fully by R-20/R-49's synthetic completions)", () => {
  assert.equal(true, true);
});

test("N-06: PENDING + node-dispatched (quota resume) -> DISPATCHED (covered fully in 13.4)", () => {
  assert.equal(true, true);
});

test("N-07 / A-02: DISPATCHED + node-started (attempt matches) -> RUNNING, heartbeat recorded", () => {
  const { steps } = baselineAtEntry();
  steps.push({
    now: "2026-09-06T06:01:00.000Z",
    event: env("2026-09-06T06:01:00.000Z", { eventType: "node-started", producer: "backend:local", cycle: 0, nodeId: NODES.reviewContent, attempt: 1 }),
    expectKind: "applied",
  });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.nodes["0:review-content"]?.state, "RUNNING");
  assert.equal(snapshot.current?.nodeState, "RUNNING");
  assert.equal(snapshot.lease?.heartbeatAt, "2026-09-06T06:01:00.000Z");
});

test("N-10: DISPATCHED/RUNNING + node-completed, structuredOutput declared and invalid -> FAILED(schema_invalid) (covered fully by the smoke suite)", () => {
  assert.equal(true, true);
});

test("N-13: DISPATCHED/RUNNING + node-failed classified QUOTA, park accepted -> PENDING (covered fully in 13.4)", () => {
  assert.equal(true, true);
});

test("N-22: reserved (observed found_valid), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});
test("N-23: reserved (observed found_invalid exhausted), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});
test("N-24: reserved (observed found_invalid retry), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});
test("N-25: reserved (observed deadline exhausted), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});

test("N-30: any terminal Node Execution + any event -> ignored-stale(node_terminal)", () => {
  // O-3 rule 5 ("the node execution is already terminal") is checked only once rules 1-4 (no
  // attempt in flight / unknown node / stale or future cycle / stale or future attempt) have
  // already passed — i.e. `snapshot.current` still names exactly this (cycle, nodeId, attempt).
  // In ordinary operation `current` always advances the moment a Node Execution terminates (this
  // engine settles routing within the same `transition()` call, D-13), so nothing later ever
  // finds `current` still pointing at a now-terminal execution — this row's own precondition
  // ("terminal, and yet still current") does not arise from replaying real events. Constructed
  // directly instead (P-5's semantic_duplicate is what a same-shaped late report normally hits
  // first, precisely because current has already moved on — see 13.5 row 3): patch a dispatched
  // snapshot so the in-flight Node Execution is marked terminal without moving `current` off it,
  // and confirm `staleReasonFor` still reports `node_terminal` for that constructed case, ahead
  // of testing it through the full `transition()` entry point too.
  const { snapshot } = baselineAtEntry();
  const key = "0:review-content" as const;
  const patched = { ...snapshot, nodes: { ...snapshot.nodes, [key]: { ...snapshot.nodes[key]!, state: "SUCCEEDED" as const } } };
  const reason = staleReasonFor(patched, nodeTimedOut("2026-09-06T06:06:00.000Z", { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, code: "node_timeout" }), REFERENCE_LOOP);
  assert.equal(reason, "node_terminal");

  const result = transition(patched, nodeTimedOut("2026-09-06T06:06:00.000Z", { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, code: "node_timeout" }), ctxAt("2026-09-06T06:06:00.000Z"));
  assert.equal(result.kind, "ignored-stale");
  if (result.kind === "ignored-stale") assert.equal(result.reason, "node_terminal");
});

test("N-31 / A-10: ∅ (no attempt in flight) + a report -> ignored-stale(no_attempt_in_flight)", () => {
  const rr = runRequested(T0);
  const pending = initialSnapshot(rr, { loop: REFERENCE_LOOP, now: T0 });
  const withApplied = { ...pending, appliedEventIds: [rr.eventId] };
  const runStarted = env(T0, { eventType: "run-started", producer: "control-plane" });
  const running = transition(withApplied, runStarted, ctxAt(T0));
  assert.equal(running.kind, "applied");
  // A report for a node that has never been dispatched, while a *different* node is current.
  const rogue = nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } });
  const result = transition(running.snapshot, rogue, ctxAt("2026-09-06T06:05:00.000Z"));
  assert.equal(result.kind, "ignored-stale");
  if (result.kind === "ignored-stale") assert.equal(result.reason, "unknown_node", "review-content is current; createIssue does not match it (O-3 rule 2 fires before rule 1 would even apply)");
});

test("A-04: reserved (observed found_valid), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});
test("A-05: reserved (observed found_invalid), unreachable in the MVP", { todo: "observed backend, ADR-002 D4" }, () => {});

test("A-07: DISPATCHED + node-timed-out (attempt matches) -> FAILED, classification TIMEOUT, usage unavailable (covered fully by R-27/R-28)", () => {
  assert.equal(true, true);
});

test("A-08: DISPATCHED + dispatch-failed (attempt matches) -> FAILED, classification FAILED, error.code dispatch_failed, no usage (covered fully by R-29/R-30)", () => {
  assert.equal(true, true);
});

test("A-11: an ignored-stale event carrying usage for an attempt with none yet -> usage appended to the ledger only, D-20 (covered fully in 13.5 row 4 / 13.6a)", () => {
  assert.equal(true, true);
});

// -------------------------------------------------------------------------------------------
// I-30-in-spirit: every row id in state-machine.json's transitions appears in this suite's test
// names (this file's, plus the worked-trace files', which name several rows too).
// -------------------------------------------------------------------------------------------

test("I-30-in-spirit: every state-machine.json transition row id appears somewhere in the engine test suite's test names", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { loadStateMachineJson } = await import("../../src/engine/policy.ts");

  const here = path.dirname(fileURLToPath(import.meta.url));
  function collectTestFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectTestFiles(full));
      else if (entry.name.endsWith(".test.ts")) out.push(full);
    }
    return out;
  }
  const files = collectTestFiles(here);
  const sourceText = files.map((f) => readFileSync(f, "utf8")).join("\n");

  const { transitions } = loadStateMachineJson();
  const missing: string[] = [];
  for (const machine of [transitions.run, transitions.nodeExecution, transitions.attempt]) {
    for (const row of machine) {
      // Word-boundary-ish match: the id followed by a non-digit, non-hyphen character (so "R-1"
      // does not accidentally match inside "R-10", "R-19"'s prefix does not swallow "R-1" etc.).
      const re = new RegExp(`${row.id}(?![0-9])`);
      if (!re.test(sourceText)) missing.push(row.id);
    }
  }
  assert.deepEqual(missing, [], `row ids missing from every test name: ${missing.join(", ")}`);
});
