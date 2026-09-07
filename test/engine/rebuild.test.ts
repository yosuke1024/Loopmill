// Acceptance criterion A4 / invariant I-01, end to end through a real `SqliteStore`: drives
// state-machine.md §13.1 ("Happy path") through `transition()`, journals every applied/ignored
// and emitted envelope into a temp-directory SQLite store with the exact `now` each transition
// used for `recordedAt` (`appliedKind: "ignored"` for an `ignored-stale` result), then asks the
// store to `rebuildSnapshot` by folding the *stored rows* (not a bare `Envelope[]` — see the
// `rebuildSnapshot` signature change in `src/store/sqlite.ts`, Ruling 5) back through
// `engine/fold.ts`'s own `fold()`. `fold()` needs the recorded clock (`row.recordedAt`) to
// reproduce `now = recordedAt` the way the original transition saw it (D-2/O-2) — a bare
// `Envelope[]` cannot carry that.

import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../../src/store/sqlite.ts";
import type { StoredEvent } from "../../src/store/sqlite.ts";
import { transition } from "../../src/engine/transition.ts";
import { fold, type FoldDiagnostic } from "../../src/engine/fold.ts";
import { DEFAULT_POLICY } from "../../src/engine/policy.ts";
import type { RunSnapshot, TransitionResult } from "../../src/types/state.ts";
import { ctxAt, RUN_ID, LOOP_ID, LOOP_VERSION, runRequested, nodeCompleted, humanDecided, fullUsage, wireUsage, type Step } from "../fixtures/engine/helpers.ts";
import { REFERENCE_LOOP, NODES } from "../fixtures/engine/reference-loop.ts";
import { freshDb } from "../fixtures/store/helpers.ts";

function sha256Digest(): string {
  return "sha256:" + "a".repeat(64);
}

/** state-machine.md §13.1's own trace: review-content -> needs-issue(then) -> create-issue ->
 * implement -> run-tests -> review-changes -> review-verdict(then) -> approve-pr -> create-pr ->
 * end-shipped, run to a SUCCEEDED Run — the same sequence 13.1-happy-path.test.ts asserts against
 * the in-memory `drive()` helper, replayed here through a real store instead. */
function trace13_1Steps(): Step[] {
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (minutes: number): string => {
    now = new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [{ now, event: runRequested(now, { source: "cron" }) }];
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, {
      cycle: 0,
      nodeId: NODES.reviewContent,
      attempt: 1,
      result: { status: "succeeded", structured: { needs_issue: true, title: "Broken link", summary: "fix it" } },
      usage: wireUsage(fullUsage()),
    }),
  });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, {
      cycle: 0,
      nodeId: NODES.createIssue,
      attempt: 1,
      result: { status: "succeeded", exitCode: 0, structured: { stdout: "https://github.com/x/y/issues/42" } },
      artifactRefs: [{ kind: "issue", ref: "42", url: "https://github.com/x/y/issues/42" }],
    }),
  });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, {
      cycle: 1,
      nodeId: NODES.implement,
      attempt: 1,
      result: { status: "succeeded", structured: { changed: true, summary: "fixed the link" } },
      artifactRefs: [{ kind: "file", ref: "src/a.ts", digest: sha256Digest() }],
      usage: wireUsage(fullUsage()),
    }),
  });
  steps.push({ now: tick(2), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({
    now: tick(5),
    event: nodeCompleted(now, {
      cycle: 1,
      nodeId: NODES.reviewChanges,
      attempt: 1,
      result: { status: "succeeded", structured: { approved: true, reasons: "looks good" } },
      usage: wireUsage(fullUsage()),
    }),
  });
  return steps;
}

test("A4/I-01 end to end: rebuildSnapshot(runId, fold) against a real SqliteStore reproduces the stored snapshot of trace 13.1, with no fold diagnostics", async () => {
  const { dbPath, cleanup } = await freshDb();
  try {
    const store = openStore(dbPath);
    const T0 = "2026-09-06T06:00:00.000Z";
    store.createRun({
      runId: RUN_ID,
      loopId: LOOP_ID,
      loopVersion: LOOP_VERSION,
      loopDigest: LOOP_VERSION,
      trigger: { kind: "schedule", source: "cron", requestedAt: T0 },
      createdAt: T0,
    });

    // Drive trace 13.1 up to review-changes' {approved: true} completion, then the human approval
    // and create-pr that finish the Run — the same steps 13.1-happy-path.test.ts's `drive()` runs,
    // but fed through `transition()` one at a time so each step's own `now`/emitted set can be
    // journaled into the store exactly as `loopmill step` would.
    let snapshot: RunSnapshot | null = null;
    const applyStep = (step: Step): TransitionResult => {
      const ctx = ctxAt(step.now, REFERENCE_LOOP, step.admission);
      const result = transition(snapshot, step.event, ctx);
      if (result.kind === "applied" || result.kind === "ignored-stale") {
        const appended = store.append(RUN_ID, {
          applied: step.event,
          appliedKind: result.kind === "ignored-stale" ? "ignored" : "applied",
          emitted: result.emitted,
          snapshot: result.snapshot,
          now: step.now,
        });
        assert.ok(appended.ok, `store.append failed for ${step.event.eventType}: ${JSON.stringify(appended)}`);
      } else {
        assert.fail(`unexpected TransitionResult kind ${result.kind} for ${step.event.eventType} in trace 13.1`);
      }
      snapshot = result.snapshot;
      return result;
    };

    for (const step of trace13_1Steps()) applyStep(step);

    // Human approval, then create-pr -> end-shipped -> run-finished(SUCCEEDED), completing 13.1.
    const approvalDigest = snapshot!.pendingApproval!.subject.digest;
    applyStep({ now: "2026-09-06T06:40:00.000Z", event: humanDecided("2026-09-06T06:40:00.000Z", { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: approvalDigest }) });
    applyStep({
      now: "2026-09-06T06:42:00.000Z",
      event: nodeCompleted("2026-09-06T06:42:00.000Z", { cycle: 0, nodeId: NODES.createPr, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "pr", ref: "77", url: "https://github.com/x/y/pull/77" }] }),
    });

    assert.equal(snapshot!.status, "SUCCEEDED");
    assert.deepEqual(snapshot!.outcome, { state: "SUCCEEDED", label: "success" });

    let diagnostics: FoldDiagnostic[] = [];
    const foldCtx = { loop: REFERENCE_LOOP, policy: DEFAULT_POLICY };
    const rebuilt = store.rebuildSnapshot(RUN_ID, (rows: StoredEvent[]) => {
      const result = fold(rows, foldCtx);
      diagnostics = result.diagnostics;
      return result.snapshot;
    });

    assert.equal(rebuilt.identical, true, `stored and rebuilt snapshots differ at line ${rebuilt.firstDifferingLine}`);
    assert.deepEqual(diagnostics, []);

    store.close();
  } finally {
    await cleanup();
  }
});
