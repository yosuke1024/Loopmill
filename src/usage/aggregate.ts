// Aggregation up the chain Attempt -> Node Execution -> Cycle -> Run (docs/spec/
// usage-normalization.md §3). Sums are element-wise over the four buckets; `estimated` and
// `unavailable` records never enter a headline sum (§3.2, invariant I11); aggregate provenance is
// the weakest contributor (`reported > derived`, `unavailable` excluded — §3.2 "Aggregate
// provenance"); a reported-but-incomplete record (claude-code `aborted_streaming`) still
// contributes its figure to the sum as a lower bound even though it does not count as measured
// (§3.3), which is why "summable" and "measured" are two different predicates below.

import type { AggregateUsage, UsageRecord, UnmeasuredExecution, Provenance } from "../types/usage.ts";
import { isMeasured } from "./record.ts";

/** The identity of one Attempt, exactly `docs/spec/usage-normalization.md` §1's `(runId,
 * cycleIndex, nodeId, attempt)` minus `runId` (the caller already knows which Run it is
 * aggregating). */
export interface UsageAttemptKey {
  cycleIndex: number;
  nodeId: string;
  attempt: number;
}

export interface KeyedUsageRecord {
  key: UsageAttemptKey;
  usage: UsageRecord;
}

type SummableProvenance = Exclude<Provenance, "unavailable" | "estimated">;

/** §3.2: only `reported`/`derived` records ever enter a headline sum. `unavailable` records have
 * nothing to add (§3.2); `estimated` records are excluded from every headline (I11) even though
 * they carry numbers, because a headline MUST be homogeneous in measurement status. */
function summable(records: UsageRecord[]): UsageRecord[] {
  return records.filter((r) => r.provenance === "reported" || r.provenance === "derived");
}

function sumBuckets(records: UsageRecord[]): {
  freshInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  totalTokens: number;
} {
  let fresh = 0;
  let write = 0;
  let read = 0;
  let output = 0;
  for (const r of records) {
    fresh += r.freshInputTokens ?? 0;
    write += r.cacheWriteTokens ?? 0;
    read += r.cacheReadTokens ?? 0;
    output += r.outputTokens ?? 0;
  }
  const totalInputTokens = fresh + write + read;
  return {
    freshInputTokens: fresh,
    cacheWriteTokens: write,
    cacheReadTokens: read,
    outputTokens: output,
    totalInputTokens,
    totalTokens: totalInputTokens + output,
  };
}

/** `reported > derived`, per §3.2. `undefined` when there is nothing summable to weigh. */
function weakestProvenance(records: UsageRecord[]): SummableProvenance | undefined {
  if (records.length === 0) return undefined;
  return records.some((r) => r.provenance === "derived") ? "derived" : "reported";
}

/**
 * The base fold: sums an arbitrary bag of Attempt records and reports their coverage, treating
 * each record as one countable unit. `Decision (not in sheet)`: a bare `UsageRecord` carries no
 * `(cycleIndex, nodeId, attempt)` identity, so an unmeasured record's `Coverage.unmeasured[]`
 * entry here is necessarily synthetic (`nodeId: "record-<n>"`); callers that have real identity
 * (the engine, replaying `(key, usage)` pairs) should use `aggregateNodeExecution`/
 * `aggregateCycle`/`aggregateRun` instead, which build the real entry.
 */
export function aggregateRecords(records: UsageRecord[]): AggregateUsage {
  const summableRecords = summable(records);
  const sums = sumBuckets(summableRecords);
  const provenance: SummableProvenance = weakestProvenance(summableRecords) ?? "reported";

  const unmeasured: UnmeasuredExecution[] = [];
  let measuredCount = 0;
  records.forEach((r, i) => {
    if (isMeasured(r)) {
      measuredCount++;
    } else {
      unmeasured.push({
        cycleIndex: 0,
        nodeId: `record-${i + 1}`,
        attempt: 1,
        runtime: r.runtime,
        reason: r.provenanceNote,
      });
    }
  });

  return {
    ...sums,
    provenance,
    measured: records.length > 0 && measuredCount === records.length,
    coverage: {
      agentExecutions: records.length,
      measuredExecutions: measuredCount,
      coverage: records.length === 0 ? 0 : measuredCount / records.length,
      unmeasured,
    },
  };
}

/**
 * §3.1/§3.5: one Node Execution's aggregate over all of its Attempts (every dispatched attempt,
 * retried or not — "there is no de-duplication"). The execution counts as ONE unit in coverage: it
 * is measured iff every one of its attempts is (§4.1's "every contributing attempt has
 * complete === true").
 */
export function aggregateNodeExecution(attempts: KeyedUsageRecord[]): AggregateUsage {
  const records = attempts.map((a) => a.usage);
  const summableRecords = summable(records);
  const sums = sumBuckets(summableRecords);
  const provenance: SummableProvenance = weakestProvenance(summableRecords) ?? "reported";
  const measured = attempts.length > 0 && attempts.every((a) => isMeasured(a.usage));

  const last = attempts[attempts.length - 1];
  const unmeasured: UnmeasuredExecution[] =
    !measured && last
      ? [
          {
            cycleIndex: last.key.cycleIndex,
            nodeId: last.key.nodeId,
            attempt: last.key.attempt,
            runtime: last.usage.runtime,
            reason: last.usage.provenanceNote,
          },
        ]
      : [];

  return {
    ...sums,
    provenance,
    measured,
    coverage: {
      agentExecutions: attempts.length > 0 ? 1 : 0,
      measuredExecutions: measured ? 1 : 0,
      coverage: attempts.length === 0 ? 0 : measured ? 1 : 0,
      unmeasured,
    },
  };
}

function groupByNodeExecution(attempts: KeyedUsageRecord[]): KeyedUsageRecord[][] {
  const map = new Map<string, KeyedUsageRecord[]>();
  for (const a of attempts) {
    const k = `${a.key.cycleIndex}:${a.key.nodeId}`;
    const list = map.get(k);
    if (list) {
      list.push(a);
    } else {
      map.set(k, [a]);
    }
  }
  return [...map.values()];
}

/** Combines several Node Execution aggregates (a Cycle's, or a Run's) into one. Only aggregates
 * that actually contributed a non-zero bucket sum weigh in on the combined provenance — an
 * all-`unavailable` node execution contributes nothing and must not silently make an otherwise
 * fully-`reported` scope look weaker than it is. */
function combineAggregates(aggs: AggregateUsage[]): AggregateUsage {
  let fresh = 0;
  let write = 0;
  let read = 0;
  let output = 0;
  let agentExecutions = 0;
  let measuredExecutions = 0;
  const unmeasured: UnmeasuredExecution[] = [];
  let sawDerived = false;
  let sawContribution = false;

  for (const a of aggs) {
    fresh += a.freshInputTokens;
    write += a.cacheWriteTokens;
    read += a.cacheReadTokens;
    output += a.outputTokens;
    agentExecutions += a.coverage.agentExecutions;
    measuredExecutions += a.coverage.measuredExecutions;
    unmeasured.push(...a.coverage.unmeasured);

    const contributed = a.freshInputTokens + a.cacheWriteTokens + a.cacheReadTokens + a.outputTokens > 0;
    if (contributed) {
      sawContribution = true;
      if (a.provenance === "derived") sawDerived = true;
    }
  }

  const totalInputTokens = fresh + write + read;
  const totalTokens = totalInputTokens + output;
  return {
    freshInputTokens: fresh,
    cacheWriteTokens: write,
    cacheReadTokens: read,
    outputTokens: output,
    totalInputTokens,
    totalTokens,
    provenance: sawContribution ? (sawDerived ? "derived" : "reported") : "reported",
    measured: agentExecutions > 0 && measuredExecutions === agentExecutions,
    coverage: {
      agentExecutions,
      measuredExecutions,
      coverage: agentExecutions === 0 ? 0 : measuredExecutions / agentExecutions,
      unmeasured,
    },
  };
}

/** §3.1: one Cycle's aggregate — the union of its Node Executions' aggregates. */
export function aggregateCycle(attempts: KeyedUsageRecord[], cycleIndex: number): AggregateUsage {
  const inCycle = attempts.filter((a) => a.key.cycleIndex === cycleIndex);
  const nodeAggs = groupByNodeExecution(inCycle).map(aggregateNodeExecution);
  return combineAggregates(nodeAggs);
}

/** §3.1/I15: one Run's aggregate over every Cycle, cycle 0 included — the caller passes every
 * attempt of the Run (cycle 0's included) and this function does not filter by cycle at all. */
export function aggregateRun(attempts: KeyedUsageRecord[]): AggregateUsage {
  const nodeAggs = groupByNodeExecution(attempts).map(aggregateNodeExecution);
  return combineAggregates(nodeAggs);
}
