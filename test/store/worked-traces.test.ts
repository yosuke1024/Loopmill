// A4 (mvp-design.md §20.3): "The stored snapshot equals the fold of the journal for every run in
// the fixture corpus (`loopmill rebuild-snapshot` is byte-identical)." Before this file, that
// identity was checked for a handful of driven scenarios but with no enumerated corpus: four of
// the six canonical worked traces named in state-machine.md §13 were checked only through the
// engine's in-memory `drive()`/fold identity (test/engine/worked-traces/), never through the real
// `SqliteStore` and `rebuildSnapshot` — the m1 audit (docs/design/m1-plan.md §5.1) recorded A4 as
// partial for exactly this gap.
//
// This test closes it: every one of the six §13 worked traces (test/fixtures/store/worked-traces.ts,
// `WORKED_TRACES`) is driven through a real store, and `store.rebuildSnapshot` — folding the
// *stored* rows back through `engine/fold.ts`'s own `fold()`, the same audit `loopmill
// rebuild-snapshot` runs — is compared against what actually landed on disk, as canonical JSON,
// byte for byte. It is one test that iterates the corpus (one `test()` call, one `t.test()`
// subtest per entry for a legible failure) so a seventh worked trace is one entry added to
// `WORKED_TRACES`, not a new test written here.
//
// test/engine/rebuild.test.ts already carries 13.1 through a real store this same way (it
// predates this corpus and is out of this task's scope — this file does not own test/engine/);
// re-running 13.1 here costs one more freshDb() and is worth it so the corpus is self-contained
// and every entry is checked the same way, in the same place.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fold } from "../../src/engine/fold.ts";
import { DEFAULT_POLICY } from "../../src/engine/policy.ts";
import { openStore } from "../../src/store/sqlite.ts";
import type { StoredEvent } from "../../src/store/sqlite.ts";
import { RUN_ID, LOOP_ID, LOOP_VERSION } from "../fixtures/engine/helpers.ts";
import { REFERENCE_LOOP } from "../fixtures/engine/reference-loop.ts";
import { freshDb } from "../fixtures/store/helpers.ts";
import { WORKED_TRACES } from "../fixtures/store/worked-traces.ts";

test("A4: rebuildSnapshot reproduces the stored snapshot, byte for byte, for every §13 worked trace in the corpus", async (t) => {
  // Guards the corpus itself: an entry silently dropped from WORKED_TRACES would make the loop
  // below pass for the wrong reason (fewer runs checked, not a broken identity) rather than
  // failing loudly the way a missing worked trace should.
  assert.deepEqual(
    WORKED_TRACES.map((trace) => trace.id),
    ["13.1", "13.2", "13.3", "13.4", "13.5", "13.6"],
    "the corpus must carry all six canonical §13 worked traces",
  );

  for (const trace of WORKED_TRACES) {
    await t.test(`${trace.id} ${trace.title}`, async () => {
      const { dbPath, cleanup } = await freshDb();
      try {
        const store = openStore(dbPath);
        const createdAt = "2026-09-06T06:00:00.000Z";
        store.createRun({
          runId: RUN_ID,
          loopId: LOOP_ID,
          loopVersion: LOOP_VERSION,
          loopDigest: LOOP_VERSION,
          trigger: { kind: "schedule", source: "cron", requestedAt: createdAt },
          createdAt,
        });

        // Drives every scripted event in this trace through transition() and journals each
        // applied/ignored-stale result into `store` (test/fixtures/store/worked-traces.ts's own
        // `makeDriver`) — the equivalent of running `loopmill step` once per hop.
        trace.run(store, RUN_ID);

        // The audit itself: fold the *stored* rows (not a re-derivation of the trace's own
        // envelope list) back through the real engine, and compare to what `append` wrote.
        let diagnostics: ReturnType<typeof fold>["diagnostics"] = [];
        const result = store.rebuildSnapshot(RUN_ID, (rows: StoredEvent[]) => {
          const folded = fold(rows, { loop: REFERENCE_LOOP, policy: DEFAULT_POLICY });
          diagnostics = folded.diagnostics;
          return folded.snapshot;
        });

        assert.equal(
          result.identical,
          true,
          `${trace.id} ${trace.title}: stored and rebuilt snapshots differ at line ${result.firstDifferingLine}\n` +
            `--- stored ---\n${result.stored}\n--- rebuilt ---\n${result.rebuilt}`,
        );
        // A byte-identical snapshot with a diagnosed emitted-set mismatch along the way would be
        // a false positive for A4 (the fold "got lucky" on the final state) — diagnostics must be
        // empty too, exactly as test/engine/rebuild.test.ts already asserts for 13.1 alone.
        assert.deepEqual(diagnostics, [], `${trace.id} ${trace.title}: fold reported diagnostics while replaying the stored journal`);

        store.close();
      } finally {
        await cleanup();
      }
    });
  }
});
