import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../../src/store/sqlite.ts";
import { isLoopmillError } from "../../src/util/errors.ts";
import { freshDb, NOW, ZERO_DIGEST } from "../fixtures/store/helpers.ts";

test("createRun / readRunHeader: round-trips the header verbatim", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = openStore(dbPath);
    store.createRun({
      runId: "run_1",
      loopId: "article-review",
      loopVersion: ZERO_DIGEST,
      loopDigest: ZERO_DIGEST,
      trigger: { kind: "manual", requestedAt: NOW },
      createdAt: NOW,
    });

    const header = store.readRunHeader("run_1");
    assert.ok(header);
    assert.equal(header.runId, "run_1");
    assert.equal(header.loopId, "article-review");
    assert.equal(header.loopVersion, ZERO_DIGEST);
    assert.equal(header.loopDigest, ZERO_DIGEST);
    assert.deepEqual(header.trigger, { kind: "manual", requestedAt: NOW });
    assert.equal(header.dedupeKey, null);
    assert.equal(header.createdAt, NOW);
    store.close();
  } finally {
    await cleanup();
  }
});

test("createRun: dedupeKey round-trips when given", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = openStore(dbPath);
    store.createRun({
      runId: "run_1",
      loopId: "article-review",
      loopVersion: ZERO_DIGEST,
      loopDigest: ZERO_DIGEST,
      trigger: { kind: "schedule", requestedAt: NOW, dedupeKey: "d1" },
      dedupeKey: "d1",
      createdAt: NOW,
    });
    const header = store.readRunHeader("run_1");
    assert.equal(header?.dedupeKey, "d1");
    store.close();
  } finally {
    await cleanup();
  }
});

test("readRunHeader: null for an unknown runId", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = openStore(dbPath);
    assert.equal(store.readRunHeader("nope"), null);
    store.close();
  } finally {
    await cleanup();
  }
});

test("createRun: a duplicate runId throws LoopmillError run_exists and leaves the original row alone", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = openStore(dbPath);
    store.createRun({
      runId: "run_1",
      loopId: "loop-a",
      loopVersion: ZERO_DIGEST,
      loopDigest: ZERO_DIGEST,
      trigger: { kind: "manual", requestedAt: NOW },
      createdAt: NOW,
    });

    assert.throws(
      () =>
        store.createRun({
          runId: "run_1",
          loopId: "loop-b", // different payload — must not silently win
          loopVersion: ZERO_DIGEST,
          loopDigest: ZERO_DIGEST,
          trigger: { kind: "manual", requestedAt: NOW },
          createdAt: NOW,
        }),
      (err: unknown) => {
        if (!isLoopmillError(err)) return false;
        assert.equal(err.code, "run_exists");
        return true;
      },
    );

    const header = store.readRunHeader("run_1");
    assert.equal(header?.loopId, "loop-a", "the original row is untouched");
    store.close();
  } finally {
    await cleanup();
  }
});

test("listRuns: returns headers plus the snapshot's status/outcome/updatedAt, newest first", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = openStore(dbPath);
    store.createRun({
      runId: "run_older",
      loopId: "loop-a",
      loopVersion: ZERO_DIGEST,
      loopDigest: ZERO_DIGEST,
      trigger: { kind: "manual", requestedAt: "2026-09-06T08:00:00.000Z" },
      createdAt: "2026-09-06T08:00:00.000Z",
    });
    store.createRun({
      runId: "run_newer",
      loopId: "loop-a",
      loopVersion: ZERO_DIGEST,
      loopDigest: ZERO_DIGEST,
      trigger: { kind: "manual", requestedAt: "2026-09-06T09:00:00.000Z" },
      createdAt: "2026-09-06T09:00:00.000Z",
    });

    const entries = store.listRuns({ loopId: "loop-a" });
    assert.deepEqual(
      entries.map((e) => e.runId),
      ["run_newer", "run_older"],
    );
    // No append() has happened yet for either run, so neither has a snapshot.
    assert.equal(entries[0]?.status, null);
    assert.equal(entries[0]?.outcome, null);
    assert.equal(entries[0]?.updatedAt, null);
    store.close();
  } finally {
    await cleanup();
  }
});

test("listRuns: filters by loopId and respects limit", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = openStore(dbPath);
    for (const [runId, loopId] of [
      ["run_a1", "loop-a"],
      ["run_a2", "loop-a"],
      ["run_b1", "loop-b"],
    ] as const) {
      store.createRun({
        runId,
        loopId,
        loopVersion: ZERO_DIGEST,
        loopDigest: ZERO_DIGEST,
        trigger: { kind: "manual", requestedAt: NOW },
        createdAt: NOW,
      });
    }

    assert.equal(store.listRuns({ loopId: "loop-b" }).length, 1);
    assert.equal(store.listRuns({ loopId: "loop-a" }).length, 2);
    assert.equal(store.listRuns({ loopId: "loop-a", limit: 1 }).length, 1);
    assert.equal(store.listRuns().length, 3);
    store.close();
  } finally {
    await cleanup();
  }
});
