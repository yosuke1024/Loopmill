// A16 end to end (mvp-design.md §20.3): `LocalDispatcher.describe()` and `.dispatch()` resolve a
// bare binary name through the SAME code path (`executor.ts`'s `resolveArgv0`, over
// `resolve-binary.ts`'s `resolveBinary`), against the SAME child-scrubbed `PATH` -- so the
// dry-run plan and the real spawn never disagree about what would run. `describe.test.ts` and
// `resolve-binary.test.ts` cover the individual pieces; this file proves the two callers actually
// agree, and that a real dispatch still fails the way a missing binary always has.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, chmodSync } from "node:fs";
import { dirname, delimiter, isAbsolute, join } from "node:path";

import { LocalDispatcher } from "../../src/backends/local/executor.ts";
import {
  fixedClock,
  loadReferenceLoop,
  makeDispatchRequest,
  makeLocalWorkspace,
  makeStubPathDir,
  stubEnvPolicy,
  testClassify,
} from "../fixtures/backends/helpers.ts";

const CLAUDE_STUB = join(import.meta.dirname, "../fixtures/backends/bin/claude.mjs");
const IMPLEMENT_INPUTS = { issue_url: "https://github.com/example/example/issues/482", finding: "stale version number", attempt: 1 };

test("A16: describe() and dispatch() resolve the same bare agent binary to the same absolute path, and dispatch actually runs it", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("binres-1");
  // A controlled PATH holding the real claude.mjs stub, but installed under the BARE name
  // "claude" -- this is the same shape a real `claude` install on an operator's PATH takes, and
  // it is the one this test needs: `binaries: { claude: "claude" }` below is deliberately a bare
  // name, so both `describe()` and `dispatch()` must resolve it through `PATH`, not just accept
  // an already-absolute path the way every other dispatch test in this suite does.
  const stubBin = makeStubPathDir([]);
  const claudeOnPath = join(stubBin.dir, "claude");
  copyFileSync(CLAUDE_STUB, claudeOnPath);
  chmodSync(claudeOnPath, 0o755);
  // The stub's own shebang is `#!/usr/bin/env node` -- `env` must still find a real `node` once
  // spawned with the CHILD's PATH (which, after this test's own `preserve: ["PATH"]`, is exactly
  // the string given to `parentEnv.PATH` below), so the real Node install's own bin directory is
  // appended after the stub directory. Resolution must still prefer the stub dir's own "claude"
  // over anything else, since it is listed first.
  const pathEnv = [stubBin.dir, dirname(process.execPath)].join(delimiter);
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      binaries: { claude: "claude" }, // bare -- PATH resolution is exactly what this test exercises
      parentEnv: { PATH: pathEnv, HOME: process.env["HOME"] ?? "" },
    });
    const request = makeDispatchRequest(
      loop,
      "implement",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: IMPLEMENT_INPUTS, env: stubEnvPolicy("structured") },
    );

    // The dry-run plan: argv[0] is the absolute path this PATH resolves "claude" to.
    const plan = dispatcher.describe(request);
    assert.ok(isAbsolute(plan.argv[0]!), `dry-run argv[0] must be absolute, got ${plan.argv[0]}`);
    assert.equal(plan.argv[0], claudeOnPath);
    assert.equal(plan.notes.some((n) => n.includes("binary not found")), false);

    // The real dispatch: spawns exactly the path the plan promised, and it runs -- proof the
    // resolution is not just computed and discarded, but actually used by `spawn()`.
    const envelope = await dispatcher.dispatch(request, fixedClock());
    assert.equal(envelope.eventType, "node-completed", `expected the stub to run and succeed: ${JSON.stringify(envelope.error)}`);
    assert.deepEqual(envelope.result?.structured, { changed: true, summary: "stub changed something" });
  } finally {
    await stubBin.cleanup();
    await ws.cleanup();
  }
});

test("A16: describe() and dispatch() resolve the same bare command binary to the same absolute path", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("binres-2");
  const stubBin = makeStubPathDir(["gh"]);
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      parentEnv: { PATH: stubBin.dir, HOME: process.env["HOME"] ?? "" },
    });
    const request = makeDispatchRequest(
      loop,
      "create-issue",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: { title: "A title", body: "A body" } },
    );

    const plan = dispatcher.describe(request);
    const resolvedGh = join(stubBin.dir, "gh");
    assert.equal(plan.argv[0], resolvedGh);

    const envelope = await dispatcher.dispatch(request, fixedClock());
    assert.equal(envelope.eventType, "node-completed", `expected the stub "gh" (exit 0) to succeed: ${JSON.stringify(envelope.error)}`);
    assert.equal(envelope.result?.exitCode, 0);
  } finally {
    await stubBin.cleanup();
    await ws.cleanup();
  }
});

test("A16: a bare binary nowhere on PATH still fails dispatch the way a missing binary always has (dispatch_failed), not a new failure mode", async () => {
  const loop = await loadReferenceLoop();
  const ws = await makeLocalWorkspace("binres-3");
  // A PATH that deliberately does not contain "claude" -- `binaries.claude` stays the bare
  // default ("claude", `executor.ts`'s own constructor default) so this exercises the exact
  // "nothing on PATH resolves it" case, not an already-absolute nonexistent path (that shape is
  // already covered by `spawn-failure.test.ts`).
  const stubBin = makeStubPathDir(["npm"]);
  try {
    const dispatcher = new LocalDispatcher({
      layout: ws.layout,
      classify: testClassify,
      parentEnv: { PATH: stubBin.dir, HOME: process.env["HOME"] ?? "" },
    });
    const request = makeDispatchRequest(
      loop,
      "implement",
      { repoRoot: ws.repo.repoRoot, worktreePath: ws.worktreePath, branch: ws.branch, baseCommit: ws.baseCommit },
      { inputs: IMPLEMENT_INPUTS, env: stubEnvPolicy("structured") },
    );

    // The plan is still useful and does not throw: argv[0] stays the bare name, with a note.
    const plan = dispatcher.describe(request);
    assert.equal(plan.argv[0], "claude");
    assert.ok(plan.notes.some((n) => n.includes("binary not found on PATH")));

    // The real dispatch rejects with dispatch_failed, exactly as it did before this task (an
    // ENOENT from `spawn()` itself -- see `resolveArgv0`'s doc comment in `executor.ts`).
    await assert.rejects(
      () => dispatcher.dispatch(request, fixedClock()),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === "dispatch_failed",
    );
  } finally {
    await stubBin.cleanup();
    await ws.cleanup();
  }
});
