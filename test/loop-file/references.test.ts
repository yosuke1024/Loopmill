// `references.ts`: the §9.1 reference grammar, resolution (§9.2), and `resolveInputs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReference,
  resolveReference,
  resolveInputs,
  type ReferenceContext,
  type NodeOutput,
} from "../../src/loop-file/references.ts";
import { isLoopmillError, LoopmillError } from "../../src/util/errors.ts";
import type { ResolvedInputs } from "../../src/types/loop.ts";

function ctx(overrides: Partial<ReferenceContext> = {}, outputs: Record<string, NodeOutput> = {}): ReferenceContext {
  return {
    run: { id: "r1", loop: "daily-content-improvement", version: "sha256:" + "a".repeat(64), trigger: "schedule" },
    cycleIndex: 0,
    trigger: { action: "opened", issue: { number: 42 } },
    nodeOutput: (id) => outputs[id],
    ...overrides,
  };
}

// --- parseReference: every accessor form -------------------------------------------------------

test("parseReference: nodes.<id>.structured.<path>", () => {
  const ref = parseReference("nodes.review-content.structured.summary");
  assert.deepEqual(ref, { kind: "node", nodeId: "review-content", accessor: "structured", path: ["summary"] });
});

test("parseReference: nodes.<id>.structured.<deep.path>", () => {
  const ref = parseReference("nodes.step.structured.a.b.c");
  assert.deepEqual(ref, { kind: "node", nodeId: "step", accessor: "structured", path: ["a", "b", "c"] });
});

test("parseReference: nodes.<id>.stdout / exitCode / filesChanged", () => {
  assert.deepEqual(parseReference("nodes.create-issue.stdout"), { kind: "node", nodeId: "create-issue", accessor: "stdout", path: [] });
  assert.deepEqual(parseReference("nodes.run-tests.exitCode"), { kind: "node", nodeId: "run-tests", accessor: "exitCode", path: [] });
  assert.deepEqual(parseReference("nodes.implement.filesChanged"), { kind: "node", nodeId: "implement", accessor: "filesChanged", path: [] });
});

test("parseReference: run.id / run.loop / run.version / run.trigger", () => {
  assert.deepEqual(parseReference("run.id"), { kind: "run", name: "id" });
  assert.deepEqual(parseReference("run.loop"), { kind: "run", name: "loop" });
  assert.deepEqual(parseReference("run.version"), { kind: "run", name: "version" });
  assert.deepEqual(parseReference("run.trigger"), { kind: "run", name: "trigger" });
});

test("parseReference: cycle.index", () => {
  assert.deepEqual(parseReference("cycle.index"), { kind: "cycle" });
});

test("parseReference: trigger.<path>", () => {
  assert.deepEqual(parseReference("trigger.action"), { kind: "trigger", path: ["action"] });
  assert.deepEqual(parseReference("trigger.issue.number"), { kind: "trigger", path: ["issue", "number"] });
});

test("parseReference: captured.<name> is rejected (reserved, §8.6)", () => {
  assert.throws(() => parseReference("captured.diff"), (err: unknown) => {
    assert.ok(isLoopmillError(err));
    assert.equal((err as LoopmillError).code, "reference_invalid");
    return true;
  });
});

test("parseReference: rejects malformed input", () => {
  for (const bad of ["", "nodes.", "nodes.step", "nodes.step.", "run.unknown", "cycle.other", "trigger.", "garbage", "nodes.Bad-Id.stdout"]) {
    assert.throws(() => parseReference(bad), `expected "${bad}" to be rejected`);
  }
});

// --- resolveReference ---------------------------------------------------------------------------

test("resolveReference: nodes.<id>.stdout resolves from the most recent execution the context supplies", () => {
  const c = ctx({}, { "create-issue": { stdout: "https://github.com/x/y/issues/1" } });
  const result = resolveReference(parseReference("nodes.create-issue.stdout"), c);
  assert.deepEqual(result, { resolved: true, value: "https://github.com/x/y/issues/1" });
});

test("resolveReference: nodes.<id>.exitCode / filesChanged", () => {
  const c = ctx({}, { "run-tests": { exitCode: 1, filesChanged: 3 } });
  assert.deepEqual(resolveReference(parseReference("nodes.run-tests.exitCode"), c), { resolved: true, value: 1 });
  assert.deepEqual(resolveReference(parseReference("nodes.run-tests.filesChanged"), c), { resolved: true, value: 3 });
});

test("resolveReference: nodes.<id>.structured.<path> indexes into the structured output", () => {
  const c = ctx({}, { "review-content": { structured: { needs_issue: true, title: "t", nested: { deep: 7 } } } });
  assert.deepEqual(resolveReference(parseReference("nodes.review-content.structured.needs_issue"), c), { resolved: true, value: true });
  assert.deepEqual(resolveReference(parseReference("nodes.review-content.structured.nested.deep"), c), { resolved: true, value: 7 });
});

test("resolveReference: an accessor the node never produced does not resolve", () => {
  const c = ctx({}, { step: {} });
  assert.deepEqual(resolveReference(parseReference("nodes.step.stdout"), c), { resolved: false, reason: 'node "step" has no stdout' });
});

test("resolveReference: no execution of the node at all does not resolve", () => {
  const c = ctx();
  const result = resolveReference(parseReference("nodes.never-ran.stdout"), c);
  assert.equal(result.resolved, false);
});

test("resolveReference: run.id / run.loop / run.version / run.trigger", () => {
  const c = ctx();
  assert.deepEqual(resolveReference(parseReference("run.id"), c), { resolved: true, value: "r1" });
  assert.deepEqual(resolveReference(parseReference("run.loop"), c), { resolved: true, value: "daily-content-improvement" });
  assert.deepEqual(resolveReference(parseReference("run.trigger"), c), { resolved: true, value: "schedule" });
});

test("resolveReference: cycle.index", () => {
  const c = ctx({ cycleIndex: 3 });
  assert.deepEqual(resolveReference(parseReference("cycle.index"), c), { resolved: true, value: 3 });
});

test("resolveReference: trigger.<path> resolves through the trigger payload", () => {
  const c = ctx({ trigger: { action: "opened", issue: { number: 42 } } });
  assert.deepEqual(resolveReference(parseReference("trigger.action"), c), { resolved: true, value: "opened" });
  assert.deepEqual(resolveReference(parseReference("trigger.issue.number"), c), { resolved: true, value: 42 });
});

test("resolveReference: an unresolvable trigger.<path> reports why, never throws", () => {
  const c = ctx({ trigger: { action: "opened" } });
  const result = resolveReference(parseReference("trigger.missing.field"), c);
  assert.equal(result.resolved, false);
});

// --- resolveInputs -------------------------------------------------------------------------------

test("resolveInputs: resolves every declared input", () => {
  const inputs: ResolvedInputs = {
    issue_url: { from: "nodes.create-issue.stdout" },
    attempt: { from: "cycle.index", default: 1 },
  };
  const c = ctx({ cycleIndex: 2 }, { "create-issue": { stdout: "https://x/1" } });
  assert.deepEqual(resolveInputs(inputs, c), { issue_url: "https://x/1", attempt: 2 });
});

test("resolveInputs: applies `default` when the reference does not resolve", () => {
  const inputs: ResolvedInputs = { attempt: { from: "nodes.never-ran.exitCode", default: 1 } };
  assert.deepEqual(resolveInputs(inputs, ctx()), { attempt: 1 });
});

test("resolveInputs: a reference with no default that does not resolve throws unresolved_reference", () => {
  const inputs: ResolvedInputs = { x: { from: "nodes.never-ran.exitCode" } };
  assert.throws(() => resolveInputs(inputs, ctx()), (err: unknown) => {
    assert.ok(isLoopmillError(err));
    assert.equal((err as LoopmillError).code, "unresolved_reference");
    return true;
  });
});

test("resolveInputs: trigger.* resolves through the payload end to end", () => {
  const inputs: ResolvedInputs = { issue_number: { from: "trigger.issue.number" } };
  assert.deepEqual(resolveInputs(inputs, ctx()), { issue_number: 42 });
});
