// A12: `loopmill run`'s exit codes match state-machine.md §12.2 one-for-one, reproduced with the
// `fake` backend against `test/fixtures/driver/exit-codes.loop.yaml` (one agent node, a
// condition, and a two-iteration retry edge back to the agent node).

import { test } from "node:test";
import assert from "node:assert/strict";

import { runLoop } from "../../src/driver/index.ts";
import { FakeDispatcher, type FakeScript } from "../../src/backends/fake/index.ts";
import type { TriggerPayload } from "../../src/types/envelope.ts";
import type { AppendInput, AppendResult } from "../../src/types/interfaces.ts";
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

test("A12: dispatch-failed whose own recording conflicts in the store -> exit 4", async () => {
  // `run.ts:558`'s own comment on this branch: exit 4 fires only when *recording* a
  // dispatch-failed completion itself fails (a store-level conflict/invalid on top of an
  // already-failed dispatch) — an ordinary dispatch-failed completion is recorded successfully
  // and handled entirely by R-29/R-30's own retry/exhaust policy (a retry redispatches; exhaustion
  // fails the Run, exit 10), never by this exit code. `applyStep` itself never returns exit code
  // 4 for any input (see `step.ts`'s own `ApplyStepOutput.exitCode` doc comment, narrowed as part
  // of this same task) — `run.ts` computes exit 4 itself, at its own call site, by checking
  // `completionEnvelope.eventType === "dispatch-failed"` against whatever nonzero exit `applyStep`
  // returned for *any* reason.
  //
  // The store-level conflict is injected directly (a `Proxy` around `ctx.store` that makes
  // `append()` reject exactly the dispatch-failed completion with `seq_conflict`) rather than
  // raced with two real processes, the way `test/driver/concurrency.test.ts` races the loop's own
  // lock: `applyStep`'s own comment on `skipLockCheck` callers already says why a genuine race
  // cannot land here in the first place — "hold the loop's lock and are the run's only writer, so
  // this branch is store-level defence in depth for them, not a case they are expected to hit".
  // Exercising defence-in-depth honestly means injecting the fault it defends against, not
  // engineering an artificial multi-process race against a lock this same run already holds
  // exclusively for its own entire lifetime.
  const repo = await makeScratchRepo();
  const ctx = await openTestContext(repo, EXIT_CODES_LOOP_PATH);
  try {
    const realAppend = ctx.store.append.bind(ctx.store);
    const wrappedStore = new Proxy(ctx.store, {
      get(target, prop, receiver) {
        if (prop === "append") {
          return (runId: string, input: AppendInput): AppendResult => {
            if (input.applied?.eventType === "dispatch-failed") {
              return { ok: false, reason: "seq_conflict" };
            }
            return realAppend(runId, input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const wrappedCtx = { ...ctx, store: wrappedStore };

    // No "fake" entry in the dispatcher map: `step`'s own backend (`fake`, exit-codes.loop.yaml's
    // `defaults.backend`) resolves to no registered `Dispatcher`, so `run.ts`'s dispatch loop
    // takes the `!dispatcher` branch — `buildDispatchFailedEnvelope({code: "no_dispatcher", ...})`
    // — the simpler of the two ways a dispatch-failed completion is built (the other,
    // `dispatcher.dispatch()` itself rejecting, reaches the exact same `applyStep` call
    // afterwards, so it is not a second thing this test needs to also cover).
    const result = await runLoop({ ctx: wrappedCtx, trigger: TRIGGER, dispatchers: {} });

    assert.equal(result.exitCode, 4);
    assert.equal(result.state, null);
    assert.equal(result.outcome, null);
  } finally {
    ctx.close();
    await repo.cleanup();
  }
});

// A12: exit 23 ("Run exiting while INTERRUPTED", state-machine.md §12.2) has no test in this file.
// **Report**: it was investigated, not skipped. `continueRun` (`src/driver/run.ts`, shared by
// `runLoop` and `gates.ts`'s `decideGate`) checks `finalSnapshot.status === "INTERRUPTED"` only
// once its own dispatch loop has already broken out — and that loop only ever breaks on
// `current.nodeState !== "DISPATCHED"` (or `current === null`). The only rule that ever produces
// `INTERRUPTED` is R-32 (`lease-expired` on an `effects: external` node — `test/driver/
// sweep.test.ts`'s A11 tests exercise it directly), and it never changes `current` at all: it
// only ever changes `status`/`interrupted`/`lease`/the attempt record, leaving `current.nodeState`
// exactly where the dispatch left it (state-machine.md §13.6's "external-effects variant" worked
// trace, row 1 — the same reference loop's `create-pr`, also effects:external: "node state frozen
// at DISPATCHED"). `node-started` — the one event that *would* move `current.nodeState` off
// `DISPATCHED` before a lease could expire — is never emitted by any m1 backend (`fake`/`local`):
// state-machine.md §2.3's own Node Execution state table restricts it to backends whose
// capability is `result: streamed`, which m1 has none of. So an `INTERRUPTED` snapshot's
// `current.nodeState` is always `DISPATCHED`, which can only ever make `continueRun`'s dispatch
// loop try to dispatch that same attempt *again* — except `assertActionsAgree` (`run.ts`'s own
// I-30-style guard, called at the top of every loop iteration) throws `internal_invariant` first:
// its own `current.nodeState === "DISPATCHED"` branch unconditionally demands exactly one
// `dispatch` action, but R-32's result carries zero (its own action is `wait(until: null)`
// instead) — confirmed empirically, not just read off the source, by constructing exactly this
// snapshot with the real engine and feeding it to `continueRun()` directly: it throws
// `"snapshot says <node> ... is DISPATCHED, but result.actions carries 0 dispatch action(s)
// instead of exactly one"` rather than ever reaching the exit-23 branch.
//
// More basically, `continueRun` is never actually offered the chance to hit this on any real
// entrypoint anyway: `runSweep()` (`src/driver/sweep.ts`) is the only thing that ever applies a
// `lease-expired`, and its own doc comment already says why it stops there — "records the
// resulting action in the returned list without performing it" — never calling `continueRun` with
// that result. `runLoop`'s and `decideGate`'s own initial calls into `continueRun` (`run-requested`
// / `human-decided`) can never themselves produce `INTERRUPTED` either — R-32 is the only rule
// that sets `status: "INTERRUPTED"` anywhere in `engine/transition.ts`, and neither of those two
// event types reaches it. `loopmill resume` (state-machine.md R-48..R-50, the only rule family
// that ever *leaves* `INTERRUPTED`) does not exist as a CLI command in m1 at all (`cli/main.ts` has
// no `resume` case) — confirming the m1-plan.md brief's own framing that `resume`/A11's
// `--due` half is m2. Given all of the above, exit 23 has no reachable path through any m1
// entrypoint as currently wired; writing a test that reaches it would require either fabricating a
// `TransitionResult` no real `transition()` call can produce (routing around
// `assertActionsAgree`, not exercising it) or fixing `run.ts`/`assertActionsAgree` to check
// `snapshot.status` before `current.nodeState` — a behaviour change this task's own instructions
// rule out ("do not change any behaviour to make a test pass") and `run.ts` is outside this task's
// file list beyond the one authorized, narrower fix in `step.ts`. Left for whoever owns `run.ts`
// to weigh in on.
