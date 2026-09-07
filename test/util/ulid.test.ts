import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deterministicEventId,
  isRunId,
  isUlid,
  newRunId,
  randomUlid,
  ulidFromParts,
  ulidTimeMs,
} from "../../src/util/ulid.ts";
import { parseRfc3339 } from "../../src/util/time.ts";
import type { DeterministicEventIdParts } from "../../src/util/ulid.ts";

const CROCKFORD_ALPHABET_RE = /^[0-9A-HJKMNP-TV-Z]+$/;

test("randomUlid: 26 characters, Crockford base32 alphabet (no I, L, O, U)", () => {
  const id = randomUlid();
  assert.equal(id.length, 26);
  assert.match(id, CROCKFORD_ALPHABET_RE);
  assert.ok(!/[ILOU]/.test(id));
  assert.ok(isUlid(id));
});

test("randomUlid: two calls produce different entropy", () => {
  const a = randomUlid(1_700_000_000_000);
  const b = randomUlid(1_700_000_000_000);
  assert.notEqual(a, b);
  // Same time component, since both were generated for the same timeMs.
  assert.equal(a.slice(0, 10), b.slice(0, 10));
});

test("ulidFromParts / ulidTimeMs: time round-trips exactly", () => {
  const timeMs = 1_788_685_451_000; // 2026-09-06T09:04:11.000Z
  const entropy = new Uint8Array(10).fill(0xab);
  const id = ulidFromParts(timeMs, entropy);
  assert.equal(id.length, 26);
  assert.equal(ulidTimeMs(id), timeMs);
});

test("ulidFromParts: rejects entropy that is not exactly 10 bytes", () => {
  assert.throws(() => ulidFromParts(0, new Uint8Array(9)));
  assert.throws(() => ulidFromParts(0, new Uint8Array(11)));
});

test("ulidFromParts: rejects an out-of-range or non-integer time", () => {
  assert.throws(() => ulidFromParts(-1, new Uint8Array(10)));
  assert.throws(() => ulidFromParts(1.5, new Uint8Array(10)));
  assert.throws(() => ulidFromParts(2 ** 48, new Uint8Array(10)));
});

test("isUlid: rejects wrong length and non-alphabet characters", () => {
  assert.equal(isUlid("too-short"), false);
  assert.equal(isUlid("0".repeat(26)), true);
  assert.equal(isUlid("I".repeat(26)), false); // I is excluded from Crockford base32
  assert.equal(isUlid("L".repeat(26)), false);
  assert.equal(isUlid("O".repeat(26)), false);
  assert.equal(isUlid("U".repeat(26)), false);
});

test("newRunId: run_ prefix followed by a valid ULID", () => {
  const id = newRunId(1_700_000_000_000);
  assert.ok(id.startsWith("run_"));
  assert.ok(isUlid(id.slice(4)));
  assert.ok(isRunId(id));
});

function baseParts(): DeterministicEventIdParts {
  return {
    nowRfc3339: "2026-09-06T09:41:12.740Z",
    runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
    eventType: "node-completed",
    cycle: 1,
    nodeId: "implement",
    attempt: 1,
    emitIndex: 0,
    causationEventId: "06G7BWHJA04BZ0ZGMKCKH6JRW7",
  };
}

test("deterministicEventId: pure — identical inputs give identical ids", () => {
  const a = deterministicEventId(baseParts());
  const b = deterministicEventId(baseParts());
  assert.equal(a, b);
  assert.ok(isUlid(a));
});

test("deterministicEventId: the ULID time component equals parseRfc3339(nowRfc3339)", () => {
  const parts = baseParts();
  const id = deterministicEventId(parts);
  assert.equal(ulidTimeMs(id), parseRfc3339(parts.nowRfc3339));
});

test("deterministicEventId: changing any single field changes the id", () => {
  const base = deterministicEventId(baseParts());

  const variants: Array<Partial<DeterministicEventIdParts>> = [
    { runId: "run_00000000000000000000000000" },
    { eventType: "node-failed" },
    { cycle: 2 },
    { cycle: null },
    { nodeId: "other-node" },
    { nodeId: null },
    { attempt: 2 },
    { attempt: null },
    { emitIndex: 1 },
    { causationEventId: "06G7BWHJA04BZ0ZGMKCKH6JRW8" },
    { causationEventId: null },
  ];

  for (const variant of variants) {
    const id = deterministicEventId({ ...baseParts(), ...variant });
    assert.notEqual(id, base, `expected a different id for variant ${JSON.stringify(variant)}`);
  }
});

test("deterministicEventId: null and 0 remain distinguishable for numeric fields", () => {
  const withNullCycle = deterministicEventId({ ...baseParts(), cycle: null });
  const withZeroCycle = deterministicEventId({ ...baseParts(), cycle: 0 });
  assert.notEqual(withNullCycle, withZeroCycle);
});

test("deterministicEventId: throws on a non-RFC-3339 `now`", () => {
  assert.throws(() => deterministicEventId({ ...baseParts(), nowRfc3339: "not-a-date" }));
});
