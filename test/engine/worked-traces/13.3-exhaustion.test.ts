// state-machine.md §13.3 "Exhaustion" — review-changes never approves; the 4th traversal is
// refused by preDispatch (I-19: no Attempt, and no retry-edge-taken, for the refused traversal).

import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, runRequested, nodeCompleted, fullUsage, wireUsage, type Step } from "../../fixtures/engine/helpers.ts";
import { NODES, RETRY_EDGE_ID } from "../../fixtures/engine/reference-loop.ts";

function fileDigest(n: number): string {
  return "sha256:" + String(n).repeat(64).slice(0, 64);
}

test("13.3: exhaustion — traversals 3/3, MAX_ITERATIONS_EXCEEDED, no 4th Attempt", () => {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (minutes: number): string => {
    now = new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];
  const push = (e: (t: string) => ReturnType<typeof nodeCompleted>): void => {
    steps.push({ now: tick(5), event: e(now), expectKind: "applied" });
  };

  steps.push({ now, event: runRequested(now) });
  push((t) => nodeCompleted(t, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }));
  push((t) => nodeCompleted(t, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }));

  for (let cycle = 1; cycle <= 4; cycle++) {
    push((t) => nodeCompleted(t, { cycle, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: `attempt ${cycle}` } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fileDigest(cycle) }], usage: wireUsage(fullUsage()) }));
    push((t) => nodeCompleted(t, { cycle, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }));
    push((t) => nodeCompleted(t, { cycle, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: `still broken, evidence ${cycle}` } }, usage: wireUsage(fullUsage()) }));
  }

  const final = drive(steps);
  assert.equal(final.snapshot.status, "MAX_ITERATIONS_EXCEEDED");
  assert.deepEqual(final.snapshot.outcome, { state: "MAX_ITERATIONS_EXCEEDED", edgeId: RETRY_EDGE_ID, traversals: 3, maxIterations: 3 });
  assert.deepEqual(final.snapshot.traversals, { [RETRY_EDGE_ID]: 3 });
  assert.equal(final.snapshot.maxCycleIndex, 4, "body executed 4 times = maxIterations + 1");
  assert.equal(final.snapshot.current, null);

  // I-19: no Attempt exists for the refused (5th) traversal.
  assert.equal(final.snapshot.attempts["5:implement:1"], undefined);
  assert.equal(final.snapshot.nodes["5:implement"], undefined);

  const lastResult = final.results[final.results.length - 1]!;
  assert.equal(lastResult.kind, "applied");
  if (lastResult.kind === "applied") {
    // Only run-finished — no retry-edge-taken for the refused traversal.
    assert.deepEqual(
      lastResult.emitted.map((e) => e.eventType),
      ["node-completed", "run-finished"],
    );
  }
});
