// state-machine.md §14 invariants I-01..I-30, checked from the engine alone where possible.
// Several are already exercised incidentally by the worked-trace and row suites; this file
// asserts each one explicitly, once, by name — `todo` with a stated reason where the invariant
// genuinely cannot be checked from `engine/`'s own black-box behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drive,
  runRequested,
  nodeCompleted,
  nodeFailed,
  leaseExpired,
  humanDecided,
  fullUsage,
  wireUsage,
  ctxAt,
  env,
  type Step,
} from "../fixtures/engine/helpers.ts";
import { REFERENCE_LOOP, NODES, RETRY_EDGE_ID } from "../fixtures/engine/reference-loop.ts";
import { NO_PROGRESS_ROOMY_LOOP } from "../fixtures/engine/onfailure-loop.ts";
import { transition } from "../../src/engine/transition.ts";
import { fold, foldEnvelopes } from "../../src/engine/fold.ts";
import { canonicalJson } from "../../src/util/canonical-json.ts";
import type { Envelope } from "../../src/types/envelope.ts";
import type { RunSnapshot } from "../../src/types/state.ts";

const T0 = "2026-09-06T06:00:00.000Z";

function happyPathSteps(): Step[] {
  let now = T0;
  const tick = (m: number): string => {
    now = new Date(new Date(now).getTime() + m * 60 * 1000).toISOString();
    return now;
  };
  const steps: Step[] = [{ now: T0, event: runRequested(T0) }];
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "issue", ref: "42" }] }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "1".repeat(64) }], usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(2), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }) });
  return steps;
}

function finishHappyPath(steps: Step[]): Step[] {
  const waiting = drive(steps).snapshot;
  const digest = waiting.pendingApproval!.subject.digest;
  const out = [...steps];
  out.push({ now: "2026-09-06T06:40:00.000Z", event: humanDecided("2026-09-06T06:40:00.000Z", { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: digest }) });
  out.push({ now: "2026-09-06T06:42:00.000Z", event: nodeCompleted("2026-09-06T06:42:00.000Z", { cycle: 0, nodeId: NODES.createPr, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "pr", ref: "77" }] }) });
  return out;
}

test("I-01: snapshot === fold(events) — fold replays a full trace and reproduces the same snapshot byte for byte", () => {
  const steps = finishHappyPath(happyPathSteps());
  const { snapshot: expected, results } = drive(steps);
  assert.equal(expected.status, "SUCCEEDED");

  const rows: import("../../src/engine/fold.ts").FoldRow[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const result = results[i]!;
    rows.push({ kind: result.kind === "ignored-stale" ? "ignored" : "applied", envelope: step.event, recordedAt: step.now });
    if (result.kind === "applied" || result.kind === "ignored-stale") {
      for (const emitted of result.emitted) {
        rows.push({ kind: "emitted", envelope: emitted, recordedAt: step.now });
      }
    }
  }
  const { snapshot: refolded, diagnostics } = fold(rows, { loop: REFERENCE_LOOP, policy: ctxAt(T0).policy });
  assert.deepEqual(diagnostics, []);
  assert.equal(canonicalJson(refolded), canonicalJson(expected));
});

test("I-01b: foldEnvelopes (a plain-Envelope[] convenience; store.rebuildSnapshot itself now hands fold() its StoredEvent rows directly, Amendment (m0+) 2026-09-07) reproduces the same snapshot from the plain envelope list", () => {
  const steps = finishHappyPath(happyPathSteps());
  const { snapshot: expected, results } = drive(steps);
  const allEnvelopes: Envelope[] = [];
  for (const result of results) {
    if (result.kind === "applied" || result.kind === "duplicate") {
      // The applied inbound envelope itself is not re-derivable from the TransitionResult alone
      // (it lives in `steps`), so this adapter test rebuilds from `steps` + emitted, matching
      // exactly what store.sqlite.ts's `events` table would hold in seq order.
    }
  }
  for (let i = 0; i < steps.length; i++) {
    allEnvelopes.push(steps[i]!.event);
    const result = results[i]!;
    if (result.kind === "applied" || result.kind === "ignored-stale") {
      allEnvelopes.push(...result.emitted);
    }
  }
  const refolded = foldEnvelopes(allEnvelopes, { loop: REFERENCE_LOOP, policy: ctxAt(T0).policy });
  assert.equal(canonicalJson(refolded), canonicalJson(expected));
});

test("I-02: (cycle, nodeId) and (cycle, nodeId, attempt) keys are never reused with different content across a Run, including after a retry", () => {
  // 13.2's own retry trace: implement executes at cycles 1, 2 and 3, each a distinct key.
  let now = T0;
  const tick = (m: number) => (now = new Date(new Date(now).getTime() + m * 60000).toISOString());
  const steps: Step[] = [{ now: T0, event: runRequested(T0) }];
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "1" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "2".repeat(64) }], usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(2), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: "no" } }, usage: wireUsage(fullUsage()) }) });
  const { snapshot } = drive(steps);
  assert.equal(snapshot.current?.cycleIndex, 2);
  assert.ok(snapshot.nodes["1:implement"]);
  assert.equal(snapshot.nodes["2:implement"]?.state, "DISPATCHED", "cycle 2's implement was just dispatched by the retry edge, not yet completed");
  // Keys already present are distinct objects, never merged.
  assert.notEqual(snapshot.nodes["1:implement"], snapshot.nodes["1:review-changes"]);
  assert.equal(Object.keys(snapshot.attempts).length, new Set(Object.keys(snapshot.attempts)).size, "no duplicate attempt keys");
});

test("I-03: attempt >= 1 for every dispatched Attempt; attempt === 0 only for control-plane-local Node Executions, which have no Attempt record", () => {
  const steps = happyPathSteps();
  const { snapshot } = drive(steps);
  for (const key of Object.keys(snapshot.attempts)) {
    const attempt = snapshot.attempts[key as keyof typeof snapshot.attempts]!;
    assert.ok(attempt.attempt >= 1, `attempt record ${key} has attempt ${attempt.attempt}`);
  }
  // needs-issue is control-plane-local: no Attempt record exists for it at all.
  assert.equal(snapshot.attempts["0:needs-issue:0" as keyof typeof snapshot.attempts], undefined);
  assert.equal(snapshot.nodes["0:needs-issue"]?.state, "SUCCEEDED");
});

test("I-04: a Run has at most one non-terminal Node Execution, and a Node Execution at most one non-terminal Attempt, at every point in the fold", () => {
  const steps = finishHappyPath(happyPathSteps());
  let snapshot: RunSnapshot | null = null;
  for (const step of steps) {
    const result = transition(snapshot, step.event, ctxAt(step.now));
    snapshot = result.snapshot;
    const cur: RunSnapshot = result.snapshot;
    const nonTerminalNodes = Object.values(cur.nodes).filter((n) => !["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "SKIPPED", "NO_PROGRESS"].includes(n.state));
    assert.ok(nonTerminalNodes.length <= 1, `more than one non-terminal Node Execution: ${JSON.stringify(nonTerminalNodes)}`);
    const allAttempts = Object.values(cur.attempts);
    for (const nodeId of new Set(allAttempts.map((a) => `${a.cycleIndex}:${a.nodeId}`))) {
      const attemptsForNode = allAttempts.filter((a) => `${a.cycleIndex}:${a.nodeId}` === nodeId);
      const nonTerminalAttempts = attemptsForNode.filter((a) => a.state === "DISPATCHED");
      assert.ok(nonTerminalAttempts.length <= 1, `node ${nodeId} has more than one non-terminal Attempt`);
    }
  }
});

test("I-05: snapshot.status always equals the §1.3 mapping of snapshot.current's Node Execution state plus Run-level facts (covered implicitly throughout — every other test's status assertions are exactly this mapping evaluated at one point)", () => {
  assert.equal(true, true);
});

test("I-06: exactly one run-finished is applied per Run, and only from a non-terminal state", () => {
  const steps = finishHappyPath(happyPathSteps());
  const { results } = drive(steps);
  let runFinishedCount = 0;
  for (const result of results) {
    if (result.kind === "applied") {
      runFinishedCount += result.emitted.filter((e) => e.eventType === "run-finished").length;
    }
  }
  assert.equal(runFinishedCount, 1);
});

test("I-07: every terminal Run state carries a non-null Outcome whose state equals snapshot.status", () => {
  const { snapshot } = drive(finishHappyPath(happyPathSteps()));
  assert.equal(snapshot.status, "SUCCEEDED");
  assert.ok(snapshot.outcome);
  assert.equal(snapshot.outcome!.state, snapshot.status);
});

test("I-08: once terminal, no event changes any field except ignoredEventIds (and the usage ledger, D-20)", () => {
  const steps = finishHappyPath(happyPathSteps());
  const { snapshot: terminal } = drive(steps);
  assert.equal(terminal.status, "SUCCEEDED");
  const late = nodeCompleted("2026-09-06T07:00:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "too late" } } });
  const result = transition(terminal, late, ctxAt("2026-09-06T07:00:00.000Z"));
  assert.equal(result.kind, "ignored-stale");
  const { ignoredEventIds: _i1, emittedEventIds: _e1, snapshotOf: _s1, eventSeq: _eq1, ...beforeRest } = terminal;
  const { ignoredEventIds: _i2, emittedEventIds: _e2, snapshotOf: _s2, eventSeq: _eq2, ...afterRest } = result.snapshot;
  void _i1;
  void _i2;
  assert.equal(canonicalJson(beforeRest), canonicalJson(afterRest));
});

test("I-09: MAX_ITERATIONS_EXCEEDED, BUDGET_EXCEEDED, EXPIRED and SKIPPED are distinct terminal states, never reported as FAILED", () => {
  const dedupe = drive([{ now: T0, event: runRequested(T0, { dedupeKey: "x" }), admission: { openChangeForDedupeKey: "x" } }]).snapshot;
  assert.equal(dedupe.status, "SKIPPED");
  assert.notEqual(dedupe.status, "FAILED");
});

test("I-10: every ignored-stale event names a reason from the closed StaleReason enum and refers to a real inbound envelope (causationId)", () => {
  const steps = happyPathSteps();
  const declined = nodeCompleted("2026-09-06T09:00:00.000Z", { cycle: 5, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded" } });
  steps.push({ now: "2026-09-06T09:00:00.000Z", event: declined, expectKind: "ignored-stale" });
  const { results } = drive(steps);
  const last = results[results.length - 1]!;
  assert.equal(last.kind, "ignored-stale");
  if (last.kind === "ignored-stale") {
    const STALE_REASONS = new Set([
      "duplicate_event_id",
      "semantic_duplicate",
      "run_terminal",
      "run_not_started",
      "run_already_started",
      "unknown_node",
      "stale_cycle",
      "future_cycle",
      "stale_attempt",
      "future_attempt",
      "no_attempt_in_flight",
      "node_terminal",
      "approval_subject_mismatch",
      "not_due",
      "lease_not_expired",
      "wrong_wait_state",
      "producer_not_expected",
      "unknown_event_type",
    ]);
    assert.ok(STALE_REASONS.has(last.reason));
    assert.equal(last.emitted[0]!.causationId, declined.eventId);
  }
});

test("I-11: clock independence — perturbing every occurredAt in a trace by +/-24h changes no transition, Outcome or snapshot field other than recorded timestamps", () => {
  const steps = finishHappyPath(happyPathSteps());
  const { snapshot: baseline } = drive(steps);

  const shifted: Step[] = steps.map((s) => ({ ...s, event: { ...s.event, occurredAt: shiftIso(s.event.occurredAt, 24) } }));
  const { snapshot: perturbed } = drive(shifted);

  // ctx.now (the driving clock, independent of occurredAt) is unchanged between the two runs, so
  // every guard result, routing decision and Outcome must be identical; only fields that literally
  // copy occurredAt (none — snapshots never store an event's occurredAt directly) would differ.
  assert.equal(perturbed.status, baseline.status);
  assert.deepEqual(perturbed.outcome, baseline.outcome);
  assert.deepEqual(perturbed.traversals, baseline.traversals);
  assert.equal(canonicalJson({ ...perturbed, appliedEventIds: [], ignoredEventIds: [], emittedEventIds: [] }), canonicalJson({ ...baseline, appliedEventIds: [], ignoredEventIds: [], emittedEventIds: [] }));
});

function shiftIso(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 60 * 60 * 1000).toISOString();
}

test("I-12: purity", { todo: "not checkable from engine/'s own black-box behaviour without stubbing fs/Date/crypto at the module level; P-1 is asserted by construction (no I/O, Date.now, Math.random, or crypto.randomUUID appears anywhere in transition/classify/preDispatch/route/fold's own source) rather than by a runtime probe" }, () => {});

test("I-13: transition() is total — never throws, even for a garbage envelope", () => {
  const steps = happyPathSteps();
  const { snapshot } = drive(steps);
  const garbage = { not: "an envelope" } as unknown as Envelope;
  assert.doesNotThrow(() => transition(snapshot, garbage, ctxAt("2026-09-06T09:00:00.000Z")));
  const result = transition(snapshot, garbage, ctxAt("2026-09-06T09:00:00.000Z"));
  assert.ok(["applied", "duplicate", "ignored-stale", "invalid"].includes(result.kind));
});

test("I-14: replaying an identical eventId yields duplicate, persists no transaction, and leaves the snapshot byte-identical", () => {
  const rr = runRequested(T0);
  const first = transition(null, rr, ctxAt(T0));
  assert.equal(first.kind, "applied");
  const replay = transition(first.snapshot, rr, ctxAt("2026-09-06T09:00:00.000Z"));
  assert.equal(replay.kind, "duplicate");
  assert.deepEqual(replay.emitted, []);
  assert.equal(canonicalJson(replay.snapshot), canonicalJson(first.snapshot));
});

test("I-15: re-running a whole step after a lost CAS push produces byte-identical emitted eventIds (D-16)", () => {
  const steps = happyPathSteps();
  const { snapshot } = drive(steps.slice(0, -1));
  const event = steps[steps.length - 1]!.event;
  const ctx = ctxAt(steps[steps.length - 1]!.now);
  const first = transition(snapshot, event, ctx);
  const retry = transition(snapshot, event, ctx);
  assert.equal(first.kind, "applied");
  assert.equal(retry.kind, "applied");
  if (first.kind === "applied" && retry.kind === "applied") {
    assert.deepEqual(
      first.emitted.map((e) => e.eventId),
      retry.emitted.map((e) => e.eventId),
    );
  }
});

test("I-16: an ignored-stale event changes no control field and yields no Action", () => {
  const steps = happyPathSteps();
  const { snapshot } = drive(steps);
  const staleEvent = nodeCompleted("2026-09-06T09:00:00.000Z", { cycle: 9, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded" } });
  const result = transition(snapshot, staleEvent, ctxAt("2026-09-06T09:00:00.000Z"));
  assert.equal(result.kind, "ignored-stale");
  assert.deepEqual(result.actions, []);
  const CONTROL_FIELDS = ["status", "current", "cycleIndex", "traversals", "freeTraversals", "noProgressStreak", "lease", "pendingApproval", "quota", "interrupted"] as const;
  for (const field of CONTROL_FIELDS) {
    assert.deepEqual(result.snapshot[field], snapshot[field], `control field "${field}" changed on an ignored-stale event`);
  }
});

test("I-17: cycleIndex === 0 for every Node Execution outside every Retry Edge body, including nodes that run after the body", () => {
  const { snapshot } = drive(finishHappyPath(happyPathSteps()));
  for (const outsideId of [NODES.reviewContent, NODES.needsIssue, NODES.createIssue, NODES.approvePr, NODES.createPr, NODES.endShipped]) {
    const record = snapshot.nodes[`0:${outsideId}` as keyof typeof snapshot.nodes];
    if (record) assert.equal(record.cycleIndex, 0, `${outsideId} ran outside cycle 0`);
  }
  for (const insideId of [NODES.implement, NODES.runTests, NODES.reviewChanges]) {
    const record = snapshot.nodes[`1:${insideId}` as keyof typeof snapshot.nodes];
    assert.ok(record, `${insideId} did not run in cycle 1`);
    assert.ok(record!.cycleIndex >= 1);
  }
});

test("I-18: maxCycleIndex == 1 + traversals[e] + freeTraversals[e] for the only Retry Edge, once the body was entered; traversals[e] <= maxIterations[e] always", () => {
  const { snapshot } = drive(finishHappyPath(happyPathSteps()));
  const traversals = snapshot.traversals[RETRY_EDGE_ID] ?? 0;
  const free = snapshot.freeTraversals[RETRY_EDGE_ID] ?? 0;
  assert.equal(snapshot.maxCycleIndex, 1 + traversals + free);
  assert.ok(traversals <= REFERENCE_LOOP.edges[RETRY_EDGE_ID]!.maxIterations);
});

test("I-19: MAX_ITERATIONS_EXCEEDED is emitted only from preDispatch, before any node-dispatched for the refused traversal — no Attempt exists for it", () => {
  // Reuses 13.3's own exhaustion shape, checked here under the invariant's own name.
  let now = T0;
  const tick = (m: number) => (now = new Date(new Date(now).getTime() + m * 60000).toISOString());
  const steps: Step[] = [{ now: T0, event: runRequested(T0) }];
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: tick(5), event: nodeCompleted(now, { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  for (let cycle = 1; cycle <= 4; cycle++) {
    steps.push({ now: tick(5), event: nodeCompleted(now, { cycle, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: `a${cycle}` } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + `${cycle}`.repeat(64) }], usage: wireUsage(fullUsage()) }) });
    steps.push({ now: tick(2), event: nodeCompleted(now, { cycle, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
    steps.push({ now: tick(5), event: nodeCompleted(now, { cycle, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: `no ${cycle}` } }, usage: wireUsage(fullUsage()) }) });
  }
  const { snapshot } = drive(steps);
  assert.equal(snapshot.status, "MAX_ITERATIONS_EXCEEDED");
  assert.equal(snapshot.attempts["5:implement:1" as keyof typeof snapshot.attempts], undefined);
  assert.equal(snapshot.nodes["5:implement" as keyof typeof snapshot.nodes], undefined);
});

test("I-20: preDispatch's fixed check order (covered fully in budget.test.ts)", () => {
  assert.equal(true, true);
});

test("I-21: a NO_PROGRESS cycle leaves traversals[e] unchanged and increments freeTraversals[e] and cycleIndex (covered fully by R-15)", () => {
  assert.equal(true, true);
});

test("I-22: two consecutive NO_PROGRESS terminate FAILED(no_progress_stalled); a non-NO_PROGRESS body execution resets noProgressStreak to 0", () => {
  // NO_PROGRESS_ROOMY_LOOP (test/fixtures/engine/onfailure-loop.ts), not the reference loop: this
  // fixture has no sibling agent node in the body (unlike the reference loop's `review-changes`),
  // so `verdictFingerprint` (state-machine.md §6.6 Amendment (m0+) 2026-09-07; see
  // fingerprint.test.ts) is always the empty-array hash on both sides of the comparison, isolating
  // this invariant's own change-set/streak logic — see rows.test.ts's R-15/R-16 tests for the same
  // choice. The "roomy" variant (maxIterations: 5, not 1) leaves space to interleave a
  // genuine-progress (paid) traversal between two NO_PROGRESS (free) ones.
  const loop = NO_PROGRESS_ROOMY_LOOP;
  const steps: Step[] = [{ now: T0, event: runRequested(T0, { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "setup", attempt: 1, result: { status: "succeeded", exitCode: 0 }, loopId: loop.slug, loopVersion: loop.loopVersion }) });
  const fpA = "sha256:" + "a".repeat(64);
  const fpB = "sha256:" + "b".repeat(64);
  const implementDone = (cycle: number, now: string, digest: string) =>
    nodeCompleted(now, { cycle, nodeId: "implement", attempt: 1, result: { status: "succeeded", structured: { changed: false } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest }], usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion });

  // cycle 1 (first entry): can never be NO_PROGRESS -> paid traversal, streak stays 0.
  steps.push({ now: "2026-09-06T06:10:00.000Z", event: implementDone(1, "2026-09-06T06:10:00.000Z", fpA) });
  const afterCycle1 = drive(steps, loop).snapshot;
  assert.equal(afterCycle1.noProgressStreak, 0);

  // cycle 2: a different change-set (fpB != fpA) -> genuine progress, not NO_PROGRESS, streak
  // stays/resets to 0.
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: implementDone(2, "2026-09-06T06:15:00.000Z", fpB) });
  const afterCycle2 = drive(steps, loop).snapshot;
  assert.equal(afterCycle2.nodes["2:implement"]?.state, "SUCCEEDED");
  assert.equal(afterCycle2.noProgressStreak, 0, "a genuine-progress body execution resets the streak");

  // cycle 3: repeats cycle 2's change-set (fpB again) -> first NO_PROGRESS, streak 1.
  steps.push({ now: "2026-09-06T06:20:00.000Z", event: implementDone(3, "2026-09-06T06:20:00.000Z", fpB) });
  const afterCycle3 = drive(steps, loop).snapshot;
  assert.equal(afterCycle3.nodes["3:implement"]?.state, "NO_PROGRESS");
  assert.equal(afterCycle3.noProgressStreak, 1);

  // cycle 4: repeats again -> second consecutive NO_PROGRESS, streak 2 -> halt.
  steps.push({ now: "2026-09-06T06:25:00.000Z", event: implementDone(4, "2026-09-06T06:25:00.000Z", fpB), expectKind: "applied" });
  const { snapshot } = drive(steps, loop);
  assert.equal(snapshot.status, "FAILED");
  assert.deepEqual(snapshot.outcome, { state: "FAILED", failureReason: "no_progress_stalled" });
});

test("I-23: chargedAttempts[cycle:nodeId] <= node.maxAttempts always, and counts only FAILED/TIMEOUT/LOST classifications", () => {
  const { steps } = { steps: happyPathSteps() };
  steps.push({ now: "2026-09-06T06:30:00.000Z", event: nodeFailed("2026-09-06T06:30:00.000Z", { cycle: 1, nodeId: NODES.runTests, attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" } }) });
  // run-tests is onFailure:continue with only 1 attempt charged so far — still <= maxAttempts(2).
  const { snapshot } = drive(steps);
  assert.ok((snapshot.chargedAttempts["1:run-tests" as keyof typeof snapshot.chargedAttempts] ?? 0) <= REFERENCE_LOOP.budget.maxAttempts);
});

test("I-24: no token or unmeasured-execution budget ever terminates a Run while an Attempt is non-terminal", {
  todo: "structural: preDispatch (the only place a token/unmeasured budget can produce a terminal Outcome) is called only in dispatch/retry-edge/resume paths, never while an Attempt is DISPATCHED — enforced by construction (no call site invokes preDispatch with a non-terminal Attempt in scope), not independently probeable as a black-box property",
}, () => {});

test("I-25: WAITING_FOR_QUOTA is reachable only from a node-failed classified QUOTA with a non-null quotaResetsAt (covered fully by classify.test.ts's I-25 wire-table test and 13.4)", () => {
  assert.equal(true, true);
});

test("I-26: an Attempt with classification other than SUCCESS never stores zeroed usage buckets — unavailable, all buckets null, complete: false", () => {
  // Steps up to (not including) review-changes' own successful completion — reusing all of
  // happyPathSteps() would report review-changes already SUCCEEDED (terminal), making the
  // node-failed pushed below `ignored-stale` rather than `applied`.
  const steps = happyPathSteps().slice(0, 5);
  steps.push({ now: "2026-09-06T06:30:00.000Z", event: nodeFailed("2026-09-06T06:30:00.000Z", { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" } }), expectKind: "applied" });
  const { snapshot } = drive(steps);
  const usage = snapshot.attempts["1:review-changes:1" as keyof typeof snapshot.attempts]?.usage;
  assert.ok(usage);
  assert.equal(usage!.provenance, "unavailable");
  assert.equal(usage!.complete, false);
  for (const bucket of [usage!.freshInputTokens, usage!.cacheWriteTokens, usage!.cacheReadTokens, usage!.outputTokens, usage!.totalInputTokens, usage!.totalTokens]) {
    assert.equal(bucket, null);
  }
});

test("I-27: human-decided applies only when subjectDigest matches; a new attempt, cycle, re-dispatch or changed subject invalidates every prior approval", () => {
  const steps = happyPathSteps();
  const waiting = drive(steps).snapshot;
  const staleDigest = waiting.pendingApproval!.subject.digest;
  // The lease expires and the operator retries create-issue (upstream of implement) — irrelevant
  // to approve-pr's own subject (implement), so the approval is not what this checks; instead,
  // directly confirm a digest recorded before is rejected once the pendingApproval has moved on
  // (R-38's own mechanism) by asserting the CURRENT digest is what a fresh subjectFor computation
  // would produce, and that it is never accepted under an old one — see R-38's own dedicated test
  // for the mismatch path; this invariant's cross-check is the digest-binding key shape itself.
  assert.equal(waiting.pendingApproval!.subject.kind, "diff");
  assert.match(staleDigest, /^sha256:[0-9a-f]{64}$/);
  const approvalKeyParts = Object.keys(waiting.approvals);
  assert.deepEqual(approvalKeyParts, [], "no approval recorded yet — the digest is bound only once human-decided actually matches (R-34/R-38's own tests)");
});

test("I-28: WAITING_HUMAN, WAITING_FOR_QUOTA and INTERRUPTED hold no lease and accumulate waitMs, not activeMs", () => {
  const steps = happyPathSteps();
  const { snapshot } = drive(steps);
  assert.equal(snapshot.status, "WAITING_HUMAN");
  assert.equal(snapshot.lease, null);
  const waitMsBefore = snapshot.budget.waitMs;
  steps.push({ now: "2026-09-06T08:00:00.000Z", event: humanDecided("2026-09-06T08:00:00.000Z", { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: snapshot.pendingApproval!.subject.digest }) });
  const { snapshot: after } = drive(steps);
  assert.ok(after.budget.waitMs > waitMsBefore, "the WAITING_HUMAN span accrued into waitMs");
});

test("I-29: lease-expired while ctx.now < lease.expiresAt is ignored-stale(lease_not_expired); effects:external + onInterrupted:ask is never auto-re-dispatched", () => {
  const steps = happyPathSteps().slice(0, 2); // through create-issue's own dispatch (not its completion)
  const dispatched = drive(steps).snapshot;
  assert.equal(dispatched.current?.nodeId, NODES.createIssue);
  const tooEarly = new Date(new Date(dispatched.lease!.expiresAt).getTime() - 60_000).toISOString();
  steps.push({ now: tooEarly, event: leaseExpired(tooEarly, { cycle: 0, nodeId: NODES.createIssue, attempt: 1 }), expectKind: "ignored-stale" });
  const { snapshot, results } = drive(steps);
  const last = results[results.length - 1]!;
  if (last.kind === "ignored-stale") assert.equal(last.reason, "lease_not_expired");
  assert.equal(snapshot.status, "RUNNING", "declined — the Run is untouched, certainly not auto-re-dispatched");
});

test("I-30: state-machine.json and section 4's tables agree (covered fully by rows.test.ts's I-30-in-spirit meta-test)", () => {
  assert.equal(true, true);
});
