// mvp-design.md §13.4's persistence-time redaction, exercised at the store's own last-line
// defence: `append` asserts `!looksLikeCredential(text)` on every serialised envelope, the
// snapshot and every attempt record before writing them, throwing `LoopmillError('secret_in_record')`
// and writing nothing at all when one slips through unredacted (this store's own decision — see
// the comment above `assertNoSecret` in src/store/sqlite.ts for why it asserts rather than
// redacts in place).

import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../../src/store/sqlite.ts";
import { isLoopmillError } from "../../src/util/errors.ts";
import { freshDb, makeAttempt, makeEnvelope, makeSnapshot, NOW, ZERO_DIGEST } from "../fixtures/store/helpers.ts";

const LEAKED_KEY = "sk-ant-EXAMPLENOTAREALKEY000000000000";

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

test("append: a credential-shaped string in an envelope's free text is refused, writing nothing", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const applied = makeEnvelope({
      eventType: "node-completed",
      runId: "run_1",
      producer: "backend:local",
      result: { status: "succeeded", summary: `finished; key is ${LEAKED_KEY} in the log` },
    });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 1 });

    assert.throws(
      () => store.append("run_1", { applied, emitted: [], snapshot, now: NOW }),
      (err: unknown) => isLoopmillError(err) && err.code === "secret_in_record",
    );
    assert.equal(store.readEvents("run_1").length, 0);
    assert.equal(store.read("run_1"), null);
    store.close();
  } finally {
    await cleanup();
  }
});

test("append: a credential-shaped string in the snapshot rolls back the events written alongside it", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const applied = makeEnvelope({ eventType: "node-completed", runId: "run_1", producer: "backend:local" });
    const snapshot = makeSnapshot({
      runId: "run_1",
      loopId: "test-loop",
      snapshotOf: 1,
      nodes: {
        "1:tidy": {
          nodeId: "tidy",
          cycleIndex: 1,
          state: "SUCCEEDED",
          attemptsUsed: 1,
          startedAt: NOW,
          finishedAt: NOW,
          summary: `leaked ${LEAKED_KEY} in the summary`,
          filesChanged: 0,
          changeFingerprint: null,
          artifactRefs: [],
          structured: null,
          stdout: null,
          exitCode: null,
        },
      },
    });

    assert.throws(
      () => store.append("run_1", { applied, emitted: [], snapshot, now: NOW }),
      (err: unknown) => isLoopmillError(err) && err.code === "secret_in_record",
    );
    assert.equal(store.readEvents("run_1").length, 0, "the event inserted before the check failed was rolled back");
    assert.equal(store.read("run_1"), null);
    store.close();
  } finally {
    await cleanup();
  }
});

test("append: a credential-shaped string in an attempt record is refused, writing nothing", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const applied = makeEnvelope({ eventType: "node-completed", runId: "run_1", producer: "backend:local" });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 1 });
    const attempt = makeAttempt({
      cycleIndex: 1,
      nodeId: "tidy",
      attempt: 1,
      state: "FAILED",
      error: { code: "runtime_error", message: `auth failed with ${LEAKED_KEY}`, classified: "runtime_error" },
    });

    assert.throws(
      () => store.append("run_1", { applied, emitted: [], snapshot, attempts: [attempt], now: NOW }),
      (err: unknown) => isLoopmillError(err) && err.code === "secret_in_record",
    );
    assert.equal(store.readEvents("run_1").length, 0);
    assert.equal(store.read("run_1"), null);
    assert.deepEqual(store.readAttempts("run_1"), []);
    store.close();
  } finally {
    await cleanup();
  }
});

test("append: ordinary prose that merely resembles the boundary condition (TV-5) is persisted unchanged", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = setUpRun(dbPath);
    const applied = makeEnvelope({
      eventType: "node-completed",
      runId: "run_1",
      producer: "backend:local",
      result: { status: "succeeded", summary: "the task-12345678901234567890 finished" },
    });
    const snapshot = makeSnapshot({ runId: "run_1", loopId: "test-loop", snapshotOf: 1 });

    const result = store.append("run_1", { applied, emitted: [], snapshot, now: NOW });
    assert.ok(result.ok);
    assert.equal(store.readEvents("run_1")[0]?.envelope.result?.summary, "the task-12345678901234567890 finished");
    store.close();
  } finally {
    await cleanup();
  }
});
