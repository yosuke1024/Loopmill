// classifyFailure (state-machine.md §7.1-§7.4): classifyFailureOrder, the positive/negative
// pattern tables of §7.3, and the SPIKE-1/SPIKE-4 measured shapes this task calls out by name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, loadPatternTable, classificationOfError, errorPayloadFor } from "../../src/engine/classify.ts";
import type { ClassifyInput } from "../../src/types/state.ts";

const patterns = loadPatternTable();

function baseInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    runtimeId: "claude-code",
    runtimeVersion: "2.1.263",
    exitCode: 0,
    signal: null,
    result: null,
    streamEvents: [],
    cancelRequested: false,
    timeoutFired: false,
    deadlineMissed: false,
    patterns,
    ...overrides,
  };
}

test("classifyFailureOrder: LOST wins over everything (deadlineMissed)", () => {
  const out = classifyFailure(baseInput({ deadlineMissed: true, timeoutFired: true, cancelRequested: true }));
  assert.equal(out.classification, "LOST");
});

test("classifyFailureOrder: TIMEOUT wins over CANCELLED/QUOTA/SUCCESS", () => {
  const out = classifyFailure(baseInput({ timeoutFired: true, cancelRequested: true, exitCode: 0, result: { is_error: false } }));
  assert.equal(out.classification, "TIMEOUT");
});

test("classifyFailureOrder: CANCELLED wins over QUOTA/SUCCESS (claude-code aborted_streaming)", () => {
  const out = classifyFailure(
    baseInput({
      cancelRequested: true,
      exitCode: 0,
      result: { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", result: "You've hit your session limit" },
    }),
  );
  assert.equal(out.classification, "CANCELLED");
});

test("claude-code: SIGINT-with-result aborted_streaming, cancelRequested false -> not CANCELLED, falls through to FAILED", () => {
  const out = classifyFailure(baseInput({ cancelRequested: false, exitCode: 0, result: { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" } }));
  assert.equal(out.classification, "FAILED", "never inferred from the result alone without cancelRequested (§7.2 row 3)");
});

test("codex: cancelRequested + no turn.completed -> CANCELLED (the discriminator is absence of a terminal event)", () => {
  const out = classifyFailure(baseInput({ runtimeId: "codex", cancelRequested: true, exitCode: 1, result: null }));
  assert.equal(out.classification, "CANCELLED");
});

test("codex: cancelRequested + turn.completed present -> not CANCELLED (the process actually finished)", () => {
  const out = classifyFailure(baseInput({ runtimeId: "codex", cancelRequested: true, exitCode: 0, result: { type: "turn.completed" } }));
  assert.notEqual(out.classification, "CANCELLED");
});

test("claude-code QUOTA: positive pattern with a resets-at suffix -> quotaResetsAt, quotaSource reported", () => {
  const out = classifyFailure(baseInput({ exitCode: 1, result: { is_error: true, result: "You've hit your session limit · resets at 2026-09-06T15:45:00.000Z" } }));
  assert.equal(out.classification, "QUOTA");
  assert.equal(out.quotaSource, "reported");
  assert.ok(out.quotaResetsAt);
});

test("claude-code QUOTA: weekly/Opus/Sonnet/Fable/usage credit limit names all match the positive pattern", () => {
  for (const limit of ["weekly", "Opus", "Sonnet", "Fable", "usage credit"]) {
    const out = classifyFailure(baseInput({ exitCode: 1, result: { is_error: true, result: `You've hit your ${limit} limit` } }));
    assert.equal(out.classification, "QUOTA", `limit name "${limit}"`);
  }
});

test("claude-code QUOTA negative look-alikes: 'Server is temporarily limiting requests' and 'Request rejected (429)' force FAILED", () => {
  for (const text of ["Server is temporarily limiting requests", "Request rejected (429): too many requests"]) {
    const out = classifyFailure(baseInput({ exitCode: 1, result: { is_error: true, result: text } }));
    assert.equal(out.classification, "FAILED", text);
  }
});

test("claude-code QUOTA: no resets-at suffix -> derived-window quotaSource (D-05)", () => {
  const out = classifyFailure(baseInput({ exitCode: 1, result: { is_error: true, result: "You've hit your session limit" } }));
  assert.equal(out.classification, "QUOTA");
  assert.equal(out.quotaSource, "derived-window");
  assert.equal(out.quotaResetsAt, undefined, "classifyFailure itself has no clock to resolve an absolute timestamp from a derived window — transition.ts does");
});

test("claude-code: a leading-indicator-only stream event (system/api_retry) with no positive text match is never terminal on its own", () => {
  const out = classifyFailure(baseInput({ exitCode: 1, result: { is_error: true, result: "some other generic failure" }, streamEvents: [{ type: "system/api_retry", error: "rate_limit" }] }));
  assert.notEqual(out.classification, "QUOTA");
});

test("codex QUOTA: 'usage limit' substring in turn.failed.error.message", () => {
  const out = classifyFailure(baseInput({ runtimeId: "codex", exitCode: 1, result: { type: "turn.failed", error: { message: "Usage limit reached for this account" } } }));
  assert.equal(out.classification, "QUOTA");
});

test("codex QUOTA: codexErrorInfo === 'usageLimitExceeded'", () => {
  const out = classifyFailure(baseInput({ runtimeId: "codex", exitCode: 1, result: { codexErrorInfo: "usageLimitExceeded" } }));
  assert.equal(out.classification, "QUOTA");
});

test("codex negative: rate_limit_exceeded with willRetry true forces FAILED", () => {
  const out = classifyFailure(baseInput({ runtimeId: "codex", exitCode: 1, result: { message: "rate_limit_exceeded, please retry", willRetry: true } }));
  assert.equal(out.classification, "FAILED");
});

test("SPIKE-1: claude-code aborted_streaming maps to CANCELLED only when cancelRequested", () => {
  const cancelled = classifyFailure(baseInput({ cancelRequested: true, exitCode: 0, result: { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" } }));
  assert.equal(cancelled.classification, "CANCELLED");
  const notCancelled = classifyFailure(baseInput({ cancelRequested: false, exitCode: 0, result: { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" } }));
  assert.notEqual(notCancelled.classification, "CANCELLED");
});

test("SPIKE-4: codex turn.failed with exit 400-ish exit code is FAILED", () => {
  const out = classifyFailure(baseInput({ runtimeId: "codex", exitCode: 1, result: { type: "turn.failed", error: { message: "bad request" } } }));
  assert.equal(out.classification, "FAILED");
});

test("SPIKE-4: codex exit 0 without turn.completed is FAILED, never SUCCESS (SIGTERM-ed codex exec)", () => {
  const out = classifyFailure(baseInput({ runtimeId: "codex", exitCode: 0, result: null }));
  assert.equal(out.classification, "FAILED");
});

test("claude-code SUCCESS: exit 0 + is_error: false", () => {
  const out = classifyFailure(baseInput({ exitCode: 0, result: { is_error: false, result: "done" } }));
  assert.equal(out.classification, "SUCCESS");
});

test("claude-code: exit 0 but is_error true (api_error auth failure) is FAILED, not SUCCESS (subtype alone is not enough)", () => {
  const out = classifyFailure(baseInput({ exitCode: 0, result: { subtype: "success", is_error: true, terminal_reason: "api_error" } }));
  assert.equal(out.classification, "FAILED");
});

test("codex SUCCESS: exit 0 + turn.completed", () => {
  const out = classifyFailure(baseInput({ runtimeId: "codex", exitCode: 0, result: { type: "turn.completed" } }));
  assert.equal(out.classification, "SUCCESS");
});

test("ambiguity rule: a non-zero exit with no recognised message is FAILED", () => {
  const out = classifyFailure(baseInput({ exitCode: 137, result: null }));
  assert.equal(out.classification, "FAILED");
});

test("ambiguity rule: exit 0 with a missing/malformed result is FAILED", () => {
  const out = classifyFailure(baseInput({ exitCode: 0, result: undefined }));
  assert.equal(out.classification, "FAILED");
});

test("ambiguity rule: SIGTERM/exit 143 with no recorded result is FAILED", () => {
  const out = classifyFailure(baseInput({ exitCode: 143, signal: "SIGTERM", result: null }));
  assert.equal(out.classification, "FAILED");
});

// -----------------------------------------------------------------------------------------
// classificationOfError / errorPayloadFor (§7.1's wire table)
// -----------------------------------------------------------------------------------------

test("classificationOfError: the §7.1 wire table, verbatim", () => {
  assert.equal(classificationOfError({ code: "x", message: "m", classified: "quota" }, "2026-09-06T15:45:00Z"), "QUOTA");
  assert.equal(classificationOfError({ code: "x", message: "m", classified: "quota" }), "FAILED", "quota without quotaResetsAt degrades to FAILED");
  assert.equal(classificationOfError({ code: "x", message: "m", classified: "timeout" }), "TIMEOUT");
  assert.equal(classificationOfError({ code: "x", message: "m", classified: "cancelled" }), "CANCELLED");
  for (const c of ["auth", "invalid_input", "artifact_invalid", "backend_error", "runtime_error", "transient", "unknown"] as const) {
    assert.equal(classificationOfError({ code: "x", message: "m", classified: c }), "FAILED", c);
  }
});

test("errorPayloadFor: round-trips through classificationOfError for QUOTA/TIMEOUT/CANCELLED", () => {
  const quota = errorPayloadFor({ classification: "QUOTA", quotaResetsAt: "2026-09-06T15:45:00Z", code: "quota", message: "m" });
  assert.equal(quota.classified, "quota");
  assert.equal(classificationOfError(quota, "2026-09-06T15:45:00Z"), "QUOTA");

  const timeout = errorPayloadFor({ classification: "TIMEOUT", code: "node_timeout", message: "m" });
  assert.equal(classificationOfError(timeout), "TIMEOUT");

  const cancelled = errorPayloadFor({ classification: "CANCELLED", code: "cancelled", message: "m" });
  assert.equal(classificationOfError(cancelled), "CANCELLED");
});

test("errorPayloadFor: SUCCESS has no ErrorPayload", () => {
  assert.throws(() => errorPayloadFor({ classification: "SUCCESS", code: "success", message: "m" }));
});
