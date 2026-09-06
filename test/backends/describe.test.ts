// Tests for `Dispatcher.describe()` (A16 -- `loopmill run --dry-run`): the plan is printed
// without spawning anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { LocalDispatcher } from "../../src/backends/local/executor.ts";
import { loadReferenceLoop, makeDispatchRequest, makeLocalWorkspace, testClassify } from "../fixtures/backends/helpers.ts";

test("describe: an agent (claude-code) node's plan carries the rendered argv, cwd, scrubbed env, and touches no filesystem beyond the prompt", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("describe-1");
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      binaries: { claude: "/nonexistent/claude" },
      parentEnv: { PATH: "/usr/bin:/bin", HOME: "/home/op", ANTHROPIC_API_KEY: "sk-ant-should-be-scrubbed" },
    });
    const request = makeDispatchRequest(
      loop,
      "implement",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: { issue_url: "https://x/1", finding: "y", attempt: 1 } },
    );
    const plan = dispatcher.describe(request);

    assert.equal(plan.argv[0], "/nonexistent/claude");
    assert.ok(plan.argv.includes("-p"));
    assert.ok(plan.argv.some((a) => a.includes("Fix the problem described in https://x/1")));
    assert.equal(plan.cwd, ws.worktreePath);
    assert.equal(plan.stdin, "/dev/null");
    assert.equal(plan.env["ANTHROPIC_API_KEY"], undefined);
    assert.ok(plan.notes.some((n) => n.includes("ANTHROPIC_API_KEY")));

    // No process was spawned: no log files under this workspace's own (uniquely-named) logsDir.
    assert.ok(!existsSync(ws.layout.logsDir));
  } finally {
    await ws.cleanup();
  }
});

test("describe: a command node's plan renders argv against the resolved inputs", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("describe-2");
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
    });
    const request = makeDispatchRequest(
      loop,
      "create-issue",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: { title: "A title", body: "A body" } },
    );
    const plan = dispatcher.describe(request);
    assert.deepEqual(plan.argv, ["gh", "issue", "create", "--title", "A title", "--body", "A body"]);
    assert.equal(plan.cwd, ws.worktreePath);
  } finally {
    await ws.cleanup();
  }
});

test("describe: a codex node's plan includes the sandbox flag mapped from permissionProfile", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("describe-3");
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      binaries: { codex: "/nonexistent/codex" },
    });
    const request = makeDispatchRequest(loop, "review-content", {
      repoRoot: ws.repo.repoRoot,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
    });
    const plan = dispatcher.describe(request);
    assert.equal(plan.argv[0], "/nonexistent/codex");
    const sIndex = plan.argv.indexOf("-s");
    assert.ok(sIndex !== -1);
    assert.equal(plan.argv[sIndex + 1], "workspace-write"); // reference loop's default permissionProfile
  } finally {
    await ws.cleanup();
  }
});
