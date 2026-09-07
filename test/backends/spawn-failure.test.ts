// Test group 8: a spawn failure (the runtime binary itself cannot be found) rejects
// `Dispatcher.dispatch` with `dispatch_failed`, never throws a different shape and never
// resolves with a `node-*` envelope (mvp-design.md §7.2 step 6, state-machine.md §10.4).

import { test } from "node:test";
import assert from "node:assert/strict";

import { LocalDispatcher } from "../../src/backends/local/executor.ts";
import { fixedClock, loadReferenceLoop, makeDispatchRequest, makeLocalWorkspace, testClassify } from "../fixtures/backends/helpers.ts";

test("local: dispatch rejects with dispatch_failed when binaries.claude points at a missing path", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("spawn-fail-1");
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      binaries: { claude: "/definitely/does/not/exist/claude" },
    });
    const request = makeDispatchRequest(
      loop,
      "implement",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: { issue_url: "https://x/1", finding: "y", attempt: 1 } },
    );
    await assert.rejects(
      () => dispatcher.dispatch(request, fixedClock()),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, "dispatch_failed");
        return true;
      },
    );
  } finally {
    await ws.cleanup();
  }
});

test("local: dispatch rejects with dispatch_failed when binaries.codex points at a missing path", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("spawn-fail-2");
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      binaries: { codex: "/definitely/does/not/exist/codex" },
    });
    const request = makeDispatchRequest(loop, "review-content", {
      repoRoot: ws.repo.repoRoot,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
    });
    await assert.rejects(
      () => dispatcher.dispatch(request, fixedClock()),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === "dispatch_failed",
    );
  } finally {
    await ws.cleanup();
  }
});

test("local: dispatch rejects with dispatch_failed when a command node's argv[0] cannot be spawned", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("spawn-fail-3");
  try {
    const testLoop = {
      ...loop,
      nodes: {
        ...loop.nodes,
        "synthetic-command": {
          kind: "command" as const,
          id: "synthetic-command",
          backend: "local" as const,
          argv: ["/definitely/does/not/exist/binary"],
          cwd: ".",
          env: null,
          inputs: {},
          onFailure: "fail_run" as const,
          effects: "none" as const,
        },
      },
    };
    const dispatcher = new LocalDispatcher({ layout: ws.layout, classify: testClassify });
    const request = makeDispatchRequest(testLoop, "synthetic-command", {
      repoRoot: ws.repo.repoRoot,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
    });
    await assert.rejects(
      () => dispatcher.dispatch(request, fixedClock()),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === "dispatch_failed",
    );
  } finally {
    await ws.cleanup();
  }
});
