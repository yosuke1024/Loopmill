import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMITTED_EVENT_TYPES,
  INBOUND_EVENT_TYPES,
  PRODUCER_POLICY,
  producerAllowed,
} from "../../src/envelope/policy.ts";
import type { EventType } from "../../src/types/envelope.ts";

const ALL_EVENT_TYPES: EventType[] = [
  "run-requested",
  "run-started",
  "node-dispatched",
  "node-started",
  "node-completed",
  "node-failed",
  "node-timed-out",
  "node-observed",
  "human-requested",
  "human-decided",
  "quota-parked",
  "retry-edge-taken",
  "run-finished",
  "ignored-stale",
  "dispatch-failed",
  "resumed",
  "lease-expired",
];

test("PRODUCER_POLICY covers all 17 event types", () => {
  assert.deepEqual(Object.keys(PRODUCER_POLICY).sort(), [...ALL_EVENT_TYPES].sort());
});

test("producerAllowed: every allowed pair is accepted", () => {
  for (const eventType of ALL_EVENT_TYPES) {
    for (const rule of PRODUCER_POLICY[eventType]) {
      if (rule === "backend:*") {
        assert.ok(producerAllowed(eventType, "backend:local"));
        assert.ok(producerAllowed(eventType, "backend:fake"));
        assert.ok(producerAllowed(eventType, "backend:github-actions"));
      } else {
        assert.ok(producerAllowed(eventType, rule), `${eventType} should allow ${rule}`);
      }
    }
  }
});

test("producerAllowed: a backend can never emit a control-flow event", () => {
  for (const eventType of ["node-dispatched", "retry-edge-taken", "run-finished", "quota-parked", "ignored-stale"] as const) {
    assert.equal(producerAllowed(eventType, "backend:local"), false);
    assert.equal(producerAllowed(eventType, "backend:fake"), false);
  }
});

test("producerAllowed: human can emit only human-decided and resumed", () => {
  for (const eventType of ALL_EVENT_TYPES) {
    const expected = eventType === "human-decided" || eventType === "resumed";
    assert.equal(producerAllowed(eventType, "human"), expected, `human -> ${eventType}`);
  }
});

test("producerAllowed: node-observed allows only the literal backend:observed producer", () => {
  assert.ok(producerAllowed("node-observed", "backend:observed"));
  assert.equal(producerAllowed("node-observed", "backend:local"), false);
  assert.equal(producerAllowed("node-observed", "backend:fake"), false);
  assert.equal(producerAllowed("node-observed", "control-plane"), false);
});

test("INBOUND_EVENT_TYPES and EMITTED_EVENT_TYPES: §3.3 partitions", () => {
  assert.deepEqual(
    [...INBOUND_EVENT_TYPES].sort(),
    [
      "human-decided",
      "lease-expired",
      "node-completed",
      "node-failed",
      "node-observed",
      "node-started",
      "node-timed-out",
      "resumed",
      "run-requested",
    ].sort(),
  );
  assert.deepEqual(
    [...EMITTED_EVENT_TYPES].sort(),
    [
      "dispatch-failed",
      "human-requested",
      "ignored-stale",
      "quota-parked",
      "retry-edge-taken",
      "run-finished",
      "run-started",
      "node-dispatched",
    ].sort(),
  );
});
