// `loopmill resume`/`loopmill resume --due` (`src/driver/resume.ts`): R-40..R-42
// (`WAITING_FOR_QUOTA`), R-48..R-50 (`INTERRUPTED`), and A37 (`resume --due` is idempotent and
// safe to run concurrently with itself). Modelled on `test/driver/sweep.test.ts`, which this file
// borrows its `controllableClock`/`crashMidDispatch` shape from: the crash is simulated the same
// way (a real dispatch through `applyStep`/`continueRun`, then the dispatcher throws instead of
// resolving, leaving a committed `node-dispatched` and a live lock the way a `kill -9` would),
// because `resumeRun`'s own `INTERRUPTED` branch needs a Run that genuinely reached that state
// through the sweep, not a hand-built snapshot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";

import { DEFAULT_POLICY_FULL } from "../../src/engine/index.ts";
import { makeEnvelope, newRunId } from "../../src/envelope/index.ts";
import { applyStep, continueRun, openRunContext, resumeDue, resumeRun, runLoop, runSweep } from "../../src/driver/index.ts";
import { FakeDispatcher } from "../../src/backends/fake/index.ts";
import { ensureLayout, openStore, resolveLoopmillHome, type SqliteStore } from "../../src/store/index.ts";
import type { Dispatcher } from "../../src/types/interfaces.ts";
import type { JsonValue } from "../../src/types/loop.ts";
import type { TriggerPayload } from "../../src/types/envelope.ts";
import type { RunContext, Clock } from "../../src/driver/index.ts";
import {
  CLI_GATE_LOOP_PATH,
  EXIT_CODES_LOOP_PATH,
  NOW,
  makeScratchRepo,
  openTestContext,
  type ScratchRepo,
} from "../fixtures/driver/helpers.ts";

const TRIGGER: TriggerPayload = { kind: "manual" };
const TRIGGER_JSON: JsonValue = { kind: "manual" };

/** Identical to `test/driver/sweep.test.ts`'s own helper: a clock this file drives explicitly
 * (park/crash at `t0`, resume at `t0 + a while`), never advancing on its own. */
function controllableClock(start: string): Clock & { advanceMs(ms: number): void } {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advanceMs(ms: number) {
      t += ms;
    },
  };
}

/** Identical in shape to `sweep.test.ts`'s own `crashOnDispatch`: wraps a real `Dispatcher` so a
 * dispatch addressed to `crashNodeId` throws instead of resolving, indistinguishable from the
 * process itself dying (never a `LoopmillError("dispatch_failed")`, which `continueRun` would
 * instead fold into an ordinary completion). */
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

/** Drives a fresh Run of `daily-content-improvement` (`CLI_GATE_LOOP_PATH`) through
 * `review-content`'s successful completion — which dispatches `create-issue` next — and then
 * "crashes" before `create-issue`'s own completion ever arrives, leaving a committed
 * `node-dispatched` and a live lock exactly as `sweep.test.ts`'s own `crashMidDispatch` does
 * (this is the same helper, reproduced here rather than imported across test files). */
async function crashMidDispatch(ctx: RunContext, clock: Clock): Promise<string> {
  const crashNodeId = "create-issue";
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
        trigger: TRIGGER_JSON,
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

/** Sweeps `ctx.loop` once, against `clock`'s current instant — the same call `sweep.test.ts` makes
 * directly to turn a crashed-and-abandoned `effects: external` attempt into `INTERRUPTED` (R-32).
 * Used here only to establish the `INTERRUPTED` *precondition* the tests below then exercise —
 * `resumeRun`/`resumeDue` each run their own sweep first regardless (mvp-design.md §7.5), so this
 * is never standing in for that. */
function sweepOnce(ctx: RunContext, clock: Clock): void {
  const outcomes = runSweep({ store: ctx.store, clock, loops: (loopId) => (loopId === ctx.loop.slug ? ctx.loop : null), policy: DEFAULT_POLICY_FULL });
  assert.equal(outcomes.length, 1, "test setup: exactly one expired lease to sweep");
}

async function withInterrupted(run: (ctx: RunContext, clock: ReturnType<typeof controllableClock>, runId: string, repo: ScratchRepo) => Promise<void>): Promise<void> {
  const repo = await makeScratchRepo();
  const clock = controllableClock(NOW);
  const ctx = await openTestContext(repo, CLI_GATE_LOOP_PATH, clock);
  try {
    const runId = await crashMidDispatch(ctx, clock);
    // Well past create-issue's own timeout (PT5M) plus the dispatch grace period (120s) —
    // sweep.test.ts's own margin.
    clock.advanceMs(60 * 60 * 1000);
    sweepOnce(ctx, clock);
    assert.equal(ctx.store.read(runId)!.status, "INTERRUPTED", "test setup: the run must be INTERRUPTED before the test under `run` begins");
    await run(ctx, clock, runId, repo);
  } finally {
    ctx.close();
    await repo.cleanup();
  }
}

/** The script `--decision retry`/`--decision skip` both need past `create-issue`'s own re-dispatch
 * (attempt 2, since attempt 1 was the crashed one): the rest of `daily-content-improvement`'s
 * happy path, verbatim from `test/fixtures/backends/fake/reference-happy.json`, far enough to
 * reach the `approve-pr` gate (`WAITING_HUMAN`, exit 20) — proof the Run actually proceeded, not
 * just that one node re-dispatched. */
function restOfHappyPathScript(): Record<string, unknown> {
  return {
    "0:create-issue:2": { status: "succeeded", exitCode: 0, stdout: "https://github.com/example/example/issues/482\n" },
    "1:implement:1": {
      status: "succeeded",
      structured: { changed: true, summary: "Updated the version string and added a regression test." },
      usageFixture: "claude-recorded-success",
      filesChanged: [{ path: "site/article.md", digest: `sha256:${"a".repeat(64)}` }],
    },
    "1:run-tests:1": { status: "succeeded", exitCode: 0, stdout: "5 passing (120ms)\n" },
    "1:review-changes:1": {
      status: "succeeded",
      structured: { approved: true, reasons: "matches the finding, tests pass" },
      usageFixture: "codex-recorded-structured",
    },
  };
}

test("A12/exit 23: resume <runId> with no --decision on an INTERRUPTED run exits 23 and writes nothing — exit 23 finally has a reachable producer", async () => {
  await withInterrupted(async (ctx, clock, runId) => {
    const beforeSnapshot = ctx.store.read(runId)!;
    const beforeEvents = ctx.store.readEvents(runId);
    const lockBefore = ctx.store.readLock(ctx.loop.slug);
    assert.equal(lockBefore, null, "test setup: R-32 released the lock when it parked the run INTERRUPTED");

    const result = await resumeRun({ ctx, runId, clock, stdout: { write: () => {} }, stderr: { write: () => {} } });

    assert.equal(result.exitCode, 23);
    assert.equal(result.state, "INTERRUPTED");
    assert.equal(result.outcome, null);

    const afterSnapshot = ctx.store.read(runId)!;
    const afterEvents = ctx.store.readEvents(runId);
    assert.deepEqual(afterSnapshot, beforeSnapshot, "no --decision must not change the snapshot at all");
    assert.equal(afterEvents.length, beforeEvents.length, "no --decision must not append to the journal");
    for (let i = 0; i < beforeEvents.length; i++) {
      assert.deepEqual(afterEvents[i], beforeEvents[i], `event ${i} must be byte-for-byte unchanged`);
    }
    assert.equal(ctx.store.readLock(ctx.loop.slug), null, "no --decision must not take the loop's lock");
  });
});

test("R-48: resume <runId> --decision retry re-dispatches create-issue attempt 2 and the run proceeds to the next gate", async () => {
  await withInterrupted(async (ctx, clock, runId) => {
    const dispatchers = { fake: new FakeDispatcher({ steps: restOfHappyPathScript() } as ConstructorParameters<typeof FakeDispatcher>[0]) };

    const result = await resumeRun({ ctx, runId, decision: "retry", actor: "maintainer", clock, dispatchers, stdout: { write: () => {} } });

    assert.equal(result.exitCode, 20, "the run must proceed all the way to the cli-mode gate");
    assert.equal(result.state, "WAITING_HUMAN");

    const snapshot = ctx.store.read(runId)!;
    assert.equal(snapshot.nodes["0:create-issue"]?.state, "SUCCEEDED");
    assert.equal(snapshot.nodes["0:create-issue"]?.attemptsUsed, 2, "R-48 dispatched attempt n+1, not a fresh attempt 1");
    assert.equal(snapshot.interrupted, null);

    const events = ctx.store.readEvents(runId);
    const resumedEvent = events.find((e) => e.envelope.eventType === "resumed");
    assert.ok(resumedEvent, "a resumed event must be in the journal");
    assert.equal(resumedEvent!.envelope.producer, "human");
    assert.deepEqual(resumedEvent!.envelope.resume, { kind: "interrupted", decision: "retry", actor: "maintainer" });
    // envelope.schema.json: resumed is a run-level event type — cycle/nodeId/attempt are
    // forbidden on it, never populated from the interrupted record's own coordinates.
    assert.equal(resumedEvent!.envelope.cycle, undefined);
    assert.equal(resumedEvent!.envelope.nodeId, undefined);
    assert.equal(resumedEvent!.envelope.attempt, undefined);
  });
});

test("R-49: resume <runId> --decision skip records create-issue SKIPPED and moves on to implement", async () => {
  await withInterrupted(async (ctx, clock, runId) => {
    // `implement`'s own `issue_url` input is `nodes.create-issue.stdout` — a SKIPPED create-issue
    // never sets it, so `continueRun`'s dispatch loop fails to resolve implement's inputs
    // (`loop-file/references.ts`'s `unresolved_reference`, exit 1) the moment it tries to actually
    // dispatch it. That failure is downstream of R-49 itself, not a symptom of this driver code:
    // the `resumed` event's own transition already recorded create-issue SKIPPED and dispatched
    // implement — durably, in the *first* `applyStep` call, which commits before `continueRun`
    // ever tries to spend anything — so the resulting snapshot is asserted directly rather than
    // requiring the whole run to complete past a node this loop's own fixture graph was never
    // designed to have skipped (its very next node depends on the skipped node's own output).
    const dispatchers = { fake: new FakeDispatcher({ steps: restOfHappyPathScript() } as ConstructorParameters<typeof FakeDispatcher>[0]) };

    const result = await resumeRun({ ctx, runId, decision: "skip", clock, dispatchers, stdout: { write: () => {} }, stderr: { write: () => {} } });

    assert.equal(result.exitCode, 1, "downstream of R-49: implement's own issue_url input cannot resolve once create-issue is skipped");

    const snapshot = ctx.store.read(runId)!;
    assert.equal(snapshot.nodes["0:create-issue"]?.state, "SKIPPED");
    assert.equal(snapshot.interrupted, null, "R-49 clears interrupted before dispatching the next node");
    assert.equal(snapshot.current?.nodeId, "implement", "routing moved past create-issue to implement");
    assert.equal(snapshot.current?.nodeState, "DISPATCHED");
    assert.equal(snapshot.current?.attempt, 1, "a fresh node, not a retried attempt of create-issue");
    assert.equal(snapshot.current?.cycleIndex, 1, "implement is the retry edge's own body node — entering it for the first time starts cycle 1");

    const events = ctx.store.readEvents(runId);
    const resumedEvent = events.find((e) => e.envelope.eventType === "resumed");
    assert.ok(resumedEvent);
    assert.deepEqual(resumedEvent!.envelope.resume, { kind: "interrupted", decision: "skip", actor: "operator" });
  });
});

test("R-50: resume <runId> --decision fail finishes the run FAILED(interrupted_abandoned) -> exit 10", async () => {
  await withInterrupted(async (ctx, clock, runId) => {
    const interruptedBefore = ctx.store.read(runId)!.interrupted;

    const result = await resumeRun({ ctx, runId, decision: "fail", actor: "maintainer", clock, dispatchers: {}, stdout: { write: () => {} } });

    assert.equal(result.exitCode, 10);
    assert.equal(result.state, "FAILED");
    assert.equal(result.outcome?.state, "FAILED");
    if (result.outcome?.state === "FAILED") {
      assert.equal(result.outcome.failureReason, "interrupted_abandoned");
      assert.equal(result.outcome.nodeId, "create-issue");
    }

    const snapshot = ctx.store.read(runId)!;
    assert.equal(snapshot.status, "FAILED");
    // `applyFinish` (engine/transition.ts) clears `current`/`lease`/`observe`/`quota` on every
    // terminal transition but deliberately leaves `interrupted` alone — nothing routes off it
    // once the Run is terminal, and the record is worth keeping for the audit trail (which node,
    // cycle and attempt the Run was abandoned at).
    assert.deepEqual(snapshot.interrupted, interruptedBefore);
  });
});

test("resume <runId> on a WAITING_HUMAN run exits 2 and writes nothing (points at approve|reject instead)", async () => {
  const repo = await makeScratchRepo();
  const clock = controllableClock(NOW);
  const ctx = await openTestContext(repo, CLI_GATE_LOOP_PATH, clock);
  try {
    const happyScript = {
      "0:review-content:1": {
        status: "succeeded" as const,
        structured: { needs_issue: true, title: "t", summary: "s" },
        usageFixture: "codex-recorded-success",
      },
      "0:create-issue:1": { status: "succeeded" as const, exitCode: 0, stdout: "https://github.com/example/example/issues/482\n" },
      "1:implement:1": {
        status: "succeeded" as const,
        structured: { changed: true, summary: "fix" },
        usageFixture: "claude-recorded-success",
        filesChanged: [{ path: "a.md", digest: `sha256:${"b".repeat(64)}` }],
      },
      "1:run-tests:1": { status: "succeeded" as const, exitCode: 0 },
      "1:review-changes:1": { status: "succeeded" as const, structured: { approved: true, reasons: "ok" }, usageFixture: "codex-recorded-structured" },
    };
    const dispatchers = { fake: new FakeDispatcher({ steps: happyScript } as ConstructorParameters<typeof FakeDispatcher>[0]) };
    const runResult = await runLoop({ ctx, trigger: TRIGGER, dispatchers, stdout: { write: () => {} } });
    assert.equal(runResult.exitCode, 20);
    assert.equal(runResult.state, "WAITING_HUMAN");
    const runId = runResult.runId!;

    const beforeSnapshot = ctx.store.read(runId)!;
    const beforeEvents = ctx.store.readEvents(runId);

    const result = await resumeRun({ ctx, runId, clock, stdout: { write: () => {} }, stderr: { write: () => {} } });
    assert.equal(result.exitCode, 2);

    const afterSnapshot = ctx.store.read(runId)!;
    const afterEvents = ctx.store.readEvents(runId);
    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(afterEvents.length, beforeEvents.length);
  } finally {
    ctx.close();
    await repo.cleanup();
  }
});

test("resume <runId> on a terminal run exits 2 and writes nothing", async () => {
  const repo = await makeScratchRepo();
  const ctx = await openTestContext(repo, EXIT_CODES_LOOP_PATH);
  try {
    const dispatchers = { fake: new FakeDispatcher({ steps: { "0:step:1": { status: "succeeded", structured: { ok: true } } } }) };
    const runResult = await runLoop({ ctx, trigger: TRIGGER, dispatchers, stdout: { write: () => {} } });
    assert.equal(runResult.exitCode, 0);
    assert.equal(runResult.state, "SUCCEEDED");
    const runId = runResult.runId!;

    const beforeSnapshot = ctx.store.read(runId)!;
    const beforeEvents = ctx.store.readEvents(runId);

    const result = await resumeRun({ ctx, runId, clock: ctx.clock, stdout: { write: () => {} }, stderr: { write: () => {} } });
    assert.equal(result.exitCode, 2);

    const afterSnapshot = ctx.store.read(runId)!;
    const afterEvents = ctx.store.readEvents(runId);
    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(afterEvents.length, beforeEvents.length);
  } finally {
    ctx.close();
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// resume --due
// ---------------------------------------------------------------------------------------------

async function openSharedStore(repoRoot: string): Promise<SqliteStore> {
  const home = resolveLoopmillHome({ repoRoot, env: {} });
  const layout = await ensureLayout(home.home);
  return openStore(layout.stateDb);
}

/** `resumeDue`'s own `resolveContext` resolves a run's stored `loopId` (a slug) back to its loop
 * file. In a real repository that means `<home>/<slug>.loop.yaml` (or the `examples/` dogfooding
 * fallback, `context.ts`'s `resolveLoopPath`) — but these tests' loop fixtures live under
 * `test/fixtures/driver/`, outside every scratch repo's own tree, so `slug` alone would never
 * resolve there. This small lookup stands in for "the loop file `resume --due` would have found
 * in a real checkout" by going straight to each fixture's own known path instead. */
function makeResolveContext(repoRoot: string, clock: Clock): (loopId: string) => Promise<RunContext | null> {
  const pathsBySlug: Record<string, string> = {
    "exit-codes": EXIT_CODES_LOOP_PATH,
    "daily-content-improvement": CLI_GATE_LOOP_PATH,
  };
  return async (loopId) => {
    const loopPath = pathsBySlug[loopId];
    if (!loopPath) return null;
    try {
      return await openRunContext({ repoRoot, env: {}, clock, loopPath });
    } catch {
      return null;
    }
  };
}

test("resume --due with nothing due exits 0 and writes nothing", async () => {
  const repo = await makeScratchRepo();
  try {
    const store = await openSharedStore(repo.repoRoot);
    try {
      const result = await resumeDue({
        store,
        resolveContext: async () => null,
        clock: controllableClock(NOW),
        stdout: { write: () => {} },
      });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.resumed, []);
      assert.deepEqual(result.skipped, []);
    } finally {
      store.close();
    }
  } finally {
    await repo.cleanup();
  }
});

test("resume --due resumes a WAITING_FOR_QUOTA run whose resumeDueAt has passed and leaves one whose resumeDueAt has not passed untouched", async () => {
  const repo = await makeScratchRepo();
  const clock = controllableClock(NOW);
  try {
    // Loop A (exit-codes): quotaResetsAt 10 minutes out -> resumeDueAt = +10m+60s jitter.
    const ctxA = await openTestContext(repo, EXIT_CODES_LOOP_PATH, clock);
    const quotaFailDispatchers = (resetsAt: string) => ({
      fake: new FakeDispatcher({
        steps: { "0:step:1": { status: "failed", error: { code: "quota", message: "usage limit", classified: "quota" }, quotaResetsAt: resetsAt } },
      }),
    });
    const parkA = await runLoop({ ctx: ctxA, trigger: TRIGGER, dispatchers: quotaFailDispatchers("2026-09-06T06:10:00.000Z"), stdout: { write: () => {} } });
    assert.equal(parkA.exitCode, 21, "test setup: run A must park WAITING_FOR_QUOTA");
    const runIdA = parkA.runId!;
    ctxA.close();

    // Loop B (daily-content-improvement): quotaResetsAt 2 hours out -> resumeDueAt way later.
    const ctxB = await openTestContext(repo, CLI_GATE_LOOP_PATH, clock);
    const parkB = await runLoop({
      ctx: ctxB,
      trigger: TRIGGER,
      dispatchers: { fake: new FakeDispatcher({ steps: { "0:review-content:1": { status: "failed", error: { code: "quota", message: "usage limit", classified: "quota" }, quotaResetsAt: "2026-09-06T08:00:00.000Z" } } }) },
      stdout: { write: () => {} },
    });
    assert.equal(parkB.exitCode, 21, "test setup: run B must park WAITING_FOR_QUOTA");
    const runIdB = parkB.runId!;
    const snapshotBBefore = ctxB.store.read(runIdB)!;
    ctxB.close();

    // Now: past A's resumeDueAt (06:11:00Z), well before B's (08:01:00Z).
    clock.advanceMs(30 * 60 * 1000);

    const store = await openSharedStore(repo.repoRoot);
    try {
      const result = await resumeDue({
        store,
        resolveContext: makeResolveContext(repo.repoRoot, clock),
        clock,
        dispatchers: (ctx) =>
          ctx.loop.slug === "exit-codes"
            ? { fake: new FakeDispatcher({ steps: { "0:step:2": { status: "succeeded", structured: { ok: true } } } }) }
            : {},
        stdout: { write: () => {} },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.resumed.length, 1, "only the due run (A) is resumed");
      assert.equal(result.resumed[0]!.runId, runIdA);
      assert.equal(result.resumed[0]!.loopId, "exit-codes");
      assert.equal(result.resumed[0]!.exitCode, 0);
      assert.equal(result.resumed[0]!.state, "SUCCEEDED");
      assert.deepEqual(result.skipped, [], "run B is not due yet, so it is neither resumed nor skipped");

      const snapshotA = store.read(runIdA)!;
      assert.equal(snapshotA.status, "SUCCEEDED");

      const snapshotBAfter = store.read(runIdB)!;
      assert.equal(snapshotBAfter.status, "WAITING_FOR_QUOTA", "run B must be left exactly as it was");
      assert.deepEqual(snapshotBAfter, snapshotBBefore, "run B's snapshot is untouched, pinning the selection boundary");
    } finally {
      store.close();
    }
  } finally {
    await repo.cleanup();
  }
});

test("resume --due skips a loop whose lock is held by another live process, exits 0, and reports it skipped (A37)", async () => {
  const repo = await makeScratchRepo();
  const clock = controllableClock(NOW);
  try {
    const ctx = await openTestContext(repo, EXIT_CODES_LOOP_PATH, clock);
    const park = await runLoop({
      ctx,
      trigger: TRIGGER,
      dispatchers: { fake: new FakeDispatcher({ steps: { "0:step:1": { status: "failed", error: { code: "quota", message: "usage limit", classified: "quota" }, quotaResetsAt: "2026-09-06T06:10:00.000Z" } } }) },
      stdout: { write: () => {} },
    });
    assert.equal(park.exitCode, 21, "test setup: the run must park WAITING_FOR_QUOTA");
    const runId = park.runId!;
    const beforeSnapshot = ctx.store.read(runId)!;

    clock.advanceMs(30 * 60 * 1000);

    // Simulate another live process already driving this loop: a lock row this scan's own
    // acquireLock call must fail against, with a lease far enough in the future that this scan's
    // own sweep (which only releases rows whose lease has already expired) leaves it alone.
    const otherLeaseUntil = new Date(Date.parse(clock.now()) + 365 * 24 * 60 * 60 * 1000).toISOString();
    const held = ctx.store.acquireLock({ loopId: ctx.loop.slug, runId: "other_process_run", ownerPid: 999999, host: "other-host", now: clock.now(), leaseUntil: otherLeaseUntil });
    assert.ok(held.acquired, "test setup: the simulated other process must acquire the loop's lock");
    ctx.close();

    const store = await openSharedStore(repo.repoRoot);
    try {
      const result = await resumeDue({
        store,
        resolveContext: makeResolveContext(repo.repoRoot, clock),
        clock,
        stdout: { write: () => {} },
      });

      assert.equal(result.exitCode, 0, "a held lock is not a batch failure");
      assert.deepEqual(result.resumed, []);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0]!.runId, runId);
      assert.equal(result.skipped[0]!.loopId, "exit-codes");
      assert.equal(result.skipped[0]!.reason, "overlapping_run");

      const afterSnapshot = store.read(runId)!;
      assert.deepEqual(afterSnapshot, beforeSnapshot, "a skipped run is left exactly as it was");
    } finally {
      store.close();
    }
  } finally {
    await repo.cleanup();
  }
});
