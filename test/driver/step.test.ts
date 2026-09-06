// `applyStep` (state-machine.md §12.1): applied -> 0, duplicate -> 0 with no new journal row,
// invalid -> 2, the loop's lock held by another live process -> 3.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";

import { applyStep } from "../../src/driver/index.ts";
import { makeEnvelope } from "../../src/envelope/index.ts";
import { EXIT_CODES_LOOP_PATH, fixedClock, makeScratchRepo, openTestContext } from "../fixtures/driver/helpers.ts";
import { newRunId } from "../../src/util/ulid.ts";

test("step: applied run-requested -> 0; the identical eventId again -> 0, duplicate, no new row", async () => {
  const repo = await makeScratchRepo();
  try {
    const clock = fixedClock();
    const ctx = await openTestContext(repo, EXIT_CODES_LOOP_PATH, clock);
    try {
      const runId = newRunId(Date.parse(clock.now()));
      const envelope = makeEnvelope(
        { eventType: "run-requested", producer: "trigger", loopId: ctx.loop.slug, loopVersion: ctx.loop.loopVersion, runId, trigger: { kind: "manual" } },
        { now: clock.now() },
      );

      const first = applyStep({ ctx, envelope, clock });
      assert.equal(first.exitCode, 0);
      assert.equal(first.result?.kind, "applied");
      const rowsAfterFirst = ctx.store.readEvents(runId).length;
      assert.ok(rowsAfterFirst > 0);

      const second = applyStep({ ctx, envelope, clock });
      assert.equal(second.exitCode, 0);
      assert.equal(second.result?.kind, "duplicate");
      const rowsAfterSecond = ctx.store.readEvents(runId).length;
      assert.equal(rowsAfterSecond, rowsAfterFirst, "P-4: a duplicate eventId writes no new row");
    } finally {
      ctx.close();
    }
  } finally {
    await repo.cleanup();
  }
});

test("step: an invalid envelope (unknown node) -> 2, nothing persisted", async () => {
  const repo = await makeScratchRepo();
  try {
    const clock = fixedClock();
    const ctx = await openTestContext(repo, EXIT_CODES_LOOP_PATH, clock);
    try {
      const runId = newRunId(Date.parse(clock.now()));
      const runRequested = makeEnvelope(
        { eventType: "run-requested", producer: "trigger", loopId: ctx.loop.slug, loopVersion: ctx.loop.loopVersion, runId, trigger: { kind: "manual" } },
        { now: clock.now() },
      );
      applyStep({ ctx, envelope: runRequested, clock });

      const bogus = makeEnvelope(
        {
          eventType: "node-completed",
          producer: "backend:fake",
          loopId: ctx.loop.slug,
          loopVersion: ctx.loop.loopVersion,
          runId,
          cycle: 0,
          nodeId: "does-not-exist",
          attempt: 1,
          result: { status: "succeeded" },
        },
        { now: clock.now() },
      );
      const rowsBefore = ctx.store.readEvents(runId).length;
      const out = applyStep({ ctx, envelope: bogus, clock });
      assert.equal(out.exitCode, 2);
      assert.equal(out.result?.kind, "invalid");
      assert.equal(ctx.store.readEvents(runId).length, rowsBefore, "an invalid envelope persists nothing");
    } finally {
      ctx.close();
    }
  } finally {
    await repo.cleanup();
  }
});

test("step: the loop's lock held by another live process -> 3, nothing persisted", async () => {
  const repo = await makeScratchRepo();
  try {
    const clock = fixedClock();
    const ctx = await openTestContext(repo, EXIT_CODES_LOOP_PATH, clock);
    try {
      const runId = newRunId(Date.parse(clock.now()));
      const runRequested = makeEnvelope(
        { eventType: "run-requested", producer: "trigger", loopId: ctx.loop.slug, loopVersion: ctx.loop.loopVersion, runId, trigger: { kind: "manual" } },
        { now: clock.now() },
      );

      // Simulate a live, different process holding the loop's lock.
      const nowMs = Date.parse(clock.now());
      ctx.store.acquireLock({
        loopId: ctx.loop.slug,
        runId: "run_other",
        ownerPid: 999999,
        host: hostname(),
        now: clock.now(),
        leaseUntil: new Date(nowMs + 60_000).toISOString(),
      });

      const out = applyStep({ ctx, envelope: runRequested, clock });
      assert.equal(out.exitCode, 3);
      assert.equal(out.result, null);
      assert.equal(ctx.store.readEvents(runId).length, 0, "nothing persisted when the lock is held elsewhere");
    } finally {
      ctx.close();
    }
  } finally {
    await repo.cleanup();
  }
});
