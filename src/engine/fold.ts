// `fold`: replays a stored trace through `transition()` and checks that what the replay emits
// equals what was actually persisted (state-machine.md P-8, invariant I-01). This is what
// `loopmill rebuild-snapshot` / A4 use. `foldEnvelopes` is the adapter the store's
// `rebuildSnapshot(runId, fold)` calls, which only ever hands back a plain `Envelope[]` (see the
// "report" note below).

import type { Envelope } from "../types/envelope.ts";
import type { RunSnapshot, TransitionContext } from "../types/state.ts";
import { EMITTED_EVENT_TYPES } from "../envelope/policy.ts";
import { toWire } from "../envelope/wire.ts";
import { transition, type EngineTransitionContext } from "./transition.ts";

export type FoldRowKind = "applied" | "ignored" | "emitted";

export interface FoldRow {
  kind: FoldRowKind;
  envelope: Envelope;
  recordedAt: string;
}

export interface FoldContext {
  loop: TransitionContext["loop"];
  policy: TransitionContext["policy"];
  admission?: EngineTransitionContext["admission"];
}

export interface FoldDiagnostic {
  seq?: number;
  message: string;
}

export interface FoldResult {
  snapshot: RunSnapshot;
  diagnostics: FoldDiagnostic[];
}

/**
 * Replays every `applied`/`ignored` row through `transition()`, using `recordedAt` as `ctx.now`
 * (state-machine.md O-2: `occurredAt` never drives a guard, but *replay* needs some `now` to
 * reproduce the original decision, and `recordedAt` — the store's own write-time column — is
 * exactly the value that was live when the original transition actually ran, distinct from
 * `event.occurredAt`, the producer's own clock). After each replayed row, the next `emitted` rows
 * in `rows` (in order, until the next `applied`/`ignored` row) are compared against what that
 * `transition()` call actually emitted, via `toWire` (byte-for-byte canonical comparison, P-2). A
 * mismatch is recorded as a diagnostic — this function never throws on a mismatch, matching
 * `state-machine.md`'s own framing of `rebuild-snapshot` as an audit tool, not an assertion.
 */
export function fold(rows: FoldRow[], ctx: FoldContext): FoldResult {
  let snapshot: RunSnapshot | null = null;
  const diagnostics: FoldDiagnostic[] = [];
  let i = 0;

  while (i < rows.length) {
    const row = rows[i]!;
    if (row.kind === "emitted") {
      diagnostics.push({ message: `unexpected leading "emitted" row for event ${row.envelope.eventId} with no preceding applied/ignored row` });
      i += 1;
      continue;
    }

    const engineCtx: EngineTransitionContext = { loop: ctx.loop, policy: ctx.policy, now: row.recordedAt };
    if (ctx.admission !== undefined) engineCtx.admission = ctx.admission;

    const result = transition(snapshot, row.envelope, engineCtx);

    let expectedEmitted: Envelope[];
    if (result.kind === "applied") {
      expectedEmitted = result.emitted;
      snapshot = result.snapshot;
    } else if (result.kind === "ignored-stale") {
      expectedEmitted = result.emitted;
      snapshot = result.snapshot;
    } else if (result.kind === "duplicate") {
      expectedEmitted = [];
      snapshot = result.snapshot;
    } else {
      diagnostics.push({ message: `replaying event ${row.envelope.eventId} produced 'invalid': ${result.error.code} ${result.error.message}` });
      i += 1;
      continue;
    }

    i += 1;
    const actualEmitted: Envelope[] = [];
    while (i < rows.length && rows[i]!.kind === "emitted") {
      actualEmitted.push(rows[i]!.envelope);
      i += 1;
    }

    if (actualEmitted.length !== expectedEmitted.length) {
      diagnostics.push({
        message: `event ${row.envelope.eventId}: replay emitted ${expectedEmitted.length} envelope(s), stored trace has ${actualEmitted.length}`,
      });
    } else {
      for (let k = 0; k < expectedEmitted.length; k++) {
        const expectedWire = toWire(expectedEmitted[k]!);
        const actualWire = toWire(actualEmitted[k]!);
        if (expectedWire !== actualWire) {
          diagnostics.push({ message: `event ${row.envelope.eventId}: emitted envelope #${k} does not match the stored trace (eventType ${expectedEmitted[k]!.eventType})` });
        }
      }
    }
  }

  if (!snapshot) {
    throw new Error("fold: no rows to replay (an empty trace has no snapshot to return)");
  }
  return { snapshot, diagnostics };
}

/**
 * Adapter for `store.rebuildSnapshot(runId, fold)`, whose own signature (`src/store/sqlite.ts`)
 * is `fold: (events: Envelope[]) => RunSnapshot` — a plain envelope list, in `seq` order, with
 * **no `kind` tag and no `recordedAt`** even though the `events` table it reads from stores both
 * (`StoredEvent.kind: "applied" | "ignored" | "emitted"`, `StoredEvent.recordedAt`). This adapter
 * therefore has to *infer* which envelopes were inbound (`applied`/`ignored`) versus emitted by
 * the control plane, from the envelope's own `eventType`/`producer` shape:
 *
 * - every type in `envelope/policy.ts`'s `EMITTED_EVENT_TYPES` (`run-started`, `node-dispatched`,
 *   `human-requested`, `quota-parked`, `retry-edge-taken`, `run-finished`, `ignored-stale`,
 *   `dispatch-failed`) is always emitted, never inbound;
 * - `node-completed`/`node-failed`/`node-timed-out` from `producer: 'control-plane'` are the
 *   synthetic completions D-13/the sweep produce — also always emitted, never inbound;
 * - everything else is inbound, replayed as `applied` (never `ignored` — this adapter cannot
 *   recover which inbound rows were originally declined, since the store's plain `Envelope[]`
 *   erases that distinction entirely; a row `transition()` itself now re-derives as stale is
 *   still replayed correctly, it is simply labelled `applied` here rather than `ignored` — the
 *   label is `fold`'s own bookkeeping, not something `transition()` reads).
 *
 * `recordedAt` is assumed equal to `occurredAt` for every envelope, per this task's own
 * instruction — true for every control-plane-emitted envelope (both are stamped from the same
 * `ctx.now`) and a reasonable approximation for an inbound one.
 *
 * **Report**: `store.rebuildSnapshot`'s callback signature should take `StoredEvent[]` (or at
 * least `Array<{ kind; envelope; recordedAt }>`) instead of `Envelope[]`, so `fold`'s real
 * `kind`/`recordedAt` distinctions survive the round trip instead of being reconstructed here.
 */
export function foldEnvelopes(events: Envelope[], ctx: FoldContext): RunSnapshot {
  const rows: FoldRow[] = events.map((envelope) => ({
    kind: isAlwaysEmitted(envelope) ? "emitted" : "applied",
    envelope,
    recordedAt: envelope.occurredAt,
  }));
  return fold(rows, ctx).snapshot;
}

const EMITTED_TYPE_SET = new Set<string>(EMITTED_EVENT_TYPES);

function isAlwaysEmitted(envelope: Envelope): boolean {
  if (EMITTED_TYPE_SET.has(envelope.eventType)) return true;
  if (
    (envelope.eventType === "node-completed" || envelope.eventType === "node-failed" || envelope.eventType === "node-timed-out") &&
    envelope.producer === "control-plane"
  ) {
    return true;
  }
  return false;
}
