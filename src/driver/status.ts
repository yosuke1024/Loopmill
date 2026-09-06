// `loopmill status` / `runs` / `logs` (mvp-design.md §15.2): read-only views over the store.
// Every entrypoint sweeps first (mvp-design.md §7.5) — these three included, since a stale
// `status` reading "RUNNING" forever on a Run whose process died is exactly the silence
// mvp-design.md §17.4 says must never happen.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_POLICY_FULL, type EnginePolicyFull } from "../engine/index.ts";
import { aggregateRun, computeCoverage, renderCoverage, renderMeasuredTokens } from "../usage/index.ts";
import { tail } from "../backends/local/logs.ts";
import type { ListRunsOptions, RunListEntry } from "../store/sqlite.ts";
import type { AttemptRecord, RunSnapshot } from "../types/state.ts";
import type { RunContext } from "./context.ts";
import { runSweep } from "./sweep.ts";

function sweepFirst(ctx: RunContext, policy: EnginePolicyFull): void {
  runSweep({ store: ctx.store, clock: ctx.clock, loops: (loopId) => (loopId === ctx.loop.slug ? ctx.loop : null), policy });
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

export interface StatusView {
  runId: string;
  loopId: string;
  loopVersion: string;
  state: string;
  currentNode: string | null;
  cycleIndex: number;
  maxCycleIndex: number;
  traversals: Record<string, number>;
  elapsedMs: number;
  activeMs: number;
  waitMs: number;
  tokensTotal: number;
  tokensRendered: string;
  coverage: string;
  artifactRefs: RunSnapshot["artifactRefs"];
  next: string;
}

function agentUsagePairs(ctx: RunContext, snapshot: RunSnapshot) {
  const out: Array<{ key: { cycleIndex: number; nodeId: string; attempt: number }; usage: NonNullable<AttemptRecord["usage"]> }> = [];
  for (const attempt of Object.values(snapshot.attempts)) {
    const node = ctx.loop.nodes[attempt.nodeId];
    if (!node || node.kind !== "agent" || !attempt.usage) continue;
    out.push({ key: { cycleIndex: attempt.cycleIndex, nodeId: attempt.nodeId, attempt: attempt.attempt }, usage: attempt.usage });
  }
  return out;
}

function coverageOf(ctx: RunContext, snapshot: RunSnapshot) {
  const executions = Object.values(snapshot.nodes)
    .filter((record) => ctx.loop.nodes[record.nodeId]?.kind === "agent")
    .map((record) => {
      const attempts = Object.values(snapshot.attempts)
        .filter((a) => a.cycleIndex === record.cycleIndex && a.nodeId === record.nodeId)
        .sort((a, b) => a.attempt - b.attempt);
      const last = attempts[attempts.length - 1];
      const node = ctx.loop.nodes[record.nodeId];
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

function nextDescription(snapshot: RunSnapshot): string {
  if (snapshot.status === "WAITING_HUMAN" && snapshot.pendingApproval) {
    const p = snapshot.pendingApproval;
    return `human-decided (${p.mode}) for nodes.${p.subject.ref}, expires ${p.expiresAt}`;
  }
  if (snapshot.status === "WAITING_FOR_QUOTA" && snapshot.quota) {
    return `resumed{kind:due} after ${snapshot.quota.resumeDueAt}`;
  }
  if (snapshot.status === "INTERRUPTED") {
    return "resumed{kind:interrupted} (resume is m2)";
  }
  if (snapshot.current) {
    return `node-completed/node-failed/node-timed-out for ${snapshot.current.nodeId} (cycle ${snapshot.current.cycleIndex}, attempt ${snapshot.current.attempt})`;
  }
  return "nothing — terminal.";
}

export function statusOf(ctx: RunContext, which: string | "last", policy: EnginePolicyFull = DEFAULT_POLICY_FULL): StatusView | null {
  sweepFirst(ctx, policy);

  let runId: string | null;
  if (which === "last") {
    const runs = ctx.store.listRuns({ loopId: ctx.loop.slug, limit: 1 });
    runId = runs[0]?.runId ?? null;
  } else {
    runId = which;
  }
  if (!runId) return null;

  const snapshot = ctx.store.read(runId);
  if (!snapshot) return null;

  const usage = aggregateRun(agentUsagePairs(ctx, snapshot));
  const coverage = coverageOf(ctx, snapshot);
  const endMs = snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : Date.parse(ctx.clock.now());
  const startMs = snapshot.startedAt ? Date.parse(snapshot.startedAt) : endMs;

  return {
    runId,
    loopId: snapshot.loopId,
    loopVersion: snapshot.loopVersion,
    state: snapshot.status,
    currentNode: snapshot.current?.nodeId ?? null,
    cycleIndex: snapshot.cycleIndex,
    maxCycleIndex: snapshot.maxCycleIndex,
    traversals: snapshot.traversals,
    elapsedMs: Math.max(0, endMs - startMs),
    activeMs: snapshot.budget.activeMs,
    waitMs: snapshot.budget.waitMs,
    tokensTotal: usage.totalTokens,
    tokensRendered: renderMeasuredTokens(usage.totalTokens, coverage),
    coverage: renderCoverage(coverage),
    artifactRefs: snapshot.artifactRefs,
    next: nextDescription(snapshot),
  };
}

// ---------------------------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------------------------

export interface RunsViewEntry extends RunListEntry {
  tokensRendered: string;
  coverage: string;
}

export function listRunsView(ctx: RunContext, opts: ListRunsOptions = {}, policy: EnginePolicyFull = DEFAULT_POLICY_FULL): RunsViewEntry[] {
  sweepFirst(ctx, policy);
  const entries = ctx.store.listRuns(opts);
  return entries.map((entry) => {
    const snapshot = ctx.store.read(entry.runId);
    if (!snapshot) {
      return { ...entry, tokensRendered: "0", coverage: "0/0 (100%)" };
    }
    const usage = aggregateRun(agentUsagePairs(ctx, snapshot));
    const coverage = coverageOf(ctx, snapshot);
    return { ...entry, tokensRendered: renderMeasuredTokens(usage.totalTokens, coverage), coverage: renderCoverage(coverage) };
  });
}

// ---------------------------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------------------------

export interface LogsAttemptView {
  attempt: number;
  state: string;
  usage: AttemptRecord["usage"];
  artifactRefs: AttemptRecord["artifactRefs"];
  error: AttemptRecord["error"];
  stdoutPath: string;
  stderrPath: string;
  stdoutTail: string | null;
  stderrTail: string | null;
}

export interface LogsNodeView {
  cycleIndex: number;
  nodeId: string;
  state: string;
  structured: unknown;
  stdout: string | null;
  exitCode: number | null;
  attempts: LogsAttemptView[];
}

function readTail(path: string, bytes: number): string | null {
  try {
    return tail(readFileSync(path, "utf8"), bytes);
  } catch {
    return null;
  }
}

export function logsOf(
  ctx: RunContext,
  runId: string,
  opts: { node?: string; cycle?: number } = {},
  policy: EnginePolicyFull = DEFAULT_POLICY_FULL,
): LogsNodeView[] {
  sweepFirst(ctx, policy);
  const snapshot = ctx.store.read(runId);
  if (!snapshot) return [];

  const nodes = Object.values(snapshot.nodes).filter(
    (n) => (opts.node === undefined || n.nodeId === opts.node) && (opts.cycle === undefined || n.cycleIndex === opts.cycle),
  );

  return nodes
    .sort((a, b) => a.cycleIndex - b.cycleIndex || a.nodeId.localeCompare(b.nodeId))
    .map((n) => {
      const attempts = Object.values(snapshot.attempts)
        .filter((a) => a.cycleIndex === n.cycleIndex && a.nodeId === n.nodeId)
        .sort((a, b) => a.attempt - b.attempt)
        .map((a): LogsAttemptView => {
          const stdoutPath = join(ctx.layout.logs, runId, `${n.cycleIndex}-${n.nodeId}-${a.attempt}.out`);
          const stderrPath = join(ctx.layout.logs, runId, `${n.cycleIndex}-${n.nodeId}-${a.attempt}.err`);
          return {
            attempt: a.attempt,
            state: a.state,
            usage: a.usage,
            artifactRefs: a.artifactRefs,
            error: a.error,
            stdoutPath,
            stderrPath,
            stdoutTail: readTail(stdoutPath, 2000),
            stderrTail: readTail(stderrPath, 2000),
          };
        });
      return {
        cycleIndex: n.cycleIndex,
        nodeId: n.nodeId,
        state: n.state,
        structured: n.structured,
        stdout: n.stdout,
        exitCode: n.exitCode,
        attempts,
      };
    });
}
