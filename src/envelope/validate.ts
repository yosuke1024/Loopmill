// End-to-end envelope validation: JSON Schema (schema.ts), the producer-policy allowlist
// (policy.ts), then the credential-shape backstop (util/redact.ts), in that order
// (docs/spec/envelope.md §3-§5, §11.1). Each stage short-circuits the next: a schema-invalid
// envelope is never checked against producer policy, and a producer-rejected envelope is never
// checked for credential shapes.
//
// Node coordinates (`cycle`/`nodeId`/`attempt` required together on node-level event types,
// forbidden on run-level ones — envelope.md §3.2) are enforced entirely by the schema's `allOf`
// conditionals (envelope.schema.json); this module does not duplicate that check, only maps the
// schema's own error into a readable `{ path, message }` pair.

import { looksLikeCredential } from "../util/redact.ts";
import type { ArtifactRef, Envelope } from "../types/envelope.ts";
import { getEnvelopeValidator } from "./schema.ts";
import { producerAllowed } from "./policy.ts";

export interface ValidationIssue {
  path: string;
  message: string;
  rule: "schema" | "producer" | "credential";
}

export type ValidateEnvelopeResult = { ok: true; envelope: Envelope } | { ok: false; errors: ValidationIssue[] };

export interface ValidateEnvelopeOptions {
  /** Enforce the producer-policy allowlist (policy.ts, state-machine.md §3.2). Default true. */
  enforceProducer?: boolean;
}

/**
 * Validates `value` as an Envelope, end to end:
 *
 * 1. JSON Schema (envelope.schema.json via schema.ts) — shape, enums, per-`eventType`
 *    conditionals, node-coordinate requirement/prohibition, and the schema's own `secretFree`
 *    backstop on most free-text fields.
 * 2. The producer-policy allowlist (policy.ts), unless `opts.enforceProducer` is `false`.
 * 3. The credential-shape backstop (envelope.md §11.1) over the free-text fields named there:
 *    `result.summary`, `error.message`, `reason`, `human.note`, `artifactRefs[].ref`/`.url` and
 *    `dispatch.target`. Most of these already carry the schema's `secretFree` $ref (stage 1 would
 *    already have failed them); `reason` does not — its `machineToken` $def is a strict
 *    lowercase-snake_case pattern instead — so this stage is not fully redundant with stage 1.
 *
 * Each stage short-circuits: a schema failure is reported alone, never mixed with a producer or
 * credential finding from a later stage.
 */
export function validateEnvelope(value: unknown, opts: ValidateEnvelopeOptions = {}): ValidateEnvelopeResult {
  const enforceProducer = opts.enforceProducer ?? true;

  const validate = getEnvelopeValidator();
  const schemaOk = validate(value);
  if (!schemaOk) {
    const errors: ValidationIssue[] = (validate.errors ?? []).map((e) => ({
      path: e.instancePath || "/",
      message: e.message ?? "schema validation failed",
      rule: "schema",
    }));
    return { ok: false, errors };
  }

  // Schema-valid: safe to treat as a well-shaped Envelope from here on.
  const envelope = value as Envelope;

  if (enforceProducer && !producerAllowed(envelope.eventType, envelope.producer)) {
    return {
      ok: false,
      errors: [
        {
          path: "/producer",
          message: `producer "${envelope.producer}" is not allowed for eventType "${envelope.eventType}"`,
          rule: "producer",
        },
      ],
    };
  }

  const credentialErrors = checkCredentialBackstop(envelope);
  if (credentialErrors.length > 0) {
    return { ok: false, errors: credentialErrors };
  }

  return { ok: true, envelope };
}

/** envelope.md §11.1: the free-text fields checked against `looksLikeCredential`, as a second,
 * application-level guard alongside the schema's own `secretFree` $def. */
function checkCredentialBackstop(envelope: Envelope): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const flag = (path: string, s: string | undefined): void => {
    if (s !== undefined && looksLikeCredential(s)) {
      errors.push({ path, message: `credential-shaped string at ${path}`, rule: "credential" });
    }
  };

  flag("/result/summary", envelope.result?.summary);
  flag("/error/message", envelope.error?.message);
  flag("/reason", envelope.reason);
  flag("/human/note", envelope.human?.note);
  flag("/dispatch/target", envelope.dispatch?.target);

  const artifactRefs: ArtifactRef[] = envelope.artifactRefs ?? [];
  artifactRefs.forEach((ref, i) => {
    flag(`/artifactRefs/${i}/ref`, ref.ref);
    flag(`/artifactRefs/${i}/url`, ref.url);
  });

  return errors;
}
