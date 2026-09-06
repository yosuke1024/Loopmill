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
import type { JsonValue, ResolvedEnvPolicy, ResolvedNode } from "./loop.ts";

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

/** mvp-design.md §7.6: sqlite (MVP); local-dir and git-branch reserved (SPIKE-3). Synchronous —
 * see the deviation note at the top of this file. */
export interface StateStore {
  read(runId: string): Snapshot | null;
  append(runId: string, input: AppendInput): AppendResult;
  sweep(now: string): LeaseExpired[];
}

// ---------------------------------------------------------------------------------------------
// Dispatcher (backends/): refined for m1 (docs/design/m1-plan.md `backends/` row).
//
// `NodeExecution` and `DispatchReceipt` (the m0 placeholders `dispatch(nodeExecution, envelope):
// Promise<DispatchReceipt>` was sketched against) are removed: nothing outside this file ever
// referenced them (checked across src/ and test/), and the shape they stood in for is now
// `DispatchRequest` below, built directly from `mvp-design.md` §7.2/§11 and `state-machine.md`
// §7.1/§10.4 rather than left as a placeholder for `backends/` to reinterpret.
// ---------------------------------------------------------------------------------------------

/**
 * What a `Dispatcher` is asked to run: one Attempt of one Node Execution, fully resolved by the
 * engine (mvp-design.md §7.2 step 6, §11; state-machine.md §10.1 Lease). Every reference in
 * `inputs` has already been substituted to its current value (loop-file.md §9) — the dispatcher
 * never resolves a reference itself, only renders `${name}` templates over what it is given.
 *
 * Decision (not in sheet), m1: `causationId` is added here, absent from the shape this task was
 * briefed against. `envelope.md` §9.1 requires the completion envelope's `causationId` to be the
 * `node-dispatched` event's own `eventId` ("the ONLY way a receiver can build the causation
 * chain", §6.3) — without it on the request, a `Dispatcher` has no way to satisfy that rule, since
 * a `Dispatcher` never sees the `node-dispatched` envelope itself (mvp-design.md §7.2 step 5: it
 * is persisted in an earlier transaction, before dispatch). Optional because `describe()` and the
 * `fake`/`local` unit tests do not always have (or need) a real one.
 */
export interface DispatchRequest {
  runId: string;
  loopId: string;
  loopVersion: string;
  slug: string;
  cycleIndex: number;
  nodeId: string;
  attempt: number;
  node: ResolvedNode;
  /** Already resolved by the engine — every reference is a plain JSON value, ready to render. */
  inputs: Record<string, JsonValue>;
  /** Set when this attempt retries a cycle whose previous attempt changed nothing
   * (state-machine.md §6.6, NO_PROGRESS) — the executor appends one prompt line noting it
   * (`Decision (not in sheet), m1`, see `local/executor.ts`). */
  retryHint?: "no_progress";
  workspace: { repoRoot: string; worktreePath: string; branch: string; baseCommit: string };
  env: ResolvedEnvPolicy;
  deadlineAt: string;
  timeoutMs: number | null;
  dedupeKey: string;
  /** The `node-dispatched` event's `eventId` — see the Decision above. */
  causationId?: string;
  signal?: AbortSignal;
}

/** What `Dispatcher.describe` reports without spawning anything or touching the filesystem
 * beyond what its own backend needs to read (e.g. a prompt file) — `loopmill run --dry-run`
 * prints exactly this (mvp-design.md acceptance criterion A16). `env` is the already-scrubbed
 * child environment (A15: what would reach the subprocess, for the operator to audit). */
export interface DispatchPlan {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: "/dev/null";
  timeoutMs: number | null;
  notes: string[];
}

/**
 * mvp-design.md §7.6: local, fake; github-actions reserved. `dispatch` resolves to the
 * completion envelope (`node-completed` | `node-failed` | `node-timed-out`, producer
 * `backend:<id>`, envelope.md §9.1) once the backend has an answer for this Attempt, and
 * **rejects** with a `LoopmillError` (`code: "dispatch_failed"`) only when the backend could not
 * even start the work (e.g. the runtime binary could not be spawned at all) — the driver turns
 * that rejection into a `dispatch-failed` event (state-machine.md §10.4). A runtime failure
 * (the process ran and failed, timed out, or was cancelled) is never a rejection: it resolves
 * with a `node-failed` / `node-timed-out` envelope like any other outcome, because node failure
 * is data, not a broken dispatcher (mvp-design.md §7.3).
 */
export interface Dispatcher {
  dispatch(request: DispatchRequest, clock: { now(): string }): Promise<Envelope>;
  /** Reports the plan `dispatch` would execute, without spawning anything. */
  describe(request: DispatchRequest): DispatchPlan;
  capabilities(): BackendCapabilities;
}
