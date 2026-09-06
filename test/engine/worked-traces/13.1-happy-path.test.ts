// state-machine.md §13.1 "Happy path", encoded against the v0.6 reference loop where both codex
// nodes (review-content, review-changes) run on `local` rather than the spec's illustrative
// `observed` backend (see test/fixtures/engine/reference-loop.ts's header comment). The same
// deltas the spec calls out — cycleIndex transitions, traversals, fingerprints — hold; coverage
// is 3/3 (100%) for this trace's three agent executions since `local` always reports full usage,
// rather than the spec's illustrative 1/3.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, runRequested, nodeCompleted, humanDecided, fullUsage, wireUsage, assertActions, type Step } from "../../fixtures/engine/helpers.ts";
import { NODES, RETRY_EDGE_ID } from "../../fixtures/engine/reference-loop.ts";
import type { Envelope } from "../../../src/types/envelope.ts";

function sha256Digest(): string {
  return "sha256:" + "a".repeat(64);
}

test("13.1 happy path: review-content -> needs-issue(then) -> create-issue -> implement -> run-tests -> review-changes -> review-verdict(then) -> approve-pr -> create-pr -> end-shipped", () => {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (minutes: number): string => {
    now = new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
    return now;
  };

  const rr = runRequested(now, { source: "cron" });
  const steps: Step[] = [{ now, event: rr, expectKind: "applied" }];

  // 1-3. run-requested -> run-started(emitted) -> node-dispatched(review-content, emitted), all
  // folded into this one applied step (see transition.ts's startRun doc comment).
  {
    const r1 = drive(steps);
    assert.equal(r1.snapshot.status, "RUNNING");
    assert.equal(r1.snapshot.current?.nodeId, NODES.reviewContent);
    assert.equal(r1.snapshot.current?.cycleIndex, 0);
    assert.equal(r1.snapshot.current?.attempt, 1);
    assert.equal(r1.snapshot.cycleIndex, 0);
    assert.deepEqual(r1.snapshot.traversals, { [RETRY_EDGE_ID]: 0 });
    assertActions(r1.results[r1.results.length - 1]!, "hop 1: run-requested -> RUNNING, review-content dispatched");
  }

  // 5-7 (per the spec's numbering; here, review-content's own completion): node SUCCEEDED,
  // condition needs-issue routes "then", create-issue dispatched.
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, {
      cycle: 0,
      nodeId: NODES.reviewContent,
      attempt: 1,
      result: { status: "succeeded", structured: { needs_issue: true, title: "Broken link", summary: "fix it" } },
      usage: wireUsage(fullUsage()),
    }),
    expectKind: "applied",
  });
  {
    const r = drive(steps);
    assert.equal(r.snapshot.nodes["0:review-content"]?.state, "SUCCEEDED");
    assert.equal(r.snapshot.nodes["0:needs-issue"]?.state, "SUCCEEDED");
    assert.deepEqual(r.snapshot.nodes["0:needs-issue"]?.structured, { branch: "then" });
    assert.equal(r.snapshot.current?.nodeId, NODES.createIssue);
    assert.equal(r.snapshot.budget.measuredExecutions, 1);
    assert.equal(r.snapshot.budget.unmeasuredExecutions, 0);
    assertActions(r.results[r.results.length - 1]!, "hop 2: review-content completes -> create-issue dispatched");
  }

  // 8. create-issue completes, artifactRefs += issue#42.
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, {
      cycle: 0,
      nodeId: NODES.createIssue,
      attempt: 1,
      result: { status: "succeeded", exitCode: 0, structured: { stdout: "https://github.com/x/y/issues/42" } },
      artifactRefs: [{ kind: "issue", ref: "42", url: "https://github.com/x/y/issues/42" }],
    }),
    expectKind: "applied",
  });
  {
    const r = drive(steps);
    assert.equal(r.snapshot.nodes["0:create-issue"]?.state, "SUCCEEDED");
    assert.deepEqual(r.snapshot.nodes["0:create-issue"]?.artifactRefs, [{ kind: "issue", ref: "42", url: "https://github.com/x/y/issues/42" }]);
    // 9. First body entry: cycleIndex 0 -> 1, no retry-edge-taken, traversals unchanged.
    assert.equal(r.snapshot.cycleIndex, 1);
    assert.equal(r.snapshot.maxCycleIndex, 1);
    assert.deepEqual(r.snapshot.traversals, { [RETRY_EDGE_ID]: 0 });
    assert.equal(r.snapshot.current?.nodeId, NODES.implement);
    assert.equal(r.snapshot.current?.cycleIndex, 1);
    const lastResult = r.results[r.results.length - 1]!;
    assert.equal(lastResult.kind, "applied");
    assertActions(lastResult, "hop 3: create-issue completes -> implement dispatched (cycle 1)");
    if (lastResult.kind === "applied") {
      assert.deepEqual(
        lastResult.emitted.map((e) => e.eventType),
        ["node-dispatched"],
      );
    }
  }

  // 10. implement completes, filesChanged.
  const fileDigest = sha256Digest();
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, {
      cycle: 1,
      nodeId: NODES.implement,
      attempt: 1,
      result: { status: "succeeded", structured: { changed: true, summary: "fixed the link" } },
      artifactRefs: [{ kind: "file", ref: "src/a.ts", digest: fileDigest }],
      usage: wireUsage(fullUsage()),
    }),
    expectKind: "applied",
  });
  {
    const r = drive(steps);
    assert.equal(r.snapshot.nodes["1:implement"]?.state, "SUCCEEDED");
    assert.ok(r.snapshot.changeFingerprints["1:implement"]);
    assert.equal(r.snapshot.budget.measuredExecutions, 2);
    assert.equal(r.snapshot.current?.nodeId, NODES.runTests);
    assertActions(r.results[r.results.length - 1]!, "hop 4: implement completes -> run-tests dispatched");
  }

  // 11. run-tests exit 0 -> SUCCEEDED, no usage (command node).
  steps.push({ now: tick(2), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), expectKind: "applied" });
  {
    const r = drive(steps);
    assert.equal(r.snapshot.nodes["1:run-tests"]?.state, "SUCCEEDED");
    assert.equal(r.snapshot.current?.nodeId, NODES.reviewChanges);
    assertActions(r.results[r.results.length - 1]!, "hop 5: run-tests completes -> review-changes dispatched");
  }

  // 12. review-changes {approved: true} -> SUCCEEDED, verdictFingerprints touched.
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, {
      cycle: 1,
      nodeId: NODES.reviewChanges,
      attempt: 1,
      result: { status: "succeeded", structured: { approved: true, reasons: "looks good" } },
      usage: wireUsage(fullUsage()),
    }),
    expectKind: "applied",
  });
  let approvePrDigest = "";
  {
    const r = drive(steps);
    assert.equal(r.snapshot.nodes["1:review-changes"]?.state, "SUCCEEDED");
    assert.equal(r.snapshot.budget.measuredExecutions, 3);
    // 13. review-verdict (then) leaves the body: cycleIndex 1 -> 0, maxCycleIndex stays 1.
    assert.equal(r.snapshot.nodes["1:review-verdict"]?.state, "SUCCEEDED");
    assert.deepEqual(r.snapshot.nodes["1:review-verdict"]?.structured, { branch: "then" });
    assert.equal(r.snapshot.cycleIndex, 0);
    assert.equal(r.snapshot.maxCycleIndex, 1);
    // 14. human-requested approve-pr: WAITING_HUMAN, lease null, pendingApproval subject digest.
    assert.equal(r.snapshot.status, "WAITING_HUMAN");
    assert.equal(r.snapshot.lease, null);
    assert.equal(r.snapshot.current?.nodeId, NODES.approvePr);
    assert.equal(r.snapshot.current?.cycleIndex, 0);
    assert.ok(r.snapshot.pendingApproval);
    assert.equal(r.snapshot.pendingApproval!.subject.kind, "diff");
    approvePrDigest = r.snapshot.pendingApproval!.subject.digest;
    assert.match(approvePrDigest, /^sha256:[0-9a-f]{64}$/);
    assertActions(r.results[r.results.length - 1]!, "hop 6: review-changes approved -> WAITING_HUMAN, approve-pr requested");
  }

  // 15. human-decided approve, matching digest -> RUNNING, approvals recorded, node SUCCEEDED.
  steps.push({ now: tick(20), event: humanDecided(now, { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: approvePrDigest }), expectKind: "applied" });
  {
    const r = drive(steps);
    assert.equal(r.snapshot.status, "RUNNING");
    assert.equal(r.snapshot.nodes["0:approve-pr"]?.state, "SUCCEEDED");
    assert.equal(Object.keys(r.snapshot.approvals).length, 1);
    assert.equal(r.snapshot.current?.nodeId, NODES.createPr);
    assertActions(r.results[r.results.length - 1]!, "hop 7: human-decided approve -> RUNNING, create-pr dispatched");
  }

  // 16. create-pr completes, artifactRefs += pr#77.
  steps.push({
    now: tick(2),
    event: nodeCompleted(now, {
      cycle: 0,
      nodeId: NODES.createPr,
      attempt: 1,
      result: { status: "succeeded", exitCode: 0 },
      artifactRefs: [{ kind: "pr", ref: "77", url: "https://github.com/x/y/pull/77" }],
    }),
    expectKind: "applied",
  });
  // 17. create-pr's own completion settles straight through end-shipped (a control-plane-local
  // node, D-13) to run-finished within the same applied step — there is no separate "current:
  // end-shipped" hop to observe from outside.
  const final = drive(steps);
  assert.equal(final.snapshot.nodes["0:create-pr"]?.state, "SUCCEEDED");
  assert.equal(final.snapshot.nodes["0:end-shipped"]?.state, "SUCCEEDED");
  assert.equal(final.snapshot.status, "SUCCEEDED");
  assert.deepEqual(final.snapshot.outcome, { state: "SUCCEEDED", label: "success" });
  assert.deepEqual(final.snapshot.traversals, { [RETRY_EDGE_ID]: 0 });
  assert.deepEqual(final.snapshot.freeTraversals, { [RETRY_EDGE_ID]: 0 });
  assert.equal(final.snapshot.maxCycleIndex, 1);
  assert.equal(final.snapshot.current, null);
  assert.equal(final.snapshot.lease, null);
  assert.equal(final.snapshot.finishedAt, now);
  // Coverage 3/3 (100%): the two Codex nodes run on `local` in v0.6, not the reserved `observed`
  // backend the spec's illustrative table uses (task instruction: "coverage becomes 9/9 instead
  // of 1/3" for the full multi-cycle traces; this single-cycle happy path is 3/3).
  assert.equal(final.snapshot.budget.agentExecutions, 3);
  assert.equal(final.snapshot.budget.measuredExecutions, 3);
  assert.equal(final.snapshot.budget.unmeasuredExecutions, 0);

  const artifactKinds = final.snapshot.artifactRefs.map((r) => r.kind);
  void artifactKinds; // artifactRefs accumulation is a `run-finished`-time concern (see below)
  const lastResult = final.results[final.results.length - 1] as Extract<import("../../../src/types/state.ts").TransitionResult, { kind: "applied" }>;
  assertActions(lastResult, "hop 8: create-pr completes -> run-finished(SUCCEEDED)");
  const runFinished = lastResult.emitted.find((e: Envelope) => e.eventType === "run-finished");
  assert.ok(runFinished);
  assert.equal(runFinished!.outcome?.state, "SUCCEEDED");
  assert.equal(runFinished!.outcome?.endLabel, "success");
});
