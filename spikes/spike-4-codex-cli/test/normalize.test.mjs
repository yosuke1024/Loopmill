// Offline tests for normalize.mjs -- no codex CLI, no network. Run with:
//   cd spikes/spike-4-codex-cli && node --test test/*.test.mjs
//
// Tests 1-3 replay the committed hand-written codex fixtures (docs/spec/usage-fixtures/codex-*.json)
// through the pure `normalizeCodexStream` function and assert the produced record matches the
// fixture's `expected.attempts[].usage` field for field, with two deliberate exceptions:
// `provenanceNote` (free text; only asserted non-empty) and `source.runtimeVersion` (best-effort
// probe; only asserted to be a non-empty string -- since the fixture's own text does not need to
// equal whatever synthetic version string a test happens to pass in).
//
// Tests 4-5 are not drawn from a committed fixture: they exercise the parse-error and clamp paths
// directly, per docs/spec/usage-normalization.md section 2.2 (the max(0, ...) clamp) and section 2.5
// (malformed/truncated stream handling).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCodexStream, parseJsonlFile } from "../normalize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "docs", "spec", "usage-fixtures");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

// Compares a produced usage record against a fixture's expected usage record, ignoring
// `provenanceNote` and `source.runtimeVersion` (each is instead asserted to be a non-empty string).
function assertUsageMatches(actual, expected) {
  assert.equal(typeof actual.provenanceNote, "string", "provenanceNote must be a string");
  assert.ok(actual.provenanceNote.length > 0, "provenanceNote must be non-empty");
  assert.equal(typeof actual.source.runtimeVersion, "string", "source.runtimeVersion must be a string");
  assert.ok(actual.source.runtimeVersion.length > 0, "source.runtimeVersion must be non-empty");

  const normalize = (u) => ({
    ...u,
    provenanceNote: undefined,
    source: { ...u.source, runtimeVersion: undefined },
  });

  assert.deepStrictEqual(normalize(actual), normalize(expected));
}

test("codex-fresh-thread.json: fresh thread, subset arithmetic, reasoning as reference (I1,I2,I3,I5,I8,I9)", () => {
  const fixture = loadFixture("codex-fresh-thread.json");
  const expectedUsage = fixture.expected.attempts[0].usage;

  const result = normalizeCodexStream({
    events: fixture.input.events,
    exitCode: fixture.input.exitCode,
    signal: fixture.input.signal,
    runtimeVersion: expectedUsage.source.runtimeVersion,
    usageAtAttemptStart: fixture.input.usageAtAttemptStart,
    model: expectedUsage.model,
  });

  assertUsageMatches(result.usage, expectedUsage);
  assert.equal(result.usage.totalTokens, fixture.expected.nodeExecution.totalTokens);
  assert.notEqual(result.usage.totalTokens, fixture.expected.mustNotEqual.totalIfCachedWereAddedToInput);
  assert.notEqual(result.usage.totalTokens, fixture.expected.mustNotEqual.totalIfReasoningWereAddedToOutput);
});

test("codex-two-turns-cumulative.json: thread reuse, the delta rule, the sum-of-deltas identity (I1,I2,I3,I5,I8,I9,I10)", () => {
  const fixture = loadFixture("codex-two-turns-cumulative.json");
  const [attempt1, attempt2] = fixture.input.attempts;
  const expected1 = fixture.expected.attempts[0].usage;
  const expected2 = fixture.expected.attempts[1].usage;

  const result1 = normalizeCodexStream({
    events: attempt1.events,
    exitCode: attempt1.exitCode,
    signal: null,
    runtimeVersion: expected1.source.runtimeVersion,
    usageAtAttemptStart: attempt1.usageAtAttemptStart,
    model: expected1.model,
  });
  assertUsageMatches(result1.usage, expected1);

  // Attempt 2's start is attempt 1's own last cumulative -- the fixture already encodes this
  // directly in attempt2.usageAtAttemptStart, so both should agree.
  assert.deepStrictEqual(attempt2.usageAtAttemptStart, result1.diagnostics.lastCumulative);

  const result2 = normalizeCodexStream({
    events: attempt2.events,
    exitCode: attempt2.exitCode,
    signal: null,
    runtimeVersion: expected2.source.runtimeVersion,
    usageAtAttemptStart: attempt2.usageAtAttemptStart,
    model: expected2.model,
  });
  assertUsageMatches(result2.usage, expected2);

  // Invariant I5 and the fixture's own run-level identity: the sum of the two deltas equals the
  // LAST cumulative reported on the thread, not the (wrong) sum of the two raw cumulatives.
  const lastCumulative = result2.diagnostics.lastCumulative;
  const sumOfTotals = result1.usage.totalTokens + result2.usage.totalTokens;
  const lastCumulativeTotal = lastCumulative.input_tokens + lastCumulative.output_tokens;

  assert.equal(sumOfTotals, lastCumulativeTotal);
  assert.equal(sumOfTotals, fixture.expected.run.totalTokens);
  assert.notEqual(sumOfTotals, fixture.expected.mustNotEqual.runTotalIfCumulativesWereSummed);
});

test("codex-turn-failed.json: turn.failed with no turn.completed normalizes to unavailable (I2,I4,I9,I12)", () => {
  const fixture = loadFixture("codex-turn-failed.json");
  const expectedUsage = fixture.expected.attempts[0].usage;

  const result = normalizeCodexStream({
    events: fixture.input.events,
    exitCode: fixture.input.exitCode,
    signal: fixture.input.signal,
    runtimeVersion: expectedUsage.source.runtimeVersion,
    usageAtAttemptStart: fixture.input.usageAtAttemptStart,
    model: expectedUsage.model,
  });

  assertUsageMatches(result.usage, expectedUsage);
  assert.equal(result.usage.provenance, "unavailable");
  assert.equal(result.usage.complete, false);
  assert.notEqual(result.usage.totalTokens, fixture.expected.mustNotEqual.storedAsZero);
});

test("a truncated last line with no turn.completed: one parse error, normalizes to unavailable", () => {
  const tmpFile = path.join(os.tmpdir(), `spike4-normalize-test-${process.pid}-${Date.now()}.jsonl`);
  const content =
    '{"type":"thread.started","thread_id":"th_test_truncated"}\n' +
    '{"type":"turn.started"}\n' +
    '{"type":"item.completed","item":{"type":"agent_message","text":"partial repl';
  fs.writeFileSync(tmpFile, content);

  try {
    const parsed = parseJsonlFile(tmpFile);
    assert.equal(parsed.parseErrors, 1);
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.lineCount, 3);

    const result = normalizeCodexStream({
      events: parsed.events,
      exitCode: 137,
      signal: "SIGKILL",
      runtimeVersion: "codex-cli 0.144.6",
      usageAtAttemptStart: null,
      model: null,
    });

    assert.equal(result.usage.provenance, "unavailable");
    assert.equal(result.usage.complete, false);
    assert.equal(result.usage.totalTokens, null);
    assert.equal(result.usage.freshInputTokens, null);
    assert.match(result.usage.provenanceNote, /SIGKILL/);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("cached_input_tokens exceeding input_tokens clamps fresh to 0 and marks the record incomplete (I2)", () => {
  const events = [
    { type: "thread.started", thread_id: "th_clamp_test" },
    { type: "turn.started" },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 150,
        cache_write_input_tokens: 0,
        output_tokens: 10,
        reasoning_output_tokens: 0,
      },
    },
  ];

  const result = normalizeCodexStream({
    events,
    exitCode: 0,
    signal: null,
    runtimeVersion: "codex-cli 0.144.6",
    usageAtAttemptStart: null,
    model: null,
  });

  assert.equal(result.usage.provenance, "derived");
  assert.equal(result.usage.freshInputTokens, 0);
  assert.equal(result.usage.complete, false);
  assert.match(result.usage.provenanceNote.toLowerCase(), /clamp/);
  // Even clamped, I1 must still hold: totals recompute from the (clamped) buckets.
  assert.equal(result.usage.totalInputTokens, result.usage.freshInputTokens + result.usage.cacheWriteTokens + result.usage.cacheReadTokens);
  assert.equal(result.usage.totalTokens, result.usage.totalInputTokens + result.usage.outputTokens);
});
