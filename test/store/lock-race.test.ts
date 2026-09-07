// A10 at store level: two independent OS processes call acquireLock for the same loopId at as
// close to the same instant as two processes can manage. Exactly one must win; the other must
// see the winner as the holder. Repeated 5 times per the task's own instruction, since a single
// run proves nothing about a race.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { openStore } from "../../src/store/sqlite.ts";
import { freshDb, NOW } from "../fixtures/store/helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RACER = join(here, "..", "fixtures", "store", "lock-racer.ts");

interface RacerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runRacer(args: string[]): Promise<RacerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RACER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("A10: two processes racing acquireLock for the same loopId — exactly one wins, 5 times", async (t) => {
  for (let i = 0; i < 5; i++) {
    await t.test(`race ${i + 1}`, async () => {
      const { dbPath, cleanup } = await freshDb();
      try {
        // Create the schema up front from this (the test) process, so the two racers never
        // contend over `CREATE TABLE IF NOT EXISTS` — the property under test is the lock row,
        // not schema creation.
        const setup = openStore(dbPath);
        setup.close();

        const loopId = "loop-race";
        const startAt = Date.now() + 300; // a few hundred ms in the future, per the task
        const leaseUntil = "2026-09-06T09:59:00.000Z";

        const [a, b] = await Promise.all([
          runRacer([dbPath, loopId, "run_a", String(startAt), NOW, leaseUntil]),
          runRacer([dbPath, loopId, "run_b", String(startAt), NOW, leaseUntil]),
        ]);

        assert.equal(a.code, 0, `racer a exited nonzero (stderr: ${a.stderr})`);
        assert.equal(b.code, 0, `racer b exited nonzero (stderr: ${b.stderr})`);

        const outcomes = [a.stdout.trim(), b.stdout.trim()];
        const acquiredCount = outcomes.filter((o) => o === "acquired").length;
        const holderCount = outcomes.filter((o) => o.startsWith("holder:")).length;
        assert.equal(acquiredCount, 1, `expected exactly one "acquired": ${outcomes.join(" | ")}`);
        assert.equal(holderCount, 1, `expected exactly one holder report: ${outcomes.join(" | ")}`);

        const verify = openStore(dbPath);
        const lock = verify.readLock(loopId);
        assert.ok(lock, "the winner's row is left standing");
        assert.ok(lock.runId === "run_a" || lock.runId === "run_b");
        verify.close();
      } finally {
        await cleanup();
      }
    });
  }
});
