// The two pure numbers a budget check needs before dispatch (docs/spec/usage-normalization.md
// §6.2, §6.5). The dispatch-time decision itself (comparing these against the Loop file's
// `maxMeasuredTokens`/`maxUnmeasuredExecutions` and producing a `BUDGET_EXCEEDED` outcome) is the
// engine's, not this module's — `usage/` only supplies the measurements.

import type { Coverage, UsageRecord } from "../types/usage.ts";

/**
 * §6.2: `maxMeasuredTokens` is evaluated against `Σ totalTokens` over Attempt records with
 * provenance in `{reported, derived}` — **regardless of `complete`**. This is deliberately not
 * the same population as Usage Coverage's "measured" (§4.1, which additionally requires
 * `complete === true`): a claude-code attempt interrupted by SIGINT (`reported`, `complete:
 * false`) still counts its tokens toward the budget, because those tokens were still spent, even
 * though the same attempt is *unmeasured* for coverage purposes.
 */
export function measuredTokens(records: UsageRecord[]): number {
  let sum = 0;
  for (const r of records) {
    if (r.provenance === "reported" || r.provenance === "derived") {
      sum += r.totalTokens ?? 0;
    }
  }
  return sum;
}

/** §6.2: the count `maxUnmeasuredExecutions` is checked against — agent Node Executions whose
 * usage provenance is `unavailable` or `estimated` (i.e. every agent execution that Usage
 * Coverage does not count as measured). */
export function unmeasuredExecutions(coverage: Coverage): number {
  return coverage.agentExecutions - coverage.measuredExecutions;
}
