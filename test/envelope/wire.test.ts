import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSize, extractFencedEnvelopes, fromWire, toWire, wireSize } from "../../src/envelope/wire.ts";
import type { Envelope } from "../../src/types/envelope.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(HERE, "..", "..", "docs", "spec", "envelope-examples");

function readExample(file: string): Envelope {
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, file), "utf8")) as Envelope;
}

// ---------------------------------------------------------------------------------------------
// toWire / fromWire
// ---------------------------------------------------------------------------------------------

test("toWire: schemaVersion is the first key", () => {
  const envelope = readExample("run-started.json");
  const wire = toWire(envelope);
  const firstKeyMatch = /^\{\n\s*"([^"]+)"/.exec(wire);
  assert.equal(firstKeyMatch?.[1], "schemaVersion");
});

test("toWire: every other key is in recursive sorted (canonical) order", () => {
  const envelope = readExample("node-completed.json");
  const wire = toWire(envelope);
  const topLevelKeyLines = wire
    .split("\n")
    .filter((line) => /^  "[^"]+":/.test(line))
    .map((line) => /^  "([^"]+)":/.exec(line)?.[1]);
  const rest = topLevelKeyLines.slice(1); // after schemaVersion
  assert.deepEqual(rest, [...rest].sort());

  // Nested objects are sorted too: the `result` object's keys.
  const resultStart = wire.indexOf('"result": {');
  const resultBlock = wire.slice(resultStart, wire.indexOf("\n  },", resultStart));
  const nestedKeys = [...resultBlock.matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]);
  assert.deepEqual(nestedKeys, [...nestedKeys].sort());
});

test("toWire: 2-space indent, trailing newline, stable across repeated calls", () => {
  const envelope = readExample("run-requested.json");
  const a = toWire(envelope);
  const b = toWire(envelope);
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
  assert.ok(!a.endsWith("\n\n"));
  assert.match(a, /^\{\n  "schemaVersion": "1\.0\.0",\n/);
});

test("fromWire(toWire(e)) deep-equals e", () => {
  for (const file of ["run-requested.json", "node-completed.json", "run-finished.json", "human-decided.json"]) {
    const envelope = readExample(file);
    const roundTripped = fromWire(toWire(envelope));
    assert.deepEqual(roundTripped, envelope);
  }
});

test("fromWire: JSON parse only, no schema check (garbage in, garbage out)", () => {
  assert.deepEqual(fromWire('{"a":1}'), { a: 1 });
  assert.throws(() => fromWire("not json"));
});

// ---------------------------------------------------------------------------------------------
// TV-3: size accounting. docs/spec/envelope.md §13: node-completed.json, the largest example,
// is 1,739 B pretty-printed / 1,943 B escaped.
// ---------------------------------------------------------------------------------------------

test("TV-3: wireSize of the largest example (node-completed.json) is 1739 B / 1943 B escaped", () => {
  const envelope = readExample("node-completed.json");
  const size = wireSize(envelope);
  assert.equal(size.bytes, 1739);
  assert.equal(size.escapedBytes, 1943);
});

test("checkSize: 32 KiB budget, ok true for every example", () => {
  for (const file of ["run-requested.json", "node-completed.json", "run-finished.json"]) {
    const check = checkSize(readExample(file));
    assert.equal(check.limit, 32 * 1024);
    assert.equal(check.ok, true);
    assert.ok(check.bytes < check.limit);
  }
});

test("checkSize: ok is false once the wire form exceeds the 32 KiB budget", () => {
  const base = readExample("node-completed.json");
  const oversized: Envelope = {
    ...base,
    result: { ...base.result, status: "succeeded", summary: "x".repeat(33 * 1024) },
  };
  // The oversized summary alone trips the schema's 4000-char summaryText cap well before 32 KiB,
  // but checkSize/wireSize operate on the wire text regardless of schema legality (size
  // accounting must work even for a not-yet-validated draft envelope).
  const check = checkSize(oversized);
  assert.equal(check.ok, false);
  assert.ok(check.bytes > check.limit);
});

// ---------------------------------------------------------------------------------------------
// TV-6: fenced `loopmill` block extraction (envelope.md §7.3).
// ---------------------------------------------------------------------------------------------

const TV6_BODY = [
  "Thanks, here is the review result.",
  "",
  "```loopmill",
  '{"schemaVersion":"1.0.0","eventId":"06G7BWJ5V056N94SSK77T05TRH","eventType":"node-observed"}',
  "```",
  "",
  "(ignore the block below, it is a quote)",
  "",
  "```loopmill",
  '{"schemaVersion":"1.0.0","eventId":"06G7BWKMQ0WWH4E7Y7J3XGD41A","eventType":"node-completed"}',
  "```",
].join("\n");

test("TV-6: yields exactly the first object, ignores prose and the second block entirely", () => {
  const found = extractFencedEnvelopes(TV6_BODY);
  assert.equal(found.length, 1);
  assert.equal((found[0] as { eventId: string }).eventId, "06G7BWJ5V056N94SSK77T05TRH");
});

test("TV-6: an indented opening fence yields no envelope", () => {
  const body = ["hello", " ```loopmill", '{"schemaVersion":"1.0.0"}', "```"].join("\n");
  assert.deepEqual(extractFencedEnvelopes(body), []);
});

test("TV-6: trailing text after 'loopmill' on the fence line yields no envelope", () => {
  const body = ["```loopmill json", '{"schemaVersion":"1.0.0"}', "```"].join("\n");
  assert.deepEqual(extractFencedEnvelopes(body), []);
});

test("TV-6: wrong case ('LOOPMILL') yields no envelope", () => {
  const body = ["```LOOPMILL", '{"schemaVersion":"1.0.0"}', "```"].join("\n");
  assert.deepEqual(extractFencedEnvelopes(body), []);
});

test("TV-6: an unterminated fence yields no envelope", () => {
  const body = ["```loopmill", '{"schemaVersion":"1.0.0","eventType":"resumed"}', "no closing fence here"].join("\n");
  assert.deepEqual(extractFencedEnvelopes(body), []);
});

test("TV-6: non-JSON contents yield no envelope (parse failure is never a best-effort repair)", () => {
  const body = ["```loopmill", "{not valid json,,,}", "```"].join("\n");
  assert.deepEqual(extractFencedEnvelopes(body), []);
});

test("TV-6: a comment with no loopmill fence yields no envelope", () => {
  assert.deepEqual(extractFencedEnvelopes("just some prose\n```json\n{}\n```"), []);
});

test("TV-6: a payload that is not a JSON object (array, scalar) yields no envelope", () => {
  assert.deepEqual(extractFencedEnvelopes(["```loopmill", "[1,2,3]", "```"].join("\n")), []);
  assert.deepEqual(extractFencedEnvelopes(["```loopmill", "42", "```"].join("\n")), []);
});

test("TV-6: trailing whitespace on the fence lines is tolerated", () => {
  const body = ["```loopmill  ", '{"schemaVersion":"1.0.0"}', "```\t"].join("\n");
  const found = extractFencedEnvelopes(body);
  assert.equal(found.length, 1);
});
