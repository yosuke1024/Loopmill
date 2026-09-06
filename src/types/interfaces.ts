// The two ports the driver imports nothing else about the outside world through. Transcribed
// from docs/design/mvp-design.md §7.6 "Portability". No logic: `store/` implements
// `StateStore`, `backends/` implements `Dispatcher`; both refine the minimal request/response
// shapes defined here.

import type { BackendCapabilities } from "./capabilities.ts";
import type { Envelope } from "./envelope.ts";
import type { Lease, RunSnapshot } from "./state.ts";

/** mvp-design.md §7.6 names the store's read/append shape `Snapshot`; it is `RunSnapshot`. */
export type Snapshot = RunSnapshot;

/** Minimal result of `StateStore.append`; `store/` refines this (e.g. the new `snapshotOf`,
 * whether the transaction actually committed vs. collided). */
export interface AppendResult {
  ok: boolean;
  snapshot: RunSnapshot;
}

/** One lease `StateStore.sweep` found expired and reported as lost. `store/` refines this into
 * the exact shape it emits (or hands to the driver) per `docs/spec/state-machine.md` §10.2. */
export interface LeaseExpired {
  runId: string;
  nodeId: string;
  cycleIndex: number;
  attempt: number;
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

/** mvp-design.md §7.6: sqlite (MVP); local-dir and git-branch reserved (SPIKE-3). */
export interface StateStore {
  read(runId: string): Promise<Snapshot | null>;
  append(runId: string, events: Envelope[], snapshot: RunSnapshot, lock: Lease): Promise<AppendResult>;
  sweep(now: string): Promise<LeaseExpired[]>;
}

/** mvp-design.md §7.6: local, fake; github-actions reserved. */
export interface Dispatcher {
  dispatch(nodeExecution: NodeExecution, envelope: Envelope): Promise<DispatchReceipt>;
  capabilities(): BackendCapabilities;
}
