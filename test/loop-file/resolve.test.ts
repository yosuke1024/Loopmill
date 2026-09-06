// `resolve.ts`: defaults (§6.2), entry derivation (§4.2), per-kind node defaults (§8), budget
// defaults (§7), the built-in env lists merged with the file's own (§6.3).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLoopFile } from "../../src/loop-file/load.ts";
import { resolveLoop, BUILTIN_ENV_DENY, BUILTIN_ENV_PRESERVE } from "../../src/loop-file/resolve.ts";
import { validateLoopDocument } from "../../src/loop-file/validate.ts";
import type { AgentNode, LoopFile, ResolvedAgentNode, ResolvedCommandNode } from "../../src/types/loop.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const REFERENCE_LOOP = path.join(REPO_ROOT, "examples", "daily-content-improvement.loop.yaml");

async function loadValidFile(file: string): Promise<LoopFile> {
  const { document } = await loadLoopFile(file);
  const result = validateLoopDocument(document, { path: file });
  assert.equal(result.ok, true, `expected ${file} to validate cleanly: ${JSON.stringify(result.findings)}`);
  assert.ok(result.file);
  return result.file;
}

// The §15.2 minimal loop, inline: everything optional is omitted, so every default in §6.2/§7/§8
// must still bind.
const MINIMAL: LoopFile = {
  schemaVersion: "0.6.0",
  slug: "tidy-changelog",
  name: "Tidy the changelog",
  trigger: { kind: "manual" },
  repos: [{ id: "app", path: ".", defaultBase: "main" }],
  defaults: { backend: "local", runtime: "claude-code", authMode: "subscription-oauth" },
  nodes: {
    tidy: {
      kind: "agent",
      prompt: "Rewrite CHANGELOG.md so every entry has a date and a link. Change nothing else.",
      next: "done",
    },
    done: { kind: "end", outcome: "success" },
  },
};

test("resolveLoop: §15.2 minimal loop -- entry derived, every default bound", () => {
  const loop = resolveLoop(MINIMAL);
  assert.equal(loop.entry, "tidy");

  const tidy = loop.nodes.tidy as ResolvedAgentNode;
  assert.equal(tidy.kind, "agent");
  assert.equal(tidy.runtime, "claude-code");
  assert.equal(tidy.backend, "local");
  assert.equal(tidy.auth, "subscription-oauth");
  assert.equal(tidy.permissionProfile, "workspace");
  assert.equal(tidy.sessionPolicy, "fresh");
  assert.equal(tidy.onFailure, "fail_run");
  assert.equal(tidy.effects, "none");
  assert.deepEqual(tidy.inputs, {});
  assert.equal(tidy.timeout, undefined);
  assert.equal(tidy.timeoutMs, undefined);

  // budget: maxAttempts 2, maxRuntime PT4H, maxRunsPerWindow {1, PT5H}, minInterval PT1H
  // (loop-file.md §15.2), maxIterations absent (no Retry Edge in this loop).
  assert.equal(loop.budget.maxAttempts, 2);
  assert.equal(loop.budget.maxIterations, undefined);
  assert.equal(loop.budget.maxRuntime, "PT4H");
  assert.equal(loop.budget.maxRuntimeMs, 4 * 60 * 60 * 1000);
  assert.equal(loop.budget.maxUnmeasuredExecutions, 0);
  assert.deepEqual(loop.budget.maxRunsPerWindow, { count: 1, window: "PT5H", windowMs: 5 * 60 * 60 * 1000 });
  assert.equal(loop.budget.minInterval, "PT1H");
  assert.equal(loop.budget.minIntervalMs, 60 * 60 * 1000);

  assert.equal(loop.approval.policy, "gated");
  assert.deepEqual(loop.edges, {});
});

test("resolveLoop: a node-level value always wins over defaults.* (§6.2)", () => {
  const file: LoopFile = {
    ...MINIMAL,
    defaults: { backend: "local", runtime: "claude-code", authMode: "subscription-oauth", permissionProfile: "workspace" },
    nodes: {
      ...MINIMAL.nodes,
      tidy: { ...MINIMAL.nodes.tidy!, kind: "agent", permissionProfile: "readonly" } as LoopFile["nodes"]["tidy"],
    },
  };
  const loop = resolveLoop(file);
  const tidy = loop.nodes.tidy as ResolvedAgentNode;
  assert.equal(tidy.permissionProfile, "readonly");
});

test("resolveLoop: command node defaults -- cwd to the repo root, env to an empty allowlist", () => {
  const file: LoopFile = {
    ...MINIMAL,
    nodes: {
      tidy: { kind: "command", argv: ["npm", "test"], next: "done" },
      done: { kind: "end", outcome: "success" },
    },
  };
  const loop = resolveLoop(file);
  const cmd = loop.nodes.tidy as ResolvedCommandNode;
  assert.equal(cmd.cwd, ".");
  assert.deepEqual(cmd.env, []);
  assert.equal(cmd.backend, "local");
  assert.equal(cmd.onFailure, "fail_run");
  assert.equal(cmd.effects, "none");
});

test("resolveLoop: inputs normalise to the long form (short-form string and explicit {from,default})", () => {
  const file: LoopFile = {
    ...MINIMAL,
    nodes: {
      tidy: {
        kind: "agent",
        inputs: {
          short: "cycle.index",
          long: { from: "run.id", default: "fallback" },
        },
        prompt: "x ${short} ${long}",
        next: "done",
      },
      done: { kind: "end", outcome: "success" },
    },
  };
  const loop = resolveLoop(file);
  const tidy = loop.nodes.tidy as ResolvedAgentNode;
  assert.deepEqual(tidy.inputs, {
    short: { from: "cycle.index" },
    long: { from: "run.id", default: "fallback" },
  });
});

test("resolveLoop: timeout is carried as both the ISO-8601 string and its millisecond value; absent stays absent", () => {
  const tidyNode = MINIMAL.nodes.tidy as AgentNode;
  const withTimeout: LoopFile = {
    ...MINIMAL,
    nodes: { tidy: { ...tidyNode, timeout: "PT30M" }, done: MINIMAL.nodes.done! },
  };
  const loop = resolveLoop(withTimeout);
  const tidy = loop.nodes.tidy as ResolvedAgentNode;
  assert.equal(tidy.timeout, "PT30M");
  assert.equal(tidy.timeoutMs, 30 * 60 * 1000);

  const withoutTimeout = resolveLoop(MINIMAL).nodes.tidy as ResolvedAgentNode;
  assert.equal(withoutTimeout.timeout, undefined);
  assert.equal(withoutTimeout.timeoutMs, undefined);
});

test("resolveLoop: budget fields the file sets override the defaults; unset fields still default", () => {
  const file: LoopFile = { ...MINIMAL, budget: { maxAttempts: 5, maxIterations: 10 } };
  const loop = resolveLoop(file);
  assert.equal(loop.budget.maxAttempts, 5);
  assert.equal(loop.budget.maxIterations, 10);
  assert.equal(loop.budget.maxRuntime, "PT4H"); // still default
});

test("resolveLoop: env policy merges the built-in deny/preserve lists with the file's own additions", () => {
  const file: LoopFile = { ...MINIMAL, env: { deny: ["NPM_TOKEN"], preserve: ["CI"], inject: { X: "y" } } };
  const loop = resolveLoop(file);
  for (const name of BUILTIN_ENV_DENY) assert.ok(loop.env.deny.includes(name), `expected built-in deny ${name}`);
  for (const name of BUILTIN_ENV_PRESERVE) assert.ok(loop.env.preserve.includes(name), `expected built-in preserve ${name}`);
  assert.ok(loop.env.deny.includes("NPM_TOKEN"));
  assert.ok(loop.env.preserve.includes("CI"));
  assert.deepEqual(loop.env.inject, { X: "y" });
  // No duplicates: a name in both the built-in and the file's own list appears once.
  const fileWithBuiltinAgain: LoopFile = { ...MINIMAL, env: { deny: ["ANTHROPIC_API_KEY"] } };
  const loop2 = resolveLoop(fileWithBuiltinAgain);
  assert.equal(loop2.env.deny.filter((n) => n === "ANTHROPIC_API_KEY").length, 1);
});

test("resolveLoop: entry is explicit when the file declares one, even if another node would also qualify as a root", () => {
  const file: LoopFile = {
    ...MINIMAL,
    entry: "tidy",
    nodes: {
      ...MINIMAL.nodes,
      other: { kind: "agent", prompt: "unrelated", next: "done" },
    },
  };
  const loop = resolveLoop(file);
  assert.equal(loop.entry, "tidy");
});

test("resolveLoop: edges array is indexed by id, fields unchanged", () => {
  const file: LoopFile = {
    ...MINIMAL,
    nodes: {
      tidy: { kind: "agent", prompt: "x", structuredOutput: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, next: "verdict" },
      verdict: { kind: "condition", inputs: { ok: "nodes.tidy.structured.ok" }, expr: "ok == true", then: "done", else: "retry-a" },
      done: { kind: "end", outcome: "success" },
    },
    edges: [{ id: "retry-a", from: "verdict", to: "tidy", when: "ok == false", maxIterations: 2 }],
  };
  const loop = resolveLoop(file);
  assert.deepEqual(loop.edges["retry-a"], { id: "retry-a", from: "verdict", to: "tidy", when: "ok == false", maxIterations: 2 });
});

test("resolveLoop: the reference loop resolves with the documented Runtime x Backend x Auth per node", async () => {
  const file = await loadValidFile(REFERENCE_LOOP);
  const loop = resolveLoop(file);

  const reviewContent = loop.nodes["review-content"] as ResolvedAgentNode;
  assert.equal(reviewContent.runtime, "codex");
  assert.equal(reviewContent.auth, "subscription-login");
  assert.equal(reviewContent.backend, "local"); // inherited from defaults

  const implement = loop.nodes.implement as ResolvedAgentNode;
  assert.equal(implement.runtime, "claude-code"); // inherited from defaults
  assert.equal(implement.auth, "subscription-oauth"); // inherited from defaults
  assert.equal(implement.model, "sonnet");

  assert.equal(loop.budget.maxIterations, 3);
  assert.equal(loop.edges["retry-implementation"]!.to, "implement");
  assert.equal(loop.approval.policy, "auto");
  assert.deepEqual(loop.approval.nodes, ["create-issue"]);
});
