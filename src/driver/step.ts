// `loopmill step`: applies exactly one Envelope to one Run (mvp-design.md §7.1, §7.2;
// state-machine.md §12.1). The sweep runs first (once), then the snapshot is read (or treated as
// absent for a `run-requested`), `transition()` is called, and the result is persisted per its
// kind — `duplicate` persists nothing (P-4). This is also the low-level "apply one envelope"
// primitive `run.ts`'s own dispatch loop and `gates.ts`'s `human-decided` both call, with the
// sweep and the loop-level lock check turned off (`sweepFirst`/`skipLockCheck`): those two
// callers already ran the sweep once for their whole entrypoint (mvp-design.md §7.5: "the sweep
// runs first, everywhere" — once per entrypoint invocation, not once per event) and already hold
// the loop's lock themselves, so re-checking either per event would be redundant at best and
// self-deadlocking at worst (a process cannot be "another live process" holding its own lock).

import { parseRfc3339 } from "../util/time.ts";
import { LoopmillError } from "../util/errors.ts";
import { DEFAULT_POLICY_FULL, isTerminalRun, transition, type EngineTransitionContext, type EnginePolicyFull } from "../engine/index.ts";
import type { Envelope } from "../types/envelope.ts";
import type { TransitionResult } from "../types/state.ts";
import type { RunContext, Clock } from "./context.ts";
import { runSweep, type SweepOutcome } from "./sweep.ts";
import { newlyTerminalAttempts } from "./attempts.ts";
import { writeRunReport } from "./report.ts";

export interface ApplyStepInput {
  ctx: RunContext;
  envelope: Envelope;
  clock: Clock;
  /** Default `true`: run the sweep first, as every entrypoint must (mvp-design.md §7.5). Passed
   * `false` by `run.ts`/`gates.ts`, which already ran it once for the whole call. */
  sweepFirst?: boolean;
  /** Default `false`: refuse (exit 3) when the loop's `locks` row is held by another live
   * process (state-machine.md §12.1 code 3). Passed `true` by `run.ts`'s own dispatch loop and
   * by `gates.ts`'s continuation, both of which are that process. */
  skipLockCheck?: boolean;
  policy?: EnginePolicyFull;
  admission?: EngineTransitionContext["admission"];
}

export interface ApplyStepOutput {
  /** state-machine.md §12.1: `0` handled (`applied`/`duplicate`/`ignored-stale`), `1` unexpected
   * error (never returned here — an unexpected throw propagates to the caller, which is
   * `cli/main.ts`'s job to map), `2` invalid envelope or loop file, `3` state conflict (the
   * loop's lock is held elsewhere).
   *
   * §12.1's own table also lists a `4` ("backend dispatch failed. The state already records
   * `dispatch-failed`") — deliberately absent from this union. Decision (not in sheet), m1,
   * closing A12 (`docs/design/m1-plan.md` §5.1 flagged this exact mismatch: "`step`'s own
   * `applyStep` declares 4 in its return type but no branch returns it"): every branch below was
   * traced and none of them can produce it, because a standalone `loopmill step`
   * (`cli/main.ts`'s `cmdStep`, the only caller that hands this function an envelope read from
   * the outside world) never itself calls a `Dispatcher` — it only threads whatever envelope it
   * was given through `transition()` and the store, exactly once. A `dispatch-failed` envelope
   * arriving at `step` this way is applied like any other inbound completion (R-29/R-30 decide
   * retry vs. fail from the envelope's own coordinates, same as `applyRunningDispatchFailed` in
   * `engine/transition.ts`) — the dispatch that failed already happened somewhere else, before
   * this envelope existed, so its failure can never be *this call's own* failure to reach a
   * backend. Only `run.ts`'s dispatch loop (`continueRun`, shared with `gates.ts`'s
   * continuation) actually calls a `Dispatcher`, and it computes its own exit 4 at its own call
   * site (`run.ts:558`, matching state-machine.md §12.2's exit-code table for `run`) by
   * inspecting `completionEnvelope.eventType === "dispatch-failed"` directly — never by reading
   * it off this function's return value, which that same call site (`sweepFirst: false,
   * skipLockCheck: true`) only ever collapses to `0`/`2`/`3` regardless of what the applied
   * envelope's own `eventType` was. Narrowed here so the type matches what the code can actually
   * return, rather than leaving a fourth value nothing produces and only `cli/main.ts`'s own
   * exit-code passthrough could have silently gone on masking. **Report**: full §12.1 coverage
   * for `4` on `step` specifically would need this function itself to attempt a dispatch on
   * behalf of some future direct-dispatch mode — no such mode exists in m1, and building one is
   * outside this task's own file list (`step.ts`'s brief covers only the type it already
   * declares). */
  exitCode: 0 | 2 | 3;
  /** `null` only when `exitCode === 3` (the conflict was detected before `transition()` was ever
   * called, so there is no result to report). */
  result: TransitionResult | null;
  sweep?: SweepOutcome[];
}

/** `true` iff a `locks` row is still live at `now` (the same inclusive boundary
 * `state-machine.md` §10.1 and `store/sqlite.ts`'s `acquireLock`/`sweep` both use). */
function lockIsLive(now: string, leaseUntil: string): boolean {
  return parseRfc3339(now) < parseRfc3339(leaseUntil);
}

export function applyStep(input: ApplyStepInput): ApplyStepOutput {
  const { ctx } = input;
  const policy = input.policy ?? DEFAULT_POLICY_FULL;

  let sweep: SweepOutcome[] | undefined;
  if (input.sweepFirst !== false) {
    sweep = runSweep({
      store: ctx.store,
      clock: input.clock,
      loops: (loopId) => (loopId === ctx.loop.slug ? ctx.loop : null),
      policy,
    });
  }

  if (input.skipLockCheck !== true) {
    const now = input.clock.now();
    const lock = ctx.store.readLock(ctx.loop.slug);
    if (lock && lockIsLive(now, lock.leaseUntil)) {
      return { exitCode: 3, result: null, ...(sweep !== undefined ? { sweep } : {}) };
    }
  }

  const now = input.clock.now();
  const snapshot = ctx.store.read(input.envelope.runId);

  // A2: "a Run pins loopVersion; editing the file mid-Run does not change that Run's
  // behaviour." `ctx.loop` is reloaded from disk fresh every time a process opens a
  // `RunContext` (`context.ts`'s `openRunContext`), so a Run continued from a *separate*
  // process (`gates.ts`'s `decideGate`, or a bare `step`) after the loop file changed on disk
  // would otherwise silently route against a *different* node graph/env policy than the one
  // that dispatched its earlier cycles — the pinned `loopVersion` string alone
  // (`engine/stale.ts`'s `validateAgainstRun`) only catches this on the *next inbound envelope*,
  // as an `invalid` result with no explanation a caller can act on. Decision (not in sheet), m1:
  // refuse cleanly here, before ever calling `transition()`, rather than let the engine's own
  // check surface as an opaque `invalid`. **Report**: full A2 compliance — actually continuing a
  // Run under its *original* resolved loop rather than merely detecting drift — needs the loop
  // file's pinned content to be recoverable after it has changed on disk (e.g. archived
  // alongside the run header), which is outside `driver/`'s own files for this task.
  if (snapshot !== null && snapshot.loopVersion !== ctx.loop.loopVersion) {
    throw new LoopmillError(
      "loop_version_drifted",
      `run ${input.envelope.runId} was pinned to loopVersion ${snapshot.loopVersion}, but the loop file at ${ctx.loopPath} now resolves to ${ctx.loop.loopVersion} — refusing to continue against a different loop than the one this Run started with`,
      { exitCode: 2 },
    );
  }

  const transitionCtx: EngineTransitionContext = { loop: ctx.loop, policy, now };
  if (input.admission !== undefined) transitionCtx.admission = input.admission;

  const result = transition(snapshot, input.envelope, transitionCtx);

  if (result.kind === "invalid") {
    return { exitCode: 2, result, ...(sweep !== undefined ? { sweep } : {}) };
  }
  if (result.kind === "duplicate") {
    // P-4: nothing persisted.
    return { exitCode: 0, result, ...(sweep !== undefined ? { sweep } : {}) };
  }

  // applied | ignored-stale: persist. §17.4 "a fire that produced nothing": `run-requested`'s
  // `createRun` + `append` are the *first* transaction — done here, in that order, so a process
  // killed between them still leaves the store with either no run row at all or a fully applied
  // one, never a run row with no journal.
  if (snapshot === null && result.kind === "applied") {
    ctx.store.createRun({
      runId: input.envelope.runId,
      loopId: result.snapshot.loopId,
      loopVersion: result.snapshot.loopVersion,
      loopDigest: result.snapshot.loopDigest,
      trigger: result.snapshot.trigger,
      ...(result.snapshot.trigger.dedupeKey !== undefined ? { dedupeKey: result.snapshot.trigger.dedupeKey } : {}),
      createdAt: now,
    });
  }

  const attempts = newlyTerminalAttempts(snapshot, result.snapshot);
  const appended = ctx.store.append(input.envelope.runId, {
    applied: input.envelope,
    appliedKind: result.kind === "ignored-stale" ? "ignored" : "applied",
    emitted: result.emitted,
    snapshot: result.snapshot,
    attempts,
    lease: result.snapshot.lease,
    now,
  });

  if (!appended.ok) {
    // A concurrent writer beat this call to the same run's journal (a lost optimistic-
    // concurrency race, or a genuine duplicate `eventId` from two processes at once) — the
    // closest fit in §12.1's four-code table is "state conflict... retrying... converges".
    // `skipLockCheck` callers (run.ts's own loop, gates.ts) hold the loop's lock and are the
    // run's only writer, so this branch is store-level defence in depth for them, not a case
    // they are expected to hit.
    return { exitCode: 3, result, ...(sweep !== undefined ? { sweep } : {}) };
  }

  // Item 6: the run report is written on every terminal path, not only the one `continueRun`
  // (`run.ts`) happens to drive — a bare `loopmill step` that itself lands the terminal event
  // (e.g. re-ingesting an exported envelope, or a test driving the state machine one event at a
  // time) must produce the same `.loopmill/reports/<runId>.md`/`.json` a full `run`/`approve`/
  // `reject` would. `applied` only (never `ignored-stale`, which cannot itself cause a fresh
  // terminal transition — R-53 already refuses any event addressed to an already-terminal Run
  // before `transition()` ever reaches this point). Best-effort: a report that could not be
  // written must never turn an otherwise-successful step into a failure.
  if (result.kind === "applied" && isTerminalRun(result.snapshot.status)) {
    try {
      writeRunReport({ layout: ctx.layout, store: ctx.store, loop: ctx.loop, runId: input.envelope.runId, snapshot: result.snapshot });
    } catch {
      // best-effort, see above.
    }
  }

  return { exitCode: 0, result, ...(sweep !== undefined ? { sweep } : {}) };
}
