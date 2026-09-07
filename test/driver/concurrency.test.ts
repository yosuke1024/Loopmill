// A10: two concurrent `runLoop` invocations of one loop — exactly one takes the lock and
// executes; the other finishes `SKIPPED(overlapping_run)`, exit 15, and writes nothing else.
// Driven as two real OS processes (`test/fixtures/driver/run-racer.ts`), synchronised to start
// at the same instant, matching `test/store/lock-race.test.ts`'s own approach at store level.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { EXIT_CODES_LOOP_PATH, FIXTURES_DIR, makeScratchRepo } from "../fixtures/driver/helpers.ts";

const RACER = join(FIXTURES_DIR, "run-racer.ts");
const SUCCESS_SCRIPT = join(FIXTURES_DIR, "success-script.json");

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
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("A10: two processes racing runLoop for the same loop — exactly one runs, the other exits 15 and writes nothing", async () => {
  const repo = await makeScratchRepo();
  try {
    // Pre-create `.loopmill/`'s layout and the store's schema from this (the test) process, so
    // the two racers never contend over `CREATE TABLE IF NOT EXISTS` (WAL setup itself needs a
    // write lock) — matching `test/store/lock-race.test.ts`'s own note: the property under test
    // is the lock *row*, not schema creation.
    {
      const { ensureLayout, resolveLoopmillHome, openStore } = await import("../../src/store/index.ts");
      const home = resolveLoopmillHome({ repoRoot: repo.repoRoot, env: {} });
      const layout = await ensureLayout(home.home);
      openStore(layout.stateDb).close();
    }

    const startAt = Date.now() + 300;
    const [a, b] = await Promise.all([
      runRacer([repo.repoRoot, EXIT_CODES_LOOP_PATH, SUCCESS_SCRIPT, String(startAt)]),
      runRacer([repo.repoRoot, EXIT_CODES_LOOP_PATH, SUCCESS_SCRIPT, String(startAt)]),
    ]);

    assert.equal(a.code, 0, `racer a should always exit 0 itself (stderr: ${a.stderr})`);
    assert.equal(b.code, 0, `racer b should always exit 0 itself (stderr: ${b.stderr})`);

    const exitCodeOf = (out: string): number => {
      const m = /exitCode:(-?\d+)/.exec(out);
      if (!m) throw new Error(`no exitCode in racer output: ${out}`);
      return Number(m[1]);
    };
    const exitCodes = [exitCodeOf(a.stdout), exitCodeOf(b.stdout)];

    const succeeded = exitCodes.filter((c) => c === 0).length;
    const skipped = exitCodes.filter((c) => c === 15).length;
    assert.equal(succeeded, 1, `expected exactly one runLoop exit 0: ${exitCodes.join(", ")}`);
    assert.equal(skipped, 1, `expected exactly one runLoop exit 15 (overlapping_run): ${exitCodes.join(", ")}`);

    // "writes nothing else": exactly one run row exists in the store.
    const { openStore } = await import("../../src/store/index.ts");
    const store = openStore(join(repo.repoRoot, ".loopmill", "state.sqlite"));
    try {
      const runs = store.listRuns({});
      assert.equal(runs.length, 1, `expected exactly one run row, got ${runs.length}`);
    } finally {
      store.close();
    }
  } finally {
    await repo.cleanup();
  }
});
