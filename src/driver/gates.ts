// `loopmill approve|reject <runId>`: records a `cli`-mode human decision and, when the resulting
// transition dispatches more work, continues the Run in the same process (mvp-design.md §12,
// §15.2). Exit codes match `run`'s own (state-machine.md §12.2) — this is a resumed `run`, not a
// different command family.

import { hostname } from "node:os";

import { DEFAULT_POLICY_FULL, type EnginePolicyFull } from "../engine/index.ts";
import { makeEnvelope } from "../envelope/index.ts";
import type { Dispatcher } from "../types/interfaces.ts";
import type { JsonValue } from "../types/loop.ts";
import { LoopmillError } from "../util/errors.ts";
import { formatRfc3339, parseRfc3339 } from "../util/time.ts";
import type { Clock, RunContext } from "./context.ts";
import { runSweep } from "./sweep.ts";
import { applyStep } from "./step.ts";
import { continueRun, type RunLoopResult, type Writer } from "./run.ts";
import { defaultDispatchers } from "./dispatchers.ts";

export interface DecideGateInput {
  ctx: RunContext;
  runId: string;
  decision: "approve" | "reject" | "cancel";
  actor: string;
  note?: string;
  clock: Clock;
  /** Decision (not in sheet), m1: not part of this task's own `decideGate` signature, which
   * lists only `{ ctx, runId, decision, actor, note?, clock }`. Continuing a Run after the
   * decision (mvp-design.md §12: "continues the Run in the same process") needs a dispatcher
   * map the same way `run.ts` does, so this is added as an optional field, defaulting to a
   * fresh `local`-only map built from `ctx.layout` (`dispatchers.ts`'s own defaults) — the same
   * thing a bare `loopmill approve <runId>` gets on the command line. A caller that needs the
   * `fake` backend (every test that drives a gate to completion without real CLIs) passes its
   * own map explicitly. **Report**: `driver/gates.ts`'s brief should probably list this field.
   */
  dispatchers?: Record<string, Dispatcher>;
  policy?: EnginePolicyFull;
  heartbeatSeconds?: number;
  json?: boolean;
  stdout?: Writer;
  stderr?: Writer;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Builds `human-decided` from the Run's own `pendingApproval` (never from a caller-supplied
 * digest — mvp-design.md §12: "the subject digest is checked", and the only digest that can
 * possibly match is the one the pending gate itself recorded) and applies it; if the resulting
 * transition dispatches further work, continues the Run exactly as `run.ts`'s own dispatch loop
 * would, in this same process, holding this same loop's lock for the duration (mvp-design.md
 * §12's "continues the Run in the same process" — one Run per loop at a time applies here too).
 */
export async function decideGate(input: DecideGateInput): Promise<RunLoopResult> {
  const { ctx, clock } = input;
  const policy = input.policy ?? DEFAULT_POLICY_FULL;
  const stdout = input.stdout ?? { write: (s: string) => void process.stdout.write(s) };
  const stderr = input.stderr ?? { write: (s: string) => void process.stderr.write(s) };
  const heartbeatSeconds = input.heartbeatSeconds ?? 30;
  const dispatchers = input.dispatchers ?? defaultDispatchers({ layout: ctx.layout });

  // Every entrypoint sweeps first (mvp-design.md §7.5).
  runSweep({ store: ctx.store, clock, loops: (loopId) => (loopId === ctx.loop.slug ? ctx.loop : null), policy });

  const snapshot = ctx.store.read(input.runId);
  if (!snapshot) {
    stderr.write(`loopmill: run_not_found: no run ${input.runId}\n`);
    return { exitCode: 2, runId: input.runId, outcome: null, state: null };
  }
  if (snapshot.status !== "WAITING_HUMAN" || !snapshot.pendingApproval) {
    stderr.write(`loopmill: no pending human gate on run ${input.runId} (state: ${snapshot.status})\n`);
    return { exitCode: 2, runId: input.runId, outcome: null, state: snapshot.status };
  }
  const pending = snapshot.pendingApproval;

  const now0 = clock.now();
  const nowMs0 = parseRfc3339(now0);
  const leaseUntil = formatRfc3339(nowMs0 + policy.dispatchGraceSeconds * 1000);
  const acquireResult = ctx.store.acquireLock({
    loopId: ctx.loop.slug,
    runId: input.runId,
    ownerPid: process.pid,
    host: hostname(),
    now: now0,
    leaseUntil,
  });
  if (!acquireResult.acquired) {
    const holder = acquireResult.holder;
    stderr.write(`skipped: overlapping_run (held by pid ${holder.ownerPid} on ${holder.host} until ${holder.leaseUntil})\n`);
    return { exitCode: 15, runId: input.runId, outcome: null, state: snapshot.status };
  }

  try {
    const humanDecidedEnvelope = makeEnvelope(
      {
        eventType: "human-decided",
        producer: "human",
        loopId: snapshot.loopId,
        loopVersion: snapshot.loopVersion,
        runId: input.runId,
        cycle: pending.cycleIndex,
        nodeId: pending.nodeId,
        attempt: 0,
        human: {
          decision: input.decision,
          subjectDigest: pending.subject.digest,
          decidedBy: input.actor,
          ...(input.note !== undefined ? { note: input.note } : {}),
        },
      },
      { now: now0 },
    );

    const stepOut = applyStep({ ctx, envelope: humanDecidedEnvelope, clock, sweepFirst: false, skipLockCheck: true, policy });
    if (!stepOut.result || stepOut.result.kind === "invalid") {
      stderr.write(`loopmill: human-decided was rejected for run ${input.runId}\n`);
      return { exitCode: 2, runId: input.runId, outcome: null, state: snapshot.status };
    }

    return await continueRun({
      ctx,
      dispatchers,
      policy,
      clock,
      trigger: toJsonValue(stepOut.result.snapshot.trigger),
      heartbeatSeconds,
      stdout,
      ...(input.json !== undefined ? { json: input.json } : {}),
      runId: input.runId,
      result: stepOut.result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`loopmill: gate decision failed: ${message}\n`);
    const exitCode = err instanceof LoopmillError ? err.exitCode : 1;
    return { exitCode, runId: input.runId, outcome: null, state: null };
  } finally {
    ctx.store.releaseLock(ctx.loop.slug, input.runId);
  }
}
