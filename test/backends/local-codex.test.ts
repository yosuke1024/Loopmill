// Tests for `src/backends/local/` against the `codex` runtime, using the stub CLI at
// test/fixtures/backends/bin/codex.mjs (never the real `codex`).

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
  type LocalWorkspace,
} from "../fixtures/backends/helpers.ts";

const CODEX_STUB = join(import.meta.dirname, "../fixtures/backends/bin/codex.mjs");

// review-content: codex agent node, structuredOutput { needs_issue: boolean, title: string,
// summary: string }. Its own inputs are declared but this test drives the node directly, so no
// inputs are strictly required by the (trivial, no-placeholder) prompt template.
const REVIEW_CONTENT_INPUTS = {};

function dispatcherFor(ws: LocalWorkspace): LocalDispatcher {
  return new LocalDispatcher({
    layout: ws.layout,
    classify: testClassify,
    binaries: { codex: CODEX_STUB },
  });
}

test("local codex: success -> node-completed, usage.provenance derived, usageBasis stripped on the wire", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("codex-1");
  try {
    const dispatcher = dispatcherFor(ws);
    const request = makeDispatchRequest(
      loop,
      "review-content",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: REVIEW_CONTENT_INPUTS, env: stubEnvPolicy("structured") },
    );
    const envelope = await dispatcher.dispatch(request, fixedClock());

    const check = validateEnvelope(envelope);
    assert.ok(check.ok, !check.ok ? JSON.stringify(check.errors) : "");
    assert.equal(envelope.eventType, "node-completed");
    assert.deepEqual(envelope.result?.structured, { needs_issue: true, title: "stub title", summary: "stub summary" });
    assert.equal(envelope.usage?.provenance, "derived");
    assert.equal(envelope.usage?.runtime, "codex");
  } finally {
    await ws.cleanup();
  }
});

test("local codex: structured output via --output-schema validates against the node's own schema", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("codex-2");
  try {
    const dispatcher = dispatcherFor(ws);
    const request = makeDispatchRequest(
      loop,
      "review-content",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: REVIEW_CONTENT_INPUTS, env: stubEnvPolicy("structured") },
    );
    const envelope = await dispatcher.dispatch(request, fixedClock());
    assert.equal(envelope.eventType, "node-completed");
    const structured = envelope.result?.structured as { needs_issue: boolean; title: string; summary: string };
    assert.equal(typeof structured.needs_issue, "boolean");
    assert.equal(typeof structured.title, "string");
    assert.equal(typeof structured.summary, "string");
  } finally {
    await ws.cleanup();
  }
});

test("local codex: turn.failed -> node-failed with the classify stub's output", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("codex-3");
  try {
    const dispatcher = dispatcherFor(ws);
    const request = makeDispatchRequest(
      loop,
      "review-content",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: REVIEW_CONTENT_INPUTS, env: stubEnvPolicy("turn-failed") },
    );
    const envelope = await dispatcher.dispatch(request, fixedClock());

    const check = validateEnvelope(envelope);
    assert.ok(check.ok, !check.ok ? JSON.stringify(check.errors) : "");
    assert.equal(envelope.eventType, "node-failed");
    assert.equal(envelope.error?.code, "codex_failed"); // testClassify's own code for this case
    assert.equal(envelope.usage?.provenance, "unavailable");
  } finally {
    await ws.cleanup();
  }
});

test(
  "local codex: SIGTERM-on-timeout -> node-timed-out with usage.provenance unavailable",
  { timeout: 20_000 },
  async () => {
    const loop = await loadReferenceLoop();
    const ws = await makeLocalWorkspace("codex-4");
    try {
      const dispatcher = dispatcherFor(ws);
      const request = makeDispatchRequest(
        loop,
        "review-content",
        { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
        { inputs: REVIEW_CONTENT_INPUTS, env: stubEnvPolicy("sleep"), timeoutMs: 300 },
      );
      const envelope = await dispatcher.dispatch(request, fixedClock());

      const check = validateEnvelope(envelope);
      assert.ok(check.ok, !check.ok ? JSON.stringify(check.errors) : "");
      assert.equal(envelope.eventType, "node-timed-out");
      assert.equal(envelope.error?.classified, "timeout");
      assert.equal(envelope.usage?.provenance, "unavailable");
      assert.equal(envelope.usage?.complete, false);
    } finally {
      await ws.cleanup();
    }
  },
);
