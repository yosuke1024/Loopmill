// The A4 corpus (mvp-design.md §20.3, state-machine.md §13): every one of the six canonical
// worked traces (13.1 "Happy path" through 13.6 "Interrupted `run` process"), each driven step by
// step through a real `SqliteStore` via `transition()` + `store.append()` — never through the
// in-memory `drive()` helper `test/engine/worked-traces/` uses, which never touches a store at
// all. Reuses that directory's own envelope builders and reference-loop constants
// (`test/fixtures/engine/helpers.ts`, `test/fixtures/engine/reference-loop.ts`) rather than
// re-deriving them; only the "drive one continuous Run into a real store, one `transition()` +
// `append()` call at a time" plumbing is new here — `test/engine/rebuild.test.ts`'s own
// `applyStep` (written for 13.1 alone) is the template `makeDriver` below generalizes across all
// six traces.
//
// Each entry's `run` takes an already-`createRun`'d store and threads one continuous Run through
// it, returning the final in-memory snapshot for the caller's own sanity checks; the caller (only
// `test/store/worked-traces.test.ts`) is the one that compares `store.rebuildSnapshot` against
// what actually landed on disk — that comparison is A4 itself, not repeated here.
//
// A note on 13.6: state-machine.md §13.6 presents two separate illustrations under one section —
// `implement`'s lease expiring (`effects: none`, R-31 auto-retries) and, independently,
// `create-pr`'s lease expiring (`effects: external`, R-32 freezes the Run as `INTERRUPTED` until a
// human decides). Decision (not in sheet), m1: this corpus entry chains both into one continuous
// Run — the first scenario's own recovery (`implement` attempt 2 succeeds) is exactly the
// prerequisite the second scenario needs (review, `WAITING_HUMAN`, `create-pr` dispatched) — so
// one corpus entry exercises the whole section's mechanics instead of only half of it. Nothing in
// §13.6's own text requires these to be two separate Runs; they read as two illustrations of the
// same `onInterrupted` policy precisely because both can happen to the same Run.

import assert from "node:assert/strict";

import { transition } from "../../../src/engine/transition.ts";
import { DEFAULT_POLICY } from "../../../src/engine/policy.ts";
import type { SqliteStore } from "../../../src/store/sqlite.ts";
import type { Envelope } from "../../../src/types/envelope.ts";
import type { RunSnapshot, TransitionResult } from "../../../src/types/state.ts";
import {
  runRequested,
  nodeCompleted,
  nodeFailed,
  leaseExpired,
  humanDecided,
  resumed,
  fullUsage,
  wireUsage,
} from "../engine/helpers.ts";
import { REFERENCE_LOOP, NODES } from "../engine/reference-loop.ts";

// -------------------------------------------------------------------------------------------
// The driver: threads a scripted sequence of inbound envelopes through the real engine
// (`transition()`), journaling every `applied`/`ignored-stale` result into `store` exactly as
// `loopmill step` would — `appliedKind: "ignored"` for an `ignored-stale` result (state-machine.md
// §5.2 P-3, P-8: the declined envelope is journaled too, so `fold(events)` can reproduce
// `snapshot.ignoredEventIds`). A `duplicate` result (§13.5 row 2: the identical `eventId`
// redelivered) is, by design, never written — that "persists nothing" claim is itself part of
// what the A4 identity below has to hold up against, not a special case this driver works around.
// -------------------------------------------------------------------------------------------

interface Driver {
  /** Runs one envelope through `transition()` against the snapshot this driver has accumulated
   * so far, journals the result into `store` when there is anything to journal, and asserts
   * `expectKind` when given (mirroring `test/fixtures/engine/helpers.ts`'s own `drive()`, so a
   * miscoded step here fails at the step that is wrong rather than surfacing only as a distant
   * rebuild mismatch). */
  apply(event: Envelope, expectKind?: TransitionResult["kind"]): TransitionResult;
  /** The snapshot after the most recent `apply()` call. Throws if nothing has been applied yet. */
  snapshot(): RunSnapshot;
}

function makeDriver(store: SqliteStore, runId: string): Driver {
  let snapshot: RunSnapshot | null = null;
  return {
    apply(event, expectKind) {
      const result = transition(snapshot, event, { loop: REFERENCE_LOOP, policy: DEFAULT_POLICY, now: event.occurredAt });
      if (expectKind) {
        assert.equal(
          result.kind,
          expectKind,
          `expected ${expectKind} for ${event.eventType} (${event.nodeId ?? "run-level"}), got ${result.kind}` +
            (result.kind === "invalid" ? `: ${result.error.code} ${result.error.message}` : ""),
        );
      }
      if (result.kind === "applied" || result.kind === "ignored-stale") {
        const appended = store.append(runId, {
          applied: event,
          appliedKind: result.kind === "ignored-stale" ? "ignored" : "applied",
          emitted: result.emitted,
          snapshot: result.snapshot,
          now: event.occurredAt,
        });
        assert.ok(appended.ok, `store.append failed for ${event.eventType}: ${JSON.stringify(appended)}`);
      }
      // "duplicate": nothing to persist, the store's own row set is already correct.
      // "invalid": nothing was ever applied; a corpus trace that hits this is miscoded, and the
      // `expectKind` assertion above (every call site below passes one) already caught it.
      snapshot = result.snapshot;
      return result;
    },
    snapshot() {
      assert.ok(snapshot, "no event has been applied yet");
      return snapshot!;
    },
  };
}

/** A distinct, valid-looking sha256 digest per call site, so successive change fingerprints in a
 * trace are never accidentally equal (which would misrepresent NO_PROGRESS detection). Matches
 * `test/engine/worked-traces/13.2-retries.test.ts` and `13.3-exhaustion.test.ts`'s own helper. */
function fileDigest(n: number): string {
  return "sha256:" + String(n).repeat(64).slice(0, 64);
}

/** A `tick(minutes)` closure anchored at `start`, mutating and returning its own running clock —
 * the same shape every `test/engine/worked-traces/*.test.ts` file already uses for its own `now`.
 * Kept local to each trace/epoch below (rather than one shared mutable clock) so a trace that
 * resumes from a store-reported timestamp (a lease's `expiresAt`, say) can start a fresh epoch
 * from that exact value without disturbing any earlier tick sequence. */
function tickFrom(start: string): (minutes: number) => string {
  let now = start;
  return (minutes: number): string => {
    now = new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
    return now;
  };
}

// -------------------------------------------------------------------------------------------
// 13.1 Happy path — review-content -> needs-issue(then) -> create-issue -> implement -> run-tests
// -> review-changes -> review-verdict(then) -> approve-pr -> create-pr -> end-shipped.
// Same event sequence as test/engine/worked-traces/13.1-happy-path.test.ts.
// -------------------------------------------------------------------------------------------

function run13_1(store: SqliteStore, runId: string): RunSnapshot {
  const d = makeDriver(store, runId);
  const t0 = "2026-09-06T06:00:00.000Z";
  const tick = tickFrom(t0);

  d.apply(runRequested(t0, { source: "cron" }), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "Broken link", summary: "fix it" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(
    nodeCompleted(tick(5), {
      cycle: 0,
      nodeId: NODES.createIssue,
      attempt: 1,
      result: { status: "succeeded", exitCode: 0, structured: { stdout: "https://github.com/x/y/issues/42" } },
      artifactRefs: [{ kind: "issue", ref: "42", url: "https://github.com/x/y/issues/42" }],
    }),
    "applied",
  );
  d.apply(
    nodeCompleted(tick(5), {
      cycle: 1,
      nodeId: NODES.implement,
      attempt: 1,
      result: { status: "succeeded", structured: { changed: true, summary: "fixed the link" } },
      artifactRefs: [{ kind: "file", ref: "src/a.ts", digest: fileDigest(1) }],
      usage: wireUsage(fullUsage()),
    }),
    "applied",
  );
  d.apply(nodeCompleted(tick(2), { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "looks good" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );

  const digest = d.snapshot().pendingApproval!.subject.digest;
  d.apply(humanDecided(tick(20), { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: digest }), "applied");
  d.apply(
    nodeCompleted(tick(2), { cycle: 0, nodeId: NODES.createPr, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "pr", ref: "77", url: "https://github.com/x/y/pull/77" }] }),
    "applied",
  );

  return d.snapshot();
}

// -------------------------------------------------------------------------------------------
// 13.2 Two retries, then success — traversals 2/3, maxCycleIndex 3. Same event sequence as
// test/engine/worked-traces/13.2-retries.test.ts.
// -------------------------------------------------------------------------------------------

function run13_2(store: SqliteStore, runId: string): RunSnapshot {
  const d = makeDriver(store, runId);
  const t0 = "2026-09-06T06:00:00.000Z";
  const tick = tickFrom(t0);

  d.apply(runRequested(t0), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "issue", ref: "42" }] }), "applied");

  // Cycle 1: implement, run-tests, review-changes(approved:false) -> retry (traversals 0 -> 1).
  d.apply(
    nodeCompleted(tick(5), { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "attempt 1" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fileDigest(1) }], usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(nodeCompleted(tick(5), { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: "reason 1" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );

  // Cycle 2: a genuinely different change-set, still rejected -> retry again (traversals 1 -> 2).
  d.apply(
    nodeCompleted(tick(5), { cycle: 2, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "attempt 2" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fileDigest(2) }], usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(nodeCompleted(tick(5), { cycle: 2, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 2, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: "reason 2, different evidence" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );

  // Cycle 3: approved -> WAITING_HUMAN, then approve + create-pr -> SUCCEEDED.
  d.apply(
    nodeCompleted(tick(5), { cycle: 3, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "attempt 3" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fileDigest(3) }], usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(nodeCompleted(tick(5), { cycle: 3, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 3, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "looks good now" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );

  const digest = d.snapshot().pendingApproval!.subject.digest;
  d.apply(humanDecided(tick(20), { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: digest }), "applied");
  d.apply(nodeCompleted(tick(2), { cycle: 0, nodeId: NODES.createPr, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "pr", ref: "77" }] }), "applied");

  return d.snapshot();
}

// -------------------------------------------------------------------------------------------
// 13.3 Exhaustion — traversals 3/3, MAX_ITERATIONS_EXCEEDED, no 4th Attempt. Same event sequence
// as test/engine/worked-traces/13.3-exhaustion.test.ts.
// -------------------------------------------------------------------------------------------

function run13_3(store: SqliteStore, runId: string): RunSnapshot {
  const d = makeDriver(store, runId);
  const t0 = "2026-09-06T06:00:00.000Z";
  const tick = tickFrom(t0);

  d.apply(runRequested(t0), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");

  // 4 cycles of implement/run-tests/review-changes(approved:false); the 4th traversal (cycle 4's
  // own review-changes completion) is refused by preDispatch (I-19: no Attempt, no
  // retry-edge-taken, for the refused traversal) -> MAX_ITERATIONS_EXCEEDED, folded into that same
  // applied transition rather than a separate hop.
  for (let cycle = 1; cycle <= 4; cycle++) {
    d.apply(
      nodeCompleted(tick(5), { cycle, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: `attempt ${cycle}` } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: fileDigest(cycle) }], usage: wireUsage(fullUsage()) }),
      "applied",
    );
    d.apply(nodeCompleted(tick(5), { cycle, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");
    d.apply(
      nodeCompleted(tick(5), { cycle, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: `still broken, evidence ${cycle}` } }, usage: wireUsage(fullUsage()) }),
      "applied",
    );
  }

  return d.snapshot();
}

// -------------------------------------------------------------------------------------------
// 13.4 Quota park (reported reset) and resume. Same event sequence as
// test/engine/worked-traces/13.4-quota.test.ts's own first ("13.4:") test — its two variants
// (the missing-`quotaResetsAt` degrade-to-FAILED case, and R-24's unparseable-`quotaResetsAt`
// case) exercise other rows of §7.1's wire table, not the canonical §13.4 trace itself.
// -------------------------------------------------------------------------------------------

function run13_4(store: SqliteStore, runId: string): RunSnapshot {
  const d = makeDriver(store, runId);
  const t0 = "2026-09-06T06:00:00.000Z";
  const tick = tickFrom(t0);

  d.apply(runRequested(t0), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");

  const quotaResetsAt = "2026-09-06T09:45:00.000Z";
  d.apply(
    nodeFailed(tick(5), { cycle: 1, nodeId: NODES.implement, attempt: 1, error: { code: "quota", message: "You've hit your session limit · resets at 3:45pm", classified: "quota" }, quotaResetsAt }),
    "applied",
  );

  // resumed(kind:due) before resumeDueAt (15:46Z) -> ignored-stale(not_due); at/after -> RUNNING.
  d.apply(resumed("2026-09-06T09:20:00.000Z", { kind: "due" }), "ignored-stale");
  d.apply(resumed("2026-09-06T09:50:00.000Z", { kind: "due" }), "applied");

  d.apply(
    nodeCompleted("2026-09-06T09:55:00.000Z", {
      cycle: 1,
      nodeId: NODES.implement,
      attempt: 2,
      result: { status: "succeeded", structured: { changed: true, summary: "fixed after quota" } },
      artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "b".repeat(64) }],
      usage: wireUsage(fullUsage()),
    }),
    "applied",
  );

  return d.snapshot();
}

// -------------------------------------------------------------------------------------------
// 13.5 Duplicate and stale delivery. Covers rows 1-3 of state-machine.md §13.5's table: an exact
// `eventId` redelivery (row 2, `duplicate`, persists nothing) and a fresh-`eventId` semantic
// duplicate (row 3, `ignored-stale(semantic_duplicate)`, persisted as an `ignored` row) — the two
// rows that are specifically about what gets *persisted*, which is what A4 is checking. Rows 4-8
// (stale_attempt, unknown_node, future_cycle, run_terminal, the disallowed-producer `invalid`)
// are exercised in test/engine/worked-traces/13.5-duplicate-stale.test.ts against `drive()`; 13.6
// below separately drives a `stale_attempt` ignored-stale through the real store too.
// -------------------------------------------------------------------------------------------

function run13_5(store: SqliteStore, runId: string): RunSnapshot {
  const d = makeDriver(store, runId);
  const t0 = "2026-09-06T06:00:00.000Z";
  const tick = tickFrom(t0);

  d.apply(runRequested(t0), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");

  // Row 1: implement completes -> applied, run-tests dispatched.
  const t1 = "2026-09-06T06:20:00.000Z";
  const e1 = nodeCompleted(t1, {
    cycle: 1,
    nodeId: NODES.implement,
    attempt: 1,
    result: { status: "succeeded", structured: { changed: true, summary: "x" } },
    artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "a".repeat(64) }],
    usage: wireUsage(fullUsage()),
  });
  d.apply(e1, "applied");

  // Row 2: the identical envelope (same eventId) redelivered -> duplicate, persists nothing.
  d.apply(e1, "duplicate");

  // Row 3: a fresh eventId reporting the same (nodeId, cycle, attempt, eventType) — implement is
  // already terminal (run-tests is current) -> ignored-stale(semantic_duplicate), persisted as an
  // "ignored" row so `fold(events)` can reproduce `snapshot.ignoredEventIds`.
  const e2 = nodeCompleted("2026-09-06T06:22:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x (again)" } } });
  d.apply(e2, "ignored-stale");

  return d.snapshot();
}

// -------------------------------------------------------------------------------------------
// 13.6 Interrupted `run` process — both illustrations of state-machine.md §13.6 chained into one
// continuous Run (see the header comment above for why): implement's lease expires
// (effects:none) -> R-31 auto re-dispatches attempt 2, whose success lets the Run continue to
// review and WAITING_HUMAN; create-pr's lease then expires (effects:external) -> R-32 freezes the
// Run as INTERRUPTED; `resumed(kind:interrupted, decision:skip)` moves it on to SUCCEEDED.
// -------------------------------------------------------------------------------------------

function run13_6(store: SqliteStore, runId: string): RunSnapshot {
  const d = makeDriver(store, runId);
  const t0 = "2026-09-06T06:00:00.000Z";
  const tick = tickFrom(t0);

  d.apply(runRequested(t0), "applied");
  d.apply(
    nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );
  d.apply(nodeCompleted(tick(5), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");

  // implement (cycle 1, attempt 1) is dispatched by create-issue's own completion (folded into
  // that same applied step, per transition.ts's startRun/dispatch doc comments); its process is
  // interrupted before any report arrives, so the lease genuinely expires (effects:none).
  const leaseExpiresAt1 = d.snapshot().lease!.expiresAt;
  d.apply(leaseExpired(leaseExpiresAt1, { cycle: 1, nodeId: NODES.implement, attempt: 1 }), "applied");

  // The original subprocess had in fact started, and its completion now reports late (O-5): the
  // superseded attempt's usage is banked but routing (now attempt 2) is untouched.
  d.apply(
    nodeCompleted(leaseExpiresAt1, { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "the lost one" } }, usage: wireUsage(fullUsage()) }),
    "ignored-stale",
  );

  // attempt 2 succeeds; the run continues normally through run-tests, review, and WAITING_HUMAN.
  const afterLease = tickFrom(leaseExpiresAt1);
  d.apply(
    nodeCompleted(afterLease(60), {
      cycle: 1,
      nodeId: NODES.implement,
      attempt: 2,
      result: { status: "succeeded", structured: { changed: true, summary: "attempt 2" } },
      artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "c".repeat(64) }],
      usage: wireUsage(fullUsage()),
    }),
    "applied",
  );
  d.apply(nodeCompleted(afterLease(2), { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }), "applied");
  d.apply(
    nodeCompleted(afterLease(5), { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }),
    "applied",
  );

  const digest = d.snapshot().pendingApproval!.subject.digest;
  d.apply(humanDecided(afterLease(20), { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: digest }), "applied");

  // create-pr (effects:external) is dispatched; this time the lease expires with no automatic
  // re-dispatch — R-32 freezes the Run as INTERRUPTED rather than retrying an external effect
  // (`gh pr create` again) blindly.
  const leaseExpiresAt2 = d.snapshot().lease!.expiresAt;
  d.apply(leaseExpired(leaseExpiresAt2, { cycle: 0, nodeId: NODES.createPr, attempt: 1 }), "applied");

  // The operator confirms PR #77 already exists (out of band) and tells the Run to move on.
  const afterInterrupt = tickFrom(leaseExpiresAt2);
  d.apply(resumed(afterInterrupt(120), { kind: "interrupted", decision: "skip" }), "applied");

  return d.snapshot();
}

// -------------------------------------------------------------------------------------------

export interface WorkedTrace {
  /** The state-machine.md §13 section number, e.g. "13.4". */
  id: string;
  /** The section's own title, e.g. "Quota park and resume". */
  title: string;
  /** Drives the trace's scripted events into `store` (already `createRun`'d for `runId`) and
   * returns the final in-memory snapshot. */
  run(store: SqliteStore, runId: string): RunSnapshot;
}

/** All six canonical §13 worked traces, in section order. Adding a seventh run is one entry here
 * — the test that iterates this array (test/store/worked-traces.test.ts) needs no changes. */
export const WORKED_TRACES: WorkedTrace[] = [
  { id: "13.1", title: "Happy path", run: run13_1 },
  { id: "13.2", title: "Two retries, then success", run: run13_2 },
  { id: "13.3", title: "Exhaustion", run: run13_3 },
  { id: "13.4", title: "Quota park and resume", run: run13_4 },
  { id: "13.5", title: "Duplicate and stale delivery", run: run13_5 },
  { id: "13.6", title: "Interrupted run process", run: run13_6 },
];
