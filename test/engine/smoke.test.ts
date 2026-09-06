// A quick end-to-end smoke test of the happy path (state-machine.md §13.1) — written first to
// find integration bugs before the full worked-trace suite (13.1.test.ts) locks in every delta.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, runRequested, nodeCompleted, fullUsage, wireUsage } from "../fixtures/engine/helpers.ts";
import { NODES } from "../fixtures/engine/reference-loop.ts";

test("smoke: run-requested folds run-started's own entry dispatch into one applied step", () => {
  const t0 = "2026-09-06T06:00:00.000Z";
  const rr = runRequested(t0);
  const step1 = drive([{ now: t0, event: rr, expectKind: "applied" }]);
  assert.equal(step1.snapshot.status, "RUNNING");
  assert.equal(step1.snapshot.current?.nodeId, NODES.reviewContent);
  assert.equal(step1.snapshot.current?.attempt, 1);
  const emitted1 = step1.results[0]!.kind === "applied" ? step1.results[0]!.emitted : [];
  assert.deepEqual(
    emitted1.map((e) => e.eventType),
    ["run-started", "node-dispatched"],
  );
});

test("smoke: happy path first hop — review-content succeeds, condition routes to create-issue", () => {
  const t0 = "2026-09-06T06:00:00.000Z";
  const rr = runRequested(t0);
  const t1 = "2026-09-06T06:05:00.000Z";
  const { snapshot } = drive([
    { now: t0, event: rr },
    {
      now: t1,
      event: nodeCompleted(t1, {
        cycle: 0,
        nodeId: NODES.reviewContent,
        attempt: 1,
        result: { status: "succeeded", structured: { needs_issue: true, title: "Broken link", summary: "fix it" } },
        usage: wireUsage(fullUsage()),
      }),
      expectKind: "applied",
    },
  ]);
  assert.equal(snapshot.status, "RUNNING");
  assert.equal(snapshot.current?.nodeId, NODES.createIssue, "review-content -> needs-issue(condition, then) -> create-issue");
  assert.equal(snapshot.nodes["0:needs-issue"]?.state, "SUCCEEDED");
  const branch = snapshot.nodes["0:needs-issue"]?.structured as { branch: string } | null;
  assert.equal(branch?.branch, "then");
  assert.equal(snapshot.budget.measuredExecutions, 1);
  assert.equal(snapshot.budget.unmeasuredExecutions, 0);
});

test("smoke: an agent's non-conforming structured output is FAILED(schema_invalid)", () => {
  const t0 = "2026-09-06T06:00:00.000Z";
  const rr = runRequested(t0);
  const t1 = "2026-09-06T06:05:00.000Z";
  const { snapshot } = drive([
    { now: t0, event: rr },
    {
      now: t1,
      event: nodeCompleted(t1, {
        cycle: 0,
        nodeId: NODES.reviewContent,
        attempt: 1,
        result: { status: "succeeded", structured: { title: "x", summary: "y" } }, // missing needs_issue
        usage: wireUsage(fullUsage()),
      }),
      expectKind: "applied",
    },
  ]);
  assert.equal(snapshot.status, "FAILED");
  if (snapshot.outcome?.state === "FAILED") {
    assert.equal(snapshot.outcome.failureReason, "schema_invalid");
  } else {
    assert.fail("expected a FAILED outcome");
  }
});

test("smoke: duplicate eventId collapses to 'duplicate' and persists nothing", () => {
  const t0 = "2026-09-06T06:00:00.000Z";
  const rr = runRequested(t0);
  const { results } = drive([
    { event: rr, now: t0, expectKind: "applied" },
    { event: rr, now: "2026-09-06T06:00:05.000Z", expectKind: "duplicate" },
  ]);
  assert.equal(results[1]!.kind, "duplicate");
  assert.deepEqual(results[1]!.emitted, []);
});
