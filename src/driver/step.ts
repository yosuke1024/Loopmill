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
import { DEFAULT_POLICY_FULL, transition, type EngineTransitionContext, type EnginePolicyFull } from "../engine/index.ts";
import type { Envelope } from "../types/envelope.ts";
import type { TransitionResult } from "../types/state.ts";
import type { RunContext, Clock } from "./context.ts";
import { runSweep, type SweepOutcome } from "./sweep.ts";
import { newlyTerminalAttempts } from "./attempts.ts";

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
   * loop's lock is held elsewhere), `4` reserved for dispatch failures — not produced by `step`
   * in m1 (a `dispatch-failed` envelope reaches `step` as an ordinary inbound envelope like any
   * other; it does not carry its own step-level exit code). */
  exitCode: 0 | 2 | 3 | 4;
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

  return { exitCode: 0, result, ...(sweep !== undefined ? { sweep } : {}) };
}
