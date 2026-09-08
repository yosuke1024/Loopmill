// The sweep every entrypoint runs first (mvp-design.md §7.5, §10.2 of state-machine.md): scans
// the store for expired leases, turns each into a `lease-expired` envelope, applies it through
// `transition()`, and persists the result. Re-dispatch after an interruption (`resume --due`) is
// m2's job — this module only records what happened and returns the resulting action for the
// caller to observe, it never performs one.
//
// Decision (not in sheet), m1: `docs/design/m1-plan.md`'s brief for this file also asks for
// `node-timed-out{human_timeout}` (a pending approval past its `expiresAt`) and
// `run-finished(EXPIRED, max_runtime)` sweep-driven events (state-machine.md §10.2's other two
// bullets). Neither has an entry point the engine exposes to *this* module the way
// `StateStore.sweep()` does for the lease case: `store.sweep()` only ever reports expired
// `locks` rows (state-machine.md §10.1's attempt lease doubles as the `local` backend's Run
// lock), and there is no equivalent store scan for "every `pendingApproval` whose `expiresAt`
// has passed" or "every `RUNNING` Run whose active clock has passed `maxRuntime`" — both would
// need a query the store does not offer (`src/store/sqlite.ts` is out of this agent's files to
// add one to). **Report**: `StateStore`/`SqliteStore` should gain a query for runs with a
// `pendingApproval.expiresAt` in the past and one for runs whose accrued `budget.activeMs` (which
// only `transition()` can recompute, since it depends on the clock-bucket rule of D-04) has
// crossed `loop.budget.maxRuntimeMs`, so this module can emit those two sweep events the way it
// already does for `lease-expired`. Until then this module implements only the lease case.

import { transition, type EngineTransitionContext } from "../engine/index.ts";
import type { EnginePolicyFull } from "../engine/index.ts";
import { makeEnvelope } from "../envelope/index.ts";
import type { AppendInput } from "../types/interfaces.ts";
import type { ResolvedLoop } from "../types/loop.ts";
import type { Action, RunSnapshot } from "../types/state.ts";
import type { SqliteStore } from "../store/index.ts";
import type { Clock } from "./context.ts";
import { newlyTerminalAttempts } from "./attempts.ts";

export interface RunSweepOptions {
  store: SqliteStore;
  clock: Clock;
  /** Resolves the `ResolvedLoop` an expired lease's `loopId` belongs to, or `null` when this
   * process does not have that loop loaded (e.g. `status`/`runs` sweeping every loop in the
   * store, not just the one the current command targets) — such a row is reported but not acted
   * on at all: neither the `lease-expired` event nor the lock's release, so the row survives for
   * a process that does have the loop loaded to handle. */
  loops: (loopId: string) => ResolvedLoop | null;
  policy: EnginePolicyFull;
}

export interface SweepOutcome {
  runId: string;
  loopId: string;
  /** `false` when the loop could not be resolved, the run had no snapshot to fold against, or
   * the resulting transition was `invalid` — only the journal write did not happen. What became
   * of the `locks` row is `lockReleased`, decided per outcome by `releaseIfIdle` below. */
  applied: boolean;
  /** True iff this sweep deleted the run's `locks` row. The row is released exactly when nothing
   * holds it any more — the resulting snapshot has no lease (parked, terminal, or attempts
   * exhausted), or the row outlived its Run's own bookkeeping (§10.1) — and kept in every other
   * case, so that a re-dispatching transition's fresh lease stays visible to the next sweep. */
  lockReleased: boolean;
  /** What the resulting `transition()` call described `run`/`resume` should do next — recorded,
   * never performed here (`docs/design/m1-plan.md`: "record the resulting action in the returned
   * list without performing it"). May be empty when the lease-expired event could not be applied,
   * or (m1's engine) when `transition()` does not yet populate `actions` for this branch —
   * `driver/run.ts` does not depend on this field for its own control flow; see its own note on
   * why it reads the resulting snapshot instead. */
  actions: Action[];
  skipReason?: "loop_unresolved" | "no_snapshot" | "invalid";
}

/**
 * Runs the sweep once: `store.sweep(now)`, then for each expired lease builds and applies a
 * `lease-expired{reason: attempt_deadline}` envelope with the run's own coordinates. Every
 * entrypoint (`run`, `step`'s own sweep flag, `status`, `runs`, `doctor`) calls this exactly once
 * per invocation (mvp-design.md §7.5: "the sweep runs first, everywhere" — not once per event).
 */
export function runSweep(opts: RunSweepOptions): SweepOutcome[] {
  const now = opts.clock.now();
  const expired = opts.store.sweep(now);
  const outcomes: SweepOutcome[] = [];

  /** `store.sweep()` is read-only (see its own doc comment): releasing the row is this module's
   * decision, and it turns on one question only — does anything still hold this lease? A `null`
   * lease on the resulting snapshot means nothing does (R-32 parked the Run `INTERRUPTED`, or the
   * attempts were exhausted into a terminal state), so the row is deleted and the loop is free. A
   * non-`null` lease means the transition installed a fresh attempt (R-31's auto-retry of an
   * `effects: none` node), and the row must survive to carry it: `append` has just refreshed the
   * same row's `lease_until`, and that row is what the next sweep will find when this attempt in
   * turn goes unanswered — deleting it here is exactly the orphaning defect this module was fixed
   * for on 2026-09-08. `releaseLock` only deletes a row still owned by `runId`, so a lease another
   * process has since taken over is never disturbed. */
  const releaseIfIdle = (loopId: string, runId: string, lease: RunSnapshot["lease"]): boolean => {
    if (lease !== null) return false;
    opts.store.releaseLock(loopId, runId);
    return true;
  };

  for (const item of expired) {
    if (item.nodeId === null || item.cycleIndex === null || item.attempt === null) {
      // state-machine.md §10.1: "a lock outliving its Run's own bookkeeping" — the snapshot had
      // no attempt in flight at all. Nothing to build a node-level lease-expired event from, and
      // nothing holds the lease either, so the row is garbage and goes.
      opts.store.releaseLock(item.loopId, item.runId);
      outcomes.push({ runId: item.runId, loopId: item.loopId, applied: false, actions: [], lockReleased: true, skipReason: "no_snapshot" });
      continue;
    }

    const loop = opts.loops(item.loopId);
    if (!loop) {
      // Not this process's loop to act on: leave the row for one that has it loaded.
      outcomes.push({ runId: item.runId, loopId: item.loopId, applied: false, actions: [], lockReleased: false, skipReason: "loop_unresolved" });
      continue;
    }

    const snapshot = opts.store.read(item.runId);
    if (!snapshot) {
      opts.store.releaseLock(item.loopId, item.runId);
      outcomes.push({ runId: item.runId, loopId: item.loopId, applied: false, actions: [], lockReleased: true, skipReason: "no_snapshot" });
      continue;
    }

    const envelope = makeEnvelope(
      {
        eventType: "lease-expired",
        producer: "control-plane",
        loopId: item.loopId,
        loopVersion: snapshot.loopVersion,
        runId: item.runId,
        cycle: item.cycleIndex,
        nodeId: item.nodeId,
        attempt: item.attempt,
        reason: "attempt_deadline",
      },
      { now },
    );

    const ctx: EngineTransitionContext = { loop, policy: opts.policy, now };
    const result = transition(snapshot, envelope, ctx);

    if (result.kind === "invalid") {
      // Nothing was applied, so nothing about the lease changed: keep the row rather than drop a
      // Run this sweep could not act on. It will be reported again, which is the point —
      // mvp-design.md §17.4's rule is that a broken Run is loud, never silent.
      outcomes.push({ runId: item.runId, loopId: item.loopId, applied: false, actions: [], lockReleased: false, skipReason: "invalid" });
      continue;
    }
    if (result.kind === "duplicate") {
      // P-4: nothing to persist; the run already recorded this exact lease-expired delivery. The
      // row can still be stale relative to that earlier application — release it iff the snapshot
      // that application produced holds no lease.
      const released = releaseIfIdle(item.loopId, item.runId, snapshot.lease);
      outcomes.push({ runId: item.runId, loopId: item.loopId, applied: false, actions: [], lockReleased: released });
      continue;
    }

    const appendInput: AppendInput = {
      applied: envelope,
      appliedKind: result.kind === "ignored-stale" ? "ignored" : "applied",
      emitted: result.emitted,
      snapshot: result.snapshot,
      attempts: newlyTerminalAttempts(snapshot, result.snapshot),
      lease: result.snapshot.lease,
      now,
    };
    opts.store.append(item.runId, appendInput);

    const released = releaseIfIdle(item.loopId, item.runId, result.snapshot.lease);

    outcomes.push({
      runId: item.runId,
      loopId: item.loopId,
      applied: result.kind === "applied",
      actions: result.kind === "applied" ? result.actions : [],
      lockReleased: released,
    });
  }

  return outcomes;
}
