// The two ports the driver imports nothing else about the outside world through. Transcribed
// from docs/design/mvp-design.md §7.6 "Portability". No logic: `store/` implements
// `StateStore`, `backends/` implements `Dispatcher`; both refine the minimal request/response
// shapes defined here.
//
// `AppendResult`, `LeaseExpired` and `StateStore` below are the refined shapes `src/store/`
// actually needs (docs/design/m1-plan.md `store/` row); they replace the placeholder shapes
// this file originally carried. Two deviations from the illustrative §7.6 code block, both
// deliberate and both store/`SqliteStore`-driven:
//
//  1. `StateStore` is synchronous, not `Promise`-returning. `node:sqlite`'s `DatabaseSync` — the
//     MVP store's only implementation — is itself synchronous, and every `StateStore` method
//     body is one SQLite transaction that must run to completion without yielding to the event
//     loop (interleaving a partially-applied transaction with anything else touching the same
//     db is exactly what atomicity forbids, mvp-design.md §9.2). Wrapping an inherently
//     synchronous, single-threaded operation in `async` buys nothing but the appearance of
//     concurrency. The reserved git-branch store (SPIKE-3) is not foreclosed by this: its own
//     test harness already drives `git` synchronously (`spawnSync`), so a sync port stays
//     implementable there too.
//  2. `StateStore` keeps the original three-method roster (`read`, `append`, `sweep`) rather
//     than growing to match every public method `SqliteStore` exposes. `SqliteStore` is a
//     strict superset: `createRun`, `readRunHeader`, `readEvents`, `listRuns`, `readAttempts`,
//     `rebuildSnapshot`, `verifyChain`, the lock methods and `close` are store-specific
//     operational/tooling surface (CLI commands, gc, audits) that this milestone's `driver/`
//     module (not yet built) does not obviously need behind a backend-swappable port. Widening
//     `StateStore` to match is a call for whoever builds `driver/`, not this module.

import type { BackendCapabilities } from "./capabilities.ts";
import type { Envelope } from "./envelope.ts";
import type { AttemptRecord, Lease, RunSnapshot } from "./state.ts";

/** mvp-design.md §7.6 names the store's read/append shape `Snapshot`; it is `RunSnapshot`. */
export type Snapshot = RunSnapshot;

/** `StateStore.append`'s input: one inbound envelope (`applied`, or `null` for an append that
 * only records side-effect envelopes), the envelopes it caused (`emitted`), the new folded
 * snapshot, any attempt records the fold touched, an optional lease refresh, and the driver's
 * clock reading (`now`) for the rows' `recorded_at`/lock timestamps. */
export interface AppendInput {
  applied: Envelope | null;
  /** How the inbound envelope was disposed of by `transition()`: `applied` (default) or `ignored`
   *  (an `ignored-stale` result — the declined envelope is journaled too, so that `fold(events)` can
   *  replay it and reproduce `snapshot.ignoredEventIds`; state-machine.md §5.2 P-3, P-8). */
  appliedKind?: "applied" | "ignored";
  emitted: Envelope[];
  snapshot: RunSnapshot;
  attempts?: AttemptRecord[];
  lease?: Lease | null;
  now: string;
}

/** Result of `StateStore.append`. `ok: true` carries the seq range this call wrote (`firstSeq`
 * .. `lastSeq`) and the snapshot's new high-water mark (`snapshotOf` — see `store/sqlite.ts`'s
 * `append` doc comment for exactly what "matches" means for the conflict check below).
 * `ok: false` distinguishes the two ways an append is refused, both leaving the store
 * untouched: `duplicate_event_id` (a UNIQUE violation on `events(run_id, event_id)` — P-4 at
 * store level) names the colliding `eventId`; `seq_conflict` (the given snapshot's `snapshotOf`
 * does not match the store's current high-water mark for this run — an optimistic-concurrency
 * loss) does not, since no single event is at fault. */
export type AppendResult =
  | { ok: true; firstSeq: number; lastSeq: number; snapshotOf: number }
  | { ok: false; reason: "duplicate_event_id" | "seq_conflict"; eventId?: string };

/** The identity of whoever holds (or held) a `locks` row: `store/sqlite.ts`'s `acquireLock`
 * (the failure branch, and the `tookOverFrom` of a takeover) and `sweep` (`LeaseExpired.holder`)
 * both report it in this shape. */
export interface LockHolder {
  runId: string;
  ownerPid: number;
  host: string;
  heartbeatAt: string;
  leaseUntil: string;
}

/** One lease `StateStore.sweep` found expired and reported as lost (state-machine.md §10.2, D-29).
 * `nodeId`/`cycleIndex`/`attempt` come from the run's `snapshot.current` and are `null` when the
 * snapshot has no attempt in flight (a lock outliving its Run's own bookkeeping); `leaseUntil` is
 * the expired `locks` row's own `lease_until`; `holder` is that row's owner. The driver — not the
 * store, which never emits events itself — turns each of these into a `lease-expired` envelope. */
export interface LeaseExpired {
  runId: string;
  loopId: string;
  nodeId: string | null;
  cycleIndex: number | null;
  attempt: number | null;
  leaseUntil: string;
  holder: LockHolder;
}

/** What `Dispatcher.dispatch` resolves with once a backend has accepted (or rejected) a Node
 * Execution. `backends/` refines this per backend. */
export interface DispatchReceipt {
  accepted: boolean;
  dedupeKey?: string;
}

/** Minimal placeholder for the thing a `Dispatcher` is asked to run. `backends/` refines this
 * into the full request shape (resolved node, inputs, working directory, environment policy). */
export interface NodeExecution {
  nodeId: string;
  cycleIndex: number;
  attempt: number;
}

/** mvp-design.md §7.6: sqlite (MVP); local-dir and git-branch reserved (SPIKE-3). Synchronous —
 * see the deviation note at the top of this file. */
export interface StateStore {
  read(runId: string): Snapshot | null;
  append(runId: string, input: AppendInput): AppendResult;
  sweep(now: string): LeaseExpired[];
}

/** mvp-design.md §7.6: local, fake; github-actions reserved. */
export interface Dispatcher {
  dispatch(nodeExecution: NodeExecution, envelope: Envelope): Promise<DispatchReceipt>;
  capabilities(): BackendCapabilities;
}
