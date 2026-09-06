// A16: `loopmill run <loop> --dry-run` validates the graph, resolves every binary and working
// directory to an absolute path, prints the exact child command lines with the post-scrub
// environment, spends zero tokens, creates no run, and never opens the store at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { resolveDryRunContext, printDryRun } from "../../src/driver/index.ts";
import { CLI_GATE_LOOP_PATH, makeScratchRepo } from "../fixtures/driver/helpers.ts";

test("A16: --dry-run prints every agent/command node's plan with scrubbed env, and touches no store", async () => {
  const repo = await makeScratchRepo();
  try {
    const parentEnv = { ...process.env, ANTHROPIC_API_KEY: "sk-ant-should-never-appear", PATH: process.env.PATH ?? "" };
    const dryCtx = await resolveDryRunContext({ repoRoot: repo.repoRoot, env: parentEnv, loopPath: CLI_GATE_LOOP_PATH });

    const stateDbPath = `${repo.repoRoot}/.loopmill/state.sqlite`;
    assert.equal(existsSync(stateDbPath), false, "resolveDryRunContext must never create state.sqlite");

    let output = "";
    const stdout = { write: (s: string) => void (output += s) };
    printDryRun(dryCtx, stdout, true);

    assert.equal(existsSync(stateDbPath), false, "printDryRun must never create state.sqlite either");

    const parsed = JSON.parse(output) as { loop: string; dryRun: true; plans: Array<{ nodeId: string; backend: string; argv?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number | null }> };
    assert.equal(parsed.loop, dryCtx.loop.slug);
    assert.ok(parsed.plans.length > 0);

    for (const plan of parsed.plans) {
      if (!plan.cwd) continue; // an entry with only `error` (no dispatcher for that backend)
      assert.ok(isAbsolute(plan.cwd), `cwd must be absolute: ${plan.cwd}`);
      assert.ok(Array.isArray(plan.argv) && plan.argv.length > 0, `argv must be non-empty for ${plan.nodeId}`);
      assert.ok(plan.env, `env must be present for ${plan.nodeId}`);
      assert.equal(Object.prototype.hasOwnProperty.call(plan.env, "ANTHROPIC_API_KEY"), false, `ANTHROPIC_API_KEY must be scrubbed for ${plan.nodeId}`);
    }
  } finally {
    await repo.cleanup();
  }
});
