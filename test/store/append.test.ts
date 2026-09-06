import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../../src/store/sqlite.ts";
import { isLoopmillError } from "../../src/util/errors.ts";
import { freshDb, makeAttempt, makeEnvelope, makeSnapshot, NOW, ZERO_DIGEST } from "../fixtures/store/helpers.ts";

function setUpRun(dbPath: string, runId = "run_1", loopId = "test-loop") {
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

test("append: one applied + two emitted -> consecutive seqs, a verifiable hash chain, canonical snapshot storage", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const applied = makeEnvelope({ eventType: "run-requested", runId: "run_1", producer: "trigger" });
    const started = makeEnvelope({ eventType: "run-started", runId: "run_1", producer: "control-plane" });
    const dispatched = makeEnvelope({
      eventType: "node-dispatched",
      runId: "run_1",
      producer: "control-plane",
      cycle: 1,
      nodeId: "tidy",
      attempt: 1,
    });
    const snapshot = makeSnapshot({
      runId: "run_1",
      loopId: "test-loop",
      snapshotOf: 3,
      current: { nodeId: "tidy", cycleIndex: 1, attempt: 1, nodeState: "DISPATCHED" },
    });

    const result = store.append("run_1", { applied, emitted: [started, dispatched], snapshot, now: NOW });
    assert.deepEqual(result, { ok: true, firstSeq: 1, lastSeq: 3, snapshotOf: 3 });

    const events = store.readEvents("run_1");
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => [e.seq, e.kind, e.eventId]),
      [
        [1, "applied", applied.eventId],
        [2, "emitted", started.eventId],
        [3, "emitted", dispatched.eventId],
      ],
    );
    assert.equal(events[0]?.prevHash, "");

    const chain = store.verifyChain("run_1");
    assert.deepEqual(chain, { ok: true });

    assert.deepEqual(store.read("run_1"), snapshot);
    store.close();
  } finally {
    await cleanup();
  }
});

test("append: a second append reusing an existing eventId is duplicate_event_id and writes nothing else", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const applied = makeEnvelope({ eventType: "run-requested", runId: "run_1", producer: "trigger" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 1 });
    const first = store.append("run_1", { applied, emitted: [], snapshot, now: NOW });
    assert.ok(first.ok);

    const dup = makeEnvelope({ eventType: "run-started", runId: "run_1", producer: "control-plane" });
    // Reuses `applied.eventId` on purpose: a different envelope, same id.
    Object.assign(dup, { eventId: applied.eventId });
    const staleClaimSnapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 2 });

    const second = store.append("run_1", { applied: null, emitted: [dup], snapshot: staleClaimSnapshot, now: NOW });
    assert.deepEqual(second, { ok: false, reason: "duplicate_event_id", eventId: applied.eventId });

    assert.equal(store.readEvents("run_1").length, 1, "no new event row");
    assert.deepEqual(store.read("run_1"), snapshot, "the snapshot from the first append is untouched");
    store.close();
  } finally {
    await cleanup();
  }
});

test("append: seq_conflict when the given snapshot's snapshotOf does not match the store's high-water mark", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const applied = makeEnvelope({ eventType: "run-requested", runId: "run_1", producer: "trigger" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 1 });
    const first = store.append("run_1", { applied, emitted: [], snapshot, now: NOW });
    assert.ok(first.ok);

    const staleEnvelope = makeEnvelope({ eventType: "run-started", runId: "run_1", producer: "control-plane" });
    // The real next snapshotOf is 2 (1 prior + 1 new); this claims 5, simulating a caller
    // whose in-memory snapshot is stale relative to the store.
    const wrongSnapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 5 });

    const second = store.append("run_1", { applied: staleEnvelope, emitted: [], snapshot: wrongSnapshot, now: NOW });
    assert.deepEqual(second, { ok: false, reason: "seq_conflict" });

    assert.equal(store.readEvents("run_1").length, 1, "no new event row");
    assert.deepEqual(store.read("run_1"), snapshot, "the snapshot from the first append is untouched");
    store.close();
  } finally {
    await cleanup();
  }
});

test("append: atomicity — a snapshot that fails to serialise rolls back events already written in the same call", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const applied = makeEnvelope({ eventType: "run-requested", runId: "run_1", producer: "trigger" });
    const emitted = makeEnvelope({ eventType: "run-started", runId: "run_1", producer: "control-plane" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 2 });
    // Canonical JSON rejects `undefined` at any depth (util/canonical-json.ts); this key exists
    // (it was explicitly assigned, not merely typed as optional-and-absent), so Object.keys sees
    // it and the store's snapshot serialisation throws — after the two events above would
    // already have been inserted into `events` within the same transaction.
    (snapshot as unknown as Record<string, unknown>).bogus = undefined;

    assert.throws(
      () => store.append("run_1", { applied, emitted: [emitted], snapshot, now: NOW }),
      (err: unknown) => isLoopmillError(err) && err.code === "canonical_json_unsupported",
    );

    assert.equal(store.readEvents("run_1").length, 0, "the whole transaction rolled back");
    assert.equal(store.read("run_1"), null, "no snapshot was committed");
    store.close();
  } finally {
    await cleanup();
  }
});

test("append: attempt records are insert-only — an identical re-write is a no-op, a differing one throws", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const e1 = makeEnvelope({ eventType: "node-completed", runId: "run_1", producer: "backend:local" });
    const attempt = makeAttempt({ cycleIndex: 1, nodeId: "tidy", attempt: 1, state: "COMPLETED" });
    const snapshot1 = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 1 });
    const r1 = store.append("run_1", { applied: e1, emitted: [], snapshot: snapshot1, attempts: [attempt], now: NOW });
    assert.ok(r1.ok);
    assert.deepEqual(store.readAttempts("run_1"), [attempt]);

    // Identical re-write of the same (cycle, nodeId, attempt) key: a no-op.
    const e2 = makeEnvelope({ eventType: "node-completed", runId: "run_1", producer: "backend:local" });
    const snapshot2 = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 2 });
    const r2 = store.append("run_1", { applied: e2, emitted: [], snapshot: snapshot2, attempts: [attempt], now: NOW });
    assert.ok(r2.ok);
    assert.deepEqual(store.readAttempts("run_1"), [attempt], "still exactly one attempt record");

    // A differing re-write of the same key is an error, and rolls back the events it would
    // otherwise have written alongside it.
    const e3 = makeEnvelope({ eventType: "node-completed", runId: "run_1", producer: "backend:local" });
    const differentAttempt = makeAttempt({ cycleIndex: 1, nodeId: "tidy", attempt: 1, state: "FAILED" });
    const snapshot3 = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 3 });
    assert.throws(
      () =>
        store.append("run_1", {
          applied: e3,
          emitted: [],
          snapshot: snapshot3,
          attempts: [differentAttempt],
          now: NOW,
        }),
      (err: unknown) => isLoopmillError(err) && err.code === "attempt_record_conflict",
    );
    assert.equal(store.readEvents("run_1").length, 2, "e3 was rolled back along with the conflicting attempt");
    store.close();
  } finally {
    await cleanup();
  }
});

test("append: a given lease refreshes the loop's locks row heartbeat and expiry", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const acquired = store.acquireLock({
      loopId: "test-loop",
      runId: "run_1",
      ownerPid: 111,
      host: "h1",
      now: NOW,
      leaseUntil: "2026-09-06T09:05:00.000Z",
    });
    assert.deepEqual(acquired, { acquired: true });

    const applied = makeEnvelope({ eventType: "node-started", runId: "run_1", producer: "backend:local" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 1 });
    const later = "2026-09-06T09:00:30.000Z";
    const newLeaseUntil = "2026-09-06T09:05:30.000Z";
    const result = store.append("run_1", {
      applied,
      emitted: [],
      snapshot,
      now: later,
      lease: {
        kind: "attempt",
        holder: "1:tidy:1",
        acquiredAt: NOW,
        heartbeatAt: later,
        expiresAt: newLeaseUntil,
      },
    });
    assert.ok(result.ok);

    const lock = store.readLock("test-loop");
    assert.equal(lock?.heartbeatAt, later);
    assert.equal(lock?.leaseUntil, newLeaseUntil);
    store.close();
  } finally {
    await cleanup();
  }
});
