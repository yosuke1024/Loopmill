// Tests for `src/backends/local/worktree.ts` (A20 -- docs/design/mvp-design.md §7.2, §13.1, §18;
// docs/spec/state-machine.md §10.4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { changedFiles, commitCycle, ensureWorktree, headCommit, resetToCycleBase } from "../../src/backends/local/worktree.ts";
import { makeScratchRepo, headCommitOf, type ScratchRepo } from "../fixtures/backends/helpers.ts";

/** Runs `body` against a fresh scratch repo and a worktree path that is a sibling of the repo
 * root (never inside it -- a worktree directory inside `repoRoot` would itself show up as an
 * untracked entry in the operator's own `git status`, contaminating exactly what the
 * "operator's checkout is untouched" test below checks). Cleans up both unconditionally,
 * whatever `body` does. */
async function withScratchWorktree(
  name: string,
  body: (ctx: { repo: ScratchRepo; worktreePath: string; branch: string; base: string }) => void | Promise<void>,
): Promise<void> {
  const repo = await makeScratchRepo();
  const worktreePath = join(repo.repoRoot, "..", `wt-${name}`);
  const branch = `loopmill/test-loop/run_${name}`;
  const base = headCommitOf(repo.repoRoot);
  try {
    await body({ repo, worktreePath, branch, base });
  } finally {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await repo.cleanup();
  }
}

test("worktree: ensureWorktree creates the branch and the worktree directory", () =>
  withScratchWorktree("1", ({ repo, worktreePath, branch, base }) => {
    const { baseCommit } = ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });
    assert.equal(baseCommit, base);
    assert.ok(existsSync(worktreePath));

    const branches = execFileSync("git", ["branch", "--list", branch], { cwd: repo.repoRoot, encoding: "utf8" });
    assert.ok(branches.includes(branch));
  }));

test("worktree: ensureWorktree is idempotent -- a second call against the same path is a no-op", () =>
  withScratchWorktree("2", ({ repo, worktreePath, branch, base }) => {
    ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });
    writeFileSync(join(worktreePath, "scratch.txt"), "hello\n");
    execFileSync("git", ["add", "-A"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-q", "-m", "cycle 1"], { cwd: worktreePath });
    const advanced = headCommit(worktreePath);
    assert.notEqual(advanced, base);

    const second = ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });
    assert.equal(second.baseCommit, advanced, "a second ensureWorktree call must not reset progress already made");
  }));

test("worktree: the operator's checkout (branch, index, working tree) is untouched after an attempt writes files (A20)", () =>
  withScratchWorktree("3", ({ repo, worktreePath, branch, base }) => {
    ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });

    const branchBefore = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.repoRoot, encoding: "utf8" }).trim();
    const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: repo.repoRoot, encoding: "utf8" });
    const readmeBefore = readFileSync(join(repo.repoRoot, "README.md"), "utf8");

    writeFileSync(join(worktreePath, "new-file.txt"), "written by an attempt\n");
    execFileSync("git", ["add", "-A"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-q", "-m", "attempt wrote a file"], { cwd: worktreePath });

    const branchAfter = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.repoRoot, encoding: "utf8" }).trim();
    const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: repo.repoRoot, encoding: "utf8" });
    const readmeAfter = readFileSync(join(repo.repoRoot, "README.md"), "utf8");

    assert.equal(branchAfter, branchBefore);
    assert.equal(statusAfter, statusBefore);
    assert.equal(readmeAfter, readmeBefore);
    assert.ok(!existsSync(join(repo.repoRoot, "new-file.txt")), "the operator's checkout must never see the attempt's file");
  }));

test("worktree: changedFiles digests match git hash-object", () =>
  withScratchWorktree("4", ({ repo, worktreePath, branch, base }) => {
    ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });

    writeFileSync(join(worktreePath, "a.txt"), "content a\n");
    writeFileSync(join(worktreePath, "README.md"), "changed the readme too\n");

    const changed = changedFiles(worktreePath);
    assert.equal(changed.length, 2);
    for (const entry of changed) {
      const expected = execFileSync("git", ["hash-object", entry.path], { cwd: worktreePath, encoding: "utf8" }).trim();
      assert.equal(entry.digest, expected, `digest for ${entry.path} must match git hash-object`);
    }
  }));

test("worktree: changedFiles reports a deleted file with an empty digest", () =>
  withScratchWorktree("5", ({ repo, worktreePath, branch, base }) => {
    ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });

    execFileSync("git", ["rm", "-q", "README.md"], { cwd: worktreePath });
    const changed = changedFiles(worktreePath);
    const readmeEntry = changed.find((f) => f.path === "README.md");
    assert.ok(readmeEntry);
    assert.equal(readmeEntry.digest, "");
    assert.ok(readmeEntry.status.includes("D"));
  }));

test("worktree: commitCycle makes one commit and returns null when nothing changed", () =>
  withScratchWorktree("6", ({ worktreePath, branch, base, repo }) => {
    ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });

    const noOp = commitCycle(worktreePath, "loopmill: test-loop cycle 1 (run_6)");
    assert.equal(noOp, null);
    assert.equal(headCommit(worktreePath), base);

    writeFileSync(join(worktreePath, "b.txt"), "new content\n");
    const result = commitCycle(worktreePath, "loopmill: test-loop cycle 1 (run_6)");
    assert.ok(result);
    assert.notEqual(result!.commit, base);
    assert.equal(headCommit(worktreePath), result!.commit);

    const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: worktreePath, encoding: "utf8" }).trim();
    assert.equal(log, "loopmill: test-loop cycle 1 (run_6)");
  }));

test("worktree: resetToCycleBase discards a stray untracked file and any tracked edit", () =>
  withScratchWorktree("7", ({ worktreePath, branch, base, repo }) => {
    ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });

    writeFileSync(join(worktreePath, "stray.txt"), "left behind by a killed attempt\n");
    writeFileSync(join(worktreePath, "README.md"), "tracked edit\n");
    assert.ok(existsSync(join(worktreePath, "stray.txt")));

    resetToCycleBase(worktreePath, base);

    assert.ok(!existsSync(join(worktreePath, "stray.txt")));
    assert.equal(readFileSync(join(worktreePath, "README.md"), "utf8"), "# scratch repo\n");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf8" }), "");
  }));
