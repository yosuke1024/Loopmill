import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnvelope } from "../../src/envelope/build.ts";
import { ENVELOPE_SCHEMA_VERSION } from "../../src/envelope/schema.ts";
import { isLoopmillError } from "../../src/util/errors.ts";
import { isUlid, ulidTimeMs } from "../../src/util/ulid.ts";
import { parseRfc3339 } from "../../src/util/time.ts";

const CLOCK = { now: "2026-09-06T09:00:04.180Z" };

function baseInput() {
  return {
    eventType: "run-started" as const,
    producer: "control-plane" as const,
    loopId: "article-review",
    loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
  };
}

test("makeEnvelope: fills schemaVersion, occurredAt and eventId", () => {
  const envelope = makeEnvelope(baseInput(), CLOCK);
  assert.equal(envelope.schemaVersion, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.occurredAt, CLOCK.now);
  assert.ok(isUlid(envelope.eventId));
});

test("makeEnvelope: eventId's ULID time component matches parseRfc3339(occurredAt)", () => {
  const envelope = makeEnvelope(baseInput(), CLOCK);
  assert.equal(ulidTimeMs(envelope.eventId), parseRfc3339(envelope.occurredAt));
});

test("makeEnvelope: caller-supplied eventId and occurredAt are respected", () => {
  const eventId = "06G7BWHED0C8C08FM4XZKEWYJW";
  const occurredAt = "2026-09-06T08:00:00.000Z";
  const envelope = makeEnvelope({ ...baseInput(), eventId, occurredAt }, CLOCK);
  assert.equal(envelope.eventId, eventId);
  assert.equal(envelope.occurredAt, occurredAt);
});

test("makeEnvelope: returns a schema- and producer-valid envelope (does not throw)", () => {
  assert.doesNotThrow(() => makeEnvelope(baseInput(), CLOCK));
});

test("makeEnvelope: throws LoopmillError envelope_invalid (exitCode 2) on a producer-policy violation", () => {
  const input = { ...baseInput(), producer: "trigger" as const }; // disallowed for run-started
  assert.throws(
    () => makeEnvelope(input, CLOCK),
    (err: unknown) => {
      assert.ok(isLoopmillError(err));
      assert.equal(err.code, "envelope_invalid");
      assert.equal(err.exitCode, 2);
      return true;
    },
  );
});

test("makeEnvelope: throws LoopmillError envelope_invalid on a schema violation (missing node coordinates)", () => {
  const input = {
    eventType: "node-completed" as const,
    producer: "backend:local" as const,
    loopId: "article-review",
    loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
    // cycle/nodeId/attempt missing, and no result — both required for node-completed.
  };
  assert.throws(
    () => makeEnvelope(input, CLOCK),
    (err: unknown) => {
      assert.ok(isLoopmillError(err));
      assert.equal(err.code, "envelope_invalid");
      assert.equal(err.exitCode, 2);
      return true;
    },
  );
});

test("makeEnvelope: two calls without an explicit eventId produce different ids", () => {
  const a = makeEnvelope(baseInput(), CLOCK);
  const b = makeEnvelope(baseInput(), CLOCK);
  assert.notEqual(a.eventId, b.eventId);
});
