// Backend and runtime identity, and the capability record every backend declares in code
// (docs/design/mvp-design.md §6.1, §6.2). No logic: the validator, the driver and every
// report read this record; no behaviour is inferred from a backend id anywhere in the engine.

/** Execution backend id. `control-plane` is the pseudo-backend for condition/human/end nodes
 * (mvp-design.md §6.2); `github-actions` is reserved (LM-VAL-028). */
export type BackendId = "local" | "fake" | "control-plane" | "github-actions";

/** Agent runtime id. `fake` is a backend, not a runtime: a fake-backend attempt still records
 * the runtime whose fixture it replayed (envelope.schema.json `$defs.runtimeId`). */
export type RuntimeId = "claude-code" | "codex";

/** Authentication mode a node runs under (loop-file.schema.json `$defs.authMode`). */
export type AuthMode = "subscription-oauth" | "subscription-login" | "api-key";

/**
 * The capability record a backend declares. Transcribed from docs/design/mvp-design.md §6.1.
 */
export interface BackendCapabilities {
  invocation: "on-demand" | "event" | "schedule-only";
  result: "returned" | "streamed" | "observed";
  usage: "full" | "partial" | "none";
  quotaSignal: "structured" | "classified" | "none";
  structuredOutput: boolean;
  retryable: boolean; // may sit in, or be the target of, a Retry Edge body
  cancellable: boolean;
  isolation: "ephemeral" | "worktree" | "shared";
  credentialLocation: "job-secret" | "vendor-side" | "user-machine" | "none"; // `none`: fake, control-plane (mvp-design.md §6.2 table)
}
