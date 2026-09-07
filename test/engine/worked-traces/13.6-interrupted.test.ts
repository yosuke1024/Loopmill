// state-machine.md §13.6 "Interrupted `run` process": the lease-expired + re-dispatch case
// (implement, effects: none, D-11 onInterrupted: retry), and the external-effects variant
// (create-pr, effects: external, D-11 onInterrupted: ask -> INTERRUPTED, then resumed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, runRequested, nodeCompleted, leaseExpired, resumed, humanDecided, fullUsage, wireUsage, assertActions, type Step } from "../../fixtures/engine/helpers.ts";
import { NODES } from "../../fixtures/engine/reference-loop.ts";

test("13.6a: implement's lease expires; effects:none + retryable -> R-31 re-dispatch attempt 2; the original attempt's late report is stale (O-5)", () => {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (m: number): string => {
    now = new Date(new Date(now).getTime() + m * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];
  steps.push({ now, event: runRequested(now) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });

  const dispatchedResult = drive(steps);
  const dispatched = dispatchedResult.snapshot;
  assert.equal(dispatched.current?.nodeId, NODES.implement);
  assert.equal(dispatched.current?.attempt, 1);
  assertActions(dispatchedResult.results[dispatchedResult.results.length - 1]!, "13.6a hop 1: baseline dispatch of implement attempt 1");
  const leaseExpiresAt = dispatched.lease!.expiresAt;

  steps.push({ now: leaseExpiresAt, event: leaseExpired(leaseExpiresAt, { cycle: 1, nodeId: NODES.implement, attempt: 1 }), expectKind: "applied" });
  const afterLease = drive(steps);
  assert.equal(afterLease.snapshot.attempts["1:implement:1"]?.state, "LOST");
  assert.equal(afterLease.snapshot.chargedAttempts["1:implement"], 1);
  assert.equal(afterLease.snapshot.status, "RUNNING", "still RUNNING — effects:none re-dispatches automatically");
  assert.equal(afterLease.snapshot.current?.attempt, 2);
  const lastResult = afterLease.results[afterLease.results.length - 1]!;
  assert.equal(lastResult.kind, "applied");
  assertActions(lastResult, "13.6a hop 2: lease-expired -> RUNNING, implement attempt 2 dispatched");
  if (lastResult.kind === "applied") {
    assert.deepEqual(
      lastResult.emitted.map((e) => e.eventType),
      ["node-dispatched"],
    );
  }

  // The original subprocess had in fact started and its completion now reports late.
  // Carries usage (the lost process really had completed and really had spent tokens) so D-20's
  // banking replaces the LOST attempt's synthetic `unavailable` placeholder with real numbers —
  // otherwise implement's Node Execution stays permanently "not fully measured" even after
  // attempt 2 succeeds (usage-normalization.md: "measured iff every contributing attempt is
  // measured"), which would trip `maxUnmeasuredExecutions`'s MVP default of 0 on the very next
  // dispatch — see 13.4-quota.test.ts's documented finding for the same interaction.
  const staleReport = nodeCompleted(leaseExpiresAt, {
    cycle: 1,
    nodeId: NODES.implement,
    attempt: 1,
    result: { status: "succeeded", structured: { changed: true, summary: "the lost one" } },
    usage: wireUsage(fullUsage()),
  });
  steps.push({ now: leaseExpiresAt, event: staleReport, expectKind: "ignored-stale" });
  const afterStale = drive(steps);
  const staleResult = afterStale.results[afterStale.results.length - 1]!;
  if (staleResult.kind === "ignored-stale") assert.equal(staleResult.reason, "stale_attempt");
  assert.equal(afterStale.snapshot.current?.attempt, 2, "routing untouched");

  // attempt 2 succeeds -> the run continues normally.
  steps.push({
    now: "2026-09-06T07:00:00.000Z",
    event: nodeCompleted("2026-09-06T07:00:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 2, result: { status: "succeeded", structured: { changed: true, summary: "attempt 2" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "c".repeat(64) }], usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  const final = drive(steps);
  assert.equal(final.snapshot.nodes["1:implement"]?.state, "SUCCEEDED");
  assert.equal(final.snapshot.current?.nodeId, NODES.runTests);
  assertActions(final.results[final.results.length - 1]!, "13.6a hop 3: implement attempt 2 completes -> run-tests dispatched");
});

test("13.6b: create-pr's lease expires; effects:external -> R-32 INTERRUPTED, resume --decision skip moves on", () => {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (m: number): string => {
    now = new Date(new Date(now).getTime() + m * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];
  steps.push({ now, event: runRequested(now) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "d".repeat(64) }], usage: wireUsage(fullUsage()) }),
  });
  steps.push({ now: tick(2), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }),
  });
  const waitingHumanResult = drive(steps);
  const waitingHuman = waitingHumanResult.snapshot;
  assert.equal(waitingHuman.status, "WAITING_HUMAN");
  assertActions(waitingHumanResult.results[waitingHumanResult.results.length - 1]!, "13.6b hop 1: review-changes approved -> WAITING_HUMAN, approve-pr requested");
  const digest = waitingHuman.pendingApproval!.subject.digest;
  steps.push({ now: tick(20), event: humanDecided(now, { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: digest }) });

  const dispatchedResult = drive(steps);
  const dispatched = dispatchedResult.snapshot;
  assert.equal(dispatched.current?.nodeId, NODES.createPr);
  assertActions(dispatchedResult.results[dispatchedResult.results.length - 1]!, "13.6b hop 2: human-decided approve -> RUNNING, create-pr dispatched");
  const leaseExpiresAt = dispatched.lease!.expiresAt;

  steps.push({ now: leaseExpiresAt, event: leaseExpired(leaseExpiresAt, { cycle: 0, nodeId: NODES.createPr, attempt: 1 }), expectKind: "applied" });
  const afterLease = drive(steps);
  assert.equal(afterLease.snapshot.status, "INTERRUPTED");
  assert.equal(afterLease.snapshot.interrupted?.nodeId, NODES.createPr);
  assert.equal(afterLease.snapshot.lease, null);
  assert.equal(afterLease.snapshot.attempts["0:create-pr:1"]?.state, "LOST");
  assertActions(afterLease.results[afterLease.results.length - 1]!, "13.6b hop 3: create-pr's lease expires, effects:external -> INTERRUPTED");

  // The operator confirms PR #77 already exists and decides to skip.
  steps.push({ now: "2026-09-06T08:00:00.000Z", event: resumed("2026-09-06T08:00:00.000Z", { kind: "interrupted", decision: "skip" }), expectKind: "applied" });
  const final = drive(steps);
  assert.equal(final.snapshot.nodes["0:create-pr"]?.state, "SKIPPED");
  assert.equal(final.snapshot.status, "SUCCEEDED");
  assert.deepEqual(final.snapshot.outcome, { state: "SUCCEEDED", label: "success" });
  assertActions(final.results[final.results.length - 1]!, "13.6b hop 4: resumed(kind:interrupted, decision:skip) -> SUCCEEDED");
});

test("13.6b variant: resume --decision fail -> FAILED(interrupted_abandoned)", () => {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (m: number): string => {
    now = new Date(new Date(now).getTime() + m * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];
  steps.push({ now, event: runRequested(now) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "e".repeat(64) }], usage: wireUsage(fullUsage()) }),
  });
  steps.push({ now: tick(2), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }),
  });
  const waitingHuman = drive(steps).snapshot;
  const digest = waitingHuman.pendingApproval!.subject.digest;
  steps.push({ now: tick(20), event: humanDecided(now, { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: digest }) });
  const dispatched = drive(steps).snapshot;
  const leaseExpiresAt = dispatched.lease!.expiresAt;
  steps.push({ now: leaseExpiresAt, event: leaseExpired(leaseExpiresAt, { cycle: 0, nodeId: NODES.createPr, attempt: 1 }) });
  steps.push({ now: "2026-09-06T08:00:00.000Z", event: resumed("2026-09-06T08:00:00.000Z", { kind: "interrupted", decision: "fail" }), expectKind: "applied" });
  const final = drive(steps);
  assert.equal(final.snapshot.status, "FAILED");
  if (final.snapshot.outcome?.state === "FAILED") {
    assert.equal(final.snapshot.outcome.failureReason, "interrupted_abandoned");
  } else {
    assert.fail("expected FAILED");
  }
  assertActions(final.results[final.results.length - 1]!, "13.6b variant hop: resumed(kind:interrupted, decision:fail) -> FAILED(interrupted_abandoned)");
});
