// The `unavailable` record constructor and the write-time / audit-time shape checks.
// docs/spec/usage-normalization.md §1.3 (nullability constraints), §2.5 (failure cases) and
// §9 invariants I1, I2, I3, I4.

import type { UsageRecord } from "../types/usage.ts";
import { LoopmillError } from "../util/errors.ts";

/** Input to `unavailableRecord`: the minimum a caller must know to record "no usage exists for
 * this attempt" per §2.5. Everything else in the record is forced to the `unavailable` shape
 * of §1.4 (all buckets, both totals, `reasoningTokens` and `listPriceEquivalentUsd` null,
 * `complete: false`, `usageBasis: "none"`). */
export interface UnavailableRecordInput {
  runtime: string;
  runtimeVersion: string | null;
  /** The event kind seen (e.g. `"turn.failed"`), or `null` when no terminal event existed at all
   * (a signal kill, a stream that closed mid-turn). */
  eventKind: string | null;
  /** Free text; becomes `provenanceNote`. Must be non-empty (checked by `assertRecordShape`). */
  note: string;
  /** Named when a runtime version can still be inferred despite no usage (e.g. from a stream's
   * `system`/`init` line). */
  model?: string | null;
  sessionRef?: UsageRecord["sessionRef"];
  /** Stored verbatim when the runtime supplies a start-of-attempt counter even though the
   * attempt itself produced no usable terminal event (§1.2). */
  usageAtAttemptStart?: Record<string, number> | null;
}

/** Builds the `unavailable` shape of §1.4/§2.5: "we do not know", never rendered as `0`. */
export function unavailableRecord(input: UnavailableRecordInput): UsageRecord {
  return {
    runtime: input.runtime,
    model: input.model ?? null,
    freshInputTokens: null,
    cacheWriteTokens: null,
    cacheReadTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalInputTokens: null,
    totalTokens: null,
    provenance: "unavailable",
    provenanceNote: input.note,
    source: { runtimeVersion: input.runtimeVersion, eventKind: input.eventKind },
    complete: false,
    usageBasis: "none",
    sessionRef: input.sessionRef ?? null,
    usageAtAttemptStart: input.usageAtAttemptStart ?? null,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
}

/**
 * §4.1: a Node Execution (and, by extension, one Attempt record) counts as *measured* iff its
 * provenance is `reported` or `derived` **and** `complete === true`. A `reported` record
 * interrupted mid-turn (`aborted_streaming`) has `complete: false` and is therefore unmeasured
 * even though every number it carries was stated by the runtime.
 */
export function isMeasured(record: UsageRecord): boolean {
  return (record.provenance === "reported" || record.provenance === "derived") && record.complete === true;
}

/**
 * Write-time / audit-time shape check for one `UsageRecord`, at any aggregation level. Throws a
 * `LoopmillError` (`code: "usage_invariant_violation"`) naming the invariant that failed; never
 * silently repairs a record. Checks:
 *
 * - I1: for a non-`unavailable` record, all four buckets are non-null and
 *   `totalInputTokens`/`totalTokens` recompute exactly from them.
 * - I2: every bucket and total is a non-negative integer.
 * - I3: `reasoningTokens`, when present, is an integer in `[0, outputTokens]`.
 * - I4: an `unavailable` record has every bucket, both totals, `reasoningTokens` and
 *   `listPriceEquivalentUsd` null, and `complete === false` — never a stored `0`.
 * - `provenanceNote` is never empty (§1.3: "empty string is a conformance failure").
 */
export function assertRecordShape(record: UsageRecord): void {
  if (record.provenanceNote.length === 0) {
    throw new LoopmillError(
      "usage_invariant_violation",
      "provenanceNote must never be empty (usage-normalization.md §1.3)",
      { details: record },
    );
  }

  if (record.provenance === "unavailable") {
    const mustBeNull: unknown[] = [
      record.freshInputTokens,
      record.cacheWriteTokens,
      record.cacheReadTokens,
      record.outputTokens,
      record.totalInputTokens,
      record.totalTokens,
      record.reasoningTokens ?? null,
      record.listPriceEquivalentUsd,
    ];
    if (mustBeNull.some((v) => v !== null) || record.complete !== false) {
      throw new LoopmillError(
        "usage_invariant_violation",
        "I4: an unavailable record must have every bucket, both totals, reasoningTokens and " +
          "listPriceEquivalentUsd null, and complete=false",
        { details: record },
      );
    }
    return;
  }

  const fresh = record.freshInputTokens;
  const write = record.cacheWriteTokens;
  const read = record.cacheReadTokens;
  const output = record.outputTokens;
  if (fresh === null || write === null || read === null || output === null) {
    throw new LoopmillError(
      "usage_invariant_violation",
      "I1: reported/derived/estimated records must have all four buckets non-null",
      { details: record },
    );
  }
  for (const [name, value] of [
    ["freshInputTokens", fresh],
    ["cacheWriteTokens", write],
    ["cacheReadTokens", read],
    ["outputTokens", output],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new LoopmillError(
        "usage_invariant_violation",
        `I2: ${name} must be a non-negative integer, got ${String(value)}`,
        { details: record },
      );
    }
  }
  const expectedTotalInput = fresh + write + read;
  const expectedTotal = expectedTotalInput + output;
  if (record.totalInputTokens !== expectedTotalInput || record.totalTokens !== expectedTotal) {
    throw new LoopmillError(
      "usage_invariant_violation",
      "I1: totalInputTokens/totalTokens must recompute exactly from the four buckets",
      { details: record },
    );
  }
  if (record.reasoningTokens !== null && record.reasoningTokens !== undefined) {
    if (
      !Number.isInteger(record.reasoningTokens) ||
      record.reasoningTokens < 0 ||
      record.reasoningTokens > output
    ) {
      throw new LoopmillError(
        "usage_invariant_violation",
        "I3: reasoningTokens must be an integer in [0, outputTokens]",
        { details: record },
      );
    }
  }
}
