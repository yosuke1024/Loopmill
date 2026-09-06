import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEnvelope } from "../../src/envelope/validate.ts";
import type { Envelope } from "../../src/types/envelope.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(HERE, "..", "..", "docs", "spec", "envelope-examples");
const SCHEMA_PATH = join(HERE, "..", "..", "docs", "spec", "envelope.schema.json");

function readExample(file: string): unknown {
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, file), "utf8"));
}

// ---------------------------------------------------------------------------------------------
// TV-1: every example validates; 19 checked, 17/17 event types covered.
// ---------------------------------------------------------------------------------------------

test("TV-1: every file in envelope-examples/ validates as expected", () => {
  const files = readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  assert.equal(files.length, 19, "envelope-examples/ should hold 19 files (17 valid + 2 invalid)");

  const coveredTypes = new Set<string>();
  let checked = 0;

  for (const file of files) {
    const value = readExample(file);
    const shouldFail = file.startsWith("invalid-");
    const result = validateEnvelope(value);

    if (shouldFail) {
      assert.equal(result.ok, false, `${file} should fail validation`);
    } else {
      assert.equal(result.ok, true, `${file} should pass validation`);
      if (result.ok) {
        coveredTypes.add(result.envelope.eventType);
      }
    }
    checked += 1;
  }

  assert.equal(checked, 19);

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as { $defs: { eventType: { enum: string[] } } };
  const allTypes = schema.$defs.eventType.enum;
  assert.equal(allTypes.length, 17);
  for (const t of allTypes) {
    assert.ok(coveredTypes.has(t), `no valid example covers eventType ${t}`);
  }
  assert.equal(coveredTypes.size, 17);
});

test("TV-1: invalid-node-completed-missing-attempt.json fails at the path the spec names", () => {
  const result = validateEnvelope(readExample("invalid-node-completed-missing-attempt.json"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.rule, "schema");
  assert.equal(result.errors[0]?.path, "/");
  assert.match(result.errors[0]?.message ?? "", /must have required property 'attempt'/);
});

test("TV-1: invalid-secret-in-summary.json fails on result/summary, the credential-shape backstop", () => {
  const result = validateEnvelope(readExample("invalid-secret-in-summary.json"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.rule, "schema");
  assert.equal(result.errors[0]?.path, "/result/summary");
  assert.match(result.errors[0]?.message ?? "", /must NOT be valid/);
});

// ---------------------------------------------------------------------------------------------
// TV-5: the credential backstop must not fire on ordinary prose.
// docs/spec/envelope.md §13 TV-5.
// ---------------------------------------------------------------------------------------------

const TV5_TABLE: Array<{ summary: string; accepted: boolean }> = [
  { summary: "a risk-averse approach to tokens", accepted: true },
  { summary: "the task-12345678901234567890 finished", accepted: true },
  { summary: "briskly-1234567890123456789012", accepted: true },
  { summary: "sk-ant-EXAMPLENOTAREALKEY000000000000", accepted: false },
  { summary: "CLAUDE_CODE_OAUTH_TOKEN=oat01_EXAMPLEEXAMPLE", accepted: false },
  { summary: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", accepted: false },
];

test("TV-5: the credential backstop table, via validateEnvelope on an otherwise valid node-completed", () => {
  const base = readExample("node-completed.json") as Envelope;
  for (const { summary, accepted } of TV5_TABLE) {
    const envelope: Envelope = {
      ...base,
      result: { ...base.result, status: "succeeded", summary },
    };
    const result = validateEnvelope(envelope);
    assert.equal(result.ok, accepted, `summary ${JSON.stringify(summary)} expected ok=${accepted}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Producer policy, end to end through validateEnvelope (state-machine.md §3.1-§3.2).
// ---------------------------------------------------------------------------------------------

/** One disallowed producer per event type, chosen to be schema-shape-valid but outside the
 * eventType's allowlist. */
const DISALLOWED_PRODUCER: Record<string, string> = {
  "run-requested": "human",
  "run-started": "trigger",
  "node-dispatched": "backend:local",
  "node-started": "control-plane",
  "node-completed": "human",
  "node-failed": "trigger",
  "node-timed-out": "human",
  "node-observed": "backend:local", // backend:* is not enough here; only backend:observed is allowed
  "human-requested": "human",
  "human-decided": "control-plane",
  "quota-parked": "backend:local",
  "retry-edge-taken": "human",
  "run-finished": "trigger",
  "ignored-stale": "human",
  "dispatch-failed": "backend:github-actions",
  "resumed": "trigger",
  "lease-expired": "backend:local",
};

test("producer policy: the example's own (allowed) producer validates", () => {
  const files = readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("invalid-"))
    .sort();
  for (const file of files) {
    const result = validateEnvelope(readExample(file));
    assert.equal(result.ok, true, `${file} should validate with its own producer`);
  }
});

test("producer policy: one disallowed producer per event type is rejected with rule 'producer'", () => {
  const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("invalid-"));
  let asserted = 0;

  for (const file of files) {
    const value = readExample(file) as Envelope;
    const disallowed = DISALLOWED_PRODUCER[value.eventType];
    assert.ok(disallowed, `no disallowed-producer fixture for eventType ${value.eventType}`);

    const mutated: Envelope = { ...value, producer: disallowed as Envelope["producer"] };
    const result = validateEnvelope(mutated);
    assert.equal(result.ok, false, `${file} with producer ${disallowed} should be rejected`);
    if (!result.ok) {
      assert.equal(result.errors[0]?.rule, "producer");
    }
    asserted += 1;
  }

  assert.equal(asserted, 17, "expected one disallowed-producer assertion per event type");
});

test("producer policy: enforceProducer: false skips the producer check", () => {
  const value = readExample("run-started.json") as Envelope;
  const mutated: Envelope = { ...value, producer: "trigger" }; // disallowed for run-started
  const rejected = validateEnvelope(mutated);
  assert.equal(rejected.ok, false);

  const skipped = validateEnvelope(mutated, { enforceProducer: false });
  assert.equal(skipped.ok, true);
});
