// The run report (mvp-design.md §17.2; state-machine.md §12.3): written once, when a Run
// reaches a terminal state, to `.loopmill/reports/<runId>.md` and `.json`. Contains the outcome,
// the last five events, a per-cycle node table, measured tokens with coverage, artifact refs,
// and — for a `FAILED` run — the failing node's effective command line and a redacted stderr
// tail, plus the exact commands to reproduce.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aggregateRun, computeCoverage, renderCoverage, renderMeasuredTokens, type KeyedUsageRecord } from "../usage/index.ts";
import { tail } from "../backends/local/logs.ts";
import type { Layout, SqliteStore, StoredEvent } from "../store/index.ts";
import type { ResolvedLoop } from "../types/loop.ts";
import type { AttemptRecord, RunSnapshot } from "../types/state.ts";
import { defaultDispatchers } from "./dispatchers.ts";

export interface WriteRunReportInput {
  layout: Layout;
  store: SqliteStore;
  loop: ResolvedLoop;
  runId: string;
  snapshot: RunSnapshot;
}

export interface WriteRunReportResult {
  markdownPath: string;
  jsonPath: string;
}

interface NodeRow {
  cycleIndex: number;
  nodeId: string;
  state: string;
  durationMs: number | null;
  totalTokens: number | null;
}

function nodeRows(snapshot: RunSnapshot): NodeRow[] {
  const rows: NodeRow[] = [];
  for (const record of Object.values(snapshot.nodes)) {
    const attempts = attemptsFor(snapshot, record.cycleIndex, record.nodeId);
    const last = attempts[attempts.length - 1];
    const durationMs =
      record.startedAt !== null && record.finishedAt !== null ? Date.parse(record.finishedAt) - Date.parse(record.startedAt) : null;
    rows.push({
      cycleIndex: record.cycleIndex,
      nodeId: record.nodeId,
      state: record.state,
      durationMs,
      totalTokens: last?.usage?.totalTokens ?? null,
    });
  }
  rows.sort((a, b) => a.cycleIndex - b.cycleIndex || a.nodeId.localeCompare(b.nodeId));
  return rows;
}

function attemptsFor(snapshot: RunSnapshot, cycleIndex: number, nodeId: string): AttemptRecord[] {
  return Object.values(snapshot.attempts)
    .filter((a) => a.cycleIndex === cycleIndex && a.nodeId === nodeId)
    .sort((a, b) => a.attempt - b.attempt);
}

/** Every agent node's attempts, keyed the way `usage/aggregate.ts`'s `KeyedUsageRecord[]` wants —
 * usage-normalization.md §4.1: only `kind: "agent"` Node Executions ever count, in numerator or
 * denominator, so a command node's `noAgentRanUsage()` placeholder is excluded here entirely
 * rather than being counted as an unmeasured agent execution. */
function agentAttempts(loop: ResolvedLoop, snapshot: RunSnapshot): KeyedUsageRecord[] {
  const out: KeyedUsageRecord[] = [];
  for (const attempt of Object.values(snapshot.attempts)) {
    const node = loop.nodes[attempt.nodeId];
    if (!node || node.kind !== "agent") continue;
    if (!attempt.usage) continue;
    out.push({ key: { cycleIndex: attempt.cycleIndex, nodeId: attempt.nodeId, attempt: attempt.attempt }, usage: attempt.usage });
  }
  return out;
}

function coverageOf(loop: ResolvedLoop, snapshot: RunSnapshot) {
  const executions = Object.values(snapshot.nodes)
    .filter((record) => loop.nodes[record.nodeId]?.kind === "agent")
    .map((record) => {
      const attempts = attemptsFor(snapshot, record.cycleIndex, record.nodeId);
      const last = attempts[attempts.length - 1];
      const node = loop.nodes[record.nodeId];
      return {
        cycleIndex: record.cycleIndex,
        nodeId: record.nodeId,
        attempt: last?.attempt ?? 1,
        runtime: (node && node.kind === "agent" ? node.runtime : "claude-code") as string,
        kind: "agent",
        state: record.state,
        usage: last?.usage ?? null,
      };
    });
  return computeCoverage(executions);
}

function lastEvents(store: SqliteStore, runId: string, n: number): StoredEvent[] {
  const all = store.readEvents(runId);
  return all.slice(Math.max(0, all.length - n));
}

/** Best-effort "effective command line" for the failing node — reconstructed via the `local`
 * dispatcher's own `describe()` on a throwaway request built from the same
 * inputs/workspace shape `run.ts`'s dispatch loop would have used. Falls back to `null` when the
 * node did not fail on the `local` backend (nothing to reconstruct — a `fake`-backend argv is
 * simulated, not real) or its inputs cannot be resolved after the fact (a later cycle may have
 * changed what a reference resolves to). */
function effectiveArgvForFailure(loop: ResolvedLoop, layout: Layout, snapshot: RunSnapshot): string[] | null {
  const outcome = snapshot.outcome;
  if (!outcome || outcome.state !== "FAILED" || outcome.nodeId === undefined || outcome.cycleIndex === undefined) return null;
  const node = loop.nodes[outcome.nodeId];
  if (!node || (node.kind !== "agent" && node.kind !== "command") || node.backend !== "local") return null;
  const attempts = attemptsFor(snapshot, outcome.cycleIndex, outcome.nodeId);
  const last = attempts[attempts.length - 1];
  if (!last) return null;
  try {
    const dispatcher = defaultDispatchers({ layout }).local!;
    const placeholderInputs: Record<string, string> = {};
    for (const name of Object.keys(node.inputs)) placeholderInputs[name] = `<${name}>`;
    const plan = dispatcher.describe({
      runId: snapshot.runId,
      loopId: snapshot.loopId,
      loopVersion: snapshot.loopVersion,
      slug: loop.slug,
      cycleIndex: outcome.cycleIndex,
      nodeId: outcome.nodeId,
      attempt: last.attempt,
      node,
      inputs: placeholderInputs,
      workspace: {
        repoRoot: "<repoRoot>",
        worktreePath: join(layout.worktrees, snapshot.runId),
        branch: `loopmill/${loop.slug}/${snapshot.runId}`,
        baseCommit: "<baseCommit>",
      },
      env: loop.env,
      deadlineAt: last.deadlineAt ?? "<deadlineAt>",
      timeoutMs: node.timeoutMs ?? null,
      dedupeKey: "<dedupeKey>",
    });
    return plan.argv;
  } catch {
    return null;
  }
}

function stderrTailForFailure(layout: Layout, snapshot: RunSnapshot): string | null {
  const outcome = snapshot.outcome;
  if (!outcome || outcome.state !== "FAILED" || outcome.nodeId === undefined || outcome.cycleIndex === undefined) return null;
  const attempts = attemptsFor(snapshot, outcome.cycleIndex, outcome.nodeId);
  const last = attempts[attempts.length - 1];
  if (!last) return null;
  const path = join(layout.logs, snapshot.runId, `${outcome.cycleIndex}-${outcome.nodeId}-${last.attempt}.err`);
  try {
    const text = readFileSync(path, "utf8");
    return tail(text, 2000);
  } catch {
    return null;
  }
}

/** Writes `.loopmill/reports/<runId>.md` and `.json`, returns both paths (mvp-design.md §17.2).
 * Synchronous, matching the store's own design (`docs/design/m1-plan.md` §3: I/O modules are not
 * forced into `Promise` for its own sake). */
export function writeRunReport(input: WriteRunReportInput): WriteRunReportResult {
  const { layout, store, loop, runId, snapshot } = input;
  mkdirSync(layout.reports, { recursive: true });

  const usage = aggregateRun(agentAttempts(loop, snapshot));
  const coverage = coverageOf(loop, snapshot);
  const rows = nodeRows(snapshot);
  const events = lastEvents(store, runId, 5);
  const argv = effectiveArgvForFailure(loop, layout, snapshot);
  const stderrTail = stderrTailForFailure(layout, snapshot);

  const jsonBody = {
    runId,
    loopId: snapshot.loopId,
    loopVersion: snapshot.loopVersion,
    outcome: snapshot.outcome,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    cycles: { maxCycleIndex: snapshot.maxCycleIndex, traversals: snapshot.traversals, freeTraversals: snapshot.freeTraversals },
    duration: { activeMs: snapshot.budget.activeMs, waitMs: snapshot.budget.waitMs },
    tokens: { total: usage.totalTokens, rendered: renderMeasuredTokens(usage.totalTokens, coverage), coverage: renderCoverage(coverage), unmeasured: coverage.unmeasured },
    nodes: rows,
    artifactRefs: snapshot.artifactRefs,
    lastEvents: events.map((e) => ({ seq: e.seq, eventType: e.eventType, occurredAt: e.envelope.occurredAt, nodeId: e.envelope.nodeId ?? null, cycle: e.envelope.cycle ?? null })),
    failure: snapshot.outcome && snapshot.outcome.state === "FAILED" ? { argv, stderrTail } : null,
    reproduce: {
      logs: `loopmill logs ${runId}`,
      dryRun: `loopmill run ${loop.slug} --dry-run`,
    },
  };

  const jsonPath = join(layout.reports, `${runId}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(jsonBody, null, 2)}\n`, "utf8");

  const md: string[] = [];
  md.push(`# Run ${runId}`);
  md.push("");
  md.push(`Loop: ${snapshot.loopId} @ ${snapshot.loopVersion}`);
  md.push(`Outcome: ${snapshot.outcome ? renderOutcome(snapshot.outcome) : "(none)"}`);
  md.push(`Cycles: ${snapshot.maxCycleIndex}`);
  md.push(`Duration: ${snapshot.budget.activeMs}ms active + ${snapshot.budget.waitMs}ms waiting`);
  md.push(`Measured Tokens: ${renderMeasuredTokens(usage.totalTokens, coverage)}`);
  md.push(`Usage Coverage: ${renderCoverage(coverage)}`);
  if (coverage.unmeasured.length > 0) {
    md.push(`Unmeasured: ${coverage.unmeasured.map((u) => `${u.nodeId} (cycle ${u.cycleIndex})`).join(", ")}`);
  }
  md.push("");
  md.push("## Last five events");
  for (const e of events) {
    md.push(`- [${e.seq}] ${e.eventType} ${e.envelope.nodeId ? `(${e.envelope.nodeId}, cycle ${e.envelope.cycle})` : ""} at ${e.envelope.occurredAt}`);
  }
  md.push("");
  md.push("## Nodes");
  md.push("| cycle | node | state | duration (ms) | tokens |");
  md.push("|---|---|---|---|---|");
  for (const r of rows) {
    md.push(`| ${r.cycleIndex} | ${r.nodeId} | ${r.state} | ${r.durationMs ?? "-"} | ${r.totalTokens ?? "-"} |`);
  }
  md.push("");
  md.push("## Artifacts");
  if (snapshot.artifactRefs.length === 0) {
    md.push("(none)");
  } else {
    for (const ref of snapshot.artifactRefs) {
      md.push(`- ${ref.kind}: ${ref.ref}${ref.url ? ` (${ref.url})` : ""}`);
    }
  }
  if (snapshot.outcome && snapshot.outcome.state === "FAILED") {
    md.push("");
    md.push("## Failure detail");
    md.push(`Node: ${snapshot.outcome.nodeId ?? "(unknown)"} (cycle ${snapshot.outcome.cycleIndex ?? "?"})`);
    md.push(`Effective argv: ${argv ? JSON.stringify(argv) : "(unavailable)"}`);
    md.push("Redacted stderr tail:");
    md.push("```");
    md.push(stderrTail ?? "(no captured log)");
    md.push("```");
  }
  md.push("");
  md.push("## Reproduce");
  md.push(`- \`loopmill logs ${runId}\``);
  md.push(`- \`loopmill run ${loop.slug} --dry-run\``);
  md.push("");

  const markdownPath = join(layout.reports, `${runId}.md`);
  writeFileSync(markdownPath, md.join("\n"), "utf8");

  return { markdownPath, jsonPath };
}

function renderOutcome(outcome: RunSnapshot["outcome"]): string {
  if (!outcome) return "(none)";
  switch (outcome.state) {
    case "SUCCEEDED":
      return `SUCCEEDED(end:${outcome.label})`;
    case "FAILED":
      return `FAILED(${outcome.failureReason})`;
    case "MAX_ITERATIONS_EXCEEDED":
      return `MAX_ITERATIONS_EXCEEDED(${outcome.edgeId}, ${outcome.traversals}/${outcome.maxIterations})`;
    case "BUDGET_EXCEEDED":
      return `BUDGET_EXCEEDED(${outcome.budgetKey}, ${outcome.observed}/${outcome.limit})`;
    case "EXPIRED":
      return `EXPIRED(${outcome.expiryReason})`;
    case "CANCELLED":
      return `CANCELLED(by:${outcome.by})`;
    case "SKIPPED":
      return `SKIPPED(${outcome.skipReason})`;
    default:
      return String((outcome as { state: string }).state);
  }
}
