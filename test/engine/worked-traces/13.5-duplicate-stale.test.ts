// state-machine.md §13.5 "Duplicate and stale delivery". Baseline: current = {implement, 1, 1,
// DISPATCHED}.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, runRequested, nodeCompleted, leaseExpired, fullUsage, wireUsage, ctxAt, assertActions, RUN_ID, LOOP_ID, LOOP_VERSION, type Step } from "../../fixtures/engine/helpers.ts";
import { NODES } from "../../fixtures/engine/reference-loop.ts";
import { transition } from "../../../src/engine/transition.ts";
import type { Envelope } from "../../../src/types/envelope.ts";

function baseline(): { steps: Step[] } {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (m: number): string => {
    now = new Date(new Date(now).getTime() + m * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];
  steps.push({ now, event: runRequested(now) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  return { steps };
}

test("13.5 row 1-2: exact eventId redelivery collapses to duplicate, persists nothing", () => {
  const { steps } = baseline();
  const t1 = "2026-09-06T06:20:00.000Z";
  const e1 = nodeCompleted(t1, {
    cycle: 1,
    nodeId: NODES.implement,
    attempt: 1,
    result: { status: "succeeded", structured: { changed: true, summary: "x" } },
    artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "a".repeat(64) }],
    usage: wireUsage(fullUsage()),
  });
  steps.push({ now: t1, event: e1, expectKind: "applied" });
  const r1 = drive(steps);
  assert.equal(r1.snapshot.nodes["1:implement"]?.state, "SUCCEEDED");
  assertActions(r1.results[r1.results.length - 1]!, "row 1-2 hop: implement completes -> run-tests dispatched");

  steps.push({ now: "2026-09-06T06:21:00.000Z", event: e1, expectKind: "duplicate" });
  const r2 = drive(steps);
  const last = r2.results[r2.results.length - 1]!;
  assert.equal(last.kind, "duplicate");
  assert.deepEqual(last.emitted, []);
});

test("13.5 row 3: a fresh eventId, same (nodeId,cycle,attempt,eventType), already terminal -> ignored-stale(semantic_duplicate)", () => {
  const { steps } = baseline();
  const t1 = "2026-09-06T06:20:00.000Z";
  steps.push({
    now: t1,
    event: nodeCompleted(t1, {
      cycle: 1,
      nodeId: NODES.implement,
      attempt: 1,
      result: { status: "succeeded", structured: { changed: true, summary: "x" } },
      artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "a".repeat(64) }],
      usage: wireUsage(fullUsage()),
    }),
    expectKind: "applied",
  });

  // A different eventId reporting the SAME (cycle,nodeId,attempt,eventType) — run-tests is now
  // current, so implement's Node Execution is already terminal.
  const e2 = nodeCompleted("2026-09-06T06:22:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x (again)" } } });
  steps.push({ now: "2026-09-06T06:22:00.000Z", event: e2, expectKind: "ignored-stale" });
  const r = drive(steps);
  const last = r.results[r.results.length - 1]!;
  assert.equal(last.kind, "ignored-stale");
  if (last.kind === "ignored-stale") {
    assert.equal(last.reason, "semantic_duplicate");
  }
});

test("13.5 row 4: a superseded attempt's late report is ignored-stale(stale_attempt) and its usage is still banked (D-20, O-5)", () => {
  const { steps } = baseline();
  const dispatchResult = drive(steps);
  const afterDispatch = dispatchResult.snapshot;
  assert.equal(afterDispatch.current?.nodeId, NODES.implement);
  assert.equal(afterDispatch.current?.attempt, 1);
  assert.ok(afterDispatch.lease);
  assertActions(dispatchResult.results[dispatchResult.results.length - 1]!, "row 4 hop 1: baseline dispatch of implement attempt 1");

  // The lease genuinely expires (implement's timeout PT30M + the default dispatch grace).
  const t1 = afterDispatch.lease!.expiresAt;
  steps.push({ now: t1, event: leaseExpired(t1, { cycle: 1, nodeId: NODES.implement, attempt: 1 }), expectKind: "applied" });
  const afterLease = drive(steps);
  assert.equal(afterLease.snapshot.current?.attempt, 2, "R-31: retryable + effects:none -> re-dispatch attempt+1");
  assert.equal(afterLease.snapshot.attempts["1:implement:1"]?.state, "LOST");
  assertActions(afterLease.results[afterLease.results.length - 1]!, "row 4 hop 2: lease-expired -> RUNNING, implement attempt 2 dispatched");

  // The original (now superseded) attempt 1's completion arrives late, carrying usage.
  const staleReport = nodeCompleted(t1, {
    cycle: 1,
    nodeId: NODES.implement,
    attempt: 1,
    result: { status: "succeeded", structured: { changed: true, summary: "the lost attempt's own result" } },
    usage: wireUsage(fullUsage({ totalTokens: 4242 })),
  });
  steps.push({ now: t1, event: staleReport, expectKind: "ignored-stale" });
  const final = drive(steps);
  const last = final.results[final.results.length - 1]!;
  assert.equal(last.kind, "ignored-stale");
  if (last.kind === "ignored-stale") {
    assert.equal(last.reason, "stale_attempt");
  }
  // D-20: usage banked on the superseded attempt even though the report itself is declined.
  assert.equal(final.snapshot.attempts["1:implement:1"]?.usage?.totalTokens, 4242);
  // O-5: routing untouched — current is still attempt 2, not overwritten by the stale report.
  assert.equal(final.snapshot.current?.attempt, 2);
  assert.equal(final.snapshot.current?.nodeId, NODES.implement);
});

test("13.5 row 5: node-started for a node that has never been dispatched -> ignored-stale(unknown_node)", () => {
  const { steps } = baseline();
  const rogue: Envelope = {
    schemaVersion: "1.1.0",
    eventId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
    eventType: "node-started",
    occurredAt: "2026-09-06T06:25:00.000Z",
    producer: "backend:local",
    loopId: LOOP_ID,
    loopVersion: LOOP_VERSION,
    runId: RUN_ID,
    cycle: 1,
    nodeId: NODES.runTests,
    attempt: 1,
  };
  steps.push({ now: "2026-09-06T06:25:00.000Z", event: rogue, expectKind: "ignored-stale" });
  const r = drive(steps);
  const last = r.results[r.results.length - 1]!;
  assert.equal(last.kind, "ignored-stale");
  if (last.kind === "ignored-stale") assert.equal(last.reason, "unknown_node");
});

test("13.5 row 6: future_cycle is ignored-stale, not an error (O-4)", () => {
  const { steps } = baseline();
  const aheadOfCycle = nodeCompleted("2026-09-06T06:25:00.000Z", { cycle: 2, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } } });
  steps.push({ now: "2026-09-06T06:25:00.000Z", event: aheadOfCycle, expectKind: "ignored-stale" });
  const r = drive(steps);
  const last = r.results[r.results.length - 1]!;
  assert.equal(last.kind, "ignored-stale");
  if (last.kind === "ignored-stale") assert.equal(last.reason, "future_cycle");
});

test("13.5 row 7: a report after run-finished is ignored-stale(run_terminal), R-53 precedes the stale test (O-6)", () => {
  const { steps } = baseline();
  const t1 = "2026-09-06T06:20:00.000Z";
  steps.push({
    now: t1,
    event: nodeCompleted(t1, { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  // Cancel the Run to reach a terminal state economically (a CANCELLED node-failed on the
  // in-flight node — R-26).
  steps.push({
    now: "2026-09-06T06:25:00.000Z",
    event: {
      schemaVersion: "1.1.0",
      eventId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      eventType: "node-failed",
      occurredAt: "2026-09-06T06:25:00.000Z",
      producer: "backend:local",
      loopId: LOOP_ID,
      loopVersion: LOOP_VERSION,
      runId: RUN_ID,
      cycle: 1,
      nodeId: NODES.runTests,
      attempt: 1,
      result: { status: "cancelled" },
      error: { code: "cancelled", message: "operator cancelled", classified: "cancelled" },
    } satisfies Envelope,
    expectKind: "applied",
  });
  const afterCancel = drive(steps);
  assert.equal(afterCancel.snapshot.status, "CANCELLED");
  assertActions(afterCancel.results[afterCancel.results.length - 1]!, "row 7 hop: node-failed(cancelled) -> CANCELLED(by: platform)");

  const lateReport = nodeCompleted("2026-09-06T06:40:00.000Z", { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } });
  steps.push({ now: "2026-09-06T06:40:00.000Z", event: lateReport, expectKind: "ignored-stale" });
  const final = drive(steps);
  const last = final.results[final.results.length - 1]!;
  assert.equal(last.kind, "ignored-stale");
  if (last.kind === "ignored-stale") assert.equal(last.reason, "run_terminal");
});

test("13.5 row 8: node-dispatched from a disallowed producer is invalid (exit 2), nothing persisted", () => {
  const { steps } = baseline();
  const beforeSnapshot = drive(steps).snapshot;
  const bogus: Envelope = {
    schemaVersion: "1.1.0",
    eventId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
    eventType: "node-dispatched",
    occurredAt: "2026-09-06T06:25:00.000Z",
    producer: "backend:github-actions",
    loopId: LOOP_ID,
    loopVersion: LOOP_VERSION,
    runId: RUN_ID,
    cycle: 1,
    nodeId: NODES.implement,
    attempt: 2,
    dispatch: { backendId: "local", transport: "process", expectedProducer: "backend:local" },
  };
  const ctx = ctxAt("2026-09-06T06:25:00.000Z");
  const result = transition(beforeSnapshot, bogus, ctx);
  assert.equal(result.kind, "invalid");
  assert.deepEqual(result.snapshot, beforeSnapshot);
});
