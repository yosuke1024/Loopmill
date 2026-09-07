import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeToPayload, payloadToOutcome } from "../../src/envelope/outcome.ts";
import { validateEnvelope } from "../../src/envelope/validate.ts";
import { makeEnvelope } from "../../src/envelope/build.ts";
import { isLoopmillError } from "../../src/util/errors.ts";
import type { Outcome } from "../../src/types/state.ts";
import type { Envelope, OutcomePayload } from "../../src/types/envelope.ts";

const CLOCK = { now: "2026-09-06T11:39:10.884Z" };

const OUTCOME_VARIANTS: Outcome[] = [
  { state: "SUCCEEDED", label: "shipped" },
  { state: "FAILED", failureReason: "node_failed" },
  { state: "FAILED", failureReason: "attempts_exhausted", nodeId: "test", cycleIndex: 2 },
  { state: "CANCELLED", by: "human" },
  { state: "CANCELLED", by: "timeout-escalation", actor: "loopmill-sweep" },
  { state: "MAX_ITERATIONS_EXCEEDED", edgeId: "retry-implement", traversals: 3, maxIterations: 3 },
  { state: "BUDGET_EXCEEDED", budgetKey: "maxMeasuredTokens", limit: 1_000_000, observed: 1_000_042 },
  { state: "EXPIRED", expiryReason: "max_runtime" },
  { state: "EXPIRED", expiryReason: "human_timeout", nodeId: "approve-merge" },
  { state: "SKIPPED", skipReason: "dedupe" },
  { state: "SKIPPED", skipReason: "min_interval", ref: "article-review:2026-09-06" },
];

test("outcomeToPayload / payloadToOutcome: round trip for every Outcome variant", () => {
  for (const outcome of OUTCOME_VARIANTS) {
    const payload = outcomeToPayload(outcome);
    assert.equal(payload.state, outcome.state);
    const roundTripped = payloadToOutcome(payload);
    assert.deepEqual(roundTripped, outcome, `round trip failed for ${JSON.stringify(outcome)}`);
  }
});

test("outcomeToPayload: SUCCEEDED maps label -> endLabel", () => {
  const payload = outcomeToPayload({ state: "SUCCEEDED", label: "shipped" });
  assert.deepEqual(payload, { state: "SUCCEEDED", endLabel: "shipped" });
});

test("payloadToOutcome: throws envelope_invalid when a required per-state field is missing", () => {
  const cases: OutcomePayload[] = [
    { state: "SUCCEEDED" }, // missing endLabel
    { state: "FAILED" }, // missing failureReason
    { state: "CANCELLED" }, // missing by
    { state: "MAX_ITERATIONS_EXCEEDED", edgeId: "e", traversals: 1 }, // missing maxIterations
    { state: "BUDGET_EXCEEDED", budgetKey: "maxStepsPerRun", limit: 200 }, // missing observed
    { state: "EXPIRED" }, // missing expiryReason
    { state: "SKIPPED" }, // missing skipReason
  ];
  for (const payload of cases) {
    assert.throws(
      () => payloadToOutcome(payload),
      (err: unknown) => {
        assert.ok(isLoopmillError(err));
        assert.equal(err.code, "envelope_invalid");
        assert.equal(err.exitCode, 2);
        return true;
      },
      `expected payloadToOutcome to throw for ${JSON.stringify(payload)}`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Schema-validated run-finished envelope for each Outcome variant (exercises Part A: the
// envelope.schema.json 1.0.0 -> 1.1.0 amendment to $defs.outcome).
// ---------------------------------------------------------------------------------------------

function runFinishedInput(outcome: Outcome) {
  return {
    eventType: "run-finished" as const,
    producer: "control-plane" as const,
    loopId: "article-review",
    loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
    outcome: outcomeToPayload(outcome),
  };
}

test("Part A: every Outcome variant builds a schema-valid run-finished envelope", () => {
  for (const outcome of OUTCOME_VARIANTS) {
    const envelope = makeEnvelope(runFinishedInput(outcome), CLOCK);
    const result = validateEnvelope(envelope);
    assert.equal(result.ok, true, `run-finished(${outcome.state}) should validate: ${JSON.stringify(result)}`);
  }
});

test("Part A: the schema rejects a run-finished missing the per-state amendment fields", () => {
  const badPayloads: OutcomePayload[] = [
    { state: "CANCELLED" }, // missing by
    { state: "MAX_ITERATIONS_EXCEEDED" }, // missing edgeId/traversals/maxIterations
    { state: "BUDGET_EXCEEDED" }, // missing budgetKey/limit/observed
    { state: "EXPIRED" }, // missing expiryReason
    { state: "SKIPPED" }, // missing skipReason
  ];
  for (const outcome of badPayloads) {
    const envelope: Envelope = {
      schemaVersion: "1.1.0",
      eventId: "06G7BWJSC0DDWBXFK4NQMK08BF",
      eventType: "run-finished",
      occurredAt: CLOCK.now,
      producer: "control-plane",
      loopId: "article-review",
      loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
      runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
      outcome,
    };
    const result = validateEnvelope(envelope);
    assert.equal(result.ok, false, `expected schema rejection for ${JSON.stringify(outcome)}`);
  }
});

test("Part A: a schema-1.0.0-shaped run-finished (no amendment fields) is still valid 1.1.0", () => {
  const envelope: Envelope = {
    schemaVersion: "1.0.0",
    eventId: "06G7BWJSC0DDWBXFK4NQMK08BF",
    eventType: "run-finished",
    occurredAt: CLOCK.now,
    producer: "control-plane",
    loopId: "article-review",
    loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
    outcome: { state: "SUCCEEDED", endLabel: "shipped", cycles: 2, summary: "done" },
  };
  const result = validateEnvelope(envelope);
  assert.equal(result.ok, true);
});
