// state-machine.md §13.4 "Quota park and resume".

import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, runRequested, nodeCompleted, nodeFailed, resumed, fullUsage, wireUsage, assertActions, type Step } from "../../fixtures/engine/helpers.ts";
import { NODES } from "../../fixtures/engine/reference-loop.ts";

test("13.4: quota park (reported reset) and resume", () => {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (minutes: number): string => {
    now = new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];

  steps.push({ now, event: runRequested(now) });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }),
    expectKind: "applied",
  });

  // 2. implement's attempt 1 fails classified quota, resets at 09:45.
  const quotaResetsAt = "2026-09-06T09:45:00.000Z";
  steps.push({
    now: tick(5),
    event: nodeFailed(now, {
      cycle: 1,
      nodeId: NODES.implement,
      attempt: 1,
      error: { code: "quota", message: "You've hit your session limit · resets at 3:45pm", classified: "quota" },
      quotaResetsAt,
    }),
    expectKind: "applied",
  });
  {
    const r = drive(steps);
    assert.equal(r.snapshot.attempts["1:implement:1"]?.state, "FAILED");
    assert.equal(r.snapshot.attempts["1:implement:1"]?.classification, "QUOTA");
    // D-07: quota parks are not charged against maxAttempts.
    assert.equal(r.snapshot.chargedAttempts["1:implement"] ?? 0, 0);
    // 3. quota-parked emitted; status WAITING_FOR_QUOTA; lease null.
    assert.equal(r.snapshot.status, "WAITING_FOR_QUOTA");
    assert.equal(r.snapshot.nodes["1:implement"]?.state, "PENDING");
    assert.equal(r.snapshot.lease, null);
    assert.equal(r.snapshot.quota?.parks, 1);
    assert.equal(r.snapshot.quota?.quotaResetsAt, quotaResetsAt);
    const last = r.results[r.results.length - 1]!;
    assert.equal(last.kind, "applied");
    assertActions(last, "hop A: implement attempt 1 fails classified quota -> WAITING_FOR_QUOTA, quota-parked");
    if (last.kind === "applied") {
      assert.deepEqual(
        last.emitted.map((e) => e.eventType),
        ["quota-parked"],
      );
    }
  }

  // 4. resumed{kind:due} at 15:20 (< resumeDueAt) -> ignored-stale(not_due), no control change.
  steps.push({ now: "2026-09-06T09:20:00.000Z", event: resumed("2026-09-06T09:20:00.000Z", { kind: "due" }), expectKind: "ignored-stale" });
  {
    const r = drive(steps);
    assert.equal(r.results[r.results.length - 1]!.kind, "ignored-stale");
    if (r.results[r.results.length - 1]!.kind === "ignored-stale") {
      assert.equal((r.results[r.results.length - 1] as { reason: string }).reason, "not_due");
    }
    assert.equal(r.snapshot.status, "WAITING_FOR_QUOTA", "ignored-stale changes no control field");
    assert.equal(r.snapshot.quota?.parks, 1);
  }

  // 5. resumed{kind:due} at 09:50 (>= resumeDueAt = resetsAt + 60s jitter) -> RUNNING.
  steps.push({ now: "2026-09-06T09:50:00.000Z", event: resumed("2026-09-06T09:50:00.000Z", { kind: "due" }), expectKind: "applied" });
  {
    const r = drive(steps);
    assert.equal(r.snapshot.status, "RUNNING");
    assert.equal(r.snapshot.current?.nodeId, NODES.implement);
    assert.equal(r.snapshot.current?.attempt, 2, "re-dispatch increments attempt for identity");
    assert.equal(r.snapshot.quota, null);
    assertActions(r.results[r.results.length - 1]!, "hop C: resumed(kind:due) after resumeDueAt -> RUNNING, implement attempt 2 dispatched");
  }

  // 7. node-completed SUCCESS on the retried attempt.
  steps.push({
    now: "2026-09-06T09:55:00.000Z",
    event: nodeCompleted("2026-09-06T09:55:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 2, result: { status: "succeeded", structured: { changed: true, summary: "fixed after quota" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "b".repeat(64) }], usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  const final = drive(steps);
  assert.equal(final.snapshot.nodes["1:implement"]?.state, "SUCCEEDED");
  assert.equal(final.snapshot.attempts["1:implement:2"]?.state, "COMPLETED");

  // usage-normalization.md §4.1, Amendment (m0+) 2026-09-07: a QUOTA-classified attempt does not
  // make its Node Execution unmeasured. Attempt 1 (the quota refusal) still keeps its own
  // `usage.provenance: 'unavailable'` on the ledger, for the audit...
  assert.equal(final.snapshot.attempts["1:implement:1"]?.classification, "QUOTA");
  assert.equal(final.snapshot.attempts["1:implement:1"]?.usage?.provenance, "unavailable");
  // ...but it is excluded from the "every contributing attempt measured" test: attempt 2 (the
  // retry after the park) is `reported`/`complete: true`, so implement's Node Execution as a
  // whole is measured, `unmeasuredExecutions` stays 0, and the post-recovery dispatch of
  // run-tests does not breach `maxUnmeasuredExecutions` (default 0) the way it did before this
  // amendment.
  assert.equal(final.snapshot.attempts["1:implement:2"]?.usage?.provenance, "reported");
  assert.equal(final.snapshot.budget.unmeasuredExecutions, 0);
  assert.equal(final.snapshot.budget.measuredExecutions, 2);
  assert.equal(final.snapshot.budget.agentExecutions, 2);

  // The Run recovered: run-tests is dispatched next, RUNNING, not BUDGET_EXCEEDED.
  assert.equal(final.snapshot.status, "RUNNING");
  assert.equal(final.snapshot.current?.nodeId, NODES.runTests);
  assert.equal(final.snapshot.current?.cycleIndex, 1);
  assert.equal(final.snapshot.current?.attempt, 1);
  const last = final.results[final.results.length - 1]!;
  assert.equal(last.kind, "applied");
  assertActions(last, "hop D: implement attempt 2 completes -> run-tests dispatched");
  if (last.kind === "applied") {
    assert.deepEqual(
      last.emitted.map((e) => e.eventType),
      ["node-dispatched"],
    );
  }
});

test("13.4 variant: §7.1 wire table — 'quota' classified with no quotaResetsAt degrades to internal FAILED (never QUOTA), so the Run fails generically, not as quota_unclassifiable", () => {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (minutes: number): string => {
    now = new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];
  steps.push({ now, event: runRequested(now) });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }),
    expectKind: "applied",
  });
  // classified quota but no quotaResetsAt at all: §7.1's wire table maps this straight to
  // internal Classification FAILED (I-25), so the Run never enters WAITING_FOR_QUOTA at all —
  // it retries (maxAttempts not yet exhausted) rather than failing outright on attempt 1.
  steps.push({
    now: tick(5),
    event: nodeFailed(now, { cycle: 1, nodeId: NODES.implement, attempt: 1, error: { code: "quota", message: "a generic usage message with no recognisable limit name", classified: "quota" } }),
    expectKind: "applied",
  });
  const { results, snapshot } = drive(steps);
  assert.equal(snapshot.status, "RUNNING", "classification FAILED + retryable -> attempt 2, never WAITING_FOR_QUOTA");
  assert.equal(snapshot.attempts["1:implement:1"]?.classification, "FAILED");
  assert.equal(snapshot.current?.attempt, 2);
  assert.equal(snapshot.quota, null);
  assertActions(results[results.length - 1]!, "13.4 variant (no quotaResetsAt): classification degrades to FAILED -> attempt 2 dispatched");
});

test("13.4 variant: R-24 — classified quota with a quotaResetsAt this engine cannot parse -> FAILED(quota_unclassifiable)", () => {
  // A schema-valid envelope can never actually carry an unparseable quotaResetsAt
  // (envelope.schema.json's pattern already enforces RFC 3339) — this row is only reachable by
  // constructing the Envelope directly, bypassing makeEnvelope's schema check, exactly as the
  // task's "at least the minimal scenario that takes that row" instruction allows.
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (minutes: number): string => {
    now = new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [];
  steps.push({ now, event: runRequested(now) });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }),
    expectKind: "applied",
  });
  // Built directly, bypassing makeEnvelope: the schema forbids this quotaResetsAt shape, but
  // transition() must still degrade gracefully (P-3) rather than assume it can never happen.
  const okEnvelope = nodeFailed(now, { cycle: 1, nodeId: NODES.implement, attempt: 1, error: { code: "quota", message: "hit the limit", classified: "quota" }, quotaResetsAt: "2026-09-06T09:45:00.000Z" });
  const raw = { ...okEnvelope, quotaResetsAt: "2026-13-99T99:99:99Z" };
  steps.push({ now: tick(5), event: raw, expectKind: "applied" });
  const { results, snapshot } = drive(steps);
  assert.equal(snapshot.status, "FAILED");
  if (snapshot.outcome?.state === "FAILED") {
    assert.equal(snapshot.outcome.failureReason, "quota_unclassifiable");
  } else {
    assert.fail("expected FAILED");
  }
  assertActions(results[results.length - 1]!, "13.4 variant (R-24): unparseable quotaResetsAt -> FAILED(quota_unclassifiable)");
});
