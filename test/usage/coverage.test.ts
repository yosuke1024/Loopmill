// docs/spec/usage-normalization.md §4.1-§4.2: coverage counts agent Node Executions only,
// SKIPPED executions count in neither term, and it nests by union rather than by averaging
// per-scope percentages (I10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage, type CoverageExecutionInput } from "../../src/usage/coverage.ts";
import type { UsageRecord } from "../../src/types/usage.ts";

function measuredUsage(): UsageRecord {
  return {
    runtime: "claude-code",
    model: "claude-sonnet-5",
    freshInputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 1,
    reasoningTokens: null,
    totalInputTokens: 10,
    totalTokens: 11,
    provenance: "reported",
    provenanceNote: "ok",
    source: { runtimeVersion: "1.0.0", eventKind: "result" },
    complete: true,
    usageBasis: "result.usage",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
}

function unmeasuredUsage(note: string): UsageRecord {
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
    provenanceNote: note,
    source: { runtimeVersion: null, eventKind: null },
    complete: false,
    usageBasis: "none",
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
}

test("computeCoverage: command/condition/human/end nodes never count, in either term", () => {
  const executions: CoverageExecutionInput[] = [
    { cycleIndex: 1, nodeId: "agent-node", attempt: 1, runtime: "claude-code", kind: "agent", state: "SUCCEEDED", usage: measuredUsage() },
    { cycleIndex: 1, nodeId: "gate", attempt: 1, runtime: "n/a", kind: "condition", state: "SUCCEEDED", usage: null },
    { cycleIndex: 1, nodeId: "run-tests", attempt: 1, runtime: "n/a", kind: "command", state: "SUCCEEDED", usage: null },
    { cycleIndex: 1, nodeId: "approve", attempt: 1, runtime: "n/a", kind: "human", state: "SUCCEEDED", usage: null },
    { cycleIndex: 1, nodeId: "done", attempt: 1, runtime: "n/a", kind: "end", state: "SUCCEEDED", usage: null },
  ];
  const coverage = computeCoverage(executions);
  assert.equal(coverage.agentExecutions, 1);
  assert.equal(coverage.measuredExecutions, 1);
});

test("computeCoverage: a SKIPPED agent node execution counts in neither term", () => {
  const executions: CoverageExecutionInput[] = [
    { cycleIndex: 1, nodeId: "dispatched", attempt: 1, runtime: "claude-code", kind: "agent", state: "SUCCEEDED", usage: measuredUsage() },
    { cycleIndex: 1, nodeId: "never-ran", attempt: 1, runtime: "claude-code", kind: "agent", state: "SKIPPED", usage: null },
  ];
  const coverage = computeCoverage(executions);
  assert.equal(coverage.agentExecutions, 1, "the SKIPPED node execution was never dispatched, so it is not counted at all");
  assert.equal(coverage.measuredExecutions, 1);
});

test("computeCoverage (I10): nests by union, not by the mean of children's percentages", () => {
  // A 1-execution scope at 0% plus a 9-execution scope at 100% must read 9/10 (90%), not 50%.
  const oneAt0: CoverageExecutionInput[] = [
    { cycleIndex: 1, nodeId: "flaky", attempt: 1, runtime: "claude-code", kind: "agent", state: "FAILED", usage: unmeasuredUsage("no result") },
  ];
  const nineAt100: CoverageExecutionInput[] = Array.from({ length: 9 }, (_, i) => ({
    cycleIndex: 2,
    nodeId: `node-${i}`,
    attempt: 1,
    runtime: "claude-code",
    kind: "agent" as const,
    state: "SUCCEEDED",
    usage: measuredUsage(),
  }));
  const union = computeCoverage([...oneAt0, ...nineAt100]);
  assert.equal(union.agentExecutions, 10);
  assert.equal(union.measuredExecutions, 9);
  assert.equal(union.coverage, 0.9);
});

test("computeCoverage: an execution with no usage record at all is unmeasured, with a synthetic reason", () => {
  const coverage = computeCoverage([
    { cycleIndex: 1, nodeId: "lost", attempt: 1, runtime: "claude-code", kind: "agent", state: "FAILED", usage: null },
  ]);
  assert.equal(coverage.measuredExecutions, 0);
  assert.equal(coverage.unmeasured.length, 1);
  assert.ok(coverage.unmeasured[0]!.reason.length > 0);
});

test("computeCoverage: unmeasured[].reason is taken verbatim from the record's provenanceNote", () => {
  const coverage = computeCoverage([
    {
      cycleIndex: 2,
      nodeId: "implement",
      attempt: 1,
      runtime: "claude-code",
      kind: "agent",
      state: "CANCELLED",
      usage: unmeasuredUsage("interrupted before completion (SIGINT; aborted_streaming)"),
    },
  ]);
  assert.equal(coverage.unmeasured[0]!.reason, "interrupted before completion (SIGINT; aborted_streaming)");
});

test("computeCoverage: an empty scope is 0/0, coverage 0 (NaN-free)", () => {
  const coverage = computeCoverage([]);
  assert.equal(coverage.agentExecutions, 0);
  assert.equal(coverage.measuredExecutions, 0);
  assert.equal(coverage.coverage, 0);
  assert.ok(Number.isFinite(coverage.coverage));
});
