// A13: `maxStepsPerRun` terminates a runaway chain as `BUDGET_EXCEEDED(maxStepsPerRun)`, exit 12
// (state-machine.md D-28; `policy.maxStepsPerRun` is an *engine* default, not a loop-file field,
// so this overrides `runLoop`'s own `policy` rather than the loop file).

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY_FULL } from "../../src/engine/index.ts";
import { runLoop } from "../../src/driver/index.ts";
import { FakeDispatcher, type FakeScript } from "../../src/backends/fake/index.ts";
import type { TriggerPayload } from "../../src/types/envelope.ts";
import { EXIT_CODES_LOOP_PATH, fixedClock, makeScratchRepo, openTestContext } from "../fixtures/driver/helpers.ts";

test("A13: a tiny maxStepsPerRun stops a runaway chain as BUDGET_EXCEEDED(maxStepsPerRun), exit 12", async () => {
  const repo = await makeScratchRepo();
  try {
    const clock = fixedClock();
    const ctx = await openTestContext(repo, EXIT_CODES_LOOP_PATH, clock);
    try {
      // Every cycle makes real progress (a fresh digest), so the retry edge would happily run to
      // MAX_ITERATIONS_EXCEEDED (maxIterations: 2 on this fixture) if nothing else stopped it
      // first — `maxStepsPerRun: 2` must win before that.
      const script: FakeScript = {
        steps: {
          "0:step:1": { status: "succeeded", structured: { ok: false }, filesChanged: [{ path: "a.txt", digest: `sha256:${"a".repeat(64)}` }] },
          "1:step:1": { status: "succeeded", structured: { ok: false }, filesChanged: [{ path: "a.txt", digest: `sha256:${"b".repeat(64)}` }] },
          "2:step:1": { status: "succeeded", structured: { ok: false }, filesChanged: [{ path: "a.txt", digest: `sha256:${"c".repeat(64)}` }] },
        },
      };
      const dispatchers = { fake: new FakeDispatcher(script) };
      const trigger: TriggerPayload = { kind: "manual" };
      const policy = { ...DEFAULT_POLICY_FULL, maxStepsPerRun: 2 };

      const result = await runLoop({ ctx, trigger, dispatchers, policy });
      assert.equal(result.exitCode, 12);
      assert.equal(result.state, "BUDGET_EXCEEDED");
      if (result.outcome?.state === "BUDGET_EXCEEDED") {
        assert.equal(result.outcome.budgetKey, "maxStepsPerRun");
        assert.equal(result.outcome.limit, 2);
      } else {
        assert.fail(`expected BUDGET_EXCEEDED(maxStepsPerRun), got ${JSON.stringify(result.outcome)}`);
      }
    } finally {
      ctx.close();
    }
  } finally {
    await repo.cleanup();
  }
});
