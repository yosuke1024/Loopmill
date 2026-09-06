import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ENVELOPE_SCHEMA_PATH, ENVELOPE_SCHEMA_VERSION, getEnvelopeValidator } from "../../src/envelope/schema.ts";

test("ENVELOPE_SCHEMA_PATH resolves to the real docs/spec/envelope.schema.json", () => {
  assert.ok(existsSync(ENVELOPE_SCHEMA_PATH));
  assert.ok(ENVELOPE_SCHEMA_PATH.endsWith("docs/spec/envelope.schema.json"));
  const schema = JSON.parse(readFileSync(ENVELOPE_SCHEMA_PATH, "utf8")) as { $id: string };
  assert.ok(schema.$id.length > 0);
});

test("ENVELOPE_SCHEMA_VERSION is 1.1.0", () => {
  assert.equal(ENVELOPE_SCHEMA_VERSION, "1.1.0");
});

test("getEnvelopeValidator: compiles and is memoised (same instance on repeat calls)", () => {
  const a = getEnvelopeValidator();
  const b = getEnvelopeValidator();
  assert.equal(a, b);
  assert.equal(typeof a, "function");
});

test("getEnvelopeValidator: schemaVersion accepts both 1.0.0 and 1.1.0", () => {
  const validate = getEnvelopeValidator();
  const base = {
    schemaVersion: "1.0.0",
    eventId: "06G7BWHED0C8C08FM4XZKEWYJW",
    eventType: "run-started",
    occurredAt: "2026-09-06T09:00:04.180Z",
    producer: "control-plane",
    loopId: "article-review",
    loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
  };
  assert.equal(validate({ ...base, schemaVersion: "1.0.0" }), true);
  assert.equal(validate({ ...base, schemaVersion: "1.1.0" }), true);
  assert.equal(validate({ ...base, schemaVersion: "2.0.0" }), true, "the semver pattern itself does not gate majors");
  assert.equal(validate({ ...base, schemaVersion: "1.0" }), false, "must be a full x.y.z semver");
});
