// state-machine.md §13.2 "Two retries, then success", continuing from the point review-changes
// first returns {approved: false}. Encoded against the v0.6 reference loop (both codex nodes on
// `local`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, runRequested, nodeCompleted, humanDecided, fullUsage, wireUsage, type Step } from "../../fixtures/engine/helpers.ts";
import { NODES, RETRY_EDGE_ID } from "../../fixtures/engine/reference-loop.ts";

function fileDigest(n: number): string {
  return "sha256:" + String(n).repeat(64).slice(0, 64);
}

test("13.2: two retries, then success — traversals 2/3, maxCycleIndex 3", () => {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (minutes: number): string => {
    now = new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];
  const push = (e: (t: string) => ReturnType<typeof nodeCompleted>, expectKind: "applied" = "applied"): void => {
    steps.push({ now: tick(5), event: e(now), expectKind });
  };

  steps.push({ now, event: runRequested(now) });
  push((t) => nodeCompleted(t, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }));
  push((t) => nodeCompleted(t, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "issue", ref: "42" }] }));
  // Cycle 1: implement, run-tests, review-changes(approved:false) -> retry.
  push((t) => nodeCompleted(t, { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "attempt 1" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fileDigest(1) }], usage: wireUsage(fullUsage()) }));
  push((t) => nodeCompleted(t, { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }));
  push((t) => nodeCompleted(t, { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: "reason 1" } }, usage: wireUsage(fullUsage()) }));

  {
    const r = drive(steps);
    assert.equal(r.snapshot.nodes["1:review-changes"]?.state, "SUCCEEDED", "D-14: a negative verdict is SUCCEEDED, not FAILED");
    assert.deepEqual(r.snapshot.nodes["1:review-verdict"]?.structured, { branch: "else" });
    // retry-edge-taken(budgetConsumed:true): traversals 0->1, cycleIndex 1->2.
    assert.deepEqual(r.snapshot.traversals, { [RETRY_EDGE_ID]: 1 });
    assert.equal(r.snapshot.cycleIndex, 2);
    assert.equal(r.snapshot.maxCycleIndex, 2);
    assert.equal(r.snapshot.current?.nodeId, NODES.implement);
    assert.equal(r.snapshot.current?.cycleIndex, 2);
    const lastResult = r.results[r.results.length - 1]!;
    assert.equal(lastResult.kind, "applied");
    if (lastResult.kind === "applied") {
      assert.deepEqual(
        lastResult.emitted.map((e) => e.eventType),
        ["node-completed", "retry-edge-taken", "node-dispatched"],
      );
      const edgeTaken = lastResult.emitted[1]!;
      assert.equal(edgeTaken.retryEdge?.budgetConsumed, true);
      assert.equal(edgeTaken.retryEdge?.traversals, 1);
      assert.equal(edgeTaken.retryEdge?.fromCycle, 1);
      assert.equal(edgeTaken.retryEdge?.toCycle, 2);
    }
  }

  // Cycle 2: implement produces a genuinely different change-set -> not NO_PROGRESS.
  push((t) => nodeCompleted(t, { cycle: 2, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "attempt 2" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fileDigest(2) }], usage: wireUsage(fullUsage()) }));
  {
    const r = drive(steps);
    assert.equal(r.snapshot.nodes["2:implement"]?.state, "SUCCEEDED", "different change-set: not NO_PROGRESS");
    assert.notEqual(r.snapshot.changeFingerprints["2:implement"], r.snapshot.changeFingerprints["1:implement"]);
  }
  push((t) => nodeCompleted(t, { cycle: 2, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }));
  push((t) => nodeCompleted(t, { cycle: 2, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: "reason 2, different evidence" } }, usage: wireUsage(fullUsage()) }));
  {
    const r = drive(steps);
    assert.deepEqual(r.snapshot.traversals, { [RETRY_EDGE_ID]: 2 });
    assert.equal(r.snapshot.cycleIndex, 3);
    assert.equal(r.snapshot.maxCycleIndex, 3);
  }

  // Cycle 3: implement, run-tests, review-changes(approved:true) -> success.
  push((t) => nodeCompleted(t, { cycle: 3, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "attempt 3" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fileDigest(3) }], usage: wireUsage(fullUsage()) }));
  push((t) => nodeCompleted(t, { cycle: 3, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }));
  push((t) => nodeCompleted(t, { cycle: 3, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "looks good now" } }, usage: wireUsage(fullUsage()) }));

  let approvalDigest = "";
  {
    const r = drive(steps);
    assert.equal(r.snapshot.status, "WAITING_HUMAN");
    assert.equal(r.snapshot.cycleIndex, 0, "leaving the body resets cycleIndex to 0");
    assert.equal(r.snapshot.maxCycleIndex, 3);
    approvalDigest = r.snapshot.pendingApproval!.subject.digest;
  }
  push((t) => humanDecided(t, { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: approvalDigest }));
  push((t) => nodeCompleted(t, { cycle: 0, nodeId: NODES.createPr, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "pr", ref: "77" }] }));

  const final = drive(steps);
  assert.equal(final.snapshot.status, "SUCCEEDED");
  assert.deepEqual(final.snapshot.outcome, { state: "SUCCEEDED", label: "success" });
  assert.deepEqual(final.snapshot.traversals, { [RETRY_EDGE_ID]: 2 });
  assert.equal(final.snapshot.maxCycleIndex, 3, "body executed 3 times (cycles 1,2,3)");
});
