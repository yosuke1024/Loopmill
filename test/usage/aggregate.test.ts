// Aggregation tests beyond the fixture corpus: mixed provenance rolls up to the weakest
// contributor (docs/spec/usage-normalization.md §3.2), an `estimated` record never enters the
// headline sum (I11), and recomputation from the stored buckets always reproduces the aggregate's
// own totals (I8).

import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRecords, aggregateNodeExecution, aggregateCycle, aggregateRun } from "../../src/usage/aggregate.ts";
import type { UsageRecord } from "../../src/types/usage.ts";

function reportedRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    runtime: "claude-code",
    model: "claude-sonnet-5",
    freshInputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 10,
    reasoningTokens: null,
    totalInputTokens: 100,
    totalTokens: 110,
    provenance: "reported",
    provenanceNote: "test fixture",
    source: { runtimeVersion: "1.0.0", eventKind: "result" },
    complete: true,
    usageBasis: "result.usage",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
    ...overrides,
  };
}

function derivedRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ...reportedRecord(),
    runtime: "codex",
    model: null,
    provenance: "derived",
    usageBasis: "turn.completed",
    sessionRef: { kind: "codex-thread", id: "th_1" },
    usageAtAttemptStart: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 },
    ...overrides,
  };
}

function estimatedRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ...reportedRecord(),
    freshInputTokens: 9999,
    cacheWriteTokens: 9999,
    cacheReadTokens: 9999,
    outputTokens: 9999,
    totalInputTokens: 29997,
    totalTokens: 39996,
    provenance: "estimated",
    usageBasis: "fixture",
    ...overrides,
  };
}

function unavailable(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    runtime: "claude-code",
    model: null,
    freshInputTokens: null,
    cacheWriteTokens: null,
    cacheReadTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalInputTokens: null,
    totalTokens: null,
    provenance: "unavailable",
    provenanceNote: "no usage",
    source: { runtimeVersion: null, eventKind: null },
    complete: false,
    usageBasis: "none",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
    ...overrides,
  };
}

test("aggregateRecords: mixed reported + derived rolls up to the weakest contributor (derived)", () => {
  const agg = aggregateRecords([reportedRecord(), derivedRecord()]);
  assert.equal(agg.provenance, "derived");
  assert.equal(agg.totalTokens, 220);
  assert.equal(agg.measured, true);
  assert.equal(agg.coverage.agentExecutions, 2);
  assert.equal(agg.coverage.measuredExecutions, 2);
});

test("aggregateRecords: all reported stays reported", () => {
  const agg = aggregateRecords([reportedRecord(), reportedRecord()]);
  assert.equal(agg.provenance, "reported");
});

test("aggregateRecords (I11): an estimated record is excluded from the headline sum", () => {
  const agg = aggregateRecords([reportedRecord(), estimatedRecord()]);
  // Only the reported record's numbers may appear in the headline.
  assert.equal(agg.totalTokens, 110);
  assert.equal(agg.freshInputTokens, 100);
  assert.equal(agg.provenance, "reported");
  // The estimated record counts as unmeasured (not measured, not summed).
  assert.equal(agg.coverage.agentExecutions, 2);
  assert.equal(agg.coverage.measuredExecutions, 1);
});

test("aggregateRecords (I11): an all-estimated scope sums to nothing (no headline exists to mix into)", () => {
  const agg = aggregateRecords([estimatedRecord(), estimatedRecord()]);
  assert.equal(agg.totalTokens, 0);
  assert.equal(agg.freshInputTokens, 0);
  assert.equal(agg.coverage.measuredExecutions, 0);
});

test("aggregateRecords: unavailable records never sum and never poison provenance", () => {
  const agg = aggregateRecords([reportedRecord(), unavailable()]);
  assert.equal(agg.totalTokens, 110);
  assert.equal(agg.provenance, "reported");
  assert.equal(agg.measured, false);
  assert.equal(agg.coverage.agentExecutions, 2);
  assert.equal(agg.coverage.measuredExecutions, 1);
});

test("aggregateRecords: a reported-but-incomplete record still contributes to the sum as a lower bound (§3.3)", () => {
  const incomplete = reportedRecord({ complete: false, provenanceNote: "aborted_streaming" });
  const agg = aggregateRecords([incomplete]);
  assert.equal(agg.totalTokens, 110, "the figure is still summed, even though it is unmeasured");
  assert.equal(agg.coverage.measuredExecutions, 0, "but it does not count as measured for coverage");
});

test("aggregateRecords (I8): recomputation reproduces the stored aggregate", () => {
  const agg = aggregateRecords([reportedRecord({ freshInputTokens: 50, cacheWriteTokens: 5, cacheReadTokens: 7, outputTokens: 3 })]);
  assert.equal(agg.totalInputTokens, agg.freshInputTokens + agg.cacheWriteTokens + agg.cacheReadTokens);
  assert.equal(agg.totalTokens, agg.totalInputTokens + agg.outputTokens);
});

test("aggregateNodeExecution: sums all attempts of one node execution, retries included, no de-duplication", () => {
  const attempt1 = { key: { cycleIndex: 1, nodeId: "implement", attempt: 1 }, usage: reportedRecord({ totalTokens: 110 }) };
  const attempt2 = { key: { cycleIndex: 1, nodeId: "implement", attempt: 2 }, usage: reportedRecord({ totalTokens: 110 }) };
  const agg = aggregateNodeExecution([attempt1, attempt2]);
  assert.equal(agg.totalTokens, 220, "both attempts count; retried tokens were spent twice");
  assert.equal(agg.coverage.agentExecutions, 1, "one node execution, however many attempts it took");
  assert.equal(agg.measured, true);
});

test("aggregateNodeExecution: measured requires every attempt to be measured", () => {
  const good = { key: { cycleIndex: 1, nodeId: "implement", attempt: 1 }, usage: reportedRecord() };
  const bad = { key: { cycleIndex: 1, nodeId: "implement", attempt: 2 }, usage: unavailable() };
  const agg = aggregateNodeExecution([good, bad]);
  assert.equal(agg.measured, false);
  assert.equal(agg.coverage.measuredExecutions, 0);
  assert.equal(agg.coverage.unmeasured.length, 1);
  assert.equal(agg.coverage.unmeasured[0]?.attempt, 2, "the unmeasured entry names the attempt that failed");
});

test("aggregateCycle and aggregateRun: cycle 0 is included in the run total (I15)", () => {
  const setup = reportedRecord({
    freshInputTokens: 40,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 10,
    totalInputTokens: 40,
    totalTokens: 50,
  });
  const implement = derivedRecord({
    freshInputTokens: 150,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 50,
    totalInputTokens: 150,
    totalTokens: 200,
  });
  const attempts = [
    { key: { cycleIndex: 0, nodeId: "setup", attempt: 1 }, usage: setup },
    { key: { cycleIndex: 1, nodeId: "implement", attempt: 1 }, usage: implement },
  ];
  const cycle0 = aggregateCycle(attempts, 0);
  assert.equal(cycle0.totalTokens, 50);
  const run = aggregateRun(attempts);
  assert.equal(run.totalTokens, 250, "the run total includes cycle 0");
  assert.equal(run.coverage.agentExecutions, 2);
});

test("aggregateRun (I8): the run aggregate is a fold, recomputes exactly from its own buckets", () => {
  const attempts = [
    { key: { cycleIndex: 1, nodeId: "a", attempt: 1 }, usage: reportedRecord({ freshInputTokens: 10, cacheWriteTokens: 1, cacheReadTokens: 2, outputTokens: 3, totalInputTokens: 13, totalTokens: 16 }) },
    { key: { cycleIndex: 2, nodeId: "b", attempt: 1 }, usage: derivedRecord({ freshInputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 4, outputTokens: 5, totalInputTokens: 24, totalTokens: 29 }) },
  ];
  const run = aggregateRun(attempts);
  assert.equal(run.freshInputTokens, 30);
  assert.equal(run.cacheWriteTokens, 1);
  assert.equal(run.cacheReadTokens, 6);
  assert.equal(run.outputTokens, 8);
  assert.equal(run.totalInputTokens, run.freshInputTokens + run.cacheWriteTokens + run.cacheReadTokens);
  assert.equal(run.totalTokens, run.totalInputTokens + run.outputTokens);
  assert.equal(run.provenance, "derived", "mixing reported and derived rolls up to the weakest");
});
