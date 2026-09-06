// preDispatch (state-machine.md §11.2, D-19, I-20): the fixed order, and clockBucketFor/
// accrueClock (D-04).

import { test } from "node:test";
import assert from "node:assert/strict";
import { preDispatch, clockBucketFor, accrueClock } from "../../src/engine/budget.ts";
import { DEFAULT_POLICY } from "../../src/engine/policy.ts";
import { REFERENCE_LOOP, NODES, RETRY_EDGE_ID } from "../fixtures/engine/reference-loop.ts";
import type { RunSnapshot } from "../../src/types/state.ts";

function baseSnapshot(overrides: Partial<RunSnapshot["budget"]> = {}): RunSnapshot {
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
    changeFingerprints: {},
    verdictFingerprints: {},
    current: null,
    nodes: {},
    attempts: {},
    chargedAttempts: {},
    quota: null,
    pendingApproval: null,
    approvals: {},
    observe: null,
    lease: null,
    interrupted: null,
    budget: { stepsUsed: 0, activeMs: 0, waitMs: 0, measuredTokens: 0, agentExecutions: 0, measuredExecutions: 0, unmeasuredExecutions: 0, ...overrides },
    artifactRefs: [],
    appliedEventIds: [],
    ignoredEventIds: [],
    emittedEventIds: [],
    terminalEventKeys: [],
  };
}

const implement = REFERENCE_LOOP.nodes[NODES.implement]!;
const edge = REFERENCE_LOOP.edges[RETRY_EDGE_ID]!;

test("preDispatch: ok when every budget is untouched", () => {
  const result = preDispatch(baseSnapshot(), REFERENCE_LOOP, implement, 1, null, DEFAULT_POLICY);
  assert.deepEqual(result, { ok: true });
});

test("preDispatch step 1: edge traversals exhausted -> MAX_ITERATIONS_EXCEEDED, checked before every resource check", () => {
  const snapshot = { ...baseSnapshot({ measuredTokens: 999_999_999 }), traversals: { [RETRY_EDGE_ID]: 3 } };
  const result = preDispatch(snapshot, REFERENCE_LOOP, implement, 4, edge, DEFAULT_POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome.state, "MAX_ITERATIONS_EXCEEDED");
    if (result.outcome.state === "MAX_ITERATIONS_EXCEEDED") assert.equal(result.outcome.traversals, 3);
  }
});

test("preDispatch step 2: free traversals exhausted -> MAX_ITERATIONS_EXCEEDED (D-10)", () => {
  const snapshot = { ...baseSnapshot(), freeTraversals: { [RETRY_EDGE_ID]: 3 } };
  const result = preDispatch(snapshot, REFERENCE_LOOP, implement, 4, edge, DEFAULT_POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.outcome.state, "MAX_ITERATIONS_EXCEEDED");
});

test("preDispatch step 3: maxMeasuredTokens breach -> BUDGET_EXCEEDED(maxMeasuredTokens)", () => {
  const snapshot = baseSnapshot({ measuredTokens: REFERENCE_LOOP.budget.maxMeasuredTokens! });
  const result = preDispatch(snapshot, REFERENCE_LOOP, implement, 1, null, DEFAULT_POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome.state, "BUDGET_EXCEEDED");
    if (result.outcome.state === "BUDGET_EXCEEDED") assert.equal(result.outcome.budgetKey, "maxMeasuredTokens");
  }
});

test("preDispatch step 4: unmeasuredExecutions breach -> BUDGET_EXCEEDED(maxUnmeasuredExecutions); the boundary at 0/0 does NOT breach (Decision (not in sheet), m1 — see budget.ts)", () => {
  const atDefault = preDispatch(baseSnapshot({ unmeasuredExecutions: 0 }), REFERENCE_LOOP, implement, 1, null, DEFAULT_POLICY);
  assert.equal(atDefault.ok, true, "0 unmeasured against the default cap of 0 must not block the very first dispatch");

  const overDefault = preDispatch(baseSnapshot({ unmeasuredExecutions: 1 }), REFERENCE_LOOP, implement, 1, null, DEFAULT_POLICY);
  assert.equal(overDefault.ok, false);
  if (!overDefault.ok) {
    assert.equal(overDefault.outcome.state, "BUDGET_EXCEEDED");
    if (overDefault.outcome.state === "BUDGET_EXCEEDED") assert.equal(overDefault.outcome.budgetKey, "maxUnmeasuredExecutions");
  }
});

test("preDispatch step 5: maxRuntime breach -> EXPIRED(max_runtime), counts activeMs only", () => {
  const snapshot = baseSnapshot({ activeMs: REFERENCE_LOOP.budget.maxRuntimeMs });
  const result = preDispatch(snapshot, REFERENCE_LOOP, implement, 1, null, DEFAULT_POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome.state, "EXPIRED");
    if (result.outcome.state === "EXPIRED") assert.equal(result.outcome.expiryReason, "max_runtime");
  }
});

test("preDispatch step 6: maxStepsPerRun breach -> BUDGET_EXCEEDED(maxStepsPerRun)", () => {
  const snapshot = baseSnapshot({ stepsUsed: DEFAULT_POLICY.maxStepsPerRun });
  const result = preDispatch(snapshot, REFERENCE_LOOP, implement, 1, null, DEFAULT_POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome.state, "BUDGET_EXCEEDED");
    if (result.outcome.state === "BUDGET_EXCEEDED") assert.equal(result.outcome.budgetKey, "maxStepsPerRun");
  }
});

test("preDispatch I-20: fixed order — a Run that breaches both the iteration budget and a token budget at once reports MAX_ITERATIONS_EXCEEDED (loop-semantic before resource, D-19)", () => {
  const snapshot = { ...baseSnapshot({ measuredTokens: REFERENCE_LOOP.budget.maxMeasuredTokens! }), traversals: { [RETRY_EDGE_ID]: 3 } };
  const result = preDispatch(snapshot, REFERENCE_LOOP, implement, 4, edge, DEFAULT_POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.outcome.state, "MAX_ITERATIONS_EXCEEDED");
});

test("preDispatch I-20: a token breach is reported before a maxRuntime breach when both are true (token line is a harder statement than a wall clock)", () => {
  const snapshot = baseSnapshot({ measuredTokens: REFERENCE_LOOP.budget.maxMeasuredTokens!, activeMs: REFERENCE_LOOP.budget.maxRuntimeMs });
  const result = preDispatch(snapshot, REFERENCE_LOOP, implement, 1, null, DEFAULT_POLICY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome.state, "BUDGET_EXCEEDED");
    if (result.outcome.state === "BUDGET_EXCEEDED") assert.equal(result.outcome.budgetKey, "maxMeasuredTokens");
  }
});

// -----------------------------------------------------------------------------------------
// Clock (D-04)
// -----------------------------------------------------------------------------------------

test("clockBucketFor: PENDING/RUNNING/WAITING_OBSERVED accrue active; WAITING_HUMAN/WAITING_FOR_QUOTA/INTERRUPTED accrue wait; terminal accrues nothing", () => {
  assert.equal(clockBucketFor("PENDING"), "active");
  assert.equal(clockBucketFor("RUNNING"), "active");
  assert.equal(clockBucketFor("WAITING_OBSERVED"), "active");
  assert.equal(clockBucketFor("WAITING_HUMAN"), "wait");
  assert.equal(clockBucketFor("WAITING_FOR_QUOTA"), "wait");
  assert.equal(clockBucketFor("INTERRUPTED"), "wait");
  assert.equal(clockBucketFor("SUCCEEDED"), "none");
  assert.equal(clockBucketFor("FAILED"), "none");
});

test("accrueClock: adds the elapsed span to activeMs while RUNNING", () => {
  const snapshot = baseSnapshot();
  const result = accrueClock(snapshot, "2026-09-06T06:05:00Z");
  assert.equal(result.activeMs, 5 * 60 * 1000);
  assert.equal(result.waitMs, 0);
});

test("accrueClock: adds the elapsed span to waitMs while WAITING_FOR_QUOTA", () => {
  const snapshot = { ...baseSnapshot(), status: "WAITING_FOR_QUOTA" as const };
  const result = accrueClock(snapshot, "2026-09-06T09:00:00Z");
  assert.equal(result.waitMs, 3 * 60 * 60 * 1000);
  assert.equal(result.activeMs, 0);
});

test("accrueClock: never goes negative even if now < updatedAt", () => {
  const snapshot = baseSnapshot();
  const result = accrueClock(snapshot, "2026-09-06T05:00:00Z");
  assert.equal(result.activeMs, 0);
});
