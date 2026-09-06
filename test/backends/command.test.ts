// Tests for `command` node execution (`src/backends/local/command.ts`, exercised through
// `LocalDispatcher`): argv rendering (loop-file.md §10.1, A6), the stdout rule, and the non-zero
// exit -> node-failed rule (mvp-design.md §7.2 step 6).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LocalDispatcher } from "../../src/backends/local/executor.ts";
import { truncateStdout } from "../../src/backends/local/command.ts";
import { validateEnvelope } from "../../src/envelope/validate.ts";
import { fixedClock, loadReferenceLoop, makeDispatchRequest, makeLocalWorkspace, testClassify, type LocalWorkspace } from "../fixtures/backends/helpers.ts";
import type { ResolvedLoop } from "../../src/types/loop.ts";

function dispatcherFor(ws: LocalWorkspace): LocalDispatcher {
  return new LocalDispatcher({
    layout: ws.layout,
    classify: testClassify,
  });
}

/** A synthetic `command` node -- not from the reference loop -- so these tests can pick
 * whatever argv/env/cwd shape they need without depending on `gh`/`npm` being installed. */
function syntheticCommandLoop(loop: ResolvedLoop, argv: string[], overrides: Partial<import("../../src/types/loop.ts").ResolvedCommandNode> = {}) {
  return {
    ...loop,
    nodes: {
      ...loop.nodes,
      "synthetic-command": {
        kind: "command" as const,
        id: "synthetic-command",
        backend: "local" as const,
        argv,
        cwd: ".",
        env: null,
        inputs: {},
        onFailure: "fail_run" as const,
        effects: "none" as const,
        ...overrides,
      },
    },
  };
}

test("command: argv is rendered with the A6 value (spaces, quotes, semicolon) as ONE element, never re-parsed", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("command-1");
  try {
    const a6 = 'a value with spaces, "quotes" and a ; semicolon';
    // `printf '%s'` echoes argv[1] verbatim with no shell involved -- if the value were ever
    // word-split or re-parsed by a shell, this would not come back byte-for-byte.
    const testLoop = syntheticCommandLoop(loop, ["printf", "%s", "${value}"]);
    const dispatcher = dispatcherFor(ws);
    const request = makeDispatchRequest(
      testLoop,
      "synthetic-command",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: { value: a6 } },
    );
    const envelope = await dispatcher.dispatch(request, fixedClock());
    assert.equal(envelope.eventType, "node-completed");
    const structured = envelope.result?.structured as { stdout: string };
    assert.equal(structured.stdout, a6);
  } finally {
    await ws.cleanup();
  }
});

test("command: stdout travels in result.structured.stdout, truncated at 8 KiB", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("command-2");
  try {
    const testLoop = syntheticCommandLoop(loop, ["node", "-e", "process.stdout.write('x'.repeat(20000))"]);
    const dispatcher = dispatcherFor(ws);
    const request = makeDispatchRequest(testLoop, "synthetic-command", {
      repoRoot: ws.repo.repoRoot,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
    });
    const envelope = await dispatcher.dispatch(request, fixedClock());
    assert.equal(envelope.eventType, "node-completed");
    const structured = envelope.result?.structured as { stdout: string };
    assert.ok(structured.stdout.endsWith("…[truncated]"));
    assert.ok(Buffer.byteLength(structured.stdout, "utf8") <= 8 * 1024);

    // The full, untruncated stream is still on disk behind the log artifactRef.
    const stdoutRef = (envelope.artifactRefs ?? []).find((r) => r.ref.endsWith(".stdout.log"));
    assert.ok(stdoutRef);
    const full = readFileSync(stdoutRef!.ref, "utf8");
    assert.equal(full.length, 20000);
  } finally {
    await ws.cleanup();
  }
});

test("command: truncateStdout caps at 8 KiB and appends the marker", () => {
  const long = "y".repeat(9000);
  const truncated = truncateStdout(long);
  assert.ok(truncated.endsWith("…[truncated]"));
  assert.ok(Buffer.byteLength(truncated, "utf8") <= 8 * 1024);

  const short = "short output";
  assert.equal(truncateStdout(short), short);
});

test("command: a non-zero exit is node-failed with error.classified runtime_error and code exit_<n>", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("command-3");
  try {
    const testLoop = syntheticCommandLoop(loop, ["node", "-e", "process.exit(7)"]);
    const dispatcher = dispatcherFor(ws);
    const request = makeDispatchRequest(testLoop, "synthetic-command", {
      repoRoot: ws.repo.repoRoot,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
    });
    const envelope = await dispatcher.dispatch(request, fixedClock());

    const check = validateEnvelope(envelope);
    assert.ok(check.ok, !check.ok ? JSON.stringify(check.errors) : "");
    assert.equal(envelope.eventType, "node-failed");
    assert.equal(envelope.result?.status, "failed");
    assert.equal(envelope.result?.exitCode, 7);
    assert.equal(envelope.error?.classified, "runtime_error");
    assert.equal(envelope.error?.code, "exit_7");
  } finally {
    await ws.cleanup();
  }
});

test("command: cwd is rejected when it escapes the worktree", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("command-4");
  try {
    const testLoop = syntheticCommandLoop(loop, ["true"], { cwd: "../escape" });
    const dispatcher = dispatcherFor(ws);
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

test("command: writes inside the worktree are reported via changedFiles-sourced artifactRefs", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("command-5");
  try {
    const testLoop = syntheticCommandLoop(loop, ["node", "-e", "require('fs').writeFileSync('written-by-command.txt', 'hi\\n')"]);
    const dispatcher = dispatcherFor(ws);
    const request = makeDispatchRequest(testLoop, "synthetic-command", {
      repoRoot: ws.repo.repoRoot,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
    });
    const envelope = await dispatcher.dispatch(request, fixedClock());
    assert.equal(envelope.eventType, "node-completed");
    const refs = (envelope.artifactRefs ?? []).map((r) => r.ref);
    assert.ok(refs.includes("written-by-command.txt"));
  } finally {
    await ws.cleanup();
  }
});
