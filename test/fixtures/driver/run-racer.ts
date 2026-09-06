// A10 fixture: one process that opens a `RunContext` against the given repo/loop, busy-waits
// until a synchronised start time, then calls `runLoop` once against the `fake` backend and
// prints its exit code. `test/driver/concurrency.test.ts` spawns two of these (via `node`, type
// stripped directly) against the same repository so their `runLoop` calls land as close to
// simultaneously as two OS processes can manage, then asserts exactly one reaches `SUCCEEDED`
// (exit 0) and the other is refused `SKIPPED(overlapping_run)` (exit 15) and writes nothing else.
//
// argv: [repoRoot, loopPath, fakeScriptPath, startAtEpochMs]

import { openRunContext, defaultDispatchers, runLoop } from "../../../src/driver/index.ts";
import { loadFakeScript } from "../../../src/backends/fake/index.ts";

const [repoRoot, loopPath, fakeScriptPath, startAtEpochMsStr] = process.argv.slice(2);

if (!repoRoot || !loopPath || !fakeScriptPath || !startAtEpochMsStr) {
  console.error("usage: run-racer.ts <repoRoot> <loopPath> <fakeScriptPath> <startAtEpochMs>");
  process.exit(2);
}

const startAtEpochMs = Number(startAtEpochMsStr);

while (Date.now() < startAtEpochMs) {
  // spin — a real race, not a schedule.
}

const clock = { now: () => new Date().toISOString() };
const ctx = await openRunContext({ repoRoot, env: {}, clock, loopPath });
try {
  const dispatchers = defaultDispatchers({ layout: ctx.layout, fakeScript: loadFakeScript(fakeScriptPath) });
  const result = await runLoop({ ctx, trigger: { kind: "manual" }, dispatchers });
  console.log(`exitCode:${result.exitCode} runId:${result.runId ?? "null"}`);
} finally {
  ctx.close();
}
