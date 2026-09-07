// The canonical Usage record. Transcribed from docs/spec/usage-normalization.md §1.1-§1.2,
// plus Coverage (§4.1-§4.2) and AggregateUsage (§3). No logic: normalisation, aggregation and
// coverage computation belong to the `usage/` module.

/** docs/spec/usage-normalization.md §1.1. */
export type Provenance = "reported" | "derived" | "estimated" | "unavailable";

/**
 * The record the decision sheet defines (usage-normalization.md §1.1, "exactly the sheet's
 * fields"). Every field below is required.
 */
export interface Usage {
  runtime: "claude-code" | "codex" | string;
  model?: string | null;

  // The four disjoint buckets. Non-null iff provenance is "reported" | "derived" | "estimated".
  freshInputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;

  /** Informational SUBSET of outputTokens. Never a summand of any total, at any level. */
  reasoningTokens?: number | null;

  /** = freshInputTokens + cacheWriteTokens + cacheReadTokens. Derived, never independently sourced. */
  totalInputTokens: number | null;
  /** = totalInputTokens + outputTokens. Derived, never independently sourced. */
  totalTokens: number | null;

  provenance: Provenance;
  /** Free text, always populated. Says which event produced the record and what was done to it. */
  provenanceNote: string;

  source: {
    runtimeVersion: string | null;
    /** The event kind the record was built from, or null when no such event existed. */
    eventKind: string | null;
  };

  /** false whenever the record does not account for the whole attempt. */
  complete: boolean;
}

/**
 * Stored record: core plus the six extensions usage-normalization.md §1.2 requires for
 * auditability. None of these may appear in a headline figure.
 */
export interface UsageRecord extends Usage {
  /** Which vendor structure the record was normalized from. Auditability of §2. */
  usageBasis: "result.usage" | "modelUsage" | "turn.completed" | "fixture" | "none";

  /** The runtime's own conversation handle, needed to audit the Codex delta rule. */
  sessionRef: { kind: "claude-session" | "codex-thread"; id: string } | null;

  /** The vendor usage counter at the START of this attempt, stored verbatim in the vendor's own
   *  field names. All-zero for codex in the MVP — every attempt is its own process and a
   *  process counts only itself (SPIKE-4 D4) — and null for runtimes that report per call. */
  usageAtAttemptStart: Record<string, number> | null;

  /** Vendor client-side list-price estimate, stored verbatim, never recomputed. §5.2. */
  listPriceEquivalentUsd: number | null;

  /** Per-model split when the runtime reports one. The four buckets of the parent record MUST
   *  equal the element-wise sum of this array. */
  perModel: Array<{
    model: string;
    freshInputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    /** Same rule as the parent's reasoningTokens: reference only, never summed. */
    reasoningTokens: number | null;
    totalInputTokens: number;
    totalTokens: number;
    listPriceEquivalentUsd: number | null;
    costBasis: "list" | "managed" | "unknown" | null;
  }> | null;
}

/**
 * One unmeasured agent Node Execution, as listed in a Coverage's `unmeasured[]` (§4.3, and the
 * shape used by every fixture's `expected.coverage.unmeasured[]`, e.g.
 * docs/spec/usage-fixtures/claude-recorded-sigint.json).
 */
export interface UnmeasuredExecution {
  cycleIndex: number;
  nodeId: string;
  attempt: number;
  runtime: string;
  /** Taken verbatim from the record's `provenanceNote` (§4.3 rule 3). */
  reason: string;
}

/**
 * Usage Coverage of a scope (Cycle, Run or Loop window): the share of agent Node Executions
 * whose usage provenance is `reported` or `derived` (§4.1-§4.2).
 */
export interface Coverage {
  /** Node Executions of kind `agent` dispatched at least once, in any state except SKIPPED. */
  agentExecutions: number;
  /** Of those, the ones whose aggregated record is `reported`/`derived` AND fully `complete`. */
  measuredExecutions: number;
  /** measuredExecutions / agentExecutions. `NaN`-free: 0 when agentExecutions is 0. */
  coverage: number;
  unmeasured: UnmeasuredExecution[];
}

/**
 * The four token buckets, summed element-wise (§3.2), for one aggregation scope (Node
 * Execution, Cycle, Run or Loop window, §3.1).
 */
export interface AggregateUsage {
  freshInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** = freshInputTokens + cacheWriteTokens + cacheReadTokens. */
  totalInputTokens: number;
  /** = totalInputTokens + outputTokens. */
  totalTokens: number;
  /** The weakest provenance among contributing records, order `reported > derived > estimated`
   *  (§3.2 "Aggregate provenance"). `unavailable` records are excluded from the sum and counted
   *  against `coverage` instead, never folded into this field. */
  provenance: Exclude<Provenance, "unavailable">;
  /** True iff every contributing record is measured (§4.1); mirrors `coverage.coverage === 1`. */
  measured: boolean;
  coverage: Coverage;
}
