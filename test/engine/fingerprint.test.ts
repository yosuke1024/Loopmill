// changeFingerprint / verdictFingerprint / progressFingerprint / noProgressFires
// (state-machine.md §6.6, D-08).

import { test } from "node:test";
import assert from "node:assert/strict";
import { changeFingerprint, verdictFingerprint, progressFingerprint, noProgressFires } from "../../src/engine/fingerprint.ts";
import { REFERENCE_LOOP, NODES, RETRY_EDGE_ID } from "../fixtures/engine/reference-loop.ts";
import type { NodeExecutionRecord, RunSnapshot } from "../../src/types/state.ts";

function record(overrides: Partial<NodeExecutionRecord> = {}): NodeExecutionRecord {
  return {
    nodeId: NODES.implement,
    cycleIndex: 1,
    state: "SUCCEEDED",
    attemptsUsed: 1,
    startedAt: "2026-09-06T06:00:00Z",
    finishedAt: "2026-09-06T06:05:00Z",
    summary: null,
    filesChanged: 0,
    changeFingerprint: null,
    artifactRefs: [],
    structured: null,
    stdout: null,
    exitCode: null,
    ...overrides,
  };
}

function snapshotWithNodes(nodes: Record<string, NodeExecutionRecord>, changeFingerprints: Record<string, string> = {}): RunSnapshot {
  return {
    schemaVersion: "1.0.0",
    snapshotOf: 0,
    eventSeq: 0,
    runId: "run_x",
    loopId: REFERENCE_LOOP.slug,
    loopVersion: REFERENCE_LOOP.loopVersion,
    loopDigest: REFERENCE_LOOP.loopVersion,
    trigger: { kind: "schedule", requestedAt: "2026-09-06T06:00:00Z" },
    status: "RUNNING",
    outcome: null,
    startedAt: "2026-09-06T06:00:00Z",
    updatedAt: "2026-09-06T06:00:00Z",
    finishedAt: null,
    cycleIndex: 1,
    maxCycleIndex: 1,
    traversals: { [RETRY_EDGE_ID]: 0 },
    freeTraversals: { [RETRY_EDGE_ID]: 0 },
    noProgressStreak: 0,
    changeFingerprints,
    verdictFingerprints: {},
    current: null,
    nodes,
    attempts: {},
    chargedAttempts: {},
    quota: null,
    pendingApproval: null,
    approvals: {},
    observe: null,
    lease: null,
    interrupted: null,
    budget: { stepsUsed: 0, activeMs: 0, waitMs: 0, measuredTokens: 0, agentExecutions: 0, measuredExecutions: 0, unmeasuredExecutions: 0 },
    artifactRefs: [],
    appliedEventIds: [],
    ignoredEventIds: [],
    emittedEventIds: [],
    terminalEventKeys: [],
  };
}

test("changeFingerprint: an empty change-set hashes the empty array (a value, not null)", () => {
  const fp = changeFingerprint([]);
  assert.equal(typeof fp, "string");
  assert.equal(fp.length, 64);
  assert.equal(fp, changeFingerprint([]), "deterministic");
});

test("changeFingerprint: order-independent (sorted before hashing)", () => {
  const a = changeFingerprint([
    { path: "b.ts", digest: "2" },
    { path: "a.ts", digest: "1" },
  ]);
  const b = changeFingerprint([
    { path: "a.ts", digest: "1" },
    { path: "b.ts", digest: "2" },
  ]);
  assert.equal(a, b);
});

test("changeFingerprint: a different digest for the same path changes the fingerprint", () => {
  const a = changeFingerprint([{ path: "a.ts", digest: "1" }]);
  const b = changeFingerprint([{ path: "a.ts", digest: "2" }]);
  assert.notEqual(a, b);
});

test("verdictFingerprint: excludes the node being fingerprinted", () => {
  const nodes = {
    "1:implement": record({ nodeId: NODES.implement, cycleIndex: 1, structured: { changed: true, summary: "x" } }),
  };
  const snapshot = snapshotWithNodes(nodes);
  const fp = verdictFingerprint(1, NODES.implement, snapshot, REFERENCE_LOOP);
  // Only implement itself exists in cycle 1 so far, and it is excluded -> empty set.
  assert.equal(fp, verdictFingerprint(1, NODES.implement, snapshotWithNodes({}), REFERENCE_LOOP));
});

test("verdictFingerprint: includes sibling agent Node Executions recorded in the same cycle, excluding non-agent kinds", () => {
  const nodesWithoutReviewChanges = {
    "1:implement": record({ nodeId: NODES.implement, cycleIndex: 1, structured: { changed: true } }),
    "1:run-tests": record({ nodeId: NODES.runTests, cycleIndex: 1, structured: null }),
  };
  const nodesWithReviewChanges = {
    ...nodesWithoutReviewChanges,
    "1:review-changes": record({ nodeId: NODES.reviewChanges, cycleIndex: 1, structured: { approved: false, reasons: "r1" } }),
  };
  // Excluding "implement" (the node being fingerprinted): run-tests never contributes (not an
  // agent), so adding review-changes' agent record is the only thing that can change the hash.
  const withoutReviewChanges = verdictFingerprint(1, NODES.implement, snapshotWithNodes(nodesWithoutReviewChanges), REFERENCE_LOOP);
  const withReviewChanges = verdictFingerprint(1, NODES.implement, snapshotWithNodes(nodesWithReviewChanges), REFERENCE_LOOP);
  assert.notEqual(withoutReviewChanges, withReviewChanges, "review-changes (agent) contributes to implement's verdictFingerprint");

  // Excluding "review-changes" instead: now implement's own structured output contributes, and
  // run-tests still does not.
  const excludingReviewChanges = verdictFingerprint(1, NODES.reviewChanges, snapshotWithNodes(nodesWithReviewChanges), REFERENCE_LOOP);
  assert.notEqual(excludingReviewChanges, withReviewChanges, "which node is excluded changes the fingerprint");
});

test("progressFingerprint: deterministic, sensitive to either input", () => {
  const a = progressFingerprint("change1", "verdict1");
  const b = progressFingerprint("change1", "verdict1");
  const c = progressFingerprint("change2", "verdict1");
  const d = progressFingerprint("change1", "verdict2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test("noProgressFires: cycle 1 can never be NO_PROGRESS (nothing to compare against)", () => {
  const snapshot = snapshotWithNodes({});
  assert.equal(noProgressFires(snapshot, REFERENCE_LOOP, 1, NODES.implement, []), false);
});

test("noProgressFires: cycle 0 can never be NO_PROGRESS (outside every body)", () => {
  const snapshot = snapshotWithNodes({});
  assert.equal(noProgressFires(snapshot, REFERENCE_LOOP, 0, NODES.reviewContent, []), false);
});

test("noProgressFires: fires when the change-set and verdict context are byte-identical to the previous cycle", () => {
  const prevChangeFp = changeFingerprint([{ path: "a.ts", digest: "same" }]);
  const nodes = {
    "1:implement": record({ nodeId: NODES.implement, cycleIndex: 1, changeFingerprint: prevChangeFp, state: "SUCCEEDED" }),
  };
  const snapshot = snapshotWithNodes(nodes, { "1:implement": prevChangeFp });
  const fires = noProgressFires(snapshot, REFERENCE_LOOP, 2, NODES.implement, [{ path: "a.ts", digest: "same" }]);
  assert.equal(fires, true);
});

test("noProgressFires: does not fire when the change-set differs from the previous cycle", () => {
  const prevChangeFp = changeFingerprint([{ path: "a.ts", digest: "same" }]);
  const nodes = {
    "1:implement": record({ nodeId: NODES.implement, cycleIndex: 1, changeFingerprint: prevChangeFp, state: "SUCCEEDED" }),
  };
  const snapshot = snapshotWithNodes(nodes, { "1:implement": prevChangeFp });
  const fires = noProgressFires(snapshot, REFERENCE_LOOP, 2, NODES.implement, [{ path: "a.ts", digest: "different" }]);
  assert.equal(fires, false);
});

test("noProgressFires: does not fire when the previous cycle's execution is not terminal", () => {
  const prevChangeFp = changeFingerprint([{ path: "a.ts", digest: "same" }]);
  const nodes = {
    "1:implement": record({ nodeId: NODES.implement, cycleIndex: 1, changeFingerprint: prevChangeFp, state: "DISPATCHED" }),
  };
  const snapshot = snapshotWithNodes(nodes, { "1:implement": prevChangeFp });
  const fires = noProgressFires(snapshot, REFERENCE_LOOP, 2, NODES.implement, [{ path: "a.ts", digest: "same" }]);
  assert.equal(fires, false);
});

// Amendment (m0+), 2026-09-07 (state-machine.md §6.6): progressFingerprint(cycle, nodeId) reads
// verdictFingerprint(cycle - 1), not verdictFingerprint(cycle) — the evidence a node was handed
// *before* it started its own cycle, not the (necessarily still-empty) sibling set of its own
// still-in-progress cycle. Both tests below check `noProgressFires` at cycle 2 against cycle 1,
// which compares verdictFingerprint(1) (evidence before cycle 2 started) against
// verdictFingerprint(0) (evidence before cycle 1 started) — a sibling agent Node Execution
// (`review-changes`) planted in cycle 0 and cycle 1 stands in for that "evidence".

test("noProgressFires: Amendment (m0+) 2026-09-07 — identical change-set AND identical prior-cycle review evidence -> NO_PROGRESS fires", () => {
  const changeFp = changeFingerprint([{ path: "a.ts", digest: "same" }]);
  const verdict = { approved: false, reasons: "same reason" };
  const nodes = {
    "0:review-changes": record({ nodeId: NODES.reviewChanges, cycleIndex: 0, structured: verdict }),
    "1:implement": record({ nodeId: NODES.implement, cycleIndex: 1, changeFingerprint: changeFp, state: "SUCCEEDED" }),
    "1:review-changes": record({ nodeId: NODES.reviewChanges, cycleIndex: 1, structured: verdict }),
  };
  const snapshot = snapshotWithNodes(nodes, { "1:implement": changeFp });
  const fires = noProgressFires(snapshot, REFERENCE_LOOP, 2, NODES.implement, [{ path: "a.ts", digest: "same" }]);
  assert.equal(fires, true, "same change-set, same evidence handed to both cycles -> stuck");
});

test("noProgressFires: Amendment (m0+) 2026-09-07 — identical change-set but the prior cycle's review evidence differs -> NO_PROGRESS does not fire", () => {
  const changeFp = changeFingerprint([{ path: "a.ts", digest: "same" }]);
  const nodes = {
    "0:review-changes": record({ nodeId: NODES.reviewChanges, cycleIndex: 0, structured: { approved: false, reasons: "reason A" } }),
    "1:implement": record({ nodeId: NODES.implement, cycleIndex: 1, changeFingerprint: changeFp, state: "SUCCEEDED" }),
    "1:review-changes": record({ nodeId: NODES.reviewChanges, cycleIndex: 1, structured: { approved: false, reasons: "reason B" } }),
  };
  const snapshot = snapshotWithNodes(nodes, { "1:implement": changeFp });
  const fires = noProgressFires(snapshot, REFERENCE_LOOP, 2, NODES.implement, [{ path: "a.ts", digest: "same" }]);
  assert.equal(fires, false, "an empty change-set alone is not enough (§6.6): a different verdict is still new information");
});
