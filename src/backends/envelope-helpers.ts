// Shared helpers for turning what a backend actually observed into envelope-legal values.
// Used by both `fake/` and `local/`, so it lives at the top of `backends/` rather than inside
// either submodule.
//
// Decision (not in sheet), m1 -- the `usage` wire shape. `docs/spec/envelope.schema.json`'s
// `$defs.usage` has `additionalProperties: false` and declares only the base `Usage` fields
// (`docs/spec/usage-normalization.md` §1.1): `runtime`, `model`, the four buckets, `reasoningTokens`,
// the two totals, `provenance`, `provenanceNote`, `source`, `complete`, `listPriceEquivalentUsd`.
// It does NOT declare the four audit extensions `src/types/usage.ts`'s `UsageRecord` adds
// (`usageBasis`, `sessionRef`, `usageAtAttemptStart`, `perModel`) -- yet `src/types/envelope.ts`
// types `Envelope.usage` as the wider `UsageRecord`. Verified empirically (not just read off the
// schema text): handing `validateEnvelope` a real `UsageRecord` with those four keys populated
// fails ajv with "must NOT have additional properties" once per extra key, and `model: null`
// (legal on `UsageRecord`, since a per-attempt record may not know one model) fails too, since the
// schema's `model` property is `{"type": "string"}` with no `null` variant. A `Dispatcher` that
// embedded the full audit record verbatim would therefore make `makeEnvelope` throw on every real
// completion -- exactly the "throws for a runtime failure" behaviour this module's contract
// forbids. `toEnvelopeUsage` is the fix: it strips a `UsageRecord` down to the schema-legal `Usage`
// subset (dropping the four audit fields, omitting `model`/`reasoningTokens`/`source`/
// `listPriceEquivalentUsd` whenever they are null rather than sending a value the schema rejects)
// before it ever reaches `makeEnvelope`. The full audit record itself is never lost by this
// module -- `Dispatcher.dispatch` returns only the envelope (docs/design/m1-plan.md's shape), so
// whoever builds the `AttemptRecord` (`src/types/state.ts`, engine territory) from the envelope's
// `usage` field only ever sees the stripped view too. See the report for the type change this
// suggests elsewhere (`Envelope.usage` should probably be typed `Usage`, not `UsageRecord`).

import type { UsageRecord } from "../types/usage.ts";
import { unavailableRecord } from "../usage/record.ts";

/**
 * The `unavailable` usage record a `command` node reports (it has no runtime CLI, so there is
 * nothing to measure). `runtime: "claude-code"` matches
 * `docs/spec/envelope-examples/node-failed.json`'s own `usage` block for its `test` command node
 * verbatim -- `UsageRecord.runtime` has no `"none"` value, and that example is the only
 * precedent for what a command node should report here, so both `fake/` and `local/` follow it
 * rather than inventing a different placeholder.
 */
export function noAgentRanUsage(): UsageRecord {
  return unavailableRecord({
    runtime: "claude-code",
    runtimeVersion: null,
    eventKind: null,
    note: "command node: no agent runtime ran, so there is nothing to measure",
  });
}

// envelope.schema.json $defs.shortText / .text / .summaryText maxLength values.
export const SHORT_TEXT_MAX = 500;
export const TEXT_MAX = 2000;
export const SUMMARY_TEXT_MAX = 4000;
// $defs.usage.properties.model maxLength.
const MODEL_MAX = 128;

const TRUNCATION_MARKER = "…"; // "…"

/** Truncates `s` to at most `maxBytes` UTF-8 bytes, appending a one-character ellipsis marker
 * when truncation happens. Byte-based (not character-based) because every schema `maxLength` in
 * `envelope.schema.json` counts characters, but truncating on a UTF-16 code-unit boundary can
 * split a multi-byte character -- slicing the UTF-8 buffer and re-decoding is the simplest way to
 * never emit invalid UTF-8, at the (harmless, one-directional) cost of occasionally truncating a
 * little short of the exact character limit for multi-byte text. */
export function truncateForSchema(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const sliced = s.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length));
  return sliced + TRUNCATION_MARKER;
}

/**
 * Strips a full `UsageRecord` down to the wire-legal `Usage` shape (see the module doc above).
 * The result is cast back to `UsageRecord` only because `Envelope.usage`'s declared type demands
 * it (`src/types/envelope.ts`, out of this task's scope to change) -- the actual object carries
 * none of the four audit-only keys.
 */
export function toEnvelopeUsage(record: UsageRecord): UsageRecord {
  // Envelope schema 1.1.0 accepts the stored record in full (envelope.md §4.6, amended 2026-09-07);
  // only the schema's string-length caps are applied, and optional fields are normalised to null
  // rather than left undefined (canonical JSON rejects undefined at any depth).
  return {
    runtime: record.runtime,
    model: record.model == null ? null : truncateForSchema(record.model, MODEL_MAX),
    freshInputTokens: record.freshInputTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    cacheReadTokens: record.cacheReadTokens,
    outputTokens: record.outputTokens,
    reasoningTokens: record.reasoningTokens ?? null,
    totalInputTokens: record.totalInputTokens,
    totalTokens: record.totalTokens,
    provenance: record.provenance,
    provenanceNote: truncateForSchema(record.provenanceNote, SHORT_TEXT_MAX),
    source: { runtimeVersion: record.source.runtimeVersion, eventKind: record.source.eventKind },
    complete: record.complete,
    usageBasis: record.usageBasis,
    sessionRef: record.sessionRef,
    usageAtAttemptStart: record.usageAtAttemptStart,
    listPriceEquivalentUsd: record.listPriceEquivalentUsd,
    perModel: record.perModel,
  };
}
