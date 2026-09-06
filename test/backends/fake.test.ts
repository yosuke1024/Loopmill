// Tests for `src/backends/fake/`: docs/design/m1-plan.md `backends/` row, test group 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FakeDispatcher, loadFakeScript, type FakeScript, type FakeScriptKey } from "../../src/backends/fake/index.ts";
import { validateEnvelope } from "../../src/envelope/validate.ts";
import type { Envelope } from "../../src/types/envelope.ts";
import { fixedClock, loadReferenceLoop, makeDispatchRequest } from "../fixtures/backends/helpers.ts";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/backends/fake");

async function dispatchAllSteps(script: FakeScript, now: string): Promise<Array<{ key: FakeScriptKey; envelope: Envelope }>> {
  const loop = await loadReferenceLoop();
  const dispatcher = new FakeDispatcher(script);
  const workspace = {
    repoRoot: "/tmp/does-not-need-to-exist",
    worktreePath: "/tmp/does-not-need-to-exist/wt",
    branch: "loopmill/daily-content-improvement/run_01TESTRUN00000000000000000",
    baseCommit: "0".repeat(40),
  };

  const results: Array<{ key: FakeScriptKey; envelope: Envelope }> = [];
  for (const key of Object.keys(script.steps) as FakeScriptKey[]) {
    const [cycleStr, nodeId, attemptStr] = key.split(":");
    const cycleIndex = Number(cycleStr);
    const attempt = Number(attemptStr);
    const request = makeDispatchRequest(loop, nodeId!, workspace, { cycleIndex, attempt });
    const envelope = await dispatcher.dispatch(request, fixedClock(now));
    results.push({ key, envelope });
  }
  return results;
}

for (const fixtureName of ["reference-happy.json", "reference-two-retries.json"]) {
  test(`fake: ${fixtureName} produces a schema-valid envelope for every scripted node`, async () => {
    const script = loadFakeScript(join(FIXTURES_DIR, fixtureName));
    const results = await dispatchAllSteps(script, "2026-09-06T21:00:00.000Z");
    assert.ok(results.length > 0, "the fixture must script at least one node");
    for (const { key, envelope } of results) {
      const check = validateEnvelope(envelope);
      assert.ok(check.ok, `${fixtureName} ${key}: envelope failed validation: ${!check.ok ? JSON.stringify(check.errors) : ""}`);
    }
  });

  test(`fake: ${fixtureName} every scripted step succeeds (the happy-path/retry contract)`, async () => {
    const script = loadFakeScript(join(FIXTURES_DIR, fixtureName));
    const results = await dispatchAllSteps(script, "2026-09-06T21:00:00.000Z");
    for (const { key, envelope } of results) {
      assert.equal(envelope.eventType, "node-completed", `${fixtureName} ${key}: expected every scripted step to succeed`);
      assert.equal(envelope.result?.status, "succeeded");
    }
  });
}

test("fake: reference-happy.json review-verdict inputs resolve to the then (approve) branch", async () => {
  const script = loadFakeScript(join(FIXTURES_DIR, "reference-happy.json"));
  const step = script.steps["1:review-changes:1"];
  assert.ok(step);
  const structured = step.structured as { approved: boolean };
  assert.equal(structured.approved, true);
});

test("fake: reference-two-retries.json rejects twice with different evidence, then approves", async () => {
  const script = loadFakeScript(join(FIXTURES_DIR, "reference-two-retries.json"));
  const cycle1 = script.steps["1:review-changes:1"]!.structured as { approved: boolean; reasons: string };
  const cycle2 = script.steps["2:review-changes:1"]!.structured as { approved: boolean; reasons: string };
  const cycle3 = script.steps["3:review-changes:1"]!.structured as { approved: boolean; reasons: string };
  assert.equal(cycle1.approved, false);
  assert.equal(cycle2.approved, false);
  assert.equal(cycle3.approved, true);
  assert.notEqual(cycle1.reasons, cycle2.reasons, "the two rejections must carry different evidence");
});

test("fake: usageFixture is replayed through usageFromFixture and the full record travels on the wire (schema 1.1.0)", async () => {
  const loop = await loadReferenceLoop();
  const script: FakeScript = {
    steps: {
      "1:implement:1": { status: "succeeded", structured: { changed: true, summary: "x" }, usageFixture: "claude-recorded-success" },
    },
  };
  const dispatcher = new FakeDispatcher(script);
  const workspace = {
    repoRoot: "/tmp/x",
    worktreePath: "/tmp/x/wt",
    branch: "loopmill/daily-content-improvement/run_1",
    baseCommit: "0".repeat(40),
  };
  const request = makeDispatchRequest(loop, "implement", workspace, { cycleIndex: 1, attempt: 1 });
  const envelope = await dispatcher.dispatch(request, fixedClock());
  assert.equal(envelope.usage?.runtime, "claude-code");
  assert.equal(envelope.usage?.provenance, "reported");
  assert.equal(envelope.usage?.totalTokens, 30476);
  // Envelope schema 1.1.0 carries the stored record in full (envelope.md §4.6, amended 2026-09-07).
  assert.equal(envelope.usage?.usageBasis, "fixture");
  assert.equal(envelope.usage?.model, null);
});

test("fake: default step is used when no exact (cycle,nodeId,attempt) key matches", async () => {
  const loop = await loadReferenceLoop();
  const script: FakeScript = {
    steps: {},
    default: { status: "succeeded", structured: { changed: true, summary: "default step" } },
  };
  const dispatcher = new FakeDispatcher(script);
  const workspace = { repoRoot: "/tmp/x", worktreePath: "/tmp/x/wt", branch: "b", baseCommit: "0".repeat(40) };
  const request = makeDispatchRequest(loop, "implement", workspace, { cycleIndex: 1, attempt: 1 });
  const envelope = await dispatcher.dispatch(request, fixedClock());
  assert.equal(envelope.eventType, "node-completed");
});

test("fake: dispatch rejects with dispatch_failed when no step and no default match", async () => {
  const loop = await loadReferenceLoop();
  const dispatcher = new FakeDispatcher({ steps: {} });
  const workspace = { repoRoot: "/tmp/x", worktreePath: "/tmp/x/wt", branch: "b", baseCommit: "0".repeat(40) };
  const request = makeDispatchRequest(loop, "implement", workspace, { cycleIndex: 1, attempt: 1 });
  await assert.rejects(
    () => dispatcher.dispatch(request, fixedClock()),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === "dispatch_failed",
  );
});

test("fake: determinism -- the same script/request/clock produces the same eventId every time", async () => {
  const loop = await loadReferenceLoop();
  const script = loadFakeScript(join(FIXTURES_DIR, "reference-happy.json"));
  const dispatcher = new FakeDispatcher(script);
  const workspace = { repoRoot: "/tmp/x", worktreePath: "/tmp/x/wt", branch: "b", baseCommit: "0".repeat(40) };
  const request = makeDispatchRequest(loop, "implement", workspace, { cycleIndex: 1, attempt: 1 });

  const envelope1 = await dispatcher.dispatch(request, fixedClock());
  const envelope2 = await dispatcher.dispatch(request, fixedClock());
  assert.equal(envelope1.eventId, envelope2.eventId);
  assert.equal(envelope1.occurredAt, envelope2.occurredAt);

  const laterClockEnvelope = await dispatcher.dispatch(request, fixedClock("2026-09-06T22:00:00.000Z"));
  assert.notEqual(laterClockEnvelope.eventId, envelope1.eventId, "a different clock reading must change the eventId");
});

test("fake: describe() returns a plan without dispatching anything", async () => {
  const loop = await loadReferenceLoop();
  const dispatcher = new FakeDispatcher({ steps: {} });
  const workspace = { repoRoot: "/tmp/x", worktreePath: "/tmp/x/wt", branch: "b", baseCommit: "0".repeat(40) };
  const request = makeDispatchRequest(loop, "implement", workspace, { cycleIndex: 1, attempt: 1 });
  const plan = dispatcher.describe(request);
  assert.deepEqual(plan.argv, ["fake", "implement"]);
  assert.equal(plan.stdin, "/dev/null");
});

test("fake: capabilities() matches BACKEND_CAPABILITIES.fake", async () => {
  const dispatcher = new FakeDispatcher({ steps: {} });
  const caps = dispatcher.capabilities();
  assert.equal(caps.isolation, "ephemeral");
  assert.equal(caps.credentialLocation, "none");
  assert.equal(caps.retryable, true);
});
