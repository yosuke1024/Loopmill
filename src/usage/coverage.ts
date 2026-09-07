// Usage Coverage: the share of agent Node Executions whose usage provenance is `reported` or
// `derived` AND fully `complete` (docs/spec/usage-normalization.md §4.1-§4.2).

import type { Coverage, UnmeasuredExecution, UsageRecord } from "../types/usage.ts";
import { isMeasured } from "./record.ts";

/** One Node Execution as coverage needs to see it: identity, its `kind` (only `"agent"` ever
 * counts, §4.1), its terminal-or-not `state` (a `"SKIPPED"` execution counts in neither term),
 * and the usage record that represents it (its last/only attempt — `null` when the execution was
 * dispatched but produced no record at all, which still counts as unmeasured). */
export interface CoverageExecutionInput {
  cycleIndex: number;
  nodeId: string;
  attempt: number;
  runtime: string;
  kind: "agent" | string;
  state: string;
  usage: UsageRecord | null;
}

/**
 * §4.1: `agentExecutions` counts Node Executions of kind `agent` that were dispatched at least
 * once, in any state except `SKIPPED` — command/condition/human/end nodes are never counted, in
 * numerator or denominator (I10). A Node Execution is `measured` iff its record's provenance is
 * `reported`/`derived` and `complete === true`; an `estimated` record, or no record at all, counts
 * as unmeasured.
 */
export function computeCoverage(executions: CoverageExecutionInput[]): Coverage {
  const agentExecutions = executions.filter((e) => e.kind === "agent" && e.state !== "SKIPPED");

  let measuredExecutions = 0;
  const unmeasured: UnmeasuredExecution[] = [];
  for (const e of agentExecutions) {
    if (e.usage && isMeasured(e.usage)) {
      measuredExecutions++;
    } else {
      unmeasured.push({
        cycleIndex: e.cycleIndex,
        nodeId: e.nodeId,
        attempt: e.attempt,
        runtime: e.runtime,
        reason: e.usage ? e.usage.provenanceNote : "no usage record was produced for this execution",
      });
    }
  }

  return {
    agentExecutions: agentExecutions.length,
    measuredExecutions,
    coverage: agentExecutions.length === 0 ? 0 : measuredExecutions / agentExecutions.length,
    unmeasured,
  };
}
