import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { openStore } from "../../src/store/sqlite.ts";
import type { Envelope } from "../../src/types/envelope.ts";
import type { RunSnapshot } from "../../src/types/state.ts";
import { freshDb, makeEnvelope, makeSnapshot, NOW, ZERO_DIGEST } from "../fixtures/store/helpers.ts";

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

// A trivial fold (docs' own suggestion: "a counter") — it ignores the events' content and only
// derives `snapshotOf` from how many there are. This is a legitimate fold to test identity
// against, as long as the snapshot given to `append` was built the same way for the same event
// count — which every test below does.
function counterFold(runId: string, loopId: string): (events: Envelope[]) => RunSnapshot {
  return (events) => makeSnapshot({ runId, loopId, snapshotOf: events.length });
}

test("rebuildSnapshot: a matching fold reports identical, byte for byte", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const e1 = makeEnvelope({ eventType: "run-requested", runId: "run_1", producer: "trigger" });
    const e2 = makeEnvelope({ eventType: "run-started", runId: "run_1", producer: "control-plane" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 2 });
    const appended = store.append("run_1", { applied: e1, emitted: [e2], snapshot, now: NOW });
    assert.ok(appended.ok);

    const result = store.rebuildSnapshot("run_1", counterFold("run_1", "test-loop"));
    assert.equal(result.identical, true);
    assert.equal(result.stored, result.rebuilt);
    assert.equal(result.firstDifferingLine, undefined);
    store.close();
  } finally {
    await cleanup();
  }
});

test("rebuildSnapshot: a tampered stored snapshot reports identical: false with the first differing line", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const e1 = makeEnvelope({ eventType: "run-requested", runId: "run_1", producer: "trigger" });
    const e2 = makeEnvelope({ eventType: "run-started", runId: "run_1", producer: "control-plane" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 2 });
    const appended = store.append("run_1", { applied: e1, emitted: [e2], snapshot, now: NOW });
    assert.ok(appended.ok);

    // Tamper the persisted row directly (bypassing the store's own API entirely) to simulate an
    // on-disk corruption or a hand edit — the store never mutates its own written text this way.
    const raw = new DatabaseSync(dbPath);
    const before = raw.prepare("SELECT snapshot_json FROM snapshots WHERE run_id = ?").get("run_1");
    const beforeText = String(before?.snapshot_json ?? "");
    assert.match(beforeText, /"status": "RUNNING"/);
    const tamperedText = beforeText.replace('"status": "RUNNING"', '"status": "FAILED"');
    raw.prepare("UPDATE snapshots SET snapshot_json = ? WHERE run_id = ?").run(tamperedText, "run_1");
    raw.close();

    const result = store.rebuildSnapshot("run_1", counterFold("run_1", "test-loop"));
    assert.equal(result.identical, false);
    assert.equal(typeof result.firstDifferingLine, "number");
    assert.ok((result.firstDifferingLine ?? 0) > 0);
    // The line the tamper landed on really does differ between stored and rebuilt.
    const line = result.firstDifferingLine ?? 0;
    const storedLines = result.stored.split("\n");
    const rebuiltLines = result.rebuilt.split("\n");
    assert.notEqual(storedLines[line - 1], rebuiltLines[line - 1]);
    store.close();
  } finally {
    await cleanup();
  }
});

test("verifyChain: ok for an untouched chain", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const e1 = makeEnvelope({ eventType: "run-requested", runId: "run_1", producer: "trigger" });
    const e2 = makeEnvelope({ eventType: "run-started", runId: "run_1", producer: "control-plane" });
    const e3 = makeEnvelope({ eventType: "node-dispatched", runId: "run_1", producer: "control-plane" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 3 });
    const appended = store.append("run_1", { applied: e1, emitted: [e2, e3], snapshot, now: NOW });
    assert.ok(appended.ok);

    assert.deepEqual(store.verifyChain("run_1"), { ok: true });
    store.close();
  } finally {
    await cleanup();
  }
});

test("verifyChain: detects a tampered event row and names its seq", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const e1 = makeEnvelope({ eventType: "run-requested", runId: "run_1", producer: "trigger" });
    const e2 = makeEnvelope({ eventType: "run-started", runId: "run_1", producer: "control-plane" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 2 });
    const appended = store.append("run_1", { applied: e1, emitted: [e2], snapshot, now: NOW });
    assert.ok(appended.ok);
    assert.deepEqual(store.verifyChain("run_1"), { ok: true });

    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare("SELECT envelope_json FROM events WHERE run_id = ? AND seq = 2").get("run_1");
    const tampered = String(row?.envelope_json ?? "").replace(e2.eventType, "tampered-event-type");
    raw.prepare("UPDATE events SET envelope_json = ? WHERE run_id = ? AND seq = 2").run(tampered, "run_1");
    raw.close();

    const result = store.verifyChain("run_1");
    assert.equal(result.ok, false);
    assert.equal(result.brokenAtSeq, 2);
    store.close();
  } finally {
    await cleanup();
  }
});
