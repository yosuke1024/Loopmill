// Shared helper: which `AttemptRecord`s a transition's resulting snapshot should be persisted
// into the store's `attempts` table (mvp-design.md §9.1: "insert only" — `store/sqlite.ts`'s
// `append` throws `attempt_record_conflict` if the same `(cycle, nodeId, attempt)` key is ever
// written twice with *different* content, and treats an identical re-write as a no-op).
//
// Decision (not in sheet), m1: `TransitionResult` carries no separate "which attempts changed"
// field — only the new `RunSnapshot`, whose own `attempts` map already holds every attempt this
// Run has ever seen, in whatever state it currently has (`DISPATCHED` while in flight,
// `COMPLETED`/`FAILED`/`LOST` once terminal). Since the table is insert-only-or-identical, this
// module only ever proposes a *terminal* attempt record for persistence, and only the first time
// it observes that attempt turn terminal (comparing against the snapshot the transition started
// from) — a `DISPATCHED` record is never written to the table at all (it lives in the
// `snapshots` row instead, which is rewritten wholesale every transaction). This also means a
// later correction to an already-terminal attempt's usage (state-machine.md §5.4/D-20: an
// `ignored-stale` event may still backfill a `LOST` attempt's usage from a late report) is
// **not** re-persisted here — doing so would hit the store's own conflict check, since the
// content differs from what was already written. The corrected figure still lives in the
// authoritative place (`snapshot.attempts`, inside the `snapshots` table, rewritten every
// transaction) — `report.ts`/`status.ts` read attempt usage from the snapshot, never from
// `store.readAttempts()`, so nothing downstream ever sees the stale table row instead of the
// corrected one. **Report**: `mvp-design.md` §9.1 calls the `attempts` table "insert only" but
// state-machine.md §5.4 describes a case that updates an already-inserted attempt's usage; the
// two are reconcilable (as done here) only by treating the table as a write-once audit copy and
// the snapshot as the field of record, which is worth confirming against the maintainer's intent.

import type { AttemptRecord, AttemptState, RunSnapshot } from "../types/state.ts";

const TERMINAL_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set(["COMPLETED", "FAILED", "LOST"]);

function isTerminalAttempt(state: AttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.has(state);
}

/** Every attempt in `next.attempts` that just became terminal in this transition — present (in
 * any state) in `next` but either absent from `prev` or not yet terminal there. `prev === null`
 * (the very first event of a Run, `run-requested`) treats every terminal attempt in `next` as
 * newly terminal, which is vacuously correct: nothing could have been terminal before the Run
 * existed. */
export function newlyTerminalAttempts(prev: RunSnapshot | null, next: RunSnapshot): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  const entries = Object.entries(next.attempts) as Array<[`${number}:${string}:${number}`, AttemptRecord]>;
  for (const [key, record] of entries) {
    if (!isTerminalAttempt(record.state)) continue;
    const before = prev?.attempts[key];
    if (before && isTerminalAttempt(before.state)) continue;
    out.push(record);
  }
  return out;
}
