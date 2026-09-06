import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../../src/store/sqlite.ts";
import { freshDb, makeSnapshot, NOW, ZERO_DIGEST } from "../fixtures/store/helpers.ts";

function setUpRun(dbPath: string, runId: string, loopId: string) {
  const store = openStore(dbPath);
  store.createRun({
    runId,
    loopId,
    loopVersion: ZERO_DIGEST,
    loopDigest: ZERO_DIGEST,
    trigger: { kind: "manual", requestedAt: NOW },
    createdAt: NOW,
  });
  return store;
}

test("acquireLock: a second acquisition against a live lease fails and reports the current holder", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    const leaseUntil = "2026-09-06T09:05:00.000Z";
    const first = store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil });
    assert.deepEqual(first, { acquired: true });

    const second = store.acquireLock({
      loopId: "loop-a",
      runId: "run_2",
      ownerPid: 200,
      host: "h2",
      now: NOW,
      leaseUntil: "2026-09-06T09:10:00.000Z",
    });
    assert.deepEqual(second, {
      acquired: false,
      holder: { runId: "run_1", ownerPid: 100, host: "h1", heartbeatAt: NOW, leaseUntil },
    });
    store.close();
  } finally {
    await cleanup();
  }
});

test("acquireLock: a lease exactly at ctx.now counts as expired (state-machine.md §10.1's inclusive boundary)", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    const leaseUntil = "2026-09-06T09:05:00.000Z";
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil });

    const takeover = store.acquireLock({
      loopId: "loop-a",
      runId: "run_2",
      ownerPid: 200,
      host: "h2",
      now: leaseUntil, // now == leaseUntil
      leaseUntil: "2026-09-06T09:10:00.000Z",
    });
    assert.ok(takeover.acquired);
    store.close();
  } finally {
    await cleanup();
  }
});

test("acquireLock: an expired lease is taken over, and the takeover names the prior holder", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    const firstLeaseUntil = "2026-09-06T09:01:00.000Z";
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil: firstLeaseUntil });

    const takeoverNow = "2026-09-06T09:02:00.000Z";
    const takeoverLeaseUntil = "2026-09-06T09:10:00.000Z";
    const takeover = store.acquireLock({
      loopId: "loop-a",
      runId: "run_2",
      ownerPid: 200,
      host: "h2",
      now: takeoverNow,
      leaseUntil: takeoverLeaseUntil,
    });
    assert.deepEqual(takeover, {
      acquired: true,
      tookOverFrom: { runId: "run_1", ownerPid: 100, host: "h1", heartbeatAt: NOW, leaseUntil: firstLeaseUntil },
    });

    const lock = store.readLock("loop-a");
    assert.equal(lock?.runId, "run_2");
    assert.equal(lock?.ownerPid, 200);
    assert.equal(lock?.leaseUntil, takeoverLeaseUntil);
    store.close();
  } finally {
    await cleanup();
  }
});

test("heartbeat: extends the lease when owned by the given runId", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil: "2026-09-06T09:01:00.000Z" });

    const extendedNow = "2026-09-06T09:00:30.000Z";
    const extendedLeaseUntil = "2026-09-06T09:02:30.000Z";
    const updated = store.heartbeat("loop-a", "run_1", { now: extendedNow, leaseUntil: extendedLeaseUntil });
    assert.equal(updated, true);

    const lock = store.readLock("loop-a");
    assert.equal(lock?.heartbeatAt, extendedNow);
    assert.equal(lock?.leaseUntil, extendedLeaseUntil);
    store.close();
  } finally {
    await cleanup();
  }
});

test("heartbeat: a no-op (returns false) when the row is not owned by the given runId", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil: "2026-09-06T09:01:00.000Z" });

    const updated = store.heartbeat("loop-a", "run_2", { now: NOW, leaseUntil: "2026-09-06T09:59:00.000Z" });
    assert.equal(updated, false);

    const lock = store.readLock("loop-a");
    assert.equal(lock?.runId, "run_1", "the row is unchanged");
    assert.equal(lock?.leaseUntil, "2026-09-06T09:01:00.000Z");
    store.close();
  } finally {
    await cleanup();
  }
});

test("heartbeat: a no-op for a loopId that has no lock row at all", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = openStore(dbPath);
    assert.equal(store.heartbeat("no-such-loop", "run_1", { now: NOW, leaseUntil: NOW }), false);
    store.close();
  } finally {
    await cleanup();
  }
});

test("releaseLock: deletes the row so a fresh acquisition by anyone succeeds", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil: "2026-09-06T09:59:00.000Z" });
    store.releaseLock("loop-a", "run_1");
    assert.equal(store.readLock("loop-a"), null);

    const reacquired = store.acquireLock({
      loopId: "loop-a",
      runId: "run_2",
      ownerPid: 200,
      host: "h2",
      now: NOW,
      leaseUntil: "2026-09-06T09:59:00.000Z",
    });
    assert.deepEqual(reacquired, { acquired: true });
    store.close();
  } finally {
    await cleanup();
  }
});

test("releaseLock: does nothing when called by a runId that does not own the row", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil: "2026-09-06T09:59:00.000Z" });
    store.releaseLock("loop-a", "run_2"); // wrong runId
    assert.ok(store.readLock("loop-a"), "the row survives");
    store.close();
  } finally {
    await cleanup();
  }
});

test("sweep: reports an expired lease with the run's current attempt, and deletes the row", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    const leaseUntil = "2026-09-06T09:01:00.000Z";
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil });

    const snapshot = makeSnapshot({
      runId: "run_1",
      loopId: "loop-a",
      snapshotOf: 0,
      current: { nodeId: "tidy", cycleIndex: 2, attempt: 3, nodeState: "RUNNING" },
    });
    // Directly seed a snapshot row (no events needed for this test — sweep only reads
    // `snapshots`, never `events`).
    store.append("run_1", { applied: null, emitted: [], snapshot, now: NOW });

    const sweptAt = "2026-09-06T09:02:00.000Z";
    const results = store.sweep(sweptAt);
    assert.deepEqual(results, [
      {
        runId: "run_1",
        loopId: "loop-a",
        nodeId: "tidy",
        cycleIndex: 2,
        attempt: 3,
        leaseUntil,
        holder: { runId: "run_1", ownerPid: 100, host: "h1", heartbeatAt: NOW, leaseUntil },
      },
    ]);
    assert.equal(store.readLock("loop-a"), null, "the row was deleted");
    store.close();
  } finally {
    await cleanup();
  }
});

test("sweep: reports nulls for nodeId/cycleIndex/attempt when the run has no current attempt", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    const leaseUntil = "2026-09-06T09:01:00.000Z";
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil });
    // No snapshot row exists for run_1 at all.

    const results = store.sweep("2026-09-06T09:02:00.000Z");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.nodeId, null);
    assert.equal(results[0]?.cycleIndex, null);
    assert.equal(results[0]?.attempt, null);
    store.close();
  } finally {
    await cleanup();
  }
});

test("sweep: idempotent — a second call at the same or a later time finds nothing left", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil: "2026-09-06T09:01:00.000Z" });

    const first = store.sweep("2026-09-06T09:02:00.000Z");
    assert.equal(first.length, 1);
    const second = store.sweep("2026-09-06T09:03:00.000Z");
    assert.deepEqual(second, []);
    store.close();
  } finally {
    await cleanup();
  }
});

test("sweep: a live lease is left alone", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath, "run_1", "loop-a");
    store.acquireLock({ loopId: "loop-a", runId: "run_1", ownerPid: 100, host: "h1", now: NOW, leaseUntil: "2026-09-06T09:59:00.000Z" });

    const results = store.sweep(NOW);
    assert.deepEqual(results, []);
    assert.ok(store.readLock("loop-a"), "the live row survives");
    store.close();
  } finally {
    await cleanup();
  }
});
