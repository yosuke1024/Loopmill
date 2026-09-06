// A20: with the `local` backend and the stub `claude` CLI (test/fixtures/backends/bin/), a
// one-agent-node loop run in a temp git repo leaves the operator's checkout untouched, the
// change lives on `loopmill/<slug>/<runId>` in `.loopmill/worktrees/<runId>`, and one cycle
// commit exists with the documented message (mvp-design.md §18, §13.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { existsSync, readFileSync } from "node:fs";

import { defaultDispatchers, runLoop } from "../../src/driver/index.ts";
import type { TriggerPayload } from "../../src/types/envelope.ts";
import { LOCAL_MINI_LOOP_PATH, currentBranch, fixedClock, headCommitOf, makeScratchRepo, openTestContext, statusPorcelain } from "../fixtures/driver/helpers.ts";

const CLAUDE_STUB = fileURLToPath(new URL("../fixtures/backends/bin/claude.mjs", import.meta.url));

function commitMessagesOf(repoRoot: string, ref: string): string[] {
  const out = execFileSync("git", ["log", "--format=%s", ref], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\n").filter((l) => l.length > 0);
}

test("A20: worktree isolation and the one-commit-per-cycle rule against the local backend", async () => {
  const repo = await makeScratchRepo();
  try {
    const operatorHeadBefore = headCommitOf(repo.repoRoot);
    const operatorBranchBefore = currentBranch(repo.repoRoot);

    const clock = fixedClock();
    const ctx = await openTestContext(repo, LOCAL_MINI_LOOP_PATH, clock);
    try {
      // Captured *after* `openRunContext` creates `.loopmill/` (an untracked, gitignored
      // directory of Loopmill's own state — mvp-design.md §9.1) but *before* `runLoop` touches
      // anything, so this is a true "did the Run itself touch the operator's tree" baseline.
      const operatorStatusBefore = statusPorcelain(repo.repoRoot);
      const dispatchers = defaultDispatchers({ layout: ctx.layout, binaries: { claude: CLAUDE_STUB } });
      const trigger: TriggerPayload = { kind: "manual" };
      const result = await runLoop({ ctx, trigger, dispatchers });

      assert.equal(result.exitCode, 0, "the stub CLI's structured-output run should SUCCEED");
      assert.equal(result.state, "SUCCEEDED");
      const runId = result.runId!;

      // The operator's own checkout is untouched.
      assert.equal(headCommitOf(repo.repoRoot), operatorHeadBefore, "the operator's HEAD must not move");
      assert.equal(currentBranch(repo.repoRoot), operatorBranchBefore, "the operator must stay on their own branch");
      assert.equal(statusPorcelain(repo.repoRoot), operatorStatusBefore, "the operator's working tree must stay clean");

      // The change lives on loopmill/<slug>/<runId> in .loopmill/worktrees/<runId>.
      const worktreePath = join(ctx.layout.worktrees, runId);
      const branch = currentBranch(worktreePath);
      assert.equal(branch, `loopmill/${ctx.loop.slug}/${runId}`);

      // One cycle commit exists with the documented message.
      const messages = commitMessagesOf(worktreePath, "HEAD");
      const expected = `loopmill: ${ctx.loop.slug} cycle 0 (${runId})`;
      assert.ok(messages.includes(expected), `expected a commit "${expected}", got ${JSON.stringify(messages)}`);
      assert.equal(headCommitOf(worktreePath) === operatorHeadBefore, false, "the worktree must have advanced past the operator's base commit");

      // Item 5, m1 follow-up: the dispatch plan `logs` reads back is persisted right before
      // dispatch, against the real `local` backend — `LocalDispatcher.describe()`'s own env
      // deny/inject notes prove this is more than the `fake` backend's placeholder note.
      const planPath = join(ctx.layout.logs, runId, "0-implement-1.plan.json");
      assert.ok(existsSync(planPath), `dispatch plan missing at ${planPath}`);
      const plan = JSON.parse(readFileSync(planPath, "utf8")) as { argv: string[]; cwd: string; notes: string[]; inputs: Record<string, unknown> };
      assert.ok(plan.argv.length > 0);
      assert.equal(plan.cwd, worktreePath);
      assert.ok(plan.notes.some((n) => n.startsWith("env denied:")), `expected an "env denied:" note, got ${JSON.stringify(plan.notes)}`);
      assert.ok(plan.notes.some((n) => n.startsWith("env injected:")), `expected an "env injected:" note, got ${JSON.stringify(plan.notes)}`);
    } finally {
      ctx.close();
    }
  } finally {
    await repo.cleanup();
  }
});
