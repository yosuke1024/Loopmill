// `loopmill resume`: un-parks a `WAITING_FOR_QUOTA` or `INTERRUPTED` Run (state-machine.md event
// row 16, R-40..R-42, R-48..R-50) and, when the resulting transition dispatches more work,
// continues the Run in the same process — the same shape `gates.ts`'s `decideGate` already uses
// for `human-decided` (mvp-design.md §12: "continues the Run in the same process"; `gates.ts`'s
// own doc comment: "this is a resumed `run`, not a different command family" — exit codes match
// `run`'s own, state-machine.md §12.2, unchanged here). Two entrypoints: `resumeRun` drives one
// named Run (`loopmill resume <runId>`), `resumeDue` drains every `WAITING_FOR_QUOTA` Run whose
// `quota.resumeDueAt` has passed (`loopmill resume --due`, mvp-design.md §7.5's "drain the gates"
// paragraph, A37).
//
// Deviations from this task's own brief, both forced by the frozen contract:
//
// 1. The `resumed` envelope carries no `cycle`/`nodeId`/`attempt`. `envelope.schema.json`'s own
//    conditional list (`"$comment": "Run-level events carry no node coordinates at all"`) names
//    `resumed` alongside `run-requested`/`run-started`/`run-finished` and sets
//    `cycle`/`nodeId`/`attempt` to the JSON Schema `false` subschema — present at all is a schema
//    failure, not merely unrequired. `engine/stale.ts`'s own `staleForResumed` doc comment says
//    the same thing directly: "`resumed` carries no node coordinates (it is Run-scoped, not in
//    `NODE_LEVEL_EVENT_TYPES`)". The engine agrees in practice: `applyWaitingForQuota` and
//    `applyInterrupted` (`engine/transition.ts`) both read `snapshot.current`/`snapshot.interrupted`
//    for their coordinates and never touch `event.cycle`/`event.nodeId`/`event.attempt` at all.
//    This task's brief asked for the interrupted record's `cycleIndex`/`nodeId` and `attempt: 0`
//    on the envelope, the way `gates.ts` sets them for `human-decided` — but `human-decided` *is*
//    a node-level event type (`NODE_LEVEL_EVENT_TYPES` in `types/envelope.ts`) and `resumed` is
//    not; the two events are not shaped alike here, however alike their driving code is.
// 2. The envelope carries `reason: resume.kind` (`"due"` / `"manual"` / `"interrupted"`). The
//    same schema conditional that forbids node coordinates on `resumed` separately *requires*
//    `reason` on it (`"enum": ["resumed", "lease-expired"]` → `"required": ["reason"]`), confirmed
//    by state-machine.md's own event table (row 16: `resume{...}`, `reason`) — the opposite of
//    this task's brief, which said "reason omitted" for the `INTERRUPTED` case. The value mirrors
//    `resume.kind` rather than a fixed literal because `docs/spec/envelope-examples/resumed.json`
//    — the normative worked example `npm run spec:validate` checks against the schema — does
//    exactly that: `{"resume": {"kind": "due", "actor": "loopmill-sweep"}, "reason": "due"}`.
//    `resume.kind` is already a `machineToken`-shaped value (`due`/`manual`/`interrupted`, no
//    further encoding needed) and is the one piece of `resume` every `resumed` envelope already
//    carries, so this also matches the pattern `lease-expired`'s own `reason` uses (a fixed
//    per-cause token, e.g. `attempt_deadline`) more closely than a single constant would.

import { hostname } from "node:os";

import { DEFAULT_POLICY_FULL, type EnginePolicyFull } from "../engine/index.ts";
import { makeEnvelope } from "../envelope/index.ts";
import type { ResumePayload } from "../types/envelope.ts";
import type { Dispatcher } from "../types/interfaces.ts";
import type { JsonValue } from "../types/loop.ts";
import type { Outcome, RunSnapshot, RunState } from "../types/state.ts";
import type { SqliteStore } from "../store/index.ts";
import { LoopmillError } from "../util/errors.ts";
import { formatRfc3339, parseRfc3339 } from "../util/time.ts";
import type { Clock, RunContext } from "./context.ts";
import { runSweep } from "./sweep.ts";
import { applyStep } from "./step.ts";
import { continueRun, type RunLoopResult, type Writer } from "./run.ts";
import { defaultDispatchers } from "./dispatchers.ts";

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function defaultStdout(): Writer {
  return { write: (s: string) => void process.stdout.write(s) };
}
function defaultStderr(): Writer {
  return { write: (s: string) => void process.stderr.write(s) };
}

// -------------------------------------------------------------------------------------------
// resumeRun: `loopmill resume <runId> [--decision retry|skip|fail]`
// -------------------------------------------------------------------------------------------

export interface ResumeRunInput {
  ctx: RunContext;
  runId: string;
  /** Only legal (and only read) when the Run is `INTERRUPTED` — §10.3: "could **not** be safely
   * re-dispatched without a human deciding". Deliberately has no default: see `resumeRun`'s own
   * doc comment on why an `INTERRUPTED` Run with no `decision` must stop and ask, never guess. */
  decision?: "retry" | "skip" | "fail";
  actor?: string;
  clock: Clock;
  dispatchers?: Record<string, Dispatcher>;
  policy?: EnginePolicyFull;
  heartbeatSeconds?: number;
  json?: boolean;
  stdout?: Writer;
  stderr?: Writer;
}

/** Builds and applies one `resumed` envelope against `runId`'s current lock — the lock-acquire +
 * `applyStep` + `continueRun` sequence `gates.ts`'s `decideGate` already uses for `human-decided`,
 * shared here by `resumeRun`'s two dispatching branches (`WAITING_FOR_QUOTA`'s `manual` bypass and
 * `INTERRUPTED`'s three decisions) so the lock lifecycle is written exactly once. Not exported:
 * both `snapshot` (already read by the caller, to decide which `resume` to build) and `resume`
 * itself are the caller's to construct. */
async function driveResume(params: {
  ctx: RunContext;
  clock: Clock;
  policy: EnginePolicyFull;
  dispatchers: Record<string, Dispatcher>;
  heartbeatSeconds: number;
  stdout: Writer;
  stderr: Writer;
  runId: string;
  snapshot: RunSnapshot;
  resume: ResumePayload;
  json: boolean | undefined;
}): Promise<RunLoopResult> {
  const { ctx, clock, policy, dispatchers, heartbeatSeconds, stdout, stderr, runId, snapshot, resume, json } = params;

  const now0 = clock.now();
  const nowMs0 = parseRfc3339(now0);
  const leaseUntil = formatRfc3339(nowMs0 + policy.dispatchGraceSeconds * 1000);
  const acquireResult = ctx.store.acquireLock({
    loopId: ctx.loop.slug,
    runId,
    ownerPid: process.pid,
    host: hostname(),
    now: now0,
    leaseUntil,
  });
  if (!acquireResult.acquired) {
    const holder = acquireResult.holder;
    stderr.write(`skipped: overlapping_run (held by pid ${holder.ownerPid} on ${holder.host} until ${holder.leaseUntil})\n`);
    return { exitCode: 15, runId, outcome: null, state: snapshot.status };
  }

  try {
    const resumedEnvelope = makeEnvelope(
      {
        eventType: "resumed",
        producer: "human",
        loopId: snapshot.loopId,
        loopVersion: snapshot.loopVersion,
        runId,
        resume,
        reason: resume.kind,
      },
      { now: now0 },
    );

    const stepOut = applyStep({ ctx, envelope: resumedEnvelope, clock, sweepFirst: false, skipLockCheck: true, policy });
    if (!stepOut.result || stepOut.result.kind === "invalid") {
      stderr.write(`loopmill: resumed was rejected for run ${runId}\n`);
      return { exitCode: 2, runId, outcome: null, state: snapshot.status };
    }
    // R-42: impossible for `kind: manual`/`kind: interrupted` (`stale.ts`'s `staleForResumed`
    // only checks `not_due` for `kind: due`, and `resumeRun` never builds one of those — see
    // `resumeDue`, below), but handled defensively rather than falling through into `continueRun`
    // with a snapshot the caller's own read is already stale relative to: a run that stopped
    // being due between `resumeRun`'s own read and this call (a narrow race, since both happen in
    // the same process a few lines apart, but not provably impossible under a real clock).
    if (stepOut.result.kind === "ignored-stale" && stepOut.result.reason === "not_due") {
      stderr.write(`loopmill: run ${runId} is not due yet\n`);
      return { exitCode: 21, runId, outcome: null, state: "WAITING_FOR_QUOTA" };
    }

    return await continueRun({
      ctx,
      dispatchers,
      policy,
      clock,
      trigger: toJsonValue(stepOut.result.snapshot.trigger),
      heartbeatSeconds,
      stdout,
      ...(json !== undefined ? { json } : {}),
      runId,
      result: stepOut.result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`loopmill: resume failed: ${message}\n`);
    const exitCode = err instanceof LoopmillError ? err.exitCode : 1;
    return { exitCode, runId, outcome: null, state: null };
  } finally {
    ctx.store.releaseLock(ctx.loop.slug, runId);
  }
}

/**
 * Resumes one named Run (`loopmill resume <runId>`). Sweeps first (mvp-design.md §7.5), reads the
 * Run, then dispatches on `snapshot.status`:
 *
 * - `INTERRUPTED` with no `decision` — reports what the Run is waiting on and stops at exit `23`,
 *   writing nothing. This is the resolution of a defect m1 itself recorded and left open
 *   (`docs/design/m1-plan.md` §5.1, A12: "Exit 23 is the open half: it is implemented in `run.ts`
 *   but no wired m1 entrypoint can reach it") and `test/driver/exit-codes.test.ts` documented at
 *   length (its own closing comment: "`loopmill resume`... does not exist as a CLI command in m1
 *   at all... confirming... `resume`/A11's `--due` half is m2"). It has a producer now, and
 *   deliberately never a default one: state-machine.md §10.3 defines `INTERRUPTED` as precisely
 *   the state a Run reaches when the node "could **not** be safely re-dispatched without a human
 *   deciding" — every m1 reference loop reaches it only through an `effects: external` node
 *   (`create-issue`, `create-pr`: `gh issue create`/`gh pr create`, each capable of having already
 *   run before the lease that made it look lost actually expired). Silently guessing `retry` here
 *   would risk exactly the double side effect `onInterrupted: ask` exists to prevent; guessing
 *   `skip` or `fail` would abandon work nobody asked to abandon. So `--decision` has no default:
 *   the operator must look (`gh issue list`, `gh pr list`, the run report) and say which.
 * - `INTERRUPTED` with a `decision` — R-48/R-49/R-50 (retry / skip / fail).
 * - `WAITING_FOR_QUOTA` with no `decision` — R-41, the manual bypass of the due check: an operator
 *   running `resume <runId>` by name is deliberately not waiting for `resumeDueAt` (that is what
 *   `resume --due`, `resumeDue` below, is for).
 * - `WAITING_FOR_QUOTA` with a `decision` — `cli_usage`, exit `2`: `--decision` only ever means
 *   something for an `INTERRUPTED` Run.
 * - `WAITING_HUMAN` — exit `2`, pointed at `approve`/`reject` instead.
 * - anything else (a terminal state, `RUNNING`, `PENDING`, the reserved `WAITING_OBSERVED`) —
 *   exit `2`: not a Run `resume` can do anything with.
 *
 * The two dispatching branches share `driveResume`, above, which acquires the loop's lock (same
 * `leaseUntil` arithmetic and `overlapping_run` handling as `decideGate`), applies the `resumed`
 * envelope and, when it dispatches, continues the Run in this same process exactly as `decideGate`
 * does for `human-decided` — releasing the lock in a `finally` either way.
 */
export async function resumeRun(input: ResumeRunInput): Promise<RunLoopResult> {
  const { ctx, clock, runId } = input;
  const policy = input.policy ?? DEFAULT_POLICY_FULL;
  const stdout = input.stdout ?? defaultStdout();
  const stderr = input.stderr ?? defaultStderr();
  const heartbeatSeconds = input.heartbeatSeconds ?? 30;
  const dispatchers = input.dispatchers ?? defaultDispatchers({ layout: ctx.layout });
  const actor = input.actor ?? "operator";

  // Every entrypoint sweeps first (mvp-design.md §7.5).
  runSweep({ store: ctx.store, clock, loops: (loopId) => (loopId === ctx.loop.slug ? ctx.loop : null), policy });

  const snapshot = ctx.store.read(runId);
  if (!snapshot) {
    stderr.write(`loopmill: run_not_found: no run ${runId}\n`);
    return { exitCode: 2, runId, outcome: null, state: null };
  }

  if (snapshot.status === "INTERRUPTED") {
    const interrupted = snapshot.interrupted;
    if (!interrupted) {
      // P-3-style defence in depth: the engine's own invariant is that `status: INTERRUPTED`
      // never appears without `snapshot.interrupted` (R-32 sets both in the same transition), so
      // this should be unreachable — but reported as a clean internal error rather than a thrown
      // TypeError on `interrupted.nodeId` below, matching mvp-design.md §17.4's "loud, never
      // silent" rule for a broken Run.
      stderr.write(`loopmill: run ${runId} is INTERRUPTED with no interrupted record — internal_invariant\n`);
      return { exitCode: 1, runId, outcome: null, state: snapshot.status };
    }

    if (input.decision === undefined) {
      stdout.write(
        `interrupted: run ${runId} is waiting at ${interrupted.nodeId} (cycle ${interrupted.cycleIndex}, attempt ${interrupted.attempt}) — ${interrupted.reason}\n`,
      );
      stdout.write("choose one: --decision retry | --decision skip | --decision fail\n");
      if (input.json) {
        stdout.write(`${JSON.stringify({ exitCode: 23, runId, state: "INTERRUPTED", interrupted, choices: ["retry", "skip", "fail"] })}\n`);
      }
      return { exitCode: 23, runId, outcome: null, state: "INTERRUPTED" };
    }

    return driveResume({
      ctx,
      clock,
      policy,
      dispatchers,
      heartbeatSeconds,
      stdout,
      stderr,
      runId,
      snapshot,
      resume: { kind: "interrupted", decision: input.decision, actor },
      json: input.json,
    });
  }

  if (snapshot.status === "WAITING_FOR_QUOTA") {
    if (input.decision !== undefined) {
      stderr.write(`loopmill: cli_usage: --decision is only valid when resuming an INTERRUPTED run (run ${runId} is WAITING_FOR_QUOTA)\n`);
      return { exitCode: 2, runId, outcome: null, state: snapshot.status };
    }
    return driveResume({
      ctx,
      clock,
      policy,
      dispatchers,
      heartbeatSeconds,
      stdout,
      stderr,
      runId,
      snapshot,
      resume: { kind: "manual", actor },
      json: input.json,
    });
  }

  if (snapshot.status === "WAITING_HUMAN") {
    stderr.write(`loopmill: run ${runId} is waiting on a human gate — use loopmill approve|reject ${runId}\n`);
    return { exitCode: 2, runId, outcome: null, state: snapshot.status };
  }

  stderr.write(`loopmill: run ${runId} is not resumable (state: ${snapshot.status})\n`);
  return { exitCode: 2, runId, outcome: null, state: snapshot.status };
}

// -------------------------------------------------------------------------------------------
// resumeDue: `loopmill resume --due`
// -------------------------------------------------------------------------------------------

export interface ResumeDueInput {
  store: SqliteStore;
  /** Resolves a `loopId` to a live `RunContext`, or `null` when the loop file backing it can no
   * longer be found (its own `.loop.yaml` moved or was deleted since the Run was created). Called
   * at most once per distinct `loopId` this scan ever needs (`resumeDue` caches the result). */
  resolveContext: (loopId: string) => Promise<RunContext | null>;
  clock: Clock;
  policy?: EnginePolicyFull;
  dispatchers?: (ctx: RunContext) => Record<string, Dispatcher>;
  heartbeatSeconds?: number;
  json?: boolean;
  stdout?: Writer;
  stderr?: Writer;
}

export interface ResumeDueResumedEntry {
  runId: string;
  loopId: string;
  exitCode: number;
  outcome: Outcome | null;
  state: RunState | null;
}

export interface ResumeDueSkippedEntry {
  runId: string;
  loopId: string;
  reason: "loop_unresolved" | "overlapping_run" | "not_due" | "invalid";
}

export interface ResumeDueResult {
  exitCode: number;
  resumed: ResumeDueResumedEntry[];
  skipped: ResumeDueSkippedEntry[];
}

function printResumeDue(stdout: Writer, json: boolean | undefined, result: ResumeDueResult): void {
  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.resumed.length === 0 && result.skipped.length === 0) {
    stdout.write("nothing due\n");
    return;
  }
  for (const r of result.resumed) {
    stdout.write(`resumed: ${r.runId} (${r.loopId}) -> exit ${r.exitCode}${r.state ? ` state ${r.state}` : ""}\n`);
  }
  for (const s of result.skipped) {
    stdout.write(`skipped: ${s.runId} (${s.loopId}) — ${s.reason}\n`);
  }
}

/**
 * Drains every `WAITING_FOR_QUOTA` Run whose `quota.resumeDueAt` has passed (R-40), the
 * `resume --due` half of A37 ("idempotent and safe to run concurrently with itself",
 * mvp-design.md §7.5) and of A11/A35 (recovering a parked Run without an operator naming it by
 * `runId`).
 *
 * 1. Sweeps every loop this process can resolve, exactly once — before enumerating candidates, not
 *    per candidate, matching every other entrypoint's "the sweep runs first" rule. `runSweep`'s own
 *    `loops` callback is synchronous (it is called mid-scan, once per expired lease row
 *    `store.sweep()` reports) while `resolveContext` is async, so every loop this scan might need
 *    is resolved *before* the sweep runs, from the only enumeration available without a dedicated
 *    locks-table query (`store.listRuns()`'s distinct `loopId`s — **report**: `docs/design/
 *    m2-plan.md`'s W0b already names the more targeted query this should become) — cached in a
 *    `Map` so a loop with many runs, or many expired leases, is still opened at most once.
 * 2. Re-lists `WAITING_FOR_QUOTA` runs (`RunListEntry.status`, from `listRuns()`'s own join against
 *    each run's stored snapshot — cheap, no second query beyond the `read()` below), reads each
 *    one's full snapshot (`RunListEntry` carries no `quota` field) and keeps those whose
 *    `quota.resumeDueAt <= now`. Processed in `runId` order for a deterministic report.
 * 3. For each candidate: resolve its context (skip `loop_unresolved` if the loop file is gone);
 *    acquire the loop's lock (a failure here is **not** an error — `skipped: overlapping_run` and
 *    move on, since another live process already driving that loop is exactly what makes running
 *    this command concurrently with itself safe, A37); emit `resumed{kind: due, actor:
 *    "control-plane"}` from producer `control-plane` (R-40, "`resume --due` (scheduled or
 *    manual)" per mvp-design.md — never a human actor, since nobody named this Run); continue the
 *    Run exactly as `resumeRun`/`decideGate` do. A run that stopped being due between this scan's
 *    read and its own apply (R-42, `ignored-stale(not_due)`) is recorded `skipped: not_due` rather
 *    than treated as an error — the boundary this scan itself uses to select candidates is the
 *    same one `transition()` re-checks with its own, freshly-read clock, so the two can disagree by
 *    exactly the width of one `now()` read.
 * 4. Exit code `0` on a normal drain, regardless of how many Runs were resumed, skipped, or of
 *    what any individual resumed Run's own outcome was — mirroring mvp-design.md §7.3's rule for
 *    the node executor ("Node failure is data, not an exit code — otherwise a failing test would
 *    look like a broken runner"): a Run this scan drained into `FAILED`, or one still sitting at
 *    `WAITING_FOR_QUOTA` after a second park, is data for the report, not a reason for the batch
 *    itself to exit non-zero. A single candidate's own unexpected failure (its `try`/`catch`,
 *    below, wrapping just that candidate's lock-acquire-through-`continueRun` sequence) is caught
 *    per candidate and recorded as a `resumed` entry carrying that error's own exit code, so one
 *    bad Run never aborts the rest of the drain. Only a failure of the scan itself — enumerating
 *    candidates, or the sweep — maps to this function's own non-zero exit (a `LoopmillError`'s own
 *    `exitCode`, else `1`), via the outer `try`/`catch` around the whole function body.
 */
export async function resumeDue(input: ResumeDueInput): Promise<ResumeDueResult> {
  const { store, resolveContext, clock } = input;
  const policy = input.policy ?? DEFAULT_POLICY_FULL;
  const stdout = input.stdout ?? defaultStdout();
  const dispatchersFor = input.dispatchers ?? ((ctx: RunContext) => defaultDispatchers({ layout: ctx.layout }));
  const heartbeatSeconds = input.heartbeatSeconds ?? 30;

  const contexts = new Map<string, RunContext | null>();
  const resolve = async (loopId: string): Promise<RunContext | null> => {
    if (contexts.has(loopId)) return contexts.get(loopId)!;
    const ctx = await resolveContext(loopId);
    contexts.set(loopId, ctx);
    return ctx;
  };

  try {
    const allRuns = store.listRuns();
    const loopIds = [...new Set(allRuns.map((r) => r.loopId))];
    for (const loopId of loopIds) {
      await resolve(loopId);
    }

    runSweep({ store, clock, loops: (loopId) => contexts.get(loopId)?.loop ?? null, policy });

    const nowMs = parseRfc3339(clock.now());
    const candidates = allRuns
      .filter((r) => r.status === "WAITING_FOR_QUOTA")
      .map((r) => ({ entry: r, snapshot: store.read(r.runId) }))
      .filter((c): c is { entry: (typeof allRuns)[number]; snapshot: RunSnapshot } => c.snapshot !== null && c.snapshot.quota !== null)
      .filter((c) => parseRfc3339(c.snapshot.quota!.resumeDueAt) <= nowMs)
      .sort((a, b) => (a.entry.runId < b.entry.runId ? -1 : a.entry.runId > b.entry.runId ? 1 : 0));

    const resumed: ResumeDueResumedEntry[] = [];
    const skipped: ResumeDueSkippedEntry[] = [];

    for (const { entry, snapshot } of candidates) {
      const ctx = await resolve(entry.loopId);
      if (!ctx) {
        skipped.push({ runId: entry.runId, loopId: entry.loopId, reason: "loop_unresolved" });
        continue;
      }

      const now0 = clock.now();
      const nowMs0 = parseRfc3339(now0);
      const leaseUntil = formatRfc3339(nowMs0 + policy.dispatchGraceSeconds * 1000);
      const acquireResult = ctx.store.acquireLock({
        loopId: ctx.loop.slug,
        runId: entry.runId,
        ownerPid: process.pid,
        host: hostname(),
        now: now0,
        leaseUntil,
      });
      if (!acquireResult.acquired) {
        // A37: another live process already driving this loop — not an error, the whole point of
        // this being safe to run concurrently with itself.
        skipped.push({ runId: entry.runId, loopId: entry.loopId, reason: "overlapping_run" });
        continue;
      }

      try {
        const resumedEnvelope = makeEnvelope(
          {
            eventType: "resumed",
            producer: "control-plane",
            loopId: snapshot.loopId,
            loopVersion: snapshot.loopVersion,
            runId: entry.runId,
            resume: { kind: "due", actor: "control-plane" },
            reason: "due",
          },
          { now: now0 },
        );

        const stepOut = applyStep({ ctx, envelope: resumedEnvelope, clock, sweepFirst: false, skipLockCheck: true, policy });
        if (!stepOut.result || stepOut.result.kind === "invalid") {
          skipped.push({ runId: entry.runId, loopId: entry.loopId, reason: "invalid" });
          continue;
        }
        if (stepOut.result.kind === "ignored-stale" && stepOut.result.reason === "not_due") {
          skipped.push({ runId: entry.runId, loopId: entry.loopId, reason: "not_due" });
          continue;
        }

        const result = await continueRun({
          ctx,
          dispatchers: dispatchersFor(ctx),
          policy,
          clock,
          trigger: toJsonValue(stepOut.result.snapshot.trigger),
          heartbeatSeconds,
          stdout,
          ...(input.json !== undefined ? { json: input.json } : {}),
          runId: entry.runId,
          result: stepOut.result,
        });
        resumed.push({ runId: entry.runId, loopId: entry.loopId, exitCode: result.exitCode, outcome: result.outcome, state: result.state });
      } catch (err) {
        // One candidate's own unexpected failure is data for the report (see this function's own
        // doc comment), not a reason to abandon the rest of the drain.
        const exitCode = err instanceof LoopmillError ? err.exitCode : 1;
        resumed.push({ runId: entry.runId, loopId: entry.loopId, exitCode, outcome: null, state: null });
      } finally {
        ctx.store.releaseLock(ctx.loop.slug, entry.runId);
      }
    }

    const result: ResumeDueResult = { exitCode: 0, resumed, skipped };
    printResumeDue(stdout, input.json, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (input.stderr ?? defaultStderr()).write(`loopmill: resume --due failed: ${message}\n`);
    const exitCode = err instanceof LoopmillError ? err.exitCode : 1;
    return { exitCode, resumed: [], skipped: [] };
  } finally {
    for (const ctx of contexts.values()) {
      ctx?.close();
    }
  }
}
