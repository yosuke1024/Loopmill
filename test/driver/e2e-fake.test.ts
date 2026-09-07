// A31: the reference loop, end to end, against the `fake` backend — no network, no subscription,
// no tokens. The reference loop's own `approve-pr` gate is `mode: label` (GitHub-ingested,
// `resume --due`, m2); `test/fixtures/driver/daily-content-improvement.loop.yaml` is the same
// loop with `defaults.backend: fake` and `approve-pr.mode: cli` so this milestone can drive it
// to `SUCCEEDED` from the command line alone: `run` stops at the gate (exit 20), `approve`
// continues it. Also covers A4 (`rebuild-snapshot` byte-identical) on the resulting journal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_POLICY_FULL, fold } from "../../src/engine/index.ts";
import { defaultDispatchers, decideGate, runLoop } from "../../src/driver/index.ts";
import { loadFakeScript } from "../../src/backends/fake/index.ts";
import type { TriggerPayload } from "../../src/types/envelope.ts";
import {
  CLI_GATE_LOOP_PATH,
  REFERENCE_HAPPY_SCRIPT,
  REFERENCE_TWO_RETRIES_SCRIPT,
  makeScratchRepo,
  openTestContext,
  type ScratchRepo,
} from "../fixtures/driver/helpers.ts";

async function withContext<T>(scriptPath: string, run: (ctx: Awaited<ReturnType<typeof openTestContext>>, repo: ScratchRepo) => Promise<T>): Promise<T> {
  const repo = await makeScratchRepo();
  try {
    const ctx = await openTestContext(repo, CLI_GATE_LOOP_PATH);
    try {
      return await run(ctx, repo);
    } finally {
      ctx.close();
    }
  } finally {
    await repo.cleanup();
  }
}

function assertRebuildIdentical(ctx: Awaited<ReturnType<typeof openTestContext>>, runId: string): void {
  const result = ctx.store.rebuildSnapshot(runId, (rows) => fold(rows, { loop: ctx.loop, policy: DEFAULT_POLICY_FULL }).snapshot);
  assert.equal(result.identical, true, `A4: rebuild-snapshot must be byte-identical (first differing line ${result.firstDifferingLine})`);
}

test("A31 happy path: run stops at the cli gate (exit 20), approve continues to SUCCEEDED(end:success)", async () => {
  await withContext(REFERENCE_HAPPY_SCRIPT, async (ctx) => {
    const dispatchers = defaultDispatchers({ layout: ctx.layout, fakeScript: loadFakeScript(REFERENCE_HAPPY_SCRIPT) });
    const trigger: TriggerPayload = { kind: "manual" };

    const runResult = await runLoop({ ctx, trigger, dispatchers, json: true });
    assert.equal(runResult.exitCode, 20, "the cli-mode gate should stop the run at WAITING_HUMAN");
    assert.equal(runResult.state, "WAITING_HUMAN");
    assert.ok(runResult.runId);
    const runId = runResult.runId!;

    const approveResult = await decideGate({ ctx, runId, decision: "approve", actor: "maintainer", clock: ctx.clock, dispatchers, json: true });
    assert.equal(approveResult.exitCode, 0);
    assert.equal(approveResult.state, "SUCCEEDED");
    assert.deepEqual(approveResult.outcome, { state: "SUCCEEDED", label: "success" });

    const events = ctx.store.readEvents(runId);
    const finished = events.filter((e) => e.eventType === "run-finished");
    assert.equal(finished.length, 1, "exactly one run-finished event");

    const mdPath = join(ctx.layout.reports, `${runId}.md`);
    const jsonPath = join(ctx.layout.reports, `${runId}.json`);
    assert.ok(existsSync(mdPath), `report markdown missing at ${mdPath}`);
    assert.ok(existsSync(jsonPath), `report json missing at ${jsonPath}`);

    assertRebuildIdentical(ctx, runId);
  });
});

test("A31 two retries: traversals 2/3, maxCycleIndex 3, then approve -> exit 0", async () => {
  await withContext(REFERENCE_TWO_RETRIES_SCRIPT, async (ctx) => {
    const dispatchers = defaultDispatchers({ layout: ctx.layout, fakeScript: loadFakeScript(REFERENCE_TWO_RETRIES_SCRIPT) });
    const trigger: TriggerPayload = { kind: "manual" };

    const runResult = await runLoop({ ctx, trigger, dispatchers });
    assert.equal(runResult.exitCode, 20);
    const runId = runResult.runId!;

    const snapshotBeforeApproval = ctx.store.read(runId)!;
    assert.equal(snapshotBeforeApproval.traversals["retry-implementation"], 2);
    assert.equal(snapshotBeforeApproval.maxCycleIndex, 3);

    const approveResult = await decideGate({ ctx, runId, decision: "approve", actor: "maintainer", clock: ctx.clock, dispatchers });
    assert.equal(approveResult.exitCode, 0);
    assert.equal(approveResult.state, "SUCCEEDED");

    const finalSnapshot = ctx.store.read(runId)!;
    assert.equal(finalSnapshot.traversals["retry-implementation"], 2);
    assert.equal(finalSnapshot.maxCycleIndex, 3);

    assertRebuildIdentical(ctx, runId);
  });
});

test("A31 rejected gate: reject at the cli gate fails the run per approve-pr's default onFailure (fail_run)", async () => {
  await withContext(REFERENCE_HAPPY_SCRIPT, async (ctx) => {
    const dispatchers = defaultDispatchers({ layout: ctx.layout, fakeScript: loadFakeScript(REFERENCE_HAPPY_SCRIPT) });
    const trigger: TriggerPayload = { kind: "manual" };

    const runResult = await runLoop({ ctx, trigger, dispatchers });
    assert.equal(runResult.exitCode, 20);
    const runId = runResult.runId!;

    const rejectResult = await decideGate({ ctx, runId, decision: "reject", actor: "maintainer", note: "not ready", clock: ctx.clock, dispatchers });
    assert.equal(rejectResult.exitCode, 10, "FAILED per state-machine.md §12.2");
    assert.equal(rejectResult.state, "FAILED");
    assert.equal(rejectResult.outcome?.state, "FAILED");
    if (rejectResult.outcome?.state === "FAILED") {
      assert.equal(rejectResult.outcome.failureReason, "human_rejected");
    }

    assertRebuildIdentical(ctx, runId);
  });
});
