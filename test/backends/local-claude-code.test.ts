// Tests for `src/backends/local/` against the `claude-code` runtime, using the stub CLI at
// test/fixtures/backends/bin/claude.mjs (never the real `claude`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { LocalDispatcher } from "../../src/backends/local/executor.ts";
import { validateEnvelope } from "../../src/envelope/validate.ts";
import {
  fixedClock,
  loadReferenceLoop,
  makeDispatchRequest,
  makeLocalWorkspace,
  stubEnvPolicy,
  testClassify,
} from "../fixtures/backends/helpers.ts";

const CLAUDE_STUB = join(import.meta.dirname, "../fixtures/backends/bin/claude.mjs");

const IMPLEMENT_INPUTS = { issue_url: "https://github.com/example/example/issues/482", finding: "stale version number", attempt: 1 };

test("local claude-code: success with structured output -> node-completed, validated structured shape, usage.provenance reported, artifactRefs include logs + changed files", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("claude-1");
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      binaries: { claude: CLAUDE_STUB },
    });

    const request = makeDispatchRequest(loop, "implement", { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit }, {
      inputs: IMPLEMENT_INPUTS,
      env: stubEnvPolicy("structured"),
    });

    const envelope = await dispatcher.dispatch(request, fixedClock());

    const check = validateEnvelope(envelope);
    assert.ok(check.ok, !check.ok ? JSON.stringify(check.errors) : "");
    assert.equal(envelope.eventType, "node-completed");
    assert.equal(envelope.result?.status, "succeeded");
    assert.deepEqual(envelope.result?.structured, { changed: true, summary: "stub changed something" });
    assert.equal(envelope.usage?.provenance, "reported");
    assert.equal(envelope.usage?.runtime, "claude-code");

    const refKinds = (envelope.artifactRefs ?? []).map((r) => r.ref);
    assert.ok(refKinds.some((r) => r.endsWith(".stdout.log")), "artifactRefs must include the stdout log");
    assert.ok(refKinds.some((r) => r.endsWith(".stderr.log")), "artifactRefs must include the stderr log");
    assert.ok(refKinds.includes("stub-agent-output.txt"), "artifactRefs must include the file the stub agent wrote");
  } finally {
    await ws.cleanup();
  }
});

test("local claude-code: implement declares no structuredOutput override -- review-content-shaped structured is only reported when the node asks for one", async () => {
  // Sanity check on the "only a structuredOutput node reports result.structured" rule using a
  // node that does NOT declare structuredOutput: run-tests is a command node, out of scope here,
  // so this instead re-uses `implement` (which DOES declare structuredOutput) with the plain
  // "success" stub mode (no structured_output key at all) to confirm the completion is then
  // downgraded to a failure rather than silently succeeding without the promised shape.
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("claude-2");
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      binaries: { claude: CLAUDE_STUB },
    });
    const request = makeDispatchRequest(loop, "implement", { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit }, {
      inputs: IMPLEMENT_INPUTS,
      env: stubEnvPolicy("success"), // no structured_output field
    });
    const envelope = await dispatcher.dispatch(request, fixedClock());
    assert.equal(envelope.eventType, "node-failed");
    assert.equal(envelope.error?.code, "structured_output_invalid");
    assert.equal(envelope.error?.classified, "artifact_invalid");
  } finally {
    await ws.cleanup();
  }
});

test(
  "local claude-code: timeout -> node-timed-out; the stub received SIGINT and its aborted_streaming result's usage is carried on the envelope (complete: false)",
  { timeout: 20_000 },
  async () => {
    const loop = await loadReferenceLoop();
    const ws = await makeLocalWorkspace("claude-3");
    try {
      const dispatcher = new LocalDispatcher({
        layout: ws.layout,
        classify: testClassify,
        binaries: { claude: CLAUDE_STUB },
      });
      const request = makeDispatchRequest(
        loop,
        "implement",
        { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
        {
          inputs: IMPLEMENT_INPUTS,
          env: stubEnvPolicy("sleep-then-exit"),
          timeoutMs: 300, // the stub sleeps 60s and only reacts to SIGINT
        },
      );
      const envelope = await dispatcher.dispatch(request, fixedClock());

      const check = validateEnvelope(envelope);
      assert.ok(check.ok, !check.ok ? JSON.stringify(check.errors) : "");
      assert.equal(envelope.eventType, "node-timed-out");
      assert.equal(envelope.error?.classified, "timeout");
      // The stub's aborted_streaming result still carries a completed helper-model usage entry;
      // `normalizeClaudeCodeResult` reports it `reported` but `complete: false` (R6).
      assert.equal(envelope.usage?.provenance, "reported");
      assert.equal(envelope.usage?.complete, false);
    } finally {
      await ws.cleanup();
    }
  },
);

test("local claude-code: stdin is /dev/null (the stub sees no TTY and an immediate EOF)", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("claude-4");
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      binaries: { claude: CLAUDE_STUB },
    });
    const request = makeDispatchRequest(loop, "implement", { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit }, {
      inputs: IMPLEMENT_INPUTS,
      env: stubEnvPolicy("success"),
    });
    const envelope = await dispatcher.dispatch(request, fixedClock());
    // "success" mode has no structured_output, so this node (which declares structuredOutput)
    // is downgraded to node-failed -- irrelevant to this test, which reads the log file the
    // stub's own stdin_check was captured into.
    assert.equal(envelope.eventType, "node-failed");

    const { readFileSync } = await import("node:fs");
    const stdoutRef = (envelope.artifactRefs ?? []).find((r) => r.ref.endsWith(".stdout.log"));
    assert.ok(stdoutRef);
    const logged = readFileSync(stdoutRef!.ref, "utf8");
    const parsed = JSON.parse(logged.trim().split("\n")[0]!) as { stdin_check: { isTTY: boolean; bytesRead?: number; errorCode?: string } };
    assert.equal(parsed.stdin_check.isTTY, false);
    assert.ok(
      parsed.stdin_check.bytesRead === 0 || parsed.stdin_check.errorCode !== undefined,
      `expected immediate EOF or a read error on /dev/null, got ${JSON.stringify(parsed.stdin_check)}`,
    );
  } finally {
    await ws.cleanup();
  }
});
