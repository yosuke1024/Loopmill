// A12: `loopmill run`'s exit codes match state-machine.md §12.2 one-for-one, reproduced with the
// `fake` backend against `test/fixtures/driver/exit-codes.loop.yaml` (one agent node, a
// condition, and a two-iteration retry edge back to the agent node).

import { test } from "node:test";
import assert from "node:assert/strict";

import { runLoop } from "../../src/driver/index.ts";
import { FakeDispatcher, type FakeScript } from "../../src/backends/fake/index.ts";
import type { TriggerPayload } from "../../src/types/envelope.ts";
import { EXIT_CODES_LOOP_PATH, advancingClock, fixedClock, makeScratchRepo, openTestContext } from "../fixtures/driver/helpers.ts";

const TRIGGER: TriggerPayload = { kind: "manual" };

async function runWith(script: FakeScript, clock = fixedClock()) {
  const repo = await makeScratchRepo();
  const ctx = await openTestContext(repo, EXIT_CODES_LOOP_PATH, clock);
  const dispatchers = { fake: new FakeDispatcher(script) };
  try {
    return await runLoop({ ctx, trigger: TRIGGER, dispatchers });
  } finally {
    ctx.close();
    await repo.cleanup();
  }
}

test("A12: SUCCEEDED -> exit 0", async () => {
  const result = await runWith({ steps: { "0:step:1": { status: "succeeded", structured: { ok: true } } } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "SUCCEEDED");
});

test("A12: FAILED -> exit 10", async () => {
  const result = await runWith({
    steps: {
      "0:step:1": { status: "failed" },
      "0:step:2": { status: "failed" },
    },
  });
  assert.equal(result.exitCode, 10);
  assert.equal(result.state, "FAILED");
  assert.equal(result.outcome?.state, "FAILED");
});

test("A12: MAX_ITERATIONS_EXCEEDED -> exit 11, exactly maxIterations traversals", async () => {
  // Each cycle must report a *different* file digest — an identical `changeFingerprint` between
  // cycles makes the retry a NO_PROGRESS (free) traversal (state-machine.md §6.6), which never
  // charges `traversals[edge]` at all and, after `policy.convergenceLimit` such cycles, fails the
  // Run with `no_progress_stalled` before MAX_ITERATIONS_EXCEEDED ever gets a chance to fire.
  const result = await runWith({
    steps: {
      "0:step:1": { status: "succeeded", structured: { ok: false }, filesChanged: [{ path: "a.txt", digest: `sha256:${"a".repeat(64)}` }] },
      "1:step:1": { status: "succeeded", structured: { ok: false }, filesChanged: [{ path: "a.txt", digest: `sha256:${"b".repeat(64)}` }] },
      "2:step:1": { status: "succeeded", structured: { ok: false }, filesChanged: [{ path: "a.txt", digest: `sha256:${"c".repeat(64)}` }] },
    },
  });
  assert.equal(result.exitCode, 11);
  assert.equal(result.state, "MAX_ITERATIONS_EXCEEDED");
  if (result.outcome?.state === "MAX_ITERATIONS_EXCEEDED") {
    assert.equal(result.outcome.traversals, 2);
    assert.equal(result.outcome.maxIterations, 2);
  } else {
    assert.fail(`expected a MAX_ITERATIONS_EXCEEDED outcome, got ${JSON.stringify(result.outcome)}`);
  }
});

test("A12: BUDGET_EXCEEDED(maxMeasuredTokens) -> exit 12, checked before the second dispatch", async () => {
  const bigUsage = {
    runtime: "claude-code" as const,
    model: "sonnet",
    freshInputTokens: 1000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 500,
    reasoningTokens: null,
    totalInputTokens: 1000,
    totalTokens: 1500,
    provenance: "reported" as const,
    provenanceNote: "test fixture",
    source: { runtimeVersion: "test", eventKind: "result" },
    complete: true,
    usageBasis: "result.usage" as const,
    sessionRef: null,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
  const result = await runWith({
    steps: {
      "0:step:1": { status: "succeeded", structured: { ok: false }, usage: bigUsage },
      "1:step:1": { status: "succeeded", structured: { ok: false }, usage: bigUsage },
    },
  });
  assert.equal(result.exitCode, 12);
  assert.equal(result.state, "BUDGET_EXCEEDED");
  if (result.outcome?.state === "BUDGET_EXCEEDED") {
    assert.equal(result.outcome.budgetKey, "maxMeasuredTokens");
  } else {
    assert.fail(`expected a BUDGET_EXCEEDED outcome, got ${JSON.stringify(result.outcome)}`);
  }
});

test("A12: CANCELLED -> exit 14", async () => {
  const result = await runWith({ steps: { "0:step:1": { status: "cancelled" } } });
  assert.equal(result.exitCode, 14);
  assert.equal(result.state, "CANCELLED");
});

test("A12: a quota-classified failure with quotaResetsAt parks the run -> exit 21, never FAILED", async () => {
  const result = await runWith({
    steps: {
      "0:step:1": {
        status: "failed",
        error: { code: "quota", message: "usage limit", classified: "quota" },
        quotaResetsAt: "2026-09-06T15:45:00.000Z",
      },
    },
  });
  assert.equal(result.exitCode, 21);
  assert.equal(result.state, "WAITING_FOR_QUOTA");
});

test("A12: EXPIRED(max_runtime) -> exit 13, driven with an advancing clock", async () => {
  const result = await runWith(
    {
      steps: {
        "0:step:1": { status: "succeeded", structured: { ok: false } },
        "1:step:1": { status: "succeeded", structured: { ok: false } },
        "2:step:1": { status: "succeeded", structured: { ok: false } },
      },
    },
    advancingClock(),
  );
  // With a clock that jumps 5 minutes on every reading, `budget.activeMs` crosses the loop's
  // `maxRuntime: PT1M` well before the retry edge would otherwise exhaust — EXPIRED, not
  // MAX_ITERATIONS_EXCEEDED, must win (state-machine.md §11.2's ordered `preDispatch`).
  assert.equal(result.exitCode, 13);
  assert.equal(result.state, "EXPIRED");
});
