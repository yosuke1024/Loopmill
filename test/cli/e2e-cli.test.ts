// The m1 follow-up's own manual scenario, automated end to end through `cli/main.ts`'s `main()`
// (not the lower-level `driver/` calls `test/driver/e2e-fake.test.ts` already exercises): a
// scratch repository with `.loopmill/daily-content-improvement.loop.yaml` committed, `run`
// against the `fake` backend stopping at the `cli`-mode gate (exit 20), `approve --fake-script`
// (item 3) continuing it to SUCCEEDED (exit 0), then `status`/`logs`/`rebuild-snapshot`/`export`
// all succeeding against the finished run, with the report on disk once it is terminal (item 6).
//
// A second test reproduces the defect this whole follow-up was written against: `approve` with
// no dispatcher registered for the node's backend must degrade to `dispatch-failed` (R-29/R-30)
// and a clean FAILED terminal state (item 2) — never the exit-4 crash that used to leave the run
// stuck RUNNING with a dispatched attempt and no process behind it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";

import { ensureLayout, resolveLoopmillHome } from "../../src/store/index.ts";
import type { Outcome } from "../../src/types/state.ts";
import { CLI_GATE_LOOP_PATH, REFERENCE_HAPPY_SCRIPT, makeScratchRepo } from "../fixtures/driver/helpers.ts";

/** In-process `main()` invocation with stdout/stderr captured — mirrors `test/cli/smoke.test.ts`'s
 * own `captureMain`, duplicated here rather than shared since neither file exports it and this
 * task's own file list keeps `test/fixtures/driver/helpers.ts` scoped to driver-level plumbing. */
async function captureMain(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { main } = await import("../../src/cli/main.ts");
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    const exitCode = await main(argv);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** `run --json`/`approve --json` at `--json` layout still print a plain-text `gate: ...` line
 * ahead of the JSON summary whenever the run stops at a human gate (`run.ts`'s phase 7 writes
 * that line unconditionally, `--json` or not) — the JSON payload itself is always the last line
 * of stdout, so this pulls just that line out before parsing. */
function lastJsonLine<T>(stdout: string): T {
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as T;
}

/** Sets up `.loopmill/daily-content-improvement.loop.yaml` committed the way mvp-design.md §9.1
 * documents (never the `examples/` fallback `openRunContext` also accepts) — matching the manual
 * scenario's own `mkdir .loopmill && cp .../daily-content-improvement.loop.yaml .loopmill/`. */
async function withLoopCommitted<T>(run: (repoRoot: string, layout: Awaited<ReturnType<typeof ensureLayout>>) => Promise<T>): Promise<T> {
  const repo = await makeScratchRepo();
  try {
    const home = resolveLoopmillHome({ repoRoot: repo.repoRoot, env: {} });
    const layout = await ensureLayout(home.home);
    await cp(CLI_GATE_LOOP_PATH, join(layout.loopsDir, "daily-content-improvement.loop.yaml"));
    return await run(repo.repoRoot, layout);
  } finally {
    await repo.cleanup();
  }
}

test("m1 follow-up manual scenario: run (exit 20, WAITING_HUMAN) -> approve --fake-script (exit 0, SUCCEEDED) -> status/logs/rebuild-snapshot/export all succeed, the report exists", async () => {
  await withLoopCommitted(async (repoRoot, layout) => {
    const runOut = await captureMain(["run", "daily-content-improvement", "--repo", repoRoot, "--fake-script", REFERENCE_HAPPY_SCRIPT, "--json"]);
    assert.equal(runOut.exitCode, 20, `stderr: ${runOut.stderr}`);
    const runPayload = lastJsonLine<{ runId: string; state: string }>(runOut.stdout);
    assert.equal(runPayload.state, "WAITING_HUMAN");
    assert.ok(runPayload.runId);
    const runId = runPayload.runId;

    // Item 3: approve accepts --fake-script exactly like run.
    const approveOut = await captureMain(["approve", runId, "--repo", repoRoot, "--actor", "maintainer", "--fake-script", REFERENCE_HAPPY_SCRIPT, "--json"]);
    assert.equal(approveOut.exitCode, 0, `stderr: ${approveOut.stderr}`);
    const approvePayload = lastJsonLine<{ state: string; outcome: Outcome | null }>(approveOut.stdout);
    assert.equal(approvePayload.state, "SUCCEEDED");
    assert.deepEqual(approvePayload.outcome, { state: "SUCCEEDED", label: "success" });

    // status <runId> --json: SUCCEEDED, tokens, coverage.
    const statusJsonOut = await captureMain(["status", runId, "--repo", repoRoot, "--json"]);
    assert.equal(statusJsonOut.exitCode, 0, `stderr: ${statusJsonOut.stderr}`);
    const statusPayload = lastJsonLine<{ runId: string; state: string; tokensRendered: string; coverage: string }>(statusJsonOut.stdout);
    assert.equal(statusPayload.state, "SUCCEEDED");
    assert.equal(statusPayload.runId, runId);
    assert.ok(statusPayload.tokensRendered.length > 0, "tokens should be rendered");
    assert.ok(statusPayload.coverage.length > 0, "coverage should be rendered");

    // status <runId> (human layout) prints the same state.
    const statusOut = await captureMain(["status", runId, "--repo", repoRoot]);
    assert.equal(statusOut.exitCode, 0, `stderr: ${statusOut.stderr}`);
    assert.match(statusOut.stdout, /SUCCEEDED/);
    assert.match(statusOut.stdout, /Tokens/);
    assert.match(statusOut.stdout, /Coverage/);

    // logs <runId> --node implement --cycle 1.
    const logsOut = await captureMain(["logs", runId, "--node", "implement", "--cycle", "1", "--repo", repoRoot, "--json"]);
    assert.equal(logsOut.exitCode, 0, `stderr: ${logsOut.stderr}`);
    const logsPayload = lastJsonLine<Array<{ nodeId: string; cycleIndex: number; attempts: Array<{ attempt: number; plan: { argv: string[]; cwd: string; inputs: Record<string, unknown> } | null }> }>>(logsOut.stdout);
    assert.equal(logsPayload.length, 1);
    assert.equal(logsPayload[0]?.nodeId, "implement");
    assert.equal(logsPayload[0]?.cycleIndex, 1);
    // Item 5: the persisted dispatch plan is readable back through `logs` — resolved inputs and
    // the effective argv/cwd the driver built right before dispatching this attempt.
    const implementAttempt = logsPayload[0]?.attempts[0];
    assert.ok(implementAttempt?.plan, "the dispatch plan should have been persisted for this attempt");
    assert.ok(Array.isArray(implementAttempt?.plan?.argv) && implementAttempt.plan.argv.length > 0);
    assert.ok(implementAttempt?.plan?.cwd);
    assert.ok(implementAttempt?.plan?.inputs && Object.keys(implementAttempt.plan.inputs).length > 0);

    // This loop's `defaults.backend` is `fake` throughout (matching the manual scenario), so the
    // persisted plan's own notes are `FakeDispatcher.describe()`'s (no env to scrub, nothing was
    // ever spawned) rather than `LocalDispatcher.describe()`'s "env denied/injected" lines — the
    // human layout must still print whatever notes the plan actually carries.
    const logsHumanOut = await captureMain(["logs", runId, "--node", "implement", "--cycle", "1", "--repo", repoRoot]);
    assert.equal(logsHumanOut.exitCode, 0, `stderr: ${logsHumanOut.stderr}`);
    assert.match(logsHumanOut.stdout, /resolved inputs:/);
    assert.match(logsHumanOut.stdout, /argv:/);
    assert.match(logsHumanOut.stdout, /fake backend: replays the script step/);

    // rebuild-snapshot <runId>: ok.
    const rebuildOut = await captureMain(["rebuild-snapshot", runId, "--repo", repoRoot]);
    assert.equal(rebuildOut.exitCode, 0, `stderr: ${rebuildOut.stderr}`);
    assert.match(rebuildOut.stdout, /^ok:/);

    // export <runId>.
    const exportOut = await captureMain(["export", runId, "--repo", repoRoot]);
    assert.equal(exportOut.exitCode, 0, `stderr: ${exportOut.stderr}`);
    assert.match(exportOut.stdout, /^wrote /);

    // The report exists once the run reached a terminal state (item 6).
    const reportMdPath = join(layout.reports, `${runId}.md`);
    const reportJsonPath = join(layout.reports, `${runId}.json`);
    assert.ok(existsSync(reportMdPath), `report markdown missing at ${reportMdPath}`);
    assert.ok(existsSync(reportJsonPath), `report json missing at ${reportJsonPath}`);
    const reportMd = readFileSync(reportMdPath, "utf8");
    assert.match(reportMd, /SUCCEEDED/);
  });
});

test("item 2: approve with no dispatcher registered for the node's backend degrades to dispatch-failed -> FAILED (never the old exit-4 crash that left the run stuck RUNNING)", async () => {
  await withLoopCommitted(async (repoRoot, layout) => {
    const runOut = await captureMain(["run", "daily-content-improvement", "--repo", repoRoot, "--fake-script", REFERENCE_HAPPY_SCRIPT, "--json"]);
    assert.equal(runOut.exitCode, 20, `stderr: ${runOut.stderr}`);
    const runId = lastJsonLine<{ runId: string }>(runOut.stdout).runId;

    // Deliberately no --fake-script: `create-pr` (backend "fake") has no dispatcher registered,
    // reproducing the exact defect this task describes ("gate decision failed: no dispatcher
    // registered for backend \"fake\"", exit 4, the run left RUNNING with a dangling dispatch).
    const approveOut = await captureMain(["approve", runId, "--repo", repoRoot, "--actor", "maintainer", "--json"]);

    // budget.maxAttempts is 2 for this loop: the first dispatch-failed retries (R-29, attempt 2),
    // the second exhausts (R-30) -> FAILED(dispatch_failed), exit 10 -- never exit 4, and the
    // failure is fully recorded, not a bare crash.
    assert.equal(approveOut.exitCode, 10, `stderr: ${approveOut.stderr}`);
    const payload = lastJsonLine<{ state: string; outcome: Outcome | null }>(approveOut.stdout);
    assert.equal(payload.state, "FAILED");
    assert.ok(payload.outcome && payload.outcome.state === "FAILED");
    if (payload.outcome && payload.outcome.state === "FAILED") {
      assert.equal(payload.outcome.failureReason, "dispatch_failed");
    }

    // The run reached a clean terminal state — status agrees, and nothing is left dangling.
    const statusOut = await captureMain(["status", runId, "--repo", repoRoot, "--json"]);
    assert.equal(statusOut.exitCode, 0, `stderr: ${statusOut.stderr}`);
    const statusPayload = lastJsonLine<{ state: string }>(statusOut.stdout);
    assert.equal(statusPayload.state, "FAILED");

    // Item 6: the report exists on this terminal path too (a run that ends in dispatch-failed
    // exhaustion), not only the happy path.
    const reportMdPath = join(layout.reports, `${runId}.md`);
    const reportJsonPath = join(layout.reports, `${runId}.json`);
    assert.ok(existsSync(reportMdPath), `report markdown missing at ${reportMdPath}`);
    assert.ok(existsSync(reportJsonPath), `report json missing at ${reportJsonPath}`);
  });
});
