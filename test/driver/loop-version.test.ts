// A2: a Run pins `loopVersion`; editing the file mid-Run does not change that Run's behaviour.
// `applyStep`'s own loopVersion-drift guard (`driver/step.ts`) is what enforces this across
// process boundaries — a fresh `RunContext` opened after the loop file changed on disk refuses
// to continue an already-pinned Run rather than silently routing it against a different loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decideGate, defaultDispatchers, layoutFor, openRunContext, runLoop } from "../../src/driver/index.ts";
import { resolveLoopmillHome } from "../../src/store/index.ts";
import { loadFakeScript } from "../../src/backends/fake/index.ts";
import type { TriggerPayload } from "../../src/types/envelope.ts";
import { CLI_GATE_LOOP_PATH, REFERENCE_HAPPY_SCRIPT, fixedClock, makeScratchRepo } from "../fixtures/driver/helpers.ts";

test("A2: a Run's own loopVersion stays pinned; a process that reopens the loop after it changed is refused, not silently rerouted", async () => {
  const repo = await makeScratchRepo();
  try {
    // A private, per-test copy of the cli-gate loop file, so this test can edit it without
    // touching the shared fixture other tests in this run depend on.
    const loopPath = join(repo.repoRoot, "daily-content-improvement.loop.yaml");
    await cp(CLI_GATE_LOOP_PATH, loopPath);
    const originalContent = await readFile(loopPath, "utf8");

    const clock = fixedClock();
    const layout = layoutFor(resolveLoopmillHome({ repoRoot: repo.repoRoot, env: {} }).home);
    const dispatchers = defaultDispatchers({ layout, fakeScript: loadFakeScript(REFERENCE_HAPPY_SCRIPT) });

    const ctx1 = await openRunContext({ repoRoot: repo.repoRoot, env: {}, clock, loopPath });
    const pinnedLoopVersion = ctx1.loop.loopVersion;
    let runId: string;
    try {
      const trigger: TriggerPayload = { kind: "manual" };
      const runResult = await runLoop({ ctx: ctx1, trigger, dispatchers });
      assert.equal(runResult.exitCode, 20);
      runId = runResult.runId!;
      assert.equal(ctx1.store.read(runId)!.loopVersion, pinnedLoopVersion);
    } finally {
      ctx1.close();
    }

    // Edit the loop file — a real content change, not a comment (loop-file.md §3's canonical
    // form drops comments entirely, so a comment-only edit would not move `loopVersion` and this
    // test would prove nothing) — and reopen a fresh context, simulating a second process
    // picking the Run up later.
    assert.ok(originalContent.includes("name: Daily Content Improvement"), "fixture drifted — update this test's edit alongside it");
    const editedContent = originalContent.replace("name: Daily Content Improvement", "name: Daily Content Improvement (edited)");
    await writeFile(loopPath, editedContent, "utf8");
    const ctx2 = await openRunContext({ repoRoot: repo.repoRoot, env: {}, clock, loopPath });
    try {
      assert.notEqual(ctx2.loop.loopVersion, pinnedLoopVersion, "the edit must actually change loopVersion, or this test proves nothing");

      // `decideGate` catches its own errors and reports them as a non-zero exit rather than
      // throwing (matching `run`'s own top-level error handling) — the refusal shows up as a
      // failed gate decision, not a rejected promise.
      const refused = await decideGate({ ctx: ctx2, runId, decision: "approve", actor: "maintainer", clock: ctx2.clock, dispatchers });
      assert.notEqual(refused.exitCode, 0, "continuing a pinned Run under a changed loop file must be refused, not silently rerouted");

      // The refusal itself must not have mutated the Run.
      const snapshotAfterRefusal = ctx2.store.read(runId)!;
      assert.equal(snapshotAfterRefusal.status, "WAITING_HUMAN");
      assert.equal(snapshotAfterRefusal.loopVersion, pinnedLoopVersion);
    } finally {
      ctx2.close();
    }

    // Restored to the original content: the same Run now continues normally, still pinned to
    // its original loopVersion throughout every later event.
    await writeFile(loopPath, originalContent, "utf8");
    const ctx3 = await openRunContext({ repoRoot: repo.repoRoot, env: {}, clock, loopPath });
    try {
      assert.equal(ctx3.loop.loopVersion, pinnedLoopVersion);
      const approveResult = await decideGate({ ctx: ctx3, runId, decision: "approve", actor: "maintainer", clock: ctx3.clock, dispatchers });
      assert.equal(approveResult.exitCode, 0);
      assert.equal(approveResult.state, "SUCCEEDED");

      for (const row of ctx3.store.readEvents(runId)) {
        assert.equal(row.envelope.loopVersion, pinnedLoopVersion, `event ${row.seq} (${row.eventType}) must carry the pinned loopVersion`);
      }
    } finally {
      ctx3.close();
    }
  } finally {
    await repo.cleanup();
  }
});
