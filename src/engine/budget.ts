// `preDispatch` (state-machine.md §11.2, D-19), the ordered budget/iteration check every
// dispatch decision runs before emitting `node-dispatched`, and the active/wait clock helpers of
// D-04 (§11.1: `maxRuntime` counts `activeMs`; human/quota/interrupted waits accumulate `waitMs`
// instead and are excluded).

import type { RetryEdge, ResolvedLoop, ResolvedNode } from "../types/loop.ts";
import type { EnginePolicy, Outcome, RunSnapshot, RunState } from "../types/state.ts";
import { parseRfc3339 } from "../util/time.ts";

// ---------------------------------------------------------------------------------------------
// preDispatch
// ---------------------------------------------------------------------------------------------

export type PreDispatchResult = { ok: true } | { ok: false; outcome: Outcome };

/**
 * The fixed, ordered check of §11.2 / D-19 (asserted by invariant I-20): loop-semantic outcomes
 * (the iteration budget, both the paid and the free half) are checked before resource outcomes
 * (tokens, unmeasured executions, wall clock, steps). Exactly one Outcome is ever produced for
 * one breach — the first check that fails short-circuits the rest.
 *
 * `edge` is the Retry Edge about to be traversed, when this dispatch is a Retry Edge target
 * (steps 1-2 are skipped, `ok`, when `edge` is `null` — the first dispatch of a normal node has
 * no edge to check). `node` is accepted per the specified signature but is not read by any of
 * the seven steps themselves (none of §11.2's checks are node-scoped) — kept for parity with the
 * spec's own `preDispatch(node, cycle, edge?)` signature and for a future per-node budget check.
 *
 * `free` (Decision (not in sheet), m1 — an addition to the spec's documented signature, not part
 * of it): true when the traversal about to be checked is a NO_PROGRESS free traversal (§6.6)
 * rather than a paid one. D-10 keeps `traversals[e]` and `freeTraversals[e]` as two *independent*
 * counters, each separately bounded by `maxIterations[e]` — "may not exceed", not "the sum may
 * not exceed". Without this flag, step 1 (the *paid* cap) would still block a free traversal once
 * the paid counter alone had already reached `maxIterations`, even though the free counter itself
 * was still zero — collapsing the two budgets into one and making D-10's own free-traversal cap
 * unreachable on its own terms whenever the paid cap happens to already be exhausted. **Report**:
 * the spec's own `preDispatch(node, cycle, edge?)` signature has no way to express this
 * distinction; it should probably gain it.
 */
export function preDispatch(
  snapshot: RunSnapshot,
  loop: ResolvedLoop,
  node: ResolvedNode,
  cycleIndex: number,
  edge: RetryEdge | null,
  policy: EnginePolicy,
  free: boolean = false,
): PreDispatchResult {
  void node;
  void cycleIndex;

  // 1. Retry Edge iteration budget (paid traversals) — only when *this* traversal is itself paid.
  if (edge && !free) {
    const traversals = snapshot.traversals[edge.id] ?? 0;
    if (traversals >= edge.maxIterations) {
      return { ok: false, outcome: { state: "MAX_ITERATIONS_EXCEEDED", edgeId: edge.id, traversals, maxIterations: edge.maxIterations } };
    }
  }

  // 2. Retry Edge iteration budget (free / NO_PROGRESS traversals, D-10).
  if (edge) {
    const freeTraversals = snapshot.freeTraversals[edge.id] ?? 0;
    if (freeTraversals >= edge.maxIterations) {
      return { ok: false, outcome: { state: "MAX_ITERATIONS_EXCEEDED", edgeId: edge.id, traversals: freeTraversals, maxIterations: edge.maxIterations } };
    }
  }

  // 3. Measured token budget.
  if (loop.budget.maxMeasuredTokens !== undefined && snapshot.budget.measuredTokens >= loop.budget.maxMeasuredTokens) {
    return {
      ok: false,
      outcome: { state: "BUDGET_EXCEEDED", budgetKey: "maxMeasuredTokens", limit: loop.budget.maxMeasuredTokens, observed: snapshot.budget.measuredTokens },
    };
  }

  // 4. Unmeasured-execution budget. Amendment (m0+), 2026-09-07 (state-machine.md §11.2 step 4):
  // reads `>`, not the pre-amendment JSON's literal `>=`. `maxUnmeasuredExecutions` defaults to 0
  // loop-wide (loop-file.md §7.2: "no MVP backend declares usage: none" — no MVP-reachable
  // backend ever produces an unmeasured execution at all), and `snapshot.budget.unmeasuredExecutions`
  // starts at 0 too; `>=` would make step 4 breach on the *very first* dispatch of *every* MVP Run
  // regardless of what actually happened (0 >= 0), which cannot be intended — it would make
  // `preDispatch` reject the reference loop's entry node before a single event, measured or not,
  // has ever occurred. `>` keeps the "check before dispatch, never kill work in flight" reading
  // intact: a Run whose unmeasured count has *already reached* the configured cap (an unmeasured
  // execution the *previous* dispatch produced) is refused on the *next* one, exactly the "the
  // offending execution already completed by the time the check fires" shape steps 3/5/6 share,
  // but a cap of 0 no longer means "reject the first dispatch of any kind".
  if (snapshot.budget.unmeasuredExecutions > loop.budget.maxUnmeasuredExecutions) {
    return {
      ok: false,
      outcome: {
        state: "BUDGET_EXCEEDED",
        budgetKey: "maxUnmeasuredExecutions",
        limit: loop.budget.maxUnmeasuredExecutions,
        observed: snapshot.budget.unmeasuredExecutions,
      },
    };
  }

  // 5. maxRuntime (active clock only, D-04).
  if (snapshot.budget.activeMs >= loop.budget.maxRuntimeMs) {
    return { ok: false, outcome: { state: "EXPIRED", expiryReason: "max_runtime" } };
  }

  // 6. maxStepsPerRun (engine policy, not loop-file configurable — D-28).
  if (snapshot.budget.stepsUsed >= policy.maxStepsPerRun) {
    return {
      ok: false,
      outcome: { state: "BUDGET_EXCEEDED", budgetKey: "maxStepsPerRun", limit: policy.maxStepsPerRun, observed: snapshot.budget.stepsUsed },
    };
  }

  // 7. ok.
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Active / wait clock (D-04)
// ---------------------------------------------------------------------------------------------

export type ClockBucket = "active" | "wait" | "none";

/** state-machine.json `machines.run.states.*.clock`, transcribed: `PENDING`, `RUNNING` and
 * `WAITING_OBSERVED` accrue `activeMs`; `WAITING_HUMAN`, `WAITING_FOR_QUOTA` and `INTERRUPTED`
 * accrue `waitMs`; every terminal state stops the clock entirely. */
export function clockBucketFor(status: RunState): ClockBucket {
  switch (status) {
    case "PENDING":
    case "RUNNING":
    case "WAITING_OBSERVED":
      return "active";
    case "WAITING_HUMAN":
    case "WAITING_FOR_QUOTA":
    case "INTERRUPTED":
      return "wait";
    default:
      return "none";
  }
}

/**
 * D-04: the elapsed time between `snapshot.updatedAt` (the instant the last *applied* event set
 * the clock running from) and `now` (`ctx.now` of the event about to be applied), added to
 * `activeMs` or `waitMs` depending on which bucket `snapshot.status` — the state being left —
 * falls into. Only `transition.ts` calls this, and only for an event about to be `applied`: an
 * `ignored-stale` event never advances `updatedAt` (D-20 permits no control-field change beyond
 * the usage-ledger exception), so the elapsed span it would have contributed is picked up by
 * whichever later event actually applies.
 */
export function accrueClock(snapshot: RunSnapshot, now: string): { activeMs: number; waitMs: number } {
  const elapsedMs = Math.max(0, parseRfc3339(now) - parseRfc3339(snapshot.updatedAt));
  const bucket = clockBucketFor(snapshot.status);
  return {
    activeMs: snapshot.budget.activeMs + (bucket === "active" ? elapsedMs : 0),
    waitMs: snapshot.budget.waitMs + (bucket === "wait" ? elapsedMs : 0),
  };
}
