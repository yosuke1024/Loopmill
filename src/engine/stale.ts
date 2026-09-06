// The O-3 stale test (state-machine.md §5.5), the P-4 duplicate test, and P-3 step 1's
// against-the-run validation (producer policy, loopId/loopVersion match, unknown nodeId, R-56).
// Pure: everything here is a function of `(snapshot, event, loop)` only.

import { isNodeLevelEvent } from "../types/envelope.ts";
import type { Envelope } from "../types/envelope.ts";
import type { ResolvedLoop } from "../types/loop.ts";
import type { RunSnapshot, StaleReason, ValidationError } from "../types/state.ts";
import { producerAllowed } from "../envelope/policy.ts";
import { isTerminalRun, nodeKey, terminalEventKey } from "./snapshot.ts";

/** P-4 / R-54: `event.eventId ∈ appliedEventIds ∪ ignoredEventIds ∪ emittedEventIds`. Checked
 * before every other test — a byte-identical redelivery is `duplicate`, never `ignored-stale`. */
export function checkDuplicate(snapshot: RunSnapshot, event: Envelope): boolean {
  return (
    snapshot.appliedEventIds.includes(event.eventId) ||
    snapshot.ignoredEventIds.includes(event.eventId) ||
    snapshot.emittedEventIds.includes(event.eventId)
  );
}

/**
 * P-3 step 1: everything that makes an envelope `invalid` (exit 2) rather than merely stale —
 * checked, and short-circuited, before `staleReasonFor`. Callers must call `checkDuplicate`
 * first (P-4 outranks both `invalid` and `ignored-stale`; state-machine.md §5.2 lists the P-3
 * order as 1. invalid, 2. ignored-stale, with duplicate handled by the caller ahead of both —
 * see `transition.ts`'s own ordering comment for the full chain including R-53's terminal-first
 * rule).
 *
 * - producer policy (R-56 and every other row's implicit producer allowlist, envelope/policy.ts
 *   `producerAllowed`, state-machine.md §3.2);
 * - `loopId`/`loopVersion` match the pinned Run (a mismatched pin can never be folded into this
 *   Run's history without corrupting it);
 * - a `nodeId` that does not exist anywhere in the pinned loop (distinct from `stale.ts`'s own
 *   "unknown_node" `StaleReason`, which means "exists in the loop, but is not the node currently
 *   in flight" — P-3 step 1's failure mode is "this loop has no such node at all").
 */
export function validateAgainstRun(snapshot: RunSnapshot, event: Envelope, loop: ResolvedLoop): ValidationError | null {
  if (event.loopId !== snapshot.loopId) {
    return { code: "loop_id_mismatch", message: `event.loopId ${JSON.stringify(event.loopId)} does not match the pinned Run`, path: "/loopId" };
  }
  if (event.loopVersion !== snapshot.loopVersion) {
    return {
      code: "loop_version_mismatch",
      message: `event.loopVersion ${JSON.stringify(event.loopVersion)} does not match the pinned Run`,
      path: "/loopVersion",
    };
  }
  if (!producerAllowed(event.eventType, event.producer)) {
    return {
      code: "producer_not_allowed",
      message: `producer ${JSON.stringify(event.producer)} is not allowed for eventType ${JSON.stringify(event.eventType)}`,
      path: "/producer",
    };
  }
  if (event.nodeId !== undefined && !Object.prototype.hasOwnProperty.call(loop.nodes, event.nodeId)) {
    return { code: "unknown_node", message: `nodeId ${JSON.stringify(event.nodeId)} does not exist in this loop`, path: "/nodeId" };
  }
  return null;
}

/**
 * The full stale test: R-51..R-55 (Run-level: `run_already_started`, `run_not_started`,
 * `run_terminal`), O-3 (per-node: `unknown_node`, `stale_cycle`/`future_cycle`,
 * `stale_attempt`/`future_attempt`, `node_terminal`), and the event-type-specific guards named
 * in state-machine.md §10.1 (`wrong_wait_state`, `lease_not_expired` for `lease-expired`), §7.5/
 * R-42 (`not_due` for `resumed`) and §8.2/R-38 (`approval_subject_mismatch` for `human-decided`).
 * Returns `null` when the event is not stale by any of these tests (it may still be `invalid` —
 * call `validateAgainstRun` first — or genuinely applicable). Assumes `snapshot` is non-null
 * (the `∅` case is R-01..R-04, handled directly by `transition.ts`) and that `checkDuplicate` has
 * already ruled out an exact `eventId` redelivery (O-6 / R-53's own text: "not an exact eventId
 * duplicate").
 */
export function staleReasonFor(snapshot: RunSnapshot, event: Envelope, loop: ResolvedLoop): StaleReason | null {
  // O-6 / R-53: terminal beats everything.
  if (isTerminalRun(snapshot.status)) {
    return "run_terminal";
  }

  // R-52: while PENDING, only run-started and run-finished are expected. Read literally: a
  // second run-requested delivered before the Run has actually started falls under this rule
  // too (state-machine.md's own text: "any except run-started, run-finished").
  if (snapshot.status === "PENDING" && event.eventType !== "run-started" && event.eventType !== "run-finished") {
    return "run_not_started";
  }

  // R-51: a second run-requested for a Run that has already left PENDING.
  if (event.eventType === "run-requested" && snapshot.status !== "PENDING") {
    return "run_already_started";
  }

  if (event.eventType === "resumed") {
    return staleForResumed(snapshot, event);
  }

  if (event.eventType === "lease-expired") {
    return staleForLeaseExpired(snapshot, event);
  }

  // P-5: a *different* eventId carrying a (nodeId, cycle, attempt, eventType) tuple already
  // recorded as terminal is `semantic_duplicate` — checked before O-3's `current`-relative test
  // (which would otherwise report `unknown_node`/`node_terminal` depending on whether the Run has
  // already moved past that node, an accident of timing P-5 is explicitly meant not to depend
  // on: "This catches a backend that reports twice with fresh ids"). `human-decided` never
  // produces a `node-completed`-shaped terminal event key of its own (it drives N-26..N-28, whose
  // terminal record is `human-decided` itself under the node's `(cycle, nodeId, attempt: 0)`), so
  // this check applies to it too, ahead of `staleForHumanDecided`'s digest check.
  if (isNodeLevelEvent(event.eventType) && isSemanticDuplicate(snapshot, event)) {
    return "semantic_duplicate";
  }

  if (event.eventType === "human-decided") {
    const nodeStale = staleForNodeLevel(snapshot, event);
    if (nodeStale) return nodeStale;
    return staleForHumanDecided(snapshot, event);
  }

  if (isNodeLevelEvent(event.eventType)) {
    return staleForNodeLevel(snapshot, event);
  }

  // run-started / run-finished (inbound only from the sweep's own re-drive, or never at all):
  // no additional test here.
  return null;
}

/** O-3, the ordered per-node test (state-machine.md §5.5). */
/** P-5: is `(event.cycle, event.nodeId, event.attempt, event.eventType)` already recorded as a
 * terminal fact (`snapshot.terminalEventKeys`)? Only meaningful for node-level events, all of
 * which carry the three coordinates together (schema-enforced). */
function isSemanticDuplicate(snapshot: RunSnapshot, event: Envelope): boolean {
  if (event.cycle === undefined || event.nodeId === undefined || event.attempt === undefined) return false;
  const key = terminalEventKey(event.cycle, event.nodeId, event.attempt, event.eventType);
  return snapshot.terminalEventKeys.includes(key);
}

function staleForNodeLevel(snapshot: RunSnapshot, event: Envelope): StaleReason | null {
  const cur = snapshot.current;
  if (!cur) {
    return "no_attempt_in_flight";
  }
  if (event.nodeId !== cur.nodeId) {
    return "unknown_node";
  }
  const eventCycle = event.cycle;
  const eventAttempt = event.attempt;
  if (eventCycle !== undefined) {
    if (eventCycle < cur.cycleIndex) return "stale_cycle";
    if (eventCycle > cur.cycleIndex) return "future_cycle";
  }
  if (eventAttempt !== undefined) {
    if (eventAttempt < cur.attempt) return "stale_attempt";
    if (eventAttempt > cur.attempt) return "future_attempt";
  }
  const nodeExec = snapshot.nodes[nodeKey(cur.cycleIndex, cur.nodeId)];
  if (nodeExec && isTerminalNodeState(nodeExec.state)) {
    return "node_terminal";
  }
  return null;
}

function isTerminalNodeState(state: string): boolean {
  return (
    state === "SUCCEEDED" ||
    state === "FAILED" ||
    state === "TIMED_OUT" ||
    state === "CANCELLED" ||
    state === "SKIPPED" ||
    state === "NO_PROGRESS"
  );
}

/** state-machine.md §8.2/R-38: `human-decided.human.subjectDigest` must equal
 * `pendingApproval.subject.digest`. Only meaningful once the node-level O-3 test already passed
 * (the caller runs it first). */
function staleForHumanDecided(snapshot: RunSnapshot, event: Envelope): StaleReason | null {
  const pending = snapshot.pendingApproval;
  const digest = event.human?.subjectDigest;
  if (!pending || pending.subject.digest !== digest) {
    return "approval_subject_mismatch";
  }
  return null;
}

/** state-machine.md §10.1: `lease-expired` is checked against `snapshot.lease` directly, before
 * falling back to the generic per-node O-3 test for a `lease-expired` that names a superseded
 * attempt. */
function staleForLeaseExpired(snapshot: RunSnapshot, event: Envelope): StaleReason | null {
  if (snapshot.lease === null) {
    return "wrong_wait_state";
  }
  // ctx.now is not available here by design (guards never read event.occurredAt, O-2, and this
  // module takes no `now` — `transition.ts` re-checks `ctx.now >= lease.expiresAt` itself before
  // treating a lease-expired as applicable; this function only rules out the two cases that do
  // not need the clock at all: no lease, or an attempt that is not the one currently in flight).
  return staleForNodeLevel(snapshot, event);
}

/** state-machine.md §7.5/R-42: `resumed` carries no node coordinates (it is Run-scoped, not in
 * `NODE_LEVEL_EVENT_TYPES`); its own stale test is about which wait state the Run is in. The
 * `not_due` half (`resume.kind === 'due'` delivered before `quota.resumeDueAt`) needs `ctx.now`
 * and is re-checked by `transition.ts`, same as the lease-expired clock check above. */
function staleForResumed(snapshot: RunSnapshot, event: Envelope): StaleReason | null {
  const kind = event.resume?.kind;
  if (kind === "due" || kind === "manual") {
    if (snapshot.status !== "WAITING_FOR_QUOTA") {
      return "wrong_wait_state";
    }
    return null; // `not_due` needs ctx.now; transition.ts checks it.
  }
  if (kind === "interrupted") {
    if (snapshot.status !== "INTERRUPTED") {
      return "wrong_wait_state";
    }
    return null;
  }
  return "unknown_event_type";
}
