// Mapping between the engine's `Outcome` (state.ts, state-machine.md §2.2) and its wire payload
// (`OutcomePayload`, envelope.md §4.9, envelope.schema.json `$defs.outcome`). `label` <-> `endLabel`;
// every other field is one-to-one per state (Amendment m0+, schema 1.1.0).

import { LoopmillError } from "../util/errors.ts";
import type { OutcomePayload } from "../types/envelope.ts";
import type { Outcome } from "../types/state.ts";

/** `Outcome` (engine-internal discriminated union) -> `OutcomePayload` (wire form). Pure,
 * total: every `Outcome` variant maps to a schema-legal payload for its state. */
export function outcomeToPayload(outcome: Outcome): OutcomePayload {
  switch (outcome.state) {
    case "SUCCEEDED":
      return { state: "SUCCEEDED", endLabel: outcome.label };

    case "FAILED": {
      const payload: OutcomePayload = { state: "FAILED", failureReason: outcome.failureReason };
      if (outcome.nodeId !== undefined) payload.nodeId = outcome.nodeId;
      if (outcome.cycleIndex !== undefined) payload.cycleIndex = outcome.cycleIndex;
      return payload;
    }

    case "CANCELLED": {
      const payload: OutcomePayload = { state: "CANCELLED", by: outcome.by };
      if (outcome.actor !== undefined) payload.actor = outcome.actor;
      return payload;
    }

    case "MAX_ITERATIONS_EXCEEDED":
      return {
        state: "MAX_ITERATIONS_EXCEEDED",
        edgeId: outcome.edgeId,
        traversals: outcome.traversals,
        maxIterations: outcome.maxIterations,
      };

    case "BUDGET_EXCEEDED":
      return {
        state: "BUDGET_EXCEEDED",
        budgetKey: outcome.budgetKey,
        limit: outcome.limit,
        observed: outcome.observed,
      };

    case "EXPIRED": {
      const payload: OutcomePayload = { state: "EXPIRED", expiryReason: outcome.expiryReason };
      if (outcome.nodeId !== undefined) payload.nodeId = outcome.nodeId;
      return payload;
    }

    case "SKIPPED": {
      const payload: OutcomePayload = { state: "SKIPPED", skipReason: outcome.skipReason };
      if (outcome.ref !== undefined) payload.ref = outcome.ref;
      return payload;
    }
  }
}

/** `OutcomePayload` (wire form) -> `Outcome` (engine-internal discriminated union). Throws
 * `LoopmillError` (`code: "envelope_invalid"`, `exitCode: 2`) when a field the target state
 * requires is missing — the schema's own `allOf` conditionals (envelope.schema.json
 * `$defs.outcome`) already make that combination impossible for a schema-valid `run-finished`
 * envelope, so this only fires on a payload built or mutated outside that check. */
export function payloadToOutcome(p: OutcomePayload): Outcome {
  switch (p.state) {
    case "SUCCEEDED": {
      if (p.endLabel === undefined) {
        throw invalid("outcome SUCCEEDED requires endLabel");
      }
      return { state: "SUCCEEDED", label: p.endLabel };
    }

    case "FAILED": {
      if (p.failureReason === undefined) {
        throw invalid("outcome FAILED requires failureReason");
      }
      const outcome: Outcome = { state: "FAILED", failureReason: p.failureReason };
      if (p.nodeId !== undefined) outcome.nodeId = p.nodeId;
      if (p.cycleIndex !== undefined) outcome.cycleIndex = p.cycleIndex;
      return outcome;
    }

    case "CANCELLED": {
      if (p.by === undefined) {
        throw invalid("outcome CANCELLED requires by");
      }
      const outcome: Outcome = { state: "CANCELLED", by: p.by };
      if (p.actor !== undefined) outcome.actor = p.actor;
      return outcome;
    }

    case "MAX_ITERATIONS_EXCEEDED": {
      if (p.edgeId === undefined || p.traversals === undefined || p.maxIterations === undefined) {
        throw invalid("outcome MAX_ITERATIONS_EXCEEDED requires edgeId, traversals and maxIterations");
      }
      return {
        state: "MAX_ITERATIONS_EXCEEDED",
        edgeId: p.edgeId,
        traversals: p.traversals,
        maxIterations: p.maxIterations,
      };
    }

    case "BUDGET_EXCEEDED": {
      if (p.budgetKey === undefined || p.limit === undefined || p.observed === undefined) {
        throw invalid("outcome BUDGET_EXCEEDED requires budgetKey, limit and observed");
      }
      return { state: "BUDGET_EXCEEDED", budgetKey: p.budgetKey, limit: p.limit, observed: p.observed };
    }

    case "EXPIRED": {
      if (p.expiryReason === undefined) {
        throw invalid("outcome EXPIRED requires expiryReason");
      }
      const outcome: Outcome = { state: "EXPIRED", expiryReason: p.expiryReason };
      if (p.nodeId !== undefined) outcome.nodeId = p.nodeId;
      return outcome;
    }

    case "SKIPPED": {
      if (p.skipReason === undefined) {
        throw invalid("outcome SKIPPED requires skipReason");
      }
      const outcome: Outcome = { state: "SKIPPED", skipReason: p.skipReason };
      if (p.ref !== undefined) outcome.ref = p.ref;
      return outcome;
    }
  }
}

function invalid(message: string): LoopmillError {
  return new LoopmillError("envelope_invalid", message, { exitCode: 2 });
}
