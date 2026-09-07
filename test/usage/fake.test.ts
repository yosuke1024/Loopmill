// docs/spec/usage-normalization.md §2.4: the `fake` backend's usage path. `estimated` reaches
// production only through this module; it validates the fixture's record and re-labels its
// `usageBasis`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { usageFromFixture } from "../../src/usage/fake.ts";
import type { UsageRecord } from "../../src/types/usage.ts";

function estimatedFixtureRecord(): UsageRecord {
  return {
    runtime: "claude-code",
    model: "claude-sonnet-5",
    freshInputTokens: 100,
    cacheWriteTokens: 10,
    cacheReadTokens: 20,
    outputTokens: 5,
    reasoningTokens: null,
    totalInputTokens: 130,
    totalTokens: 135,
    provenance: "estimated",
    provenanceNote: "fixture asserts the estimated path",
    source: { runtimeVersion: null, eventKind: null },
    complete: true,
    usageBasis: "result.usage", // deliberately "wrong" here to prove usageFromFixture re-labels it
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
}

test("usageFromFixture: stamps usageBasis as fixture regardless of the input's own basis", () => {
  const replayed = usageFromFixture(estimatedFixtureRecord());
  assert.equal(replayed.usageBasis, "fixture");
  assert.equal(replayed.provenance, "estimated");
  assert.equal(replayed.totalTokens, 135);
});

test("usageFromFixture: rejects a record that fails shape validation (I4: unavailable must be all-null)", () => {
  const broken: UsageRecord = {
    runtime: "codex",
    model: null,
    freshInputTokens: null,
    cacheWriteTokens: null,
    cacheReadTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalInputTokens: null,
    totalTokens: 0, // conformance failure: unavailable must never store 0
    provenance: "unavailable",
    provenanceNote: "x",
    source: { runtimeVersion: null, eventKind: null },
    complete: false,
    usageBasis: "none",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
  assert.throws(() => usageFromFixture(broken));
});

test("usageFromFixture: a well-formed unavailable fixture record passes through validated", () => {
  const record: UsageRecord = {
    runtime: "observed",
    model: null,
    freshInputTokens: null,
    cacheWriteTokens: null,
    cacheReadTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalInputTokens: null,
    totalTokens: null,
    provenance: "unavailable",
    provenanceNote: "fixture asserts a failure path",
    source: { runtimeVersion: null, eventKind: null },
    complete: false,
    usageBasis: "none",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
  const replayed = usageFromFixture(record);
  assert.equal(replayed.usageBasis, "fixture");
  assert.equal(replayed.provenance, "unavailable");
});
