// docs/spec/usage-normalization.md §6.2: the two pure numbers a budget check needs before
// dispatch. `measuredTokens` sums provenance reported/derived REGARDLESS of `complete` (unlike
// coverage's stricter "measured", §4.1) — a claude-code attempt interrupted by SIGINT still
// counts its spent tokens toward the token budget even though it is unmeasured for coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { measuredTokens, unmeasuredExecutions } from "../../src/usage/budget.ts";
import type { UsageRecord, Coverage } from "../../src/types/usage.ts";

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    runtime: "claude-code",
    model: null,
    freshInputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 5,
    reasoningTokens: null,
    totalInputTokens: 10,
    totalTokens: 15,
    provenance: "reported",
    provenanceNote: "x",
    source: { runtimeVersion: null, eventKind: "result" },
    complete: true,
    usageBasis: "result.usage",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
    ...overrides,
  };
}

test("measuredTokens: sums totalTokens over reported/derived records only", () => {
  const total = measuredTokens([
    record({ totalTokens: 100 }),
    record({ totalTokens: 200, provenance: "derived" }),
    record({ totalTokens: null, provenance: "unavailable" }),
    record({ totalTokens: 999, provenance: "estimated" }),
  ]);
  assert.equal(total, 300);
});

test("measuredTokens: a reported-but-incomplete record still counts (tokens were still spent)", () => {
  const total = measuredTokens([record({ totalTokens: 928, complete: false })]);
  assert.equal(total, 928, "unlike coverage's measured count, the token budget counts spend regardless of complete");
});

test("measuredTokens: empty input sums to 0", () => {
  assert.equal(measuredTokens([]), 0);
});

test("unmeasuredExecutions: agentExecutions minus measuredExecutions", () => {
  const coverage: Coverage = { agentExecutions: 8, measuredExecutions: 7, coverage: 0.875, unmeasured: [] };
  assert.equal(unmeasuredExecutions(coverage), 1);
});

test("unmeasuredExecutions: fully measured scope has zero unmeasured executions", () => {
  const coverage: Coverage = { agentExecutions: 3, measuredExecutions: 3, coverage: 1, unmeasured: [] };
  assert.equal(unmeasuredExecutions(coverage), 0);
});
