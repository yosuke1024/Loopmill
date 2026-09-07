// Tests for `src/backends/local/env.ts` (A15 -- docs/design/mvp-design.md §13.2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv } from "../../src/backends/local/env.ts";
import { BUILTIN_ENV_PRESERVE } from "../../src/loop-file/resolve.ts";
import { loadReferenceLoop, nodeOf } from "../fixtures/backends/helpers.ts";

test("env: A15 -- ANTHROPIC_API_KEY/OPENAI_API_KEY/GH_TOKEN in the parent env never reach an agent node, and are reported denied", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "implement"); // agent node, effects: none
  const parentEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/op",
    ANTHROPIC_API_KEY: "sk-ant-should-never-appear",
    OPENAI_API_KEY: "sk-should-never-appear-either",
    GH_TOKEN: "ghp_should-never-appear",
  };
  const { env, denied } = buildChildEnv(parentEnv, loop.env, node);

  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(env["OPENAI_API_KEY"], undefined);
  assert.equal(env["GH_TOKEN"], undefined);
  assert.ok(denied.includes("ANTHROPIC_API_KEY"));
  assert.ok(denied.includes("OPENAI_API_KEY"));
  assert.ok(denied.includes("GH_TOKEN"));
  // PATH/HOME are preserved.
  assert.equal(env["PATH"], "/usr/bin:/bin");
  assert.equal(env["HOME"], "/home/op");
});

test("env: A15 -- GITHUB_TOKEN is denied to an agent node too, even though it is not in the built-in deny list by name", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "implement");
  const parentEnv = { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_should-never-appear" };
  const { env, denied } = buildChildEnv(parentEnv, loop.env, node);
  assert.equal(env["GITHUB_TOKEN"], undefined);
  assert.ok(denied.includes("GITHUB_TOKEN"));
});

test("env: A15 -- a command node with effects: external gets GH_TOKEN", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "create-issue"); // command, effects: external
  const parentEnv = { PATH: "/usr/bin", GH_TOKEN: "ghp_real_token_value" };
  const { env, denied } = buildChildEnv(parentEnv, loop.env, node);
  assert.equal(env["GH_TOKEN"], "ghp_real_token_value");
  assert.ok(!denied.includes("GH_TOKEN"));
});

test("env: A15 -- a command node WITHOUT effects: external does not get GH_TOKEN", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "run-tests"); // command, effects: none (default)
  const parentEnv = { PATH: "/usr/bin", GH_TOKEN: "ghp_should-not-leak-here" };
  const { env, denied } = buildChildEnv(parentEnv, loop.env, node);
  assert.equal(env["GH_TOKEN"], undefined);
  assert.ok(denied.includes("GH_TOKEN"));
});

test("env: PATH/HOME are preserved for every node kind", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "run-tests");
  const parentEnv = { PATH: "/usr/bin:/bin", HOME: "/home/op", SHELL: "/bin/bash" };
  const { env } = buildChildEnv(parentEnv, loop.env, node);
  assert.equal(env["PATH"], "/usr/bin:/bin");
  assert.equal(env["HOME"], "/home/op");
  assert.equal(env["SHELL"], "/bin/bash");
});

// Amendment (m0+), 2026-09-07 (loop-file.md §6.3): `USER` reaches the child, for both node kinds.
// This is not housekeeping — it is the one variable `claude` uses to find its own subscription
// login. Measured on the maintainer's macOS host during the first live run of
// `.loopmill/readme-freshness.loop.yaml`: with PATH/HOME/SHELL alone, `claude auth status --json`
// answers `loggedIn: false, authMethod: "none"` and `claude -p` returns
// `Not logged in · Please run /login` after 165 ms without contacting the API; adding `USER`
// alone restores `loggedIn: true, authMethod: "claude.ai"`. `LOGNAME` was measured NOT to
// substitute for it, and `codex` needs neither — which is why the live run's Codex node
// succeeded and its Claude Code node failed on the very next step. Delete `USER` from
// BUILTIN_ENV_PRESERVE and every `claude-code` node on a `local` backend stops authenticating.
test("env: USER is preserved -- claude-code cannot find its subscription login without it", async () => {
  const loop = await loadReferenceLoop();
  const parentEnv = { PATH: "/usr/bin:/bin", HOME: "/home/op", USER: "op", LOGNAME: "op" };
  for (const nodeId of ["implement", "run-tests"]) {
    const { env } = buildChildEnv(parentEnv, loop.env, nodeOf(loop, nodeId));
    assert.equal(env["USER"], "op", `${nodeId}: USER must reach the child`);
  }
  assert.ok(BUILTIN_ENV_PRESERVE.includes("USER"), "USER must be in the built-in preserve list, not just the reference loop's own");
});

test("env: inject applies -- the loop's env.inject value reaches the child and is reported as injected", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "implement");
  // The reference loop's own env.inject: { LOOPMILL_LOOP: "daily-content-improvement" }.
  const { env, injected } = buildChildEnv({ PATH: "/usr/bin" }, loop.env, node);
  assert.equal(env["LOOPMILL_LOOP"], "daily-content-improvement");
  assert.ok(injected.includes("LOOPMILL_LOOP"));
});

test("env: inject wins over the parent env's own value of the same name", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "implement");
  const { env } = buildChildEnv({ PATH: "/usr/bin", LOOPMILL_LOOP: "operator-set-this" }, loop.env, node);
  assert.equal(env["LOOPMILL_LOOP"], "daily-content-improvement");
});

test("env: a loop-level deny addition (env.deny: [NPM_TOKEN] in the reference loop) is scrubbed", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "run-tests");
  const parentEnv = { PATH: "/usr/bin", NPM_TOKEN: "should-not-appear" };
  const { env, denied } = buildChildEnv(parentEnv, loop.env, node);
  assert.equal(env["NPM_TOKEN"], undefined);
  assert.ok(denied.includes("NPM_TOKEN"));
});

test("env: a command node's own non-empty env allowlist intersects with preserve+inject", () => {
  const node = {
    kind: "command" as const,
    id: "custom",
    backend: "local" as const,
    argv: ["true"],
    cwd: ".",
    env: ["CI"],
    inputs: {},
    onFailure: "fail_run" as const,
    effects: "none" as const,
  };
  const policy = { deny: [], preserve: ["PATH", "HOME", "CI"], inject: { LOOPMILL_LOOP: "x" } };
  const parentEnv = { PATH: "/usr/bin", HOME: "/home/op", CI: "true" };
  const { env } = buildChildEnv(parentEnv, policy, node);
  assert.equal(env["CI"], "true");
  assert.equal(env["PATH"], undefined, "PATH is preserved by policy but not in this command's own allowlist");
  assert.equal(env["HOME"], undefined);
  assert.equal(env["LOOPMILL_LOOP"], undefined, "inject is not in this command's own allowlist either");
});

test("env: a command node with no env field (resolved to null) applies no additional restriction", async () => {
  const loop = await loadReferenceLoop();
  const node = nodeOf(loop, "run-tests"); // no `env:` declared -> resolves to null (no further restriction)
  assert.equal((node as { env: string[] | null }).env, null);
  const { env } = buildChildEnv({ PATH: "/usr/bin", HOME: "/home/op" }, loop.env, node);
  assert.equal(env["PATH"], "/usr/bin");
  assert.equal(env["HOME"], "/home/op");
});

test("env: deny wins over inject -- a loop cannot use inject to reinstate a denied vendor-auth variable", () => {
  const node = {
    kind: "agent" as const,
    id: "a",
    runtime: "claude-code" as const,
    backend: "local" as const,
    auth: "subscription-oauth" as const,
    permissionProfile: "workspace" as const,
    sessionPolicy: "fresh" as const,
    inputs: {},
    onFailure: "fail_run" as const,
    effects: "none" as const,
  };
  const policy = {
    deny: ["ANTHROPIC_API_KEY"],
    preserve: ["PATH"],
    inject: { ANTHROPIC_API_KEY: "sk-ant-injected-should-not-appear" },
  };
  const { env, denied } = buildChildEnv({ PATH: "/usr/bin" }, policy, node);
  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  assert.ok(denied.includes("ANTHROPIC_API_KEY"));
});
