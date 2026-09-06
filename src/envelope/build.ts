// Envelope construction (docs/spec/envelope.md §3): fills the fields a producer does not have to
// think about — `schemaVersion`, `occurredAt`, `eventId` — and validates the result before
// handing it back, so nothing that fails its own construction check is ever persisted or
// dispatched.

import { LoopmillError } from "../util/errors.ts";
import { parseRfc3339 } from "../util/time.ts";
import { randomUlid } from "../util/ulid.ts";
import type { Envelope } from "../types/envelope.ts";
import { ENVELOPE_SCHEMA_VERSION } from "./schema.ts";
import { validateEnvelope } from "./validate.ts";

/** The only clock a pure builder needs: the current instant, RFC 3339, injected by the caller
 * (docs/design/m1-plan.md §3: "Pure modules take `now` as a parameter"). */
export interface Clock {
  now: string;
}

export type MakeEnvelopeInput = Omit<Envelope, "schemaVersion" | "eventId" | "occurredAt"> & {
  eventId?: string;
  occurredAt?: string;
};

/**
 * Builds one envelope: fills `schemaVersion` (`ENVELOPE_SCHEMA_VERSION`), `occurredAt`
 * (`clock.now`, unless `input` already supplies one — e.g. a re-stamped polled event, envelope.md
 * §8.2) and `eventId` (a fresh ULID at `parseRfc3339(occurredAt)`, unless `input` already supplies
 * one — e.g. a deterministic or delivery-derived id), then validates the result end to end
 * (`validateEnvelope`: schema, producer policy, credential backstop).
 *
 * Throws `LoopmillError` (`code: "envelope_invalid"`, `exitCode: 2`) when validation fails —
 * mirroring `loopmill step`'s own exit code for an invalid envelope (state-machine.md §12).
 */
export function makeEnvelope(input: MakeEnvelopeInput, clock: Clock): Envelope {
  const occurredAt = input.occurredAt ?? clock.now;
  const eventId = input.eventId ?? randomUlid(parseRfc3339(occurredAt));

  const envelope = {
    ...input,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    occurredAt,
    eventId,
  } as Envelope;

  const result = validateEnvelope(envelope);
  if (!result.ok) {
    const detail = result.errors.map((e) => `${e.path} ${e.message} (${e.rule})`).join("; ");
    throw new LoopmillError("envelope_invalid", `envelope failed validation: ${detail}`, {
      exitCode: 2,
      details: result.errors,
    });
  }
  return result.envelope;
}
