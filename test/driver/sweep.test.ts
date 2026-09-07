// A11: "A process killed after `node-dispatched` was committed and before the completion leaves
// a complete journal; the next entrypoint reports `INTERRUPTED` after the lease expires"
// (docs/design/mvp-design.md §20.3). The `resume --due` half of A11 is m2 by design (no `resume`
// command exists yet — `docs/design/m1-plan.md`'s A11 row) and is out of scope here; this file
// covers the m1 half only: `runSweep()` itself (`src/driver/sweep.ts`), untested until now, and
// the observable result a later entrypoint reports once it runs.
//
// The crash is simulated the same way a real `kill -9` behaves: everything up to and including
// the `node-dispatched` commit goes through the normal `applyStep`/`continueRun` machinery (the
// same calls `run.ts`'s own dispatch loop makes), then the dispatcher itself throws instead of
// ever resolving — matching "the completion never arrives", not "the process cleaned up and
// exited". Crucially this drives `continueRun()` directly rather than `runLoop()`: `runLoop()`'s
// own `finally` always calls `ctx.store.releaseLock()`, which a real `kill -9` never runs (no
// `finally` block anywhere executes once the OS has torn down the process) — going through
// `runLoop()` here would release the very lock/lease row this test needs to survive the "crash"
// so the sweep has something to find later.
//
// `create-issue` (`test/fixtures/driver/daily-content-improvement.loop.yaml`) is used as the
// dispatched-and-abandoned node because it is `effects: external` (state-machine.md D-11):
// R-32's `onInterruptedRetry = !effectsExternal` only reaches `INTERRUPTED` for an external-effect
// node — an `effects: none` node (the default; `exit-codes.loop.yaml`'s only node) auto-retries
// on a lease-expired instead (or exhausts to FAILED), never reaching the status this file tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";

import { DEFAULT_POLICY_FULL } from "../../src/engine/index.ts";
import { makeEnvelope, newRunId } from "../../src/envelope/index.ts";
import { applyStep, continueRun, runSweep, statusOf } from "../../src/driver/index.ts";
import { FakeDispatcher } from "../../src/backends/fake/index.ts";
import type { Dispatcher } from "../../src/types/interfaces.ts";
import type { JsonValue } from "../../src/types/loop.ts";
import type { RunContext, Clock } from "../../src/driver/index.ts";
import { CLI_GATE_LOOP_PATH, NOW, makeScratchRepo, openTestContext, type ScratchRepo } from "../fixtures/driver/helpers.ts";

const TRIGGER: JsonValue = { kind: "manual" };

/** A clock this file drives explicitly (crash at `t0`, sweep at `t0 + a while`) — neither
 * `helpers.ts`'s `fixedClock` (never advances) nor its `advancingClock` (advances a fixed step on
 * every `.now()` call, which would also perturb every intermediate read this setup makes) fits;
 * this test needs full control over exactly when the clock jumps. */
function controllableClock(start: string): Clock & { advanceMs(ms: number): void } {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advanceMs(ms: number) {
      t += ms;
    },
  };
}

/** Wraps a real `Dispatcher` so a dispatch addressed to `crashNodeId` throws instead of
 * resolving — the one node this test's "process" never gets to finish. A plain `Error` (not a
 * `LoopmillError` carrying `code: "dispatch_failed"`) so `continueRun`'s own catch
 * (`src/driver/run.ts`'s dispatch loop) re-throws it rather than folding it into a
 * `dispatch-failed` completion (state-machine.md's own distinction: this must be indistinguishable
 * from the process itself dying, not from the backend reporting a failure it lived to report). */
function crashOnDispatch(inner: Dispatcher, crashNodeId: string): Dispatcher {
  return {
    capabilities: () => inner.capabilities(),
    describe: (request) => inner.describe(request),
    dispatch: async (request, clock) => {
      if (request.nodeId === crashNodeId) {
        throw new Error(`SIMULATED_CRASH: the process died mid-dispatch of "${crashNodeId}"`);
      }
      return inner.dispatch(request, clock);
    },
  };
}

/**
 * Drives a fresh Run of `daily-content-improvement` (`CLI_GATE_LOOP_PATH`) through
 * `review-content`'s successful completion — which dispatches `create-issue` next — and then
 * "crashes" before `create-issue`'s own completion ever arrives. On return the store holds: a
 * journal ending in `create-issue`'s `node-dispatched`, a snapshot with
 * `current = {nodeId: "create-issue", nodeState: "DISPATCHED", ...}`, and a live `locks` row
 * whose lease reflects that dispatch's own deadline (`applyStep`'s own `append({lease: ...})`
 * heartbeat-refresh) — never released, exactly as a real `kill -9` would leave it.
 */
async function crashMidDispatch(ctx: RunContext, clock: Clock, crashNodeId = "create-issue"): Promise<string> {
  const now = clock.now();
  const nowMs = Date.parse(now);
  const runId = newRunId(nowMs);
  const leaseUntil = new Date(nowMs + DEFAULT_POLICY_FULL.dispatchGraceSeconds * 1000).toISOString();
  const acquired = ctx.store.acquireLock({ loopId: ctx.loop.slug, runId, ownerPid: process.pid, host: hostname(), now, leaseUntil });
  assert.ok(acquired.acquired, "test setup: the loop's lock must be free at the start of the test");

  const runRequested = makeEnvelope(
    { eventType: "run-requested", producer: "trigger", loopId: ctx.loop.slug, loopVersion: ctx.loop.loopVersion, runId, trigger: { kind: "manual" } },
    { now },
  );
  const step1 = applyStep({ ctx, envelope: runRequested, clock, sweepFirst: false, skipLockCheck: true });
  assert.equal(step1.exitCode, 0, "test setup: run-requested must be accepted");
  assert.ok(step1.result && step1.result.kind === "applied", "test setup: run-requested must be applied");

  // `usageFixture` matters here only to avoid tripping `BUDGET_EXCEEDED(maxUnmeasuredExecutions)`
  // on the very first dispatch — the loop's own budget declares no override, so the default of 0
  // unmeasured executions (loop-file.md §7.2) would otherwise fail the Run before it ever reaches
  // `create-issue`, before the scenario this test needs even gets set up.
  const fake = new FakeDispatcher({
    steps: {
      "0:review-content:1": {
        status: "succeeded",
        structured: { needs_issue: true, title: "stale version number", summary: "v1.2 vs v1.3" },
        usageFixture: "codex-recorded-success",
      },
    },
  });
  const dispatchers = { fake: crashOnDispatch(fake, crashNodeId) };

  await assert.rejects(
    () =>
      continueRun({
        ctx,
        dispatchers,
        policy: DEFAULT_POLICY_FULL,
        clock,
        trigger: TRIGGER,
        heartbeatSeconds: 0,
        stdout: { write: () => {} },
        runId,
        result: step1.result!,
      }),
    /SIMULATED_CRASH/,
    "test setup: continueRun must propagate the simulated crash uncaught (never releasing the lock)",
  );

  return runId;
}

async function withContext(run: (ctx: RunContext, clock: ReturnType<typeof controllableClock>, repo: ScratchRepo) => Promise<void>): Promise<void> {
  const repo = await makeScratchRepo();
  const clock = controllableClock(NOW);
  const ctx = await openTestContext(repo, CLI_GATE_LOOP_PATH, clock);
  try {
    await run(ctx, clock, repo);
  } finally {
    ctx.close();
    await repo.cleanup();
  }
}

test("A11: runSweep() sweeps a Run whose node-dispatched is committed and whose lock's lease has expired into INTERRUPTED, journal intact", async () => {
  await withContext(async (ctx, clock) => {
    const runId = await crashMidDispatch(ctx, clock);

    const beforeSnapshot = ctx.store.read(runId)!;
    assert.equal(beforeSnapshot.status, "RUNNING");
    assert.equal(beforeSnapshot.current?.nodeId, "create-issue");
    assert.equal(beforeSnapshot.current?.nodeState, "DISPATCHED");
    const beforeEvents = ctx.store.readEvents(runId);
    assert.ok(beforeEvents.some((e) => e.envelope.eventType === "node-dispatched" && e.envelope.nodeId === "create-issue"), "the crashed attempt's node-dispatched must already be in the journal");

    const lockBefore = ctx.store.readLock(ctx.loop.slug);
    assert.ok(lockBefore, "the crashed process's lock/lease row must still be live — nothing ever released it");

    // Well past create-issue's own timeout (PT5M) plus the dispatch grace period (120s).
    clock.advanceMs(60 * 60 * 1000);

    const outcomes = runSweep({
      store: ctx.store,
      clock,
      loops: (loopId) => (loopId === ctx.loop.slug ? ctx.loop : null),
      policy: DEFAULT_POLICY_FULL,
    });

    assert.equal(outcomes.length, 1, "exactly one expired lease: this run's own");
    const outcome = outcomes[0]!;
    assert.equal(outcome.runId, runId);
    assert.equal(outcome.loopId, ctx.loop.slug);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.skipReason, undefined);
    // state-machine.md R-32: a lease-expired on an effects:external node's attempt is never
    // auto-retried — the recorded action is wait(∞), never a fresh dispatch.
    assert.deepEqual(outcome.actions, [{ type: "wait", until: null }]);

    const afterSnapshot = ctx.store.read(runId)!;
    assert.equal(afterSnapshot.status, "INTERRUPTED");
    assert.deepEqual(afterSnapshot.interrupted, { nodeId: "create-issue", cycleIndex: 0, attempt: 1, reason: "attempt_deadline", at: clock.now() });
    // state-machine.md §13.6's own "external-effects variant" worked trace, row 1 (the same
    // reference loop's `create-pr`, also effects:external): "node state frozen at DISPATCHED" —
    // R-32 never touches `snapshot.current` itself, only `status`/`interrupted`/`lease`/the
    // attempt record.
    assert.equal(afterSnapshot.current?.nodeId, "create-issue");
    assert.equal(afterSnapshot.current?.nodeState, "DISPATCHED");
    assert.equal(afterSnapshot.lease, null);
    assert.equal(afterSnapshot.attempts["0:create-issue:1"]?.state, "LOST");

    // `store.sweep()` deletes the `locks` row unconditionally once its lease is in the past
    // (sweep.ts's own doc comment) — freeing the loop for a fresh `run` to acquire it.
    assert.equal(ctx.store.readLock(ctx.loop.slug), null);

    // The journal is intact: every event recorded before the sweep is still there, byte-for-byte,
    // in the same order, plus exactly one new lease-expired event appended at the end — nothing
    // lost, nothing rewritten (state-machine.md §6.5: on an INTERRUPTED-then-abandoned Run "the
    // engine records and labels, and never destroys").
    const afterEvents = ctx.store.readEvents(runId);
    assert.equal(afterEvents.length, beforeEvents.length + 1);
    for (let i = 0; i < beforeEvents.length; i++) {
      assert.deepEqual(afterEvents[i], beforeEvents[i], `pre-sweep event ${i} must be byte-for-byte unchanged`);
    }
    const lastEvent = afterEvents[afterEvents.length - 1]!;
    assert.equal(lastEvent.kind, "applied");
    assert.equal(lastEvent.envelope.eventType, "lease-expired");
    assert.equal(lastEvent.envelope.cycle, 0);
    assert.equal(lastEvent.envelope.nodeId, "create-issue");
    assert.equal(lastEvent.envelope.attempt, 1);
    assert.equal(lastEvent.envelope.reason, "attempt_deadline");
  });
});

test("A11: the next entrypoint (status) reports INTERRUPTED once the lease has expired", async () => {
  await withContext(async (ctx, clock) => {
    const runId = await crashMidDispatch(ctx, clock);
    clock.advanceMs(60 * 60 * 1000);

    // `statusOf` (src/driver/status.ts) sweeps first, exactly like `run`/`step` — this is "the
    // next entrypoint" A11 asks for, standing in for a fresh `loopmill status <runId>` after the
    // crash: nobody re-drove this Run, yet it now reports itself accurately instead of reading
    // "RUNNING" forever (mvp-design.md §17.4's own framing for why the sweep exists at all).
    const view = statusOf(ctx, runId);
    assert.ok(view, "status must find the run");
    assert.equal(view!.state, "INTERRUPTED");
    assert.equal(view!.currentNode, "create-issue");
    assert.equal(view!.next, "resumed{kind:interrupted} (resume is m2)");

    // Confirmed via the store directly too, not only the status view's own rendering.
    const snapshot = ctx.store.read(runId)!;
    assert.equal(snapshot.status, "INTERRUPTED");

    // And the swept lock is gone, same as the direct-runSweep() test above.
    assert.equal(ctx.store.readLock(ctx.loop.slug), null);
  });
});

// The orphaning defect, fixed 2026-09-08 (`docs/design/m2-plan.md` §2.2). Everything above uses
// `create-issue`, which is `effects: external`: R-32 parks the Run `INTERRUPTED` with no lease, so
// releasing the `locks` row is right and the bug never showed. `review-content` is `effects: none`
// — the default, and what every agent node in every loop here is — so R-31 auto-retries instead,
// and the sweep's own bookkeeping is what decides whether that retry is ever seen again.
//
// Before the fix, `SqliteStore.sweep()` deleted the row as part of the scan. The re-dispatch's
// fresh lease was then written by `append` as an `UPDATE ... WHERE loop_id = ? AND run_id = ?`
// against a row that no longer existed — zero rows, silently — and since the scan's only index was
// that same row, no later sweep could ever see the Run again. It stayed `RUNNING` for ever with a
// live `snapshot.lease` nobody was serving: the silent Run `mvp-design.md` §17.4 forbids, reached
// by an ordinary crash on an ordinary node.
test("the sweep never orphans a Run: an effects:none lease-expiry keeps its lock row, stays visible, and ends FAILED rather than silent", async () => {
  await withContext(async (ctx, clock) => {
    const runId = await crashMidDispatch(ctx, clock, "review-content");
    assert.equal(ctx.store.read(runId)!.current?.nodeId, "review-content", "test setup: the crashed node must be the effects:none one");

    const sweepOnce = () =>
      runSweep({ store: ctx.store, clock, loops: (loopId) => (loopId === ctx.loop.slug ? ctx.loop : null), policy: DEFAULT_POLICY_FULL });

    clock.advanceMs(60 * 60 * 1000);
    const first = sweepOnce();
    assert.equal(first.length, 1);
    const firstOutcome = first[0]!;
    assert.equal(firstOutcome.applied, true);
    // state-machine.md R-31: an effects:none node is safely re-dispatchable, so the recorded
    // action is a fresh dispatch — which `runSweep` deliberately does not perform.
    assert.equal(firstOutcome.actions[0]?.type, "dispatch");
    assert.equal(firstOutcome.lockReleased, false, "the row must survive to carry the fresh attempt's lease");

    const afterFirst = ctx.store.read(runId)!;
    assert.equal(afterFirst.status, "RUNNING");
    assert.equal(afterFirst.current?.attempt, 2, "R-31 installed attempt n+1");
    assert.ok(afterFirst.lease, "which carries its own lease");
    const lockAfterFirst = ctx.store.readLock(ctx.loop.slug);
    assert.ok(lockAfterFirst, "and the locks row still exists to hold it — the regression this test exists for");
    assert.equal(lockAfterFirst!.leaseUntil, afterFirst.lease!.expiresAt, "row and snapshot agree on the new lease");

    // Nobody ever dispatched attempt 2. The Run must therefore still be reachable by the next
    // sweep; before the fix it was not, because the row indexing it had just been deleted.
    clock.advanceMs(60 * 60 * 1000);
    const second = sweepOnce();
    assert.equal(second.length, 1, "the Run is still visible to a later entrypoint's sweep");

    // And it terminates: attempts exhaust into a reported terminal state instead of a RUNNING
    // snapshot nothing will ever answer.
    const afterSecond = ctx.store.read(runId)!;
    assert.equal(afterSecond.status, "FAILED");
    assert.equal(afterSecond.lease, null);
    assert.equal(second[0]!.lockReleased, true, "nothing holds the loop any more");
    assert.equal(ctx.store.readLock(ctx.loop.slug), null, "so a fresh run of this loop is free to start");
  });
});
