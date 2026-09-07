// The backend capability records (docs/design/mvp-design.md §6.2 table; docs/spec/loop-file.md
// §14, the identical table). A backend is not a name; it is a declared capability record, held
// in code and echoed by `loopmill backends --json`. The validator (`loop-file/validate.ts`), the
// driver and every report read this record; no behaviour is inferred from a backend id anywhere
// else in the engine.

import type { BackendCapabilities, BackendId } from "../types/capabilities.ts";

/**
 * Every backend id the MVP engine knows about, keyed exactly as `BackendId` names them.
 * `control-plane` is the pseudo-backend for `condition` / `human` / `end` nodes: it is why a
 * Retry Edge can be validated at all (`retryable: false`, LM-VAL-007). `github-actions` is
 * reserved (LM-VAL-028); its record is kept only so a dominance or capability lookup that
 * resolves to it still has something to read.
 *
 * Deviation from `BackendCapabilities` as declared in `src/types/capabilities.ts`: the source
 * tables give `control-plane`'s `isolation` as `n/a`, which is not a member of
 * `BackendCapabilities.isolation` (`"ephemeral" | "worktree" | "shared"`). `ephemeral` is used
 * here as the closest safe value (control-plane nodes hold no working-tree state of their own);
 * see the report for the exact type change this would need (an `"n/a"` member, or making the
 * field optional).
 */
export const BACKEND_CAPABILITIES: Record<BackendId, BackendCapabilities> = {
  local: {
    invocation: "on-demand",
    result: "returned",
    usage: "full",
    quotaSignal: "classified",
    structuredOutput: true,
    retryable: true,
    cancellable: true,
    isolation: "worktree",
    credentialLocation: "user-machine",
  },
  fake: {
    invocation: "on-demand",
    result: "returned",
    usage: "full",
    quotaSignal: "classified",
    structuredOutput: true,
    retryable: true,
    cancellable: true,
    isolation: "ephemeral",
    credentialLocation: "none",
  },
  "control-plane": {
    invocation: "on-demand",
    result: "returned",
    usage: "none",
    quotaSignal: "none",
    structuredOutput: false,
    retryable: false,
    cancellable: true,
    isolation: "n/a",
    credentialLocation: "none",
  },
  "github-actions": {
    invocation: "on-demand",
    result: "returned",
    usage: "full",
    quotaSignal: "classified",
    structuredOutput: true,
    retryable: true,
    cancellable: true,
    isolation: "ephemeral",
    credentialLocation: "job-secret",
  },
};

/** Looks up a capability record by a possibly-untrusted string id (e.g. from a Loop file or a
 * `--backend` flag). Returns `undefined` for anything not in `BACKEND_CAPABILITIES`, including
 * a well-formed but unknown id -- callers decide what that means (an unresolvable capability
 * lookup is not automatically a validation error at this layer). */
export function capabilitiesFor(id: string): BackendCapabilities | undefined {
  return Object.prototype.hasOwnProperty.call(BACKEND_CAPABILITIES, id)
    ? BACKEND_CAPABILITIES[id as BackendId]
    : undefined;
}
