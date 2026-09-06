// record.ts: unavailableRecord, assertRecordShape (I1, I2, I4) and isMeasured (§4.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { unavailableRecord, assertRecordShape, isMeasured } from "../../src/usage/record.ts";
import { isLoopmillError } from "../../src/util/errors.ts";
import type { UsageRecord } from "../../src/types/usage.ts";

test("unavailableRecord: builds the full §1.4 unavailable shape", () => {
  const record = unavailableRecord({
    runtime: "codex",
    runtimeVersion: "0.153.4",
    eventKind: "turn.failed",
    note: "turn.failed with no preceding turn.completed",
  });
  assert.equal(record.provenance, "unavailable");
  assert.equal(record.complete, false);
  assert.equal(record.usageBasis, "none");
  for (const field of ["freshInputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "totalInputTokens", "totalTokens", "reasoningTokens", "listPriceEquivalentUsd"] as const) {
    assert.equal(record[field], null, `${field} must be null`);
  }
  assert.equal(record.sessionRef, null);
  assert.equal(record.model, null);
});

test("unavailableRecord: passes through optional identity fields when given", () => {
  const record = unavailableRecord({
    runtime: "claude-code",
    runtimeVersion: null,
    eventKind: null,
    note: "killed",
    model: "claude-sonnet-5",
    sessionRef: { kind: "claude-session", id: "sess-1" },
    usageAtAttemptStart: { input_tokens: 0 },
  });
  assert.equal(record.model, "claude-sonnet-5");
  assert.deepEqual(record.sessionRef, { kind: "claude-session", id: "sess-1" });
  assert.deepEqual(record.usageAtAttemptStart, { input_tokens: 0 });
});

test("isMeasured: reported+complete is measured; reported+incomplete is not; unavailable is not", () => {
  const base: UsageRecord = {
    runtime: "claude-code",
    model: null,
    freshInputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 1,
    reasoningTokens: null,
    totalInputTokens: 1,
    totalTokens: 2,
    provenance: "reported",
    provenanceNote: "x",
    source: { runtimeVersion: null, eventKind: "result" },
    complete: true,
    usageBasis: "result.usage",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
  assert.equal(isMeasured(base), true);
  assert.equal(isMeasured({ ...base, complete: false }), false);
  assert.equal(isMeasured({ ...base, provenance: "estimated" }), false);
  assert.equal(isMeasured(unavailableRecord({ runtime: "codex", runtimeVersion: null, eventKind: null, note: "x" })), false);
});

test("assertRecordShape (I4): throws when an unavailable record stores a 0 instead of null", () => {
  const broken = unavailableRecord({ runtime: "codex", runtimeVersion: null, eventKind: null, note: "x" });
  const corrupted: UsageRecord = { ...broken, totalTokens: 0 };
  assert.throws(() => assertRecordShape(corrupted), (err: unknown) => {
    if (!isLoopmillError(err)) return false;
    assert.equal(err.code, "usage_invariant_violation");
    return true;
  });
});

test("assertRecordShape (I2): throws on a negative bucket", () => {
  const record: UsageRecord = {
    runtime: "codex",
    model: null,
    freshInputTokens: -1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    totalInputTokens: -1,
    totalTokens: -1,
    provenance: "derived",
    provenanceNote: "x",
    source: { runtimeVersion: null, eventKind: "turn.completed" },
    complete: true,
    usageBasis: "turn.completed",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
  assert.throws(() => assertRecordShape(record));
});

test("assertRecordShape (I1): throws when totals do not recompute from the buckets", () => {
  const record: UsageRecord = {
    runtime: "claude-code",
    model: null,
    freshInputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 5,
    reasoningTokens: null,
    totalInputTokens: 999, // wrong: should be 10
    totalTokens: 1004,
    provenance: "reported",
    provenanceNote: "x",
    source: { runtimeVersion: null, eventKind: "result" },
    complete: true,
    usageBasis: "result.usage",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
  assert.throws(() => assertRecordShape(record));
});

test("assertRecordShape: throws on an empty provenanceNote", () => {
  const record = unavailableRecord({ runtime: "codex", runtimeVersion: null, eventKind: null, note: "" });
  assert.throws(() => assertRecordShape(record));
});

test("assertRecordShape: a well-formed record of any provenance passes", () => {
  assert.doesNotThrow(() =>
    assertRecordShape(
      unavailableRecord({ runtime: "codex", runtimeVersion: null, eventKind: "turn.failed", note: "no turn.completed" }),
    ),
  );
});
