// The producer-policy allowlist (docs/spec/state-machine.md §3.1's "Producer(s)" column, §3.2)
// and the inbound/emitted event-type partitions (§3.3). This is control-plane policy `loopmill
// step` enforces on top of (not instead of) schema validation: the schema constrains the *shape*
// of `producer`, never which producer may send which `eventType` (envelope.md §5).

import type { EventType, Producer } from "../types/envelope.ts";

type ProducerRule = "control-plane" | "human" | "trigger" | "backend:*" | "backend:observed";

/**
 * state-machine.md §3.1's "Producer(s)" column, transcribed exactly. `"backend:*"` allows any
 * `backend:<id>` producer (state-machine.md §3.2: "the same type legitimately comes from
 * different backends"); `"backend:observed"` allows only that one literal producer —
 * `node-observed` is reserved to the `observed` backend and unreachable in the MVP (SPIKE-2
 * NO-GO, ADR-002 D4).
 */
export const PRODUCER_POLICY: Record<EventType, ReadonlyArray<ProducerRule>> = {
  "run-requested": ["trigger", "control-plane"],
  "run-started": ["control-plane"],
  "node-dispatched": ["control-plane"],
  "node-started": ["backend:*"],
  "node-completed": ["backend:*", "control-plane"],
  "node-failed": ["backend:*", "control-plane"],
  "node-timed-out": ["backend:*", "control-plane"],
  "node-observed": ["backend:observed"],
  "human-requested": ["control-plane"],
  "human-decided": ["human"],
  "quota-parked": ["control-plane"],
  "retry-edge-taken": ["control-plane"],
  "run-finished": ["control-plane"],
  "ignored-stale": ["control-plane"],
  "dispatch-failed": ["control-plane"],
  "resumed": ["human", "control-plane"],
  "lease-expired": ["control-plane"],
};

/**
 * True iff `producer` is allowed to emit `eventType` (state-machine.md §3.2). A backend can never
 * emit a control-flow event (`node-dispatched`, `retry-edge-taken`, `run-finished`,
 * `quota-parked`, `ignored-stale`); a `human` producer can emit only `human-decided` and
 * `resumed`.
 */
export function producerAllowed(eventType: EventType, producer: Producer | string): boolean {
  const rules = PRODUCER_POLICY[eventType];
  return rules.some((rule) => {
    if (rule === "backend:*") return producer.startsWith("backend:");
    return rule === producer;
  });
}

/** state-machine.md §3.3: event types that may arrive from outside one `step` (a backend, a
 * human via polling or `loopmill approve`/`reject`, the sweep). */
export const INBOUND_EVENT_TYPES: ReadonlyArray<EventType> = [
  "run-requested",
  "node-started",
  "node-completed",
  "node-failed",
  "node-timed-out",
  "node-observed",
  "human-decided",
  "resumed",
  "lease-expired",
];

/** state-machine.md §3.3: event types produced by `transition()` inside a step and persisted in
 * the same transaction. `node-completed`, `node-failed` and `node-timed-out` appear in both
 * partitions (the control plane also synthesises them for control-plane-local nodes and the
 * sweep), so they are listed in `INBOUND_EVENT_TYPES` above and not repeated here. */
export const EMITTED_EVENT_TYPES: ReadonlyArray<EventType> = [
  "run-started",
  "node-dispatched",
  "human-requested",
  "quota-parked",
  "retry-edge-taken",
  "run-finished",
  "ignored-stale",
  "dispatch-failed",
];
