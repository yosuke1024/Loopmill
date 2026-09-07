// Shared machinery behind the A3 property test (mvp-design.md §20.3: "`transition(snapshot,
// event)` is pure: same inputs, same outputs, no I/O — proven by a property test"). Not itself a
// `*.test.ts` file — `npm test`'s glob (`test/**/*.test.ts`) does not pick this up — so it can be
// imported by both `purity.test.ts` (the property test proper) and `invariants.test.ts`'s I-12
// (which delegates to the exact same checks rather than re-deriving them) without registering its
// own `node:test` cases twice.
//
// Three independent proofs, one per A3 clause:
//   - `checkDeterminism`: the same (snapshot, event, ctx) triple, called twice on independent
//     clones, yields byte-identical `TransitionResult`s (canonical JSON, `util/canonical-json.ts`
//     — already this codebase's own standard for "byte for byte", e.g. I-01/I-08/I-11/I-14).
//   - `checkNoMutation`: both accepted proof shapes the task names, applied together — (a) the
//     snapshot/event are canonical-JSON-snapshotted before the call and compared after, and (b) a
//     deep-frozen clone of the same inputs is run through `transition()` too and must produce the
//     *same* result as the unfrozen call; a mutation attempt on a frozen object throws in strict
//     ESM, and `transition()`'s own outer try/catch (transition.ts's P-3 "internal_invariant"
//     backstop) would swallow that throw and turn it into a different `TransitionResult`, which
//     the comparison catches even though the throw itself never escapes.
//   - `checkNoIO`: `fs`, `node:fs/promises`, `child_process` and `Math.random` are monkey-patched
//     to record any call, and the global `Date` is wrapped in a `Proxy` that records `Date.now()`
//     and zero-argument `new Date()` (both wall-clock reads — `ctx.now` is meant to be the only
//     time source; `new Date(explicitMs)` stays untouched, since that is pure parsing/formatting,
//     e.g. `classify.ts`'s own `new Date(resetsAtEpochSeconds * 1000)`). Not exhaustive: network
//     sockets/`fetch`, `worker_threads`, and `crypto.getRandomValues`/`randomUUID` are not
//     guarded — a static grep of every module `transition()` can reach (`src/engine/*.ts`,
//     `src/envelope/*.ts`, `src/loop-file/*.ts`, `src/usage/*.ts`, `src/util/*.ts`) turned up none
//     of these, and `util/ulid.ts`'s own `randomUlid`/`crypto.getRandomValues` call exists only for
//     *generating* fresh ids (`newRunId`, used by this test suite's own fixtures to mint `RUN_ID`)
//     and is never on `transition()`'s own call path (it uses `deterministicEventId`, a pure hash
//     of its inputs, for every event it emits) — named here per this task's own instruction to
//     name what a runtime probe cannot reach, rather than left silently unchecked.
//
// Every triple's *snapshot* comes from a real fold reached by `drive()` over these fixtures'
// loops (never a hand-built/malformed one — the task's own instruction); only the *event* half of
// a triple is sometimes synthetic or adversarial (`buildMutatedTriples`), which is the point: a
// pure function must behave identically on repeat calls and touch no I/O for *any* event a caller
// might hand it, not only the well-formed ones.

import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import childProcess from "node:child_process";

import {
  drive,
  runRequested,
  nodeCompleted,
  nodeFailed,
  leaseExpired,
  humanDecided,
  resumed,
  nodeTimedOut,
  fullUsage,
  wireUsage,
  ctxAt,
  type Step,
} from "../fixtures/engine/helpers.ts";
import { REFERENCE_LOOP, NODES, RETRY_EDGE_ID } from "../fixtures/engine/reference-loop.ts";
import { NO_PROGRESS_ROOMY_LOOP, ONFAILURE_LOOP, ONFAILURE_CONTINUE_LOOP, COMMAND_ONFAILURE_CONTINUE_LOOP } from "../fixtures/engine/onfailure-loop.ts";
import { transition, type EngineTransitionContext } from "../../src/engine/transition.ts";
import { canonicalJson, parseJson } from "../../src/util/canonical-json.ts";
import type { Envelope } from "../../src/types/envelope.ts";
import type { RunSnapshot, TransitionResult } from "../../src/types/state.ts";
import type { ResolvedLoop } from "../../src/types/loop.ts";

void RETRY_EDGE_ID; // kept for symmetry with the fixture's own export; not needed by any scenario below

// -------------------------------------------------------------------------------------------
// PRNG — mulberry32. Deterministic given a seed, no external entropy, so the whole pool this
// file builds (and therefore every property-check trial) is exactly reproducible from one
// integer. The task's own instruction: "seed any randomness deterministically and print the seed
// on failure" — every assertion message below embeds `seed`, so a failing case's own error text
// already carries what a human needs to reproduce it (rerun with this same fixed default).
// -------------------------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Decision (not in sheet), m1: a fixed literal rather than a time-derived seed — the whole point
 * of seeding deterministically is that the default run (no environment, no flags) is already
 * reproducible; a `Date.now()`-derived seed would defeat that on every single invocation. */
export const DEFAULT_SEED = 0x1cebee12;

function pick<T>(rng: () => number, arr: readonly T[]): T {
  const idx = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[idx]!;
}

function randInt(rng: () => number, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function randDigest(rng: () => number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 64; i++) out += chars[Math.floor(rng() * 16)];
  return `sha256:${out}`;
}

// -------------------------------------------------------------------------------------------
// Small clock helper (the same tick-forward pattern every worked-trace test in this suite uses).
// -------------------------------------------------------------------------------------------

function makeClock(start: string): { now: () => string; tick: (minutes: number) => string } {
  let now = start;
  return {
    now: () => now,
    tick: (minutes: number) => {
      now = new Date(new Date(now).getTime() + minutes * 60_000).toISOString();
      return now;
    },
  };
}

// -------------------------------------------------------------------------------------------
// Triples
// -------------------------------------------------------------------------------------------

export interface Triple {
  label: string;
  snapshot: RunSnapshot | null;
  event: Envelope;
  ctx: EngineTransitionContext;
}

/** Drives `steps` through `transition()` exactly as `helpers.ts`'s own `drive()` does, but
 * additionally records the *pre*-step (snapshot, event, ctx) triple at every hop — the shape
 * `drive()` itself discards — plus every post-step snapshot, so a caller can build a legal
 * `duplicate`-triggering triple by pairing a later event against an *earlier* real snapshot that
 * has already applied it. */
function driveCollectingTriples(label: string, steps: Step[], loop: ResolvedLoop): { triples: Triple[]; afterSnapshots: RunSnapshot[]; finalSnapshot: RunSnapshot } {
  let snapshot: RunSnapshot | null = null;
  const triples: Triple[] = [];
  const afterSnapshots: RunSnapshot[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const ctx = ctxAt(step.now, loop, step.admission);
    triples.push({
      label: `${label}#${i}:${step.event.eventType}${step.event.nodeId ? `(${step.event.nodeId})` : ""}`,
      snapshot,
      event: step.event,
      ctx,
    });
    const result = transition(snapshot, step.event, ctx);
    if (step.expectKind) {
      assert.equal(result.kind, step.expectKind, `${label}#${i}: expected ${step.expectKind} building the pool, got ${result.kind}` + (result.kind === "invalid" ? `: ${result.error.code} ${result.error.message}` : ""));
    }
    snapshot = result.snapshot;
    afterSnapshots.push(snapshot);
  }
  return { triples, afterSnapshots, finalSnapshot: snapshot! };
}

// -------------------------------------------------------------------------------------------
// Scenario builders. Each returns a fresh, real `Step[]` script driven through a real loop —
// several distinct loop topologies (the reference loop, the NO_PROGRESS/onFailure fixtures) and
// event orders, several randomised via `rng` — so `driveCollectingTriples` yields a wide spread
// of genuinely reachable (snapshot, event, ctx) triples covering `applied`, `duplicate`,
// `ignored-stale` and `invalid` results across most of the Run/Node/Attempt states §13 and
// state-machine.md's row tables name. Every scenario mirrors a recipe this suite already trusts
// elsewhere (state-machine.md §13's worked traces, `rows.test.ts`'s row tests, `invariants.test.ts`
// itself) rather than inventing new engine behaviour — this file's job is only to *generate*
// many such traces, not to discover new ones.
// -------------------------------------------------------------------------------------------

interface Scenario {
  label: string;
  loop: ResolvedLoop;
  steps: Step[];
}

function scenarioHappySuccess(rng: () => number, label: string): Scenario {
  const clock = makeClock("2026-09-06T06:00:00.000Z");
  const steps: Step[] = [{ now: clock.now(), event: runRequested(clock.now()) }];
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });

  // 0-2 extra reject-then-retry cycles before the final approve, well under the reference loop's
  // own retry edge maxIterations (4, per I-19) so this never accidentally hits MAX_ITERATIONS_EXCEEDED.
  const extraRejects = randInt(rng, 0, 2);
  let cycle = 1;
  for (let i = 0; i < extraRejects; i++) {
    steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: `r${i}` } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: randDigest(rng) }], usage: wireUsage(fullUsage()) }) });
    steps.push({ now: clock.tick(2), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
    steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: `no ${i}` } }, usage: wireUsage(fullUsage()) }) });
    cycle += 1;
  }
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "final" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: randDigest(rng) }], usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(2), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }) });

  const waiting = drive(steps, REFERENCE_LOOP).snapshot;
  const digest = waiting.pendingApproval!.subject.digest;
  steps.push({ now: clock.tick(20), event: humanDecided(clock.now(), { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: digest }) });
  steps.push({
    now: clock.tick(2),
    event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.createPr, attempt: 1, result: { status: "succeeded", exitCode: 0 }, artifactRefs: [{ kind: "pr", ref: String(randInt(rng, 1, 999)) }] }),
    expectKind: "applied",
  });
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioMaxIterationsExceeded(rng: () => number, label: string): Scenario {
  const clock = makeClock("2026-09-06T06:00:00.000Z");
  const steps: Step[] = [{ now: clock.now(), event: runRequested(clock.now()) }];
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  for (let cycle = 1; cycle <= 4; cycle++) {
    steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: `a${cycle}` } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: randDigest(rng) }], usage: wireUsage(fullUsage()) }) });
    steps.push({ now: clock.tick(2), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
    const expectKind = cycle === 4 ? "applied" : undefined;
    steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: false, reasons: `no ${cycle}` } }, usage: wireUsage(fullUsage()) }), ...(expectKind ? { expectKind } : {}) });
  }
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioNoProgressHalt(rng: () => number, label: string): Scenario {
  const loop = NO_PROGRESS_ROOMY_LOOP;
  const clock = makeClock("2026-09-06T06:00:00.000Z");
  const steps: Step[] = [{ now: clock.now(), event: runRequested(clock.now(), { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: "setup", attempt: 1, result: { status: "succeeded", exitCode: 0 }, loopId: loop.slug, loopVersion: loop.loopVersion }) });

  const implementDone = (cycle: number, digest: string) =>
    nodeCompleted(clock.now(), { cycle, nodeId: "implement", attempt: 1, result: { status: "succeeded", structured: { changed: false } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest }], usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion });

  // cycle 1 (first entry): can never itself be NO_PROGRESS.
  steps.push({ now: clock.tick(5), event: implementDone(1, randDigest(rng)) });

  // 0-2 further genuine-progress cycles (a fresh digest each time), inside the roomy edge's own
  // maxIterations: 5 headroom.
  const extraProgress = randInt(rng, 0, 2);
  for (let i = 0; i < extraProgress; i++) {
    steps.push({ now: clock.tick(5), event: implementDone(2 + i, randDigest(rng)) });
  }

  // Two consecutive repeats of the same digest -> NO_PROGRESS, NO_PROGRESS -> FAILED(no_progress_stalled).
  const repeat = randDigest(rng);
  steps.push({ now: clock.tick(5), event: implementDone(2 + extraProgress, repeat) });
  steps.push({ now: clock.tick(5), event: implementDone(3 + extraProgress, repeat), expectKind: "applied" });

  return { label, loop, steps };
}

function scenarioQuotaParkResume(rng: () => number, label: string): Scenario {
  const clock = makeClock("2026-09-06T06:00:00.000Z");
  const steps: Step[] = [{ now: clock.now(), event: runRequested(clock.now()) }];
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });

  const failNow = clock.tick(5);
  const quotaResetsAt = new Date(new Date(failNow).getTime() + randInt(rng, 30, 90) * 60_000).toISOString();
  steps.push({ now: failNow, event: nodeFailed(failNow, { cycle: 1, nodeId: NODES.implement, attempt: 1, error: { code: "quota", message: "You've hit your session limit · resets soon", classified: "quota" }, quotaResetsAt }) });

  // Sometimes an operator (or the sweep) tries to resume before quotaResetsAt + jitter — ignored-stale(not_due).
  if (rng() < 0.5) {
    const early = new Date(new Date(quotaResetsAt).getTime() - randInt(rng, 5, 20) * 60_000).toISOString();
    steps.push({ now: early, event: resumed(early, { kind: "due" }) });
  }
  // policyDefaults.quotaJitterSeconds is 60 (docs/spec/state-machine.json) — clearing it by a
  // wide, random margin avoids the test depending on that exact constant.
  const onTime = new Date(new Date(quotaResetsAt).getTime() + randInt(rng, 65, 180) * 1000).toISOString();
  steps.push({ now: onTime, event: resumed(onTime, { kind: "due" }) });
  steps.push({
    now: new Date(new Date(onTime).getTime() + 5 * 60_000).toISOString(),
    event: nodeCompleted(new Date(new Date(onTime).getTime() + 5 * 60_000).toISOString(), { cycle: 1, nodeId: NODES.implement, attempt: 2, result: { status: "succeeded", structured: { changed: true, summary: "after quota" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: randDigest(rng) }], usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioInterruptedRetry(rng: () => number, label: string): Scenario {
  const clock = makeClock("2026-09-06T06:00:00.000Z");
  const steps: Step[] = [{ now: clock.now(), event: runRequested(clock.now()) }];
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });

  const dispatched = drive(steps, REFERENCE_LOOP).snapshot;
  const leaseExpiresAt = dispatched.lease!.expiresAt;
  steps.push({ now: leaseExpiresAt, event: leaseExpired(leaseExpiresAt, { cycle: 1, nodeId: NODES.implement, attempt: 1 }) });

  // The original subprocess had actually started and now reports late — stale_attempt.
  const staleReport = nodeCompleted(leaseExpiresAt, { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "the lost one" } }, usage: wireUsage(fullUsage()) });
  steps.push({ now: leaseExpiresAt, event: staleReport });

  steps.push({
    now: "2026-09-06T07:00:00.000Z",
    event: nodeCompleted("2026-09-06T07:00:00.000Z", { cycle: 1, nodeId: NODES.implement, attempt: 2, result: { status: "succeeded", structured: { changed: true, summary: "attempt 2" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: randDigest(rng) }], usage: wireUsage(fullUsage()) }),
    expectKind: "applied",
  });
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioInterruptedExternal(rng: () => number, label: string): Scenario {
  const clock = makeClock("2026-09-06T06:00:00.000Z");
  const steps: Step[] = [{ now: clock.now(), event: runRequested(clock.now()) }];
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: randDigest(rng) }], usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(2), event: nodeCompleted(clock.now(), { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }) });

  const waiting = drive(steps, REFERENCE_LOOP).snapshot;
  const digest = waiting.pendingApproval!.subject.digest;
  steps.push({ now: clock.tick(20), event: humanDecided(clock.now(), { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: digest }) });

  const dispatched = drive(steps, REFERENCE_LOOP).snapshot;
  const leaseExpiresAt = dispatched.lease!.expiresAt;
  steps.push({ now: leaseExpiresAt, event: leaseExpired(leaseExpiresAt, { cycle: 0, nodeId: NODES.createPr, attempt: 1 }) });

  const decision = pick(rng, ["skip", "fail"] as const);
  steps.push({ now: "2026-09-06T08:00:00.000Z", event: resumed("2026-09-06T08:00:00.000Z", { kind: "interrupted", decision }), expectKind: "applied" });
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioOnFailureStepRetryEdge(label: string): Scenario {
  const loop = ONFAILURE_LOOP;
  const steps: Step[] = [{ now: "2026-09-06T06:00:00.000Z", event: runRequested("2026-09-06T06:00:00.000Z", { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeFailed("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "step", attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
  steps.push({ now: "2026-09-06T06:10:00.000Z", event: nodeFailed("2026-09-06T06:10:00.000Z", { cycle: 0, nodeId: "step", attempt: 2, error: { code: "runtime_error", message: "x again", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
  // retry-edge-taken -> "step" dispatched again at cycle 1, attempt 1.
  steps.push({ now: "2026-09-06T06:15:00.000Z", event: nodeCompleted("2026-09-06T06:15:00.000Z", { cycle: 1, nodeId: "step", attempt: 1, result: { status: "succeeded" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });

  const waiting = drive(steps, loop).snapshot;
  assert.equal(waiting.status, "WAITING_HUMAN", `${label}: expected gate to be waiting after step's retried success`);
  const digest = waiting.pendingApproval!.subject.digest;
  steps.push({
    now: "2026-09-06T06:20:00.000Z",
    event: humanDecided("2026-09-06T06:20:00.000Z", { cycle: 0, nodeId: "gate", decision: "approve", subjectDigest: digest, loopId: loop.slug, loopVersion: loop.loopVersion }),
    expectKind: "applied",
  });
  return { label, loop, steps };
}

function scenarioOnFailureMaxIterations(label: string): Scenario {
  const loop = ONFAILURE_LOOP; // back-edge maxIterations: 2, from:"step" to:"step" (a self-loop)
  const steps: Step[] = [{ now: "2026-09-06T06:00:00.000Z", event: runRequested("2026-09-06T06:00:00.000Z", { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  let now = "2026-09-06T06:00:00.000Z";
  const tick = (m: number) => (now = new Date(new Date(now).getTime() + m * 60_000).toISOString());
  let cycle = 0;
  for (let traversal = 0; traversal < 2; traversal++) {
    steps.push({ now: tick(5), event: nodeFailed(now, { cycle, nodeId: "step", attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
    steps.push({ now: tick(5), event: nodeFailed(now, { cycle, nodeId: "step", attempt: 2, error: { code: "runtime_error", message: "x again", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
    cycle = drive(steps, loop).snapshot.cycleIndex;
  }
  steps.push({ now: tick(5), event: nodeFailed(now, { cycle, nodeId: "step", attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
  steps.push({ now: tick(5), event: nodeFailed(now, { cycle, nodeId: "step", attempt: 2, error: { code: "runtime_error", message: "x again", classified: "runtime_error" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }), expectKind: "applied" });
  return { label, loop, steps };
}

function scenarioOnFailureGateRejectRetryEdge(label: string): Scenario {
  const loop = ONFAILURE_LOOP; // gate: onFailure retry_edge:back-edge, subject: nodes.step
  const steps: Step[] = [{ now: "2026-09-06T06:00:00.000Z", event: runRequested("2026-09-06T06:00:00.000Z", { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeCompleted("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "step", attempt: 1, result: { status: "succeeded" }, usage: wireUsage(fullUsage()), loopId: loop.slug, loopVersion: loop.loopVersion }) });
  const waiting = drive(steps, loop).snapshot;
  assert.equal(waiting.status, "WAITING_HUMAN", `${label}: expected gate to be waiting`);
  const digest = waiting.pendingApproval!.subject.digest;
  steps.push({
    now: "2026-09-06T06:10:00.000Z",
    event: humanDecided("2026-09-06T06:10:00.000Z", { cycle: 0, nodeId: "gate", decision: "reject", subjectDigest: digest, loopId: loop.slug, loopVersion: loop.loopVersion }),
    expectKind: "applied",
  });
  return { label, loop, steps };
}

function scenarioOnFailureContinueSkip(rng: () => number, label: string): Scenario {
  const loop = ONFAILURE_CONTINUE_LOOP;
  const steps: Step[] = [{ now: "2026-09-06T06:00:00.000Z", event: runRequested("2026-09-06T06:00:00.000Z", { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeFailed("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "step", attempt: 1, error: { code: "runtime_error", message: "x", classified: "runtime_error" }, loopId: loop.slug, loopVersion: loop.loopVersion }) });
  steps.push({ now: "2026-09-06T06:10:00.000Z", event: nodeFailed("2026-09-06T06:10:00.000Z", { cycle: 0, nodeId: "step", attempt: 2, error: { code: "runtime_error", message: "x again", classified: "runtime_error" }, loopId: loop.slug, loopVersion: loop.loopVersion }) });
  const waiting = drive(steps, loop).snapshot;
  assert.equal(waiting.status, "WAITING_HUMAN", `${label}: expected gate to be waiting after step was SKIPPED`);
  const digest = waiting.pendingApproval!.subject.digest;
  const decision = pick(rng, ["approve", "reject"] as const);
  steps.push({
    now: "2026-09-06T06:15:00.000Z",
    event: humanDecided("2026-09-06T06:15:00.000Z", { cycle: 0, nodeId: "gate", decision, subjectDigest: digest, loopId: loop.slug, loopVersion: loop.loopVersion }),
    expectKind: "applied",
  });
  return { label, loop, steps };
}

function scenarioCommandOnFailureContinue(label: string): Scenario {
  const loop = COMMAND_ONFAILURE_CONTINUE_LOOP;
  const steps: Step[] = [{ now: "2026-09-06T06:00:00.000Z", event: runRequested("2026-09-06T06:00:00.000Z", { loopId: loop.slug, loopVersion: loop.loopVersion }) }];
  steps.push({ now: "2026-09-06T06:05:00.000Z", event: nodeFailed("2026-09-06T06:05:00.000Z", { cycle: 0, nodeId: "run-cmd", attempt: 1, error: { code: "exit_1", message: "npm test exited with code 1", classified: "runtime_error" }, exitCode: 1, loopId: loop.slug, loopVersion: loop.loopVersion }) });
  steps.push({
    now: "2026-09-06T06:10:00.000Z",
    event: nodeFailed("2026-09-06T06:10:00.000Z", { cycle: 0, nodeId: "run-cmd", attempt: 2, error: { code: "exit_1", message: "npm test exited with code 1 (again)", classified: "runtime_error" }, exitCode: 1, structured: { stdout: "FAIL retry-edge.test.ts\n3 failing" }, loopId: loop.slug, loopVersion: loop.loopVersion }),
    expectKind: "applied",
  });
  return { label, loop, steps };
}

/** Shared prefix for the three `approve-pr` gate scenarios below (state-machine.md §13.1 up to
 * the gate). */
function baseApprovePrSteps(): { steps: Step[]; clock: ReturnType<typeof makeClock> } {
  const clock = makeClock("2026-09-06T06:00:00.000Z");
  const steps: Step[] = [{ now: clock.now(), event: runRequested(clock.now()) }];
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 1, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded", structured: { changed: true, summary: "x" } }, artifactRefs: [{ kind: "file", ref: "a.ts", digest: "sha256:" + "7".repeat(64) }], usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(2), event: nodeCompleted(clock.now(), { cycle: 1, nodeId: NODES.runTests, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 1, nodeId: NODES.reviewChanges, attempt: 1, result: { status: "succeeded", structured: { approved: true, reasons: "ok" } }, usage: wireUsage(fullUsage()) }) });
  return { steps, clock };
}

function scenarioApprovePrRejectFailRun(label: string): Scenario {
  const { steps, clock } = baseApprovePrSteps();
  const waiting = drive(steps, REFERENCE_LOOP).snapshot;
  const digest = waiting.pendingApproval!.subject.digest;
  steps.push({ now: clock.tick(20), event: humanDecided(clock.now(), { cycle: 0, nodeId: NODES.approvePr, decision: "reject", subjectDigest: digest }), expectKind: "applied" });
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioApprovePrCancel(label: string): Scenario {
  const { steps, clock } = baseApprovePrSteps();
  const waiting = drive(steps, REFERENCE_LOOP).snapshot;
  const digest = waiting.pendingApproval!.subject.digest;
  steps.push({ now: clock.tick(20), event: humanDecided(clock.now(), { cycle: 0, nodeId: NODES.approvePr, decision: "cancel", subjectDigest: digest }), expectKind: "applied" });
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioApprovePrDigestMismatch(label: string): Scenario {
  const { steps, clock } = baseApprovePrSteps();
  steps.push({ now: clock.tick(20), event: humanDecided(clock.now(), { cycle: 0, nodeId: NODES.approvePr, decision: "approve", subjectDigest: "sha256:" + "0".repeat(64) }), expectKind: "ignored-stale" });
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioApprovePrExpired(label: string): Scenario {
  const { steps } = baseApprovePrSteps();
  const waiting = drive(steps, REFERENCE_LOOP).snapshot;
  const expiresAt = waiting.pendingApproval!.expiresAt;
  steps.push({ now: expiresAt, event: nodeTimedOut(expiresAt, { cycle: 0, nodeId: NODES.approvePr, attempt: 0, code: "human_timeout" }), expectKind: "applied" });
  return { label, loop: REFERENCE_LOOP, steps };
}

function scenarioDedupeSkip(label: string): Scenario {
  return {
    label,
    loop: REFERENCE_LOOP,
    steps: [{ now: "2026-09-06T06:00:00.000Z", event: runRequested("2026-09-06T06:00:00.000Z", { dedupeKey: "x" }), admission: { openChangeForDedupeKey: "x" }, expectKind: "applied" }],
  };
}

function scenarioMinIntervalSkip(label: string): Scenario {
  return {
    label,
    loop: REFERENCE_LOOP,
    steps: [{ now: "2026-09-06T06:00:00.000Z", event: runRequested("2026-09-06T06:00:00.000Z"), admission: { minIntervalBreached: true }, expectKind: "applied" }],
  };
}

function scenarioRunsPerWindowSkip(label: string): Scenario {
  return {
    label,
    loop: REFERENCE_LOOP,
    steps: [{ now: "2026-09-06T06:00:00.000Z", event: runRequested("2026-09-06T06:00:00.000Z"), admission: { runsPerWindowBreached: true }, expectKind: "applied" }],
  };
}

function scenarioLateStaleReport(label: string): Scenario {
  const clock = makeClock("2026-09-06T06:00:00.000Z");
  const steps: Step[] = [{ now: clock.now(), event: runRequested(clock.now()) }];
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.reviewContent, attempt: 1, result: { status: "succeeded", structured: { needs_issue: true, title: "t", summary: "s" } }, usage: wireUsage(fullUsage()) }) });
  steps.push({ now: clock.tick(5), event: nodeCompleted(clock.now(), { cycle: 0, nodeId: NODES.createIssue, attempt: 1, result: { status: "succeeded", exitCode: 0 } }) });
  // Far beyond any cycle the Run has actually reached yet -> ignored-stale(future_cycle).
  steps.push({ now: clock.tick(30), event: nodeCompleted(clock.now(), { cycle: 9, nodeId: NODES.implement, attempt: 1, result: { status: "succeeded" } }), expectKind: "ignored-stale" });
  return { label, loop: REFERENCE_LOOP, steps };
}

// -------------------------------------------------------------------------------------------
// Pool assembly
// -------------------------------------------------------------------------------------------

/** Every deterministic-shape scenario, each run once (twice for the ones parameterised by
 * `rng`, to widen the spread a little further without letting the pool balloon), flattened into
 * one big triple list plus every post-step snapshot reached (fodder for `buildMutatedTriples`'s
 * `duplicate`-forcing strategy). */
function buildBaseTriples(rng: () => number): { triples: Triple[]; afterSnapshots: RunSnapshot[] } {
  const scenarios: Scenario[] = [
    scenarioHappySuccess(rng, "happy-a"),
    scenarioHappySuccess(rng, "happy-b"),
    scenarioMaxIterationsExceeded(rng, "max-iterations"),
    scenarioNoProgressHalt(rng, "no-progress-a"),
    scenarioNoProgressHalt(rng, "no-progress-b"),
    scenarioQuotaParkResume(rng, "quota-a"),
    scenarioQuotaParkResume(rng, "quota-b"),
    scenarioInterruptedRetry(rng, "interrupted-retry"),
    scenarioInterruptedExternal(rng, "interrupted-external-a"),
    scenarioInterruptedExternal(rng, "interrupted-external-b"),
    scenarioOnFailureStepRetryEdge("onfailure-step-retry-edge"),
    scenarioOnFailureMaxIterations("onfailure-max-iterations"),
    scenarioOnFailureGateRejectRetryEdge("onfailure-gate-reject-retry-edge"),
    scenarioOnFailureContinueSkip(rng, "onfailure-continue-skip-a"),
    scenarioOnFailureContinueSkip(rng, "onfailure-continue-skip-b"),
    scenarioCommandOnFailureContinue("command-onfailure-continue"),
    scenarioApprovePrRejectFailRun("approve-pr-reject"),
    scenarioApprovePrCancel("approve-pr-cancel"),
    scenarioApprovePrDigestMismatch("approve-pr-digest-mismatch"),
    scenarioApprovePrExpired("approve-pr-expired"),
    scenarioDedupeSkip("dedupe-skip"),
    scenarioMinIntervalSkip("min-interval-skip"),
    scenarioRunsPerWindowSkip("runs-per-window-skip"),
    scenarioLateStaleReport("late-stale-report"),
  ];

  const triples: Triple[] = [];
  const afterSnapshots: RunSnapshot[] = [];
  for (const scenario of scenarios) {
    const built = driveCollectingTriples(scenario.label, scenario.steps, scenario.loop);
    triples.push(...built.triples);
    afterSnapshots.push(...built.afterSnapshots);
  }
  return { triples, afterSnapshots };
}

const BOGUS_NODE_IDS = ["no-such-node", "", "review-content", "implement", "gate"] as const;

/** Layers randomised, sometimes-adversarial *events* on top of real, already-reachable snapshots
 * drawn from `base` — never a fabricated snapshot (the task's own instruction), only the event
 * half of the triple. Exercises `transition()`'s full result-kind space (a mutated `cycle`/
 * `attempt`/`nodeId` typically lands on `ignored-stale` or `invalid`; a reused `eventId` forces
 * `duplicate`; a bare garbage object exercises I-13's totality guarantee at the same time). */
function buildMutatedTriples(rng: () => number, base: readonly Triple[], count: number): Triple[] {
  const withSnapshot = base.filter((t): t is Triple & { snapshot: RunSnapshot } => t.snapshot !== null);
  if (withSnapshot.length === 0) return [];
  const out: Triple[] = [];
  for (let i = 0; i < count; i++) {
    const source = pick(rng, withSnapshot);
    const strategy = randInt(rng, 0, 5);
    const clonedEvent = cloneViaCanonicalJson(source.event);
    let event: Envelope;
    let strategyName: string;
    switch (strategy) {
      case 0: {
        strategyName = "cycle-shift";
        event = clonedEvent.cycle === undefined ? clonedEvent : { ...clonedEvent, cycle: clonedEvent.cycle + randInt(rng, -2, 5) };
        break;
      }
      case 1: {
        strategyName = "attempt-shift";
        event = clonedEvent.attempt === undefined ? clonedEvent : { ...clonedEvent, attempt: clonedEvent.attempt + randInt(rng, -2, 5) };
        break;
      }
      case 2: {
        strategyName = "nodeId-swap";
        event = clonedEvent.nodeId === undefined ? clonedEvent : { ...clonedEvent, nodeId: pick(rng, BOGUS_NODE_IDS) };
        break;
      }
      case 3: {
        strategyName = "duplicate-eventId";
        const knownIds = [...source.snapshot.appliedEventIds, ...source.snapshot.emittedEventIds];
        event = knownIds.length === 0 ? clonedEvent : { ...clonedEvent, eventId: pick(rng, knownIds) };
        break;
      }
      case 4: {
        strategyName = "producer-swap";
        event = { ...clonedEvent, producer: pick(rng, ["human", "trigger", "control-plane", "backend:local"] as const) };
        break;
      }
      default: {
        strategyName = "garbage-object";
        event = { not: "an envelope", junk: [1, 2, 3], sourceEventType: clonedEvent.eventType } as unknown as Envelope;
        break;
      }
    }
    out.push({
      label: `mutated#${i}:${strategyName}@${source.label}`,
      snapshot: source.snapshot,
      event,
      ctx: source.ctx,
    });
  }
  return out;
}

/** The full generated pool this A3 property test runs its three checks over. */
export function buildTriplePool(rng: () => number, mutatedCount = 30): Triple[] {
  const { triples: base, afterSnapshots } = buildBaseTriples(rng);

  // A couple of genuine `transition(null, ...)` triples belong in the pool too (`transition`'s
  // own signature is `RunSnapshot | null`) — `scenarioDedupeSkip`/`-MinIntervalSkip`/
  // `-RunsPerWindowSkip` above already contribute three (their only step starts from `null`).

  // A real duplicate: replay `run-requested`'s own eventId against the snapshot it already
  // produced (not the pre-step `null` a fresh pool triple would give it) -> kind "duplicate".
  const runRequestedTriple = base.find((t) => t.event.eventType === "run-requested" && t.snapshot === null);
  const duplicates: Triple[] = [];
  if (runRequestedTriple) {
    const afterRunRequested = afterSnapshots.find((s) => s.appliedEventIds.includes(runRequestedTriple.event.eventId));
    if (afterRunRequested) {
      duplicates.push({ label: "duplicate-replay:run-requested", snapshot: afterRunRequested, event: runRequestedTriple.event, ctx: runRequestedTriple.ctx });
    }
  }

  // I-13's own shape (a garbage object against a real, non-terminal mid-run snapshot) — folded in
  // here too rather than only via the random mutation layer, so it is always present regardless
  // of what `rng` happens to draw.
  const midRun = afterSnapshots.find((s) => s.status === "RUNNING");
  const garbage: Triple[] = midRun
    ? [{ label: "garbage-envelope@mid-run", snapshot: midRun, event: { not: "an envelope" } as unknown as Envelope, ctx: ctxAt("2026-09-06T09:00:00.000Z", REFERENCE_LOOP) }]
    : [];

  const mutated = buildMutatedTriples(rng, base, mutatedCount);

  return [...base, ...duplicates, ...garbage, ...mutated];
}

// -------------------------------------------------------------------------------------------
// Clone / freeze helpers
// -------------------------------------------------------------------------------------------

/** Round-trips `value` through this codebase's own canonical serialiser
 * (`util/canonical-json.ts`) — already this suite's standard tool for "byte for byte" snapshot
 * comparisons — producing an independent deep copy sharing no references with the original. */
function cloneViaCanonicalJson<T>(value: T): T {
  return parseJson(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// -------------------------------------------------------------------------------------------
// The three property checks
// -------------------------------------------------------------------------------------------

export interface CheckSummary {
  checked: number;
}

/** A3 clause 1: "same inputs, same outputs." Each triple is called twice on independently cloned
 * snapshot/event objects (never the same object reference for both calls, so this cannot pass
 * merely because both calls happened to share — and jointly mutate — one object) against the same
 * `ctx`, and the two `TransitionResult`s must be byte-identical. */
export function checkDeterminism(triples: readonly Triple[], seed: number): CheckSummary {
  let checked = 0;
  for (const t of triples) {
    const snapshotA = t.snapshot === null ? null : cloneViaCanonicalJson(t.snapshot);
    const snapshotB = t.snapshot === null ? null : cloneViaCanonicalJson(t.snapshot);
    const resultA = transition(snapshotA, cloneViaCanonicalJson(t.event), t.ctx);
    const resultB = transition(snapshotB, cloneViaCanonicalJson(t.event), t.ctx);
    assert.equal(canonicalJson(resultA), canonicalJson(resultB), `[seed=${seed}] ${t.label}: transition() returned different results for identical (snapshot, event, ctx) inputs — rerun with mulberry32(${seed}) to reproduce`);
    checked++;
  }
  return { checked };
}

/** A3 clause 2: "no I/O" as it bears on the inputs — `transition` must not modify the snapshot or
 * event it is given. Both proof shapes the task names, applied together (see this file's header
 * comment for why the frozen-clone half also catches a mutation that throws internally). */
export function checkNoMutation(triples: readonly Triple[], seed: number): CheckSummary {
  let checked = 0;
  for (const t of triples) {
    const beforeSnapshotJson = t.snapshot === null ? null : canonicalJson(t.snapshot);
    const beforeEventJson = canonicalJson(t.event);

    const baselineResult = transition(t.snapshot, t.event, t.ctx);
    assert.equal(t.snapshot === null ? null : canonicalJson(t.snapshot), beforeSnapshotJson, `[seed=${seed}] ${t.label}: transition() mutated its snapshot input`);
    assert.equal(canonicalJson(t.event), beforeEventJson, `[seed=${seed}] ${t.label}: transition() mutated its event input`);

    const frozenSnapshot = t.snapshot === null ? null : deepFreeze(cloneViaCanonicalJson(t.snapshot));
    const frozenEvent = deepFreeze(cloneViaCanonicalJson(t.event));
    let frozenResult: TransitionResult;
    try {
      frozenResult = transition(frozenSnapshot, frozenEvent, t.ctx);
    } catch (err) {
      throw new Error(`[seed=${seed}] ${t.label}: transition() threw on frozen inputs instead of returning a TransitionResult (I-13 requires it never throw) — ${String(err)}`);
    }
    assert.equal(
      canonicalJson(frozenResult),
      canonicalJson(baselineResult),
      `[seed=${seed}] ${t.label}: transition() behaved differently against frozen (unmutable) inputs than against the real ones — consistent with a mutation attempt that was thrown, caught by transition()'s own try/catch, and reported as internal_invariant instead of escaping`,
    );
    checked++;
  }
  return { checked };
}

type Restorer = () => void;

function patchMethod(obj: object, key: string, onCall: (label: string) => void, label: string): Restorer {
  const target = obj as Record<string, unknown>;
  const original = target[key];
  if (typeof original !== "function") return () => {};
  target[key] = (...args: unknown[]) => {
    onCall(label);
    return (original as (...a: unknown[]) => unknown).apply(obj, args);
  };
  return () => {
    target[key] = original;
  };
}

function installIOGuards(violations: string[]): { restore: () => void } {
  const record = (label: string) => violations.push(label);
  const restorers: Restorer[] = [
    patchMethod(fs, "readFileSync", record, "fs.readFileSync"),
    patchMethod(fs, "readFile", record, "fs.readFile"),
    patchMethod(fs, "writeFileSync", record, "fs.writeFileSync"),
    patchMethod(fs, "writeFile", record, "fs.writeFile"),
    patchMethod(fs, "existsSync", record, "fs.existsSync"),
    patchMethod(fsPromises, "readFile", record, "fs/promises.readFile"),
    patchMethod(fsPromises, "writeFile", record, "fs/promises.writeFile"),
    patchMethod(childProcess, "spawn", record, "child_process.spawn"),
    patchMethod(childProcess, "spawnSync", record, "child_process.spawnSync"),
    patchMethod(childProcess, "exec", record, "child_process.exec"),
    patchMethod(childProcess, "execSync", record, "child_process.execSync"),
    patchMethod(childProcess, "execFile", record, "child_process.execFile"),
    patchMethod(childProcess, "execFileSync", record, "child_process.execFileSync"),
    patchMethod(childProcess, "fork", record, "child_process.fork"),
    patchMethod(Math, "random", record, "Math.random"),
  ];

  // `Date`: a Proxy over the constructor catches both `Date.now()` (a `get` on `"now"` followed
  // by a call) and zero-argument `new Date()` (the `construct` trap) — `new Date(explicitMs)` /
  // `new Date(isoString)` pass straight through untouched, since those are pure parsing, not a
  // wall-clock read (see this file's header comment for the `classify.ts` example that must not
  // trip this guard).
  const RealDate = globalThis.Date;
  const GuardedDate = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) violations.push("new Date() (zero-argument, a wall-clock read)");
      return Reflect.construct(target, args, newTarget);
    },
    get(target, prop, receiver) {
      if (prop === "now") {
        return (...args: unknown[]) => {
          violations.push("Date.now()");
          return (target.now as (...a: unknown[]) => number)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  (globalThis as unknown as { Date: unknown }).Date = GuardedDate;
  restorers.push(() => {
    (globalThis as unknown as { Date: unknown }).Date = RealDate;
  });

  return {
    restore: () => {
      for (const restore of restorers.reverse()) restore();
    },
  };
}

/** A3 clause 3: "no I/O." Every I/O surface `transition()`'s dependency graph could in principle
 * reach (see this file's header comment for what is and is not covered) is monkey-patched to
 * record a call rather than silently allow it, `transition()` is run over the whole generated
 * pool, and the guards are torn down again — success is an *empty* `violations` list, not merely
 * "the function returned something". */
export function checkNoIO(triples: readonly Triple[], seed: number): CheckSummary {
  const violations: string[] = [];
  const guard = installIOGuards(violations);
  try {
    for (const t of triples) {
      const snapshot = t.snapshot === null ? null : cloneViaCanonicalJson(t.snapshot);
      const event = cloneViaCanonicalJson(t.event);
      transition(snapshot, event, t.ctx);
      if (violations.length > 0) {
        throw new Error(`[seed=${seed}] ${t.label}: transition() reached I/O it must never reach: ${violations.join("; ")} — rerun with mulberry32(${seed}) to reproduce`);
      }
    }
  } finally {
    guard.restore();
  }
  return { checked: triples.length };
}
