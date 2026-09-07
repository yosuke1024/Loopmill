// claude-code edge cases not already pinned by a fixture (docs/spec/usage-normalization.md §2.1).
// The SIGTERM/no-result shape is already covered end to end by
// docs/spec/usage-fixtures/claude-killed.json via test/usage/fixtures.test.ts; it is not repeated
// here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeClaudeCodeResult } from "../../src/usage/claude-code.ts";

test("claude-code: an empty modelUsage object ({}) counts as absent and falls back to result.usage", () => {
  const record = normalizeClaudeCodeResult({
    result: {
      session_id: "sess-1",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.01,
      modelUsage: {}, // present, but empty -- §2.1: "{} counts as absent for rule 1"
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        output_tokens: 20,
      },
    },
    exitCode: 0,
    signal: null,
    runtimeVersion: "2.1.263",
  });
  assert.equal(record.usageBasis, "result.usage", "an empty modelUsage must not win the basis precedence");
  assert.equal(record.freshInputTokens, 100);
  assert.equal(record.cacheWriteTokens, 10);
  assert.equal(record.cacheReadTokens, 5);
  assert.equal(record.outputTokens, 20);
  assert.equal(record.totalTokens, 135);
  assert.equal(record.provenance, "reported");
  assert.equal(record.perModel, null);
});

test("claude-code: all-zero usage with is_error is the zeroed-crash rule, not a measured zero", () => {
  const record = normalizeClaudeCodeResult({
    result: {
      session_id: "sess-2",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      total_cost_usd: 0,
      modelUsage: {},
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
    exitCode: 1,
    signal: null,
    runtimeVersion: "2.1.263",
  });
  assert.equal(record.provenance, "unavailable", "storing that zero would silently bias every average downward");
  assert.equal(record.complete, false);
  assert.equal(record.freshInputTokens, null);
  assert.equal(record.totalTokens, null);
  assert.equal(record.listPriceEquivalentUsd, null, "unavailable records never carry a list-price figure either");
  assert.ok(record.provenanceNote.length > 0);
});

test("claude-code: a zeroed modelUsage-basis record also triggers the zeroed-crash rule", () => {
  const record = normalizeClaudeCodeResult({
    result: {
      session_id: "sess-3",
      subtype: "success",
      is_error: true,
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
    exitCode: 1,
    signal: null,
    runtimeVersion: "2.1.263",
  });
  assert.equal(record.provenance, "unavailable");
  assert.equal(record.complete, false);
});

test("claude-code: no result and no signal (e.g. an unexplained empty stdout) is still unavailable with a null eventKind", () => {
  const record = normalizeClaudeCodeResult({
    result: null,
    exitCode: 1,
    signal: null,
    runtimeVersion: "2.1.263",
  });
  assert.equal(record.provenance, "unavailable");
  assert.equal(record.source.eventKind, null);
  assert.equal(record.complete, false);
});

test("claude-code: error_max_budget_usd without the modelUsage basis is reported but incomplete", () => {
  const record = normalizeClaudeCodeResult({
    result: {
      session_id: "sess-4",
      subtype: "error_max_budget_usd",
      is_error: true,
      usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
    },
    exitCode: 1,
    signal: null,
    runtimeVersion: "2.1.263",
  });
  assert.equal(record.provenance, "reported");
  assert.equal(record.complete, false, "modelUsage is required to be complete for this subtype, and it is absent here");
});

test("claude-code: error_max_budget_usd WITH the modelUsage basis is reported and complete", () => {
  const record = normalizeClaudeCodeResult({
    result: {
      session_id: "sess-5",
      subtype: "error_max_budget_usd",
      is_error: true,
      modelUsage: {
        "claude-sonnet-5": { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
      usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
    },
    exitCode: 1,
    signal: null,
    runtimeVersion: "2.1.263",
  });
  assert.equal(record.provenance, "reported");
  assert.equal(record.complete, true);
  assert.equal(record.usageBasis, "modelUsage");
});
