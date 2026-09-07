// `loadLoop` (loop.ts): the full read -> validate -> resolve composition, and `loopVersion`
// stability (docs/spec/loop-file.md §3, §3.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLoop } from "../../src/loop-file/loop.ts";
import { loadLoopFile } from "../../src/loop-file/load.ts";
import { loopVersionOf } from "../../src/loop-file/canonical.ts";
import { LoopmillError, isLoopmillError } from "../../src/util/errors.ts";
import type { LoopFile } from "../../src/types/loop.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const REFERENCE_LOOP = path.join(REPO_ROOT, "examples", "daily-content-improvement.loop.yaml");
const INVALID_RETRY_EDGE = path.join(REPO_ROOT, "docs", "spec", "examples", "invalid-retry-edge.loop.yaml");

test("loadLoop: the reference loop loads, validates with zero findings, and resolves", async () => {
  const { loop, file, findings } = await loadLoop(REFERENCE_LOOP);
  assert.deepEqual(findings, []);
  assert.equal(file.slug, "daily-content-improvement");
  assert.equal(loop.slug, "daily-content-improvement");
  assert.equal(loop.entry, "review-content");
  assert.equal(Object.keys(loop.nodes).length, 11);
  assert.ok(loop.edges["retry-implementation"]);
  assert.match(loop.loopVersion, /^sha256:[0-9a-f]{64}$/);
});

test("loadLoop: throws loop_invalid (exitCode 2) for a Loop file with semantic findings, unless allowInvalid", async () => {
  await assert.rejects(
    () => loadLoop(INVALID_RETRY_EDGE),
    (err: unknown) => {
      assert.ok(isLoopmillError(err));
      assert.equal((err as LoopmillError).code, "loop_invalid");
      assert.equal((err as LoopmillError).exitCode, 2);
      assert.ok(Array.isArray((err as LoopmillError).details));
      return true;
    },
  );

  const { loop, findings } = await loadLoop(INVALID_RETRY_EDGE, { allowInvalid: true });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, "LM-VAL-007");
  // Resolution still succeeds: the file is schema-valid, `entry` is unambiguous, so a
  // `ResolvedLoop` can still be produced even though a Run would never dispatch against it.
  assert.equal(loop.entry, "implement");
});

test("loopVersion: stable across two independent loads of the same file", async () => {
  const a = await loadLoop(REFERENCE_LOOP);
  const b = await loadLoop(REFERENCE_LOOP);
  assert.equal(a.loop.loopVersion, b.loop.loopVersion);
});

test("loopVersion: unchanged by comments, whitespace, quoting style or mapping key order; changed by a semantic edit", async (t) => {
  const original = await readFile(REFERENCE_LOOP, "utf8");
  const dir = await mkdtemp(path.join(tmpdir(), "loopmill-canonical-"));

  // Variant 1: re-ordered top-level keys, re-indented flow mappings, extra comments and blank
  // lines, single quotes swapped for double. None of this is a semantic change.
  const variantA = [
    "# a completely different comment at the top of the file",
    "",
    'schemaVersion: "0.6.0"',
    "",
    "name: Daily Content Improvement",
    "slug: daily-content-improvement",
    "",
    "trigger: { tz: Asia/Tokyo, cron: '0 6 * * *', kind: schedule }",
    "",
    "description: >-",
    "  Review yesterday's published articles with Codex, open an Issue when something",
    "  is wrong, let Claude Code implement the fix, verify with the test suite and a",
    "  second Codex review, and open a pull request once a human approves. Never merges.",
    "",
    "repos: [{ defaultBase: main, path: '.', id: site }]",
    "",
    "budget:",
    "  minInterval: PT1H",
    "  maxRunsPerWindow: { window: PT5H, count: 1 }",
    "  maxMeasuredTokens: 2000000",
    "  maxRuntime: PT4H",
    "  maxIterations: 3",
    "  maxAttempts: 2",
    "",
    "defaults:",
    "  isolation: worktree",
    "  permissionProfile: workspace",
    "  authMode: subscription-oauth",
    "  runtime: claude-code",
    "  backend: local",
    "",
    "env:",
    "  inject: { LOOPMILL_LOOP: daily-content-improvement }",
    "  preserve: [CI]",
    "  deny: [NPM_TOKEN]",
    "",
    "approval:",
    "  nodes: [create-issue]",
    "  reason: >-",
    "    Issue creation is reversible and is the intended unattended output of this",
    "    loop; pull request creation stays gated.",
    "  policy: auto",
    "",
    "entry: review-content",
    "",
  ].join("\n");

  // Splice variantA's header in, then keep the original `nodes:`/`edges:` block verbatim so both
  // files describe the identical document -- this exercises re-ordering/re-quoting/commenting
  // without hand-retyping the whole node graph.
  const nodesStart = original.indexOf("\nnodes:\n");
  assert.notEqual(nodesStart, -1);
  const nodesAndEdges = original.slice(nodesStart + 1);
  const fileA = path.join(dir, "daily-content-improvement.loop.yaml");
  await writeFile(fileA, `${variantA}\n${nodesAndEdges}`, "utf8");

  await t.test("comment/whitespace/key-order variant hashes the same as the original", async () => {
    const { document: docOriginal } = await loadLoopFile(REFERENCE_LOOP);
    const { document: docVariant } = await loadLoopFile(fileA);
    assert.notDeepEqual(docOriginal, {}); // sanity: not accidentally empty
    assert.equal(loopVersionOf(docVariant as LoopFile), loopVersionOf(docOriginal as LoopFile));
  });

  await t.test("a prompt change changes loopVersion", async () => {
    const changed = original.replace("Fix the problem described in", "Please fix the problem described in");
    assert.notEqual(changed, original);
    const fileB = path.join(dir, "changed.loop.yaml");
    await writeFile(fileB, changed, "utf8");
    const { document: docOriginal } = await loadLoopFile(REFERENCE_LOOP);
    const { document: docChanged } = await loadLoopFile(fileB);
    assert.notEqual(loopVersionOf(docChanged as LoopFile), loopVersionOf(docOriginal as LoopFile));
  });

  await t.test("re-ordering a sequence (an array field) DOES change loopVersion", async () => {
    const { document: docOriginal } = await loadLoopFile(REFERENCE_LOOP);
    const doc = docOriginal as LoopFile;
    assert.deepEqual(doc.approval?.nodes, ["create-issue"]);
    const reordered: LoopFile = { ...doc, approval: { ...doc.approval, nodes: ["create-issue", "create-pr"] } };
    // Unlike an object's keys, an array's order (and membership) is meaningful (loop-file.md
    // §3.1: "Re-ordering a YAML sequence does change it").
    assert.notEqual(loopVersionOf(reordered), loopVersionOf(doc));
  });
});

test("load.ts: a duplicate YAML mapping key is loop_yaml_invalid (exitCode 2) with line/column in the message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loopmill-dup-key-"));
  const file = path.join(dir, "dup.loop.yaml");
  await writeFile(
    file,
    [
      'schemaVersion: "0.6.0"',
      "slug: dup",
      "slug: dup-again",
      "name: Duplicate key",
      "trigger: { kind: manual }",
      "repos: [{ id: a, path: '.', defaultBase: main }]",
      "nodes: { step: { kind: end, outcome: success } }",
      "",
    ].join("\n"),
    "utf8",
  );
  await assert.rejects(
    () => loadLoopFile(file),
    (err: unknown) => {
      assert.ok(isLoopmillError(err));
      assert.equal((err as LoopmillError).code, "loop_yaml_invalid");
      assert.equal((err as LoopmillError).exitCode, 2);
      assert.match((err as LoopmillError).message, /line \d+, column \d+/);
      return true;
    },
  );
});
