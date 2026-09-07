// `loopmill run`: drives one Run from `run-requested` to a terminal state or a wait, in one
// process, against one backend map (mvp-design.md §7.1-§7.5; state-machine.md §12.2, D-17).
// Implements the seven-phase algorithm of `docs/design/m1-plan.md`'s `run.ts` row: the sweep,
// `--dry-run`, admission, the lock, the first transaction, the dispatch loop, and the exit.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";

import { DEFAULT_POLICY_FULL, isTerminalRun, referenceContextFor, type EnginePolicyFull } from "../engine/index.ts";
import { makeEnvelope, newRunId } from "../envelope/index.ts";
import { resolveInputs } from "../loop-file/index.ts";
import { commitCycle, headCommit } from "../backends/local/worktree.ts";
import type { Envelope, TriggerPayload } from "../types/envelope.ts";
import type { Dispatcher, DispatchRequest } from "../types/interfaces.ts";
import type { JsonValue, ResolvedNode } from "../types/loop.ts";
import type { Outcome, RunSnapshot, RunState, TransitionResult } from "../types/state.ts";
import { LoopmillError } from "../util/errors.ts";
import { redact } from "../util/redact.ts";
import { formatRfc3339, parseRfc3339 } from "../util/time.ts";
import type { RunContext } from "./context.ts";

/** The subset `resolveRepoRoot`/`defaultDispatcherFor`/`printDryRun` actually read — both
 * `RunContext` (a live store already open) and `DryRunLoopContext` (`context.ts`'s
 * `resolveDryRunContext`, which deliberately never opens one — A16) satisfy this structurally,
 * so `--dry-run` never has to open a store just to reuse these helpers. */
type LoopishContext = Pick<RunContext, "loop" | "layout" | "repoRoot">;
import { runSweep } from "./sweep.ts";
import { applyStep } from "./step.ts";
import { writeRunReport } from "./report.ts";
import { defaultDispatchers } from "./dispatchers.ts";
import { dispatchPlanPath } from "./status.ts";

export interface Writer {
  write(chunk: string): void;
}

function stdoutWriter(): Writer {
  return { write: (s) => void process.stdout.write(s) };
}
function stderrWriter(): Writer {
  return { write: (s) => void process.stderr.write(s) };
}

export interface RunLoopOptions {
  ctx: RunContext;
  trigger: TriggerPayload;
  dispatchers: Record<string, Dispatcher>;
  policy?: EnginePolicyFull;
  dryRun?: boolean;
  json?: boolean;
  /** Default 30 (mvp-design.md §7.5). */
  heartbeatSeconds?: number;
  stdout?: Writer;
  stderr?: Writer;
}

export interface RunLoopResult {
  exitCode: number;
  runId: string | null;
  outcome: Outcome | null;
  state: RunState | null;
}

function toJsonValue(value: unknown): JsonValue {
  // A clean structural conversion (drops `undefined` fields the way JSON always does) rather
  // than an unsafe cast — `TriggerPayload` has no index signature of its own, so it is not
  // structurally a `JsonValue` without one.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isDispatchableNode(node: ResolvedNode): node is Extract<ResolvedNode, { kind: "agent" | "command" }> {
  return node.kind === "agent" || node.kind === "command";
}

function resolveRepoRoot(ctx: LoopishContext): string {
  const repo = ctx.loop.repos[0];
  if (!repo) {
    throw new LoopmillError("loop_invalid", `loop "${ctx.loop.slug}" declares no repos[]`, { exitCode: 2 });
  }
  if (repo.path === undefined) {
    throw new LoopmillError(
      "loop_invalid",
      `repo "${repo.id}" has no local path — the "local" backend needs repos[].path (remote repos are not supported in m1)`,
      { exitCode: 2 },
    );
  }
  return resolvePath(ctx.repoRoot, repo.path);
}

/** The commit this attempt should start from: the worktree's own current `HEAD` when it already
 * exists (a later attempt or cycle — the driver commits after every successful `local` node, so
 * `HEAD` already reflects the last one), else `repos[].defaultBase` resolved against the
 * operator's own checkout with `git rev-parse` via `execFileSync` (`child_process.execFile`
 * family — never a shell, matching `backends/local/worktree.ts`'s own convention). */
function resolveBaseCommit(repoRoot: string, worktreePath: string, defaultBase: string): string {
  if (existsSync(worktreePath)) {
    return headCommit(worktreePath);
  }
  try {
    return execFileSync("git", ["rev-parse", defaultBase], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    throw new LoopmillError("git_failed", `git rev-parse ${defaultBase} failed in ${repoRoot}: ${stderr.trim() || e.message}`, { cause: err });
  }
}

/** mvp-design.md §16.2 / §18: the exact node-dispatched envelope this attempt's `Action`
 * described, so the driver can read its `dispatch.deadline`/`dispatch.dedupeKey` and use its
 * `eventId` as the completion's `causationId` (envelope.md §9.1). Searched from the end since a
 * step may emit more than one envelope (e.g. a folded routing chain) and the dispatch is always
 * the last one when `snapshot.current` says a dispatch just happened. */
function findDispatchEnvelope(emitted: Envelope[], cycle: number, nodeId: string, attempt: number): Envelope | undefined {
  for (let i = emitted.length - 1; i >= 0; i--) {
    const e = emitted[i]!;
    if (e.eventType === "node-dispatched" && e.cycle === cycle && e.nodeId === nodeId && e.attempt === attempt) {
      return e;
    }
  }
  return undefined;
}

function emittedOf(result: TransitionResult): Envelope[] {
  return result.kind === "applied" || result.kind === "ignored-stale" ? result.emitted : [];
}

/** Prepends a `commit` artifactRef ahead of whatever the backend itself reported (mvp-design.md
 * §7.2 step 6's own framing: "the driver is the impure shell and the envelope has not been
 * persisted yet" — this is a plain-data edit of an envelope object that has not reached the
 * store, not a re-signed or re-validated one). */
function withCommitRef(envelope: Envelope, commit: string): Envelope {
  return { ...envelope, artifactRefs: [{ kind: "commit", ref: commit }, ...(envelope.artifactRefs ?? [])] };
}

/** Item 2's own shape: the `dispatch-failed` control-plane envelope, built with the same
 * coordinates and `dispatch` payload the corresponding `node-dispatched` carried (mvp-design.md
 * §7.2 step 6, state-machine.md R-29/R-30) — used both when `dispatchers[node.backend]` is
 * missing (`code: "no_dispatcher"`) and when `dispatcher.dispatch()` itself rejects with
 * `dispatch_failed` (`code` is the rejection's own `LoopmillError.code`, currently always
 * `"dispatch_failed"`). A missing/rejecting dispatcher is never an abort: this envelope is
 * applied through `transition()` exactly like a real completion, so the Run's own retry/exhaust
 * policy (R-29 retries up to `maxAttempts`, R-30 fails the Run) decides what happens next, never
 * a bare process crash. */
function buildDispatchFailedEnvelope(params: {
  snapshot: RunSnapshot;
  runId: string;
  current: NonNullable<RunSnapshot["current"]>;
  backendId: string;
  deadlineAt: string;
  dedupeKey: string;
  causationId: string;
  code: string;
  message: string;
  now: string;
}): Envelope {
  return makeEnvelope(
    {
      eventType: "dispatch-failed",
      producer: "control-plane",
      loopId: params.snapshot.loopId,
      loopVersion: params.snapshot.loopVersion,
      runId: params.runId,
      cycle: params.current.cycleIndex,
      nodeId: params.current.nodeId,
      attempt: params.current.attempt,
      causationId: params.causationId,
      dispatch: { backendId: params.backendId, transport: "process", expectedProducer: `backend:${params.backendId}`, deadline: params.deadlineAt, dedupeKey: params.dedupeKey },
      error: { code: params.code, message: params.message, classified: "backend_error" },
    },
    { now: params.now },
  );
}

function outcomeExitCode(outcome: Outcome): number {
  switch (outcome.state) {
    case "SUCCEEDED":
      return 0;
    case "FAILED":
      return 10;
    case "MAX_ITERATIONS_EXCEEDED":
      return 11;
    case "BUDGET_EXCEEDED":
      return 12;
    case "EXPIRED":
      return 13;
    case "CANCELLED":
      return 14;
    case "SKIPPED":
      return 15;
    default:
      return 1;
  }
}

function printSummary(w: Writer, json: boolean | undefined, summary: RunLoopResult & { message?: string }): void {
  if (json) {
    w.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  if (summary.message) w.write(`${summary.message}\n`);
  if (summary.runId) w.write(`runId: ${summary.runId}\n`);
  if (summary.state) w.write(`state: ${summary.state}\n`);
}

export async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
  const { ctx } = opts;
  const clock = ctx.clock;
  const policy = opts.policy ?? DEFAULT_POLICY_FULL;
  const stdout = opts.stdout ?? stdoutWriter();
  const stderr = opts.stderr ?? stderrWriter();
  const heartbeatSeconds = opts.heartbeatSeconds ?? 30;

  // Phase 1: the sweep, first, always (mvp-design.md §7.5).
  runSweep({
    store: ctx.store,
    clock,
    loops: (loopId) => (loopId === ctx.loop.slug ? ctx.loop : null),
    policy,
  });

  // Phase 2: --dry-run. Validates, resolves, prints — spends nothing, touches no store.
  if (opts.dryRun) {
    printDryRun(ctx, stdout, opts.json);
    return { exitCode: 0, runId: null, outcome: null, state: null };
  }

  // Phase 3: admission (R-02/R-03). Dedupe is m2 — pass null and document (Decision (not in
  // sheet), m1): `openChangeForDedupeKey` needs a store index this milestone does not build
  // (mvp-design.md §18 "Dedupe and SKIPPED" — the `runs` table's dedupe index — is a `driver/`+
  // `store/` feature this task's own file list keeps out of scope for `store/sqlite.ts`).
  const now0 = clock.now();
  const nowMs0 = parseRfc3339(now0);
  const recentRuns = ctx.store.listRuns({ loopId: ctx.loop.slug });
  const minIntervalBreached = recentRuns.some((r) => nowMs0 - parseRfc3339(r.createdAt) < ctx.loop.budget.minIntervalMs);
  const windowMs = ctx.loop.budget.maxRunsPerWindow.windowMs;
  const windowCount = recentRuns.filter((r) => nowMs0 - parseRfc3339(r.createdAt) < windowMs).length;
  const runsPerWindowBreached = windowCount >= ctx.loop.budget.maxRunsPerWindow.count;
  const admission = { openChangeForDedupeKey: null, minIntervalBreached, runsPerWindowBreached };

  // Phase 4: the lock. mvp-design.md decision 4.4 / state-machine.md D-17,D-18: a live row
  // refuses this run outright, exit 15, nothing written.
  const runId = newRunId(nowMs0);
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
    // Note: no run row is created — mvp-design.md decision 4.4's own text ("touches nothing").
    return { exitCode: 15, runId: null, outcome: null, state: null };
  }

  try {
    // Phase 5: run-requested, the first transaction (mvp-design.md §17.4).
    const runRequestedEnvelope = makeEnvelope(
      {
        eventType: "run-requested",
        producer: "trigger",
        loopId: ctx.loop.slug,
        loopVersion: ctx.loop.loopVersion,
        runId,
        trigger: opts.trigger,
      },
      { now: now0 },
    );

    const stepOut = applyStep({ ctx, envelope: runRequestedEnvelope, clock, sweepFirst: false, skipLockCheck: true, policy, admission });
    if (!stepOut.result || stepOut.result.kind === "invalid") {
      printSummary(stdout, opts.json, { exitCode: 2, runId, outcome: null, state: null, message: "run-requested was rejected" });
      return { exitCode: 2, runId, outcome: null, state: null };
    }

    return await continueRun({
      ctx,
      dispatchers: opts.dispatchers,
      policy,
      clock,
      trigger: toJsonValue(opts.trigger),
      heartbeatSeconds,
      stdout,
      ...(opts.json !== undefined ? { json: opts.json } : {}),
      runId,
      result: stepOut.result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`loopmill: run failed: ${message}\n`);
    const exitCode = err instanceof LoopmillError ? err.exitCode : 1;
    return { exitCode, runId, outcome: null, state: null };
  } finally {
    ctx.store.releaseLock(ctx.loop.slug, runId);
  }
}

export interface ContinueRunInput {
  ctx: RunContext;
  dispatchers: Record<string, Dispatcher>;
  policy: EnginePolicyFull;
  clock: { now(): string };
  /** The Run's own `trigger`, already reduced to `JsonValue` — `runLoop` passes the full
   * `TriggerPayload` it was given; `gates.ts` (which resumes an existing Run from just its
   * `runId`) passes `snapshot.trigger`, the reduced subset the store actually persisted. See
   * `route.ts`'s own `RunReferenceInfo` doc comment for why the full payload is not always
   * available after the fact — **report** carried there, not repeated here. */
  trigger: JsonValue;
  heartbeatSeconds: number;
  stdout: Writer;
  json?: boolean;
  runId: string;
  result: TransitionResult;
}

/**
 * Item 1's own instruction: a cheap I-30-style guard that `continueRun`'s snapshot-derived
 * control-flow decision and `transition.ts`'s own `result.actions` never silently disagree.
 * Only meaningful for `applied` results — `duplicate`/`ignored-stale`/`invalid` all carry a
 * statically empty `actions: []` (`src/types/state.ts`) regardless of what `result.snapshot`
 * still shows from a prior transition, so there is nothing to cross-check for those. Throws
 * `LoopmillError("internal_invariant", ...)`, which every caller of `continueRun` already maps to
 * exit 1 (the `catch` blocks in `runLoop`/`gates.ts`'s `decideGate`, via `err.exitCode`).
 */
function assertActionsAgree(result: TransitionResult): void {
  if (result.kind !== "applied") return;
  const snapshot = result.snapshot;
  const current = snapshot.current;
  const dispatchActions = result.actions.filter((a): a is Extract<typeof a, { type: "dispatch" }> => a.type === "dispatch");

  if (current && current.nodeState === "DISPATCHED") {
    if (dispatchActions.length !== 1) {
      throw new LoopmillError(
        "internal_invariant",
        `snapshot says ${current.nodeId} (cycle ${current.cycleIndex}, attempt ${current.attempt}) is DISPATCHED, but result.actions carries ${dispatchActions.length} dispatch action(s) instead of exactly one`,
      );
    }
    const a = dispatchActions[0]!;
    if (a.nodeId !== current.nodeId || a.cycle !== current.cycleIndex || a.attempt !== current.attempt) {
      throw new LoopmillError(
        "internal_invariant",
        `result.actions' dispatch (${a.nodeId}, cycle ${a.cycle}, attempt ${a.attempt}) disagrees with snapshot.current (${current.nodeId}, cycle ${current.cycleIndex}, attempt ${current.attempt})`,
      );
    }
    return;
  }
  if (dispatchActions.length > 0) {
    throw new LoopmillError(
      "internal_invariant",
      `result.actions carries a dispatch action but snapshot.current is not DISPATCHED (status ${snapshot.status})`,
    );
  }

  // Not a dispatch: the other three action kinds each correspond to exactly one Run status this
  // same transition can have just produced (WAITING_HUMAN / WAITING_FOR_QUOTA / INTERRUPTED / a
  // terminal status) — checked only when the resulting status actually is one of those, since an
  // `applied` result reached via a mid-flight event (e.g. N-07's heartbeat on node-started) both
  // carries no Action and leaves the Run's status wherever it already was.
  if (snapshot.status === "WAITING_HUMAN") {
    const approvals = result.actions.filter((a) => a.type === "request-approval");
    if (approvals.length !== 1) {
      throw new LoopmillError("internal_invariant", `snapshot.status is WAITING_HUMAN but result.actions carries ${approvals.length} request-approval action(s) instead of exactly one`);
    }
  } else if (snapshot.status === "WAITING_FOR_QUOTA") {
    const waits = result.actions.filter((a) => a.type === "wait");
    if (waits.length !== 1) {
      throw new LoopmillError("internal_invariant", `snapshot.status is WAITING_FOR_QUOTA but result.actions carries ${waits.length} wait action(s) instead of exactly one`);
    }
  } else if (snapshot.status === "INTERRUPTED") {
    const waits = result.actions.filter((a) => a.type === "wait" && a.until === null);
    if (waits.length !== 1) {
      throw new LoopmillError("internal_invariant", `snapshot.status is INTERRUPTED but result.actions carries ${waits.length} wait(until: null) action(s) instead of exactly one`);
    }
  } else if (isTerminalRun(snapshot.status)) {
    const finishes = result.actions.filter((a) => a.type === "finish");
    if (finishes.length !== 1) {
      throw new LoopmillError("internal_invariant", `snapshot.status is terminal (${snapshot.status}) but result.actions carries ${finishes.length} finish action(s) instead of exactly one`);
    }
  }
}

/**
 * Phases 6-7 of mvp-design.md §7.2, factored out so `run.ts`'s own `run-requested` continuation
 * and `gates.ts`'s `human-decided` continuation (mvp-design.md §12: "continues the Run in the
 * same process") share one dispatch loop and one exit-code mapping instead of two. Does **not**
 * take or release the loop's lock itself — both callers already hold it (`gates.ts` takes it the
 * same way `runLoop` does, immediately before calling this).
 *
 * Control flow is still driven by the resulting `RunSnapshot` (`result.snapshot.current?.
 * nodeState === "DISPATCHED"` to decide whether to dispatch, `result.snapshot.status` to decide
 * phase 7's exit) rather than by `TransitionResult.actions` directly — the snapshot is the one
 * value every other driver module (store, report, status) already reasons about, so re-deriving
 * control flow from it here keeps one source of truth instead of two. `transition.ts` now
 * populates `actions` for every dispatch/request-approval/wait/finish decision (state-machine.md
 * §5.1's `Action` union, matching the "Side effects" column of §4.1) — `assertActionsAgree`,
 * below, is a cheap I-30-style guard that the two views can never silently diverge: it re-checks,
 * on every `applied` result this function sees, that the snapshot-derived decision and
 * `result.actions` name the same node/cycle/attempt (or the same wait/finish), and throws
 * `internal_invariant` (mapped to exit 1, `cli/main.ts`'s `printError`) the moment they don't.
 */
export async function continueRun(input: ContinueRunInput): Promise<RunLoopResult> {
  const { ctx, policy, clock, runId, dispatchers, trigger, heartbeatSeconds, json } = input;
  const stdout = input.stdout;
  let result = input.result;

  // Phase 6: the dispatch loop.
  dispatchLoop: while (true) {
    assertActionsAgree(result);
    const snapshot: RunSnapshot = result.snapshot;
    const current = snapshot.current;
    if (!current || current.nodeState !== "DISPATCHED") {
      break dispatchLoop;
    }

    const node = ctx.loop.nodes[current.nodeId];
    if (!node || !isDispatchableNode(node)) {
      throw new LoopmillError("internal_invariant", `dispatched node "${current.nodeId}" is not an agent/command node`);
    }

    const dispatchedEnvelope = findDispatchEnvelope(emittedOf(result), current.cycleIndex, current.nodeId, current.attempt);
    if (!dispatchedEnvelope || !dispatchedEnvelope.dispatch) {
      throw new LoopmillError("internal_invariant", `no node-dispatched envelope found for ${current.cycleIndex}:${current.nodeId}:${current.attempt}`);
    }

    const backendId = node.backend;
    const dispatcher = dispatchers[backendId];

    const deadlineAt = dispatchedEnvelope.dispatch.deadline ?? formatRfc3339(parseRfc3339(clock.now()) + (node.timeoutMs ?? 0));
    const dedupeKey = dispatchedEnvelope.dispatch.dedupeKey ?? `${runId}:${current.cycleIndex}:${current.nodeId}:${current.attempt}`;

    let completionEnvelope: Envelope;
    if (!dispatcher) {
      // Item 2: a dispatcher that cannot be found is a `dispatch-failed` completion (R-29/R-30),
      // never a process abort — no request was ever built, no worktree ever touched, nothing was
      // spawned, so there is nothing to heartbeat or clean up here either.
      completionEnvelope = buildDispatchFailedEnvelope({
        snapshot,
        runId,
        current,
        backendId,
        deadlineAt,
        dedupeKey,
        causationId: dispatchedEnvelope.eventId,
        code: "no_dispatcher",
        message: `no dispatcher registered for backend "${backendId}"`,
        now: clock.now(),
      });
    } else {
      const repoRoot = resolveRepoRoot(ctx);
      const worktreePath = join(ctx.layout.worktrees, runId);
      const branch = `loopmill/${ctx.loop.slug}/${runId}`;
      const defaultBase = ctx.loop.repos[0]!.defaultBase;
      const baseCommit = resolveBaseCommit(repoRoot, worktreePath, defaultBase);

      const refCtx = referenceContextFor(snapshot, ctx.loop, current.cycleIndex, { trigger });
      const inputs = resolveInputs(node.inputs, refCtx);

      const request: DispatchRequest = {
        runId,
        // A2: the Run's own pinned identity (`snapshot.loopId`/`snapshot.loopVersion`), not
        // `ctx.loop`'s current one — see `step.ts`'s `applyStep` doc comment on the loopVersion
        // drift guard for why the two can differ across process boundaries.
        loopId: snapshot.loopId,
        loopVersion: snapshot.loopVersion,
        slug: ctx.loop.slug,
        cycleIndex: current.cycleIndex,
        nodeId: current.nodeId,
        attempt: current.attempt,
        node,
        inputs,
        workspace: { repoRoot, worktreePath, branch, baseCommit },
        env: ctx.loop.env,
        deadlineAt,
        timeoutMs: node.timeoutMs ?? null,
        dedupeKey,
        causationId: dispatchedEnvelope.eventId,
      };

      // Heartbeat while the attempt is in flight (mvp-design.md §7.5, state-machine.md §10.1
      // D-24). `leaseUntil` here follows this task's own instruction literally
      // (`deadlineAt + policy.dispatchGraceSeconds`); the engine's own `deadlineAt` already
      // folds one grace period in (`transition.ts`'s `deadlineAtFor`), so this heartbeat value
      // is deliberately a little more generous than `snapshot.lease.expiresAt` — a second grace
      // period is a safety margin against the sweep expiring an attempt the moment its deadline
      // passes while a heartbeat is mid-flight, never a correctness requirement (the
      // authoritative lease the engine itself reasons about, `lease_not_expired`, stays exactly
      // `deadlineAt`, refreshed separately by `applyStep`'s own `append({ lease: ... })` once
      // the completion lands). Decision (not in sheet), m1.
      const heartbeatLeaseUntil = formatRfc3339(parseRfc3339(deadlineAt) + policy.dispatchGraceSeconds * 1000);
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      if (heartbeatSeconds > 0) {
        heartbeatTimer = setInterval(() => {
          ctx.store.heartbeat(ctx.loop.slug, runId, { now: clock.now(), leaseUntil: heartbeatLeaseUntil });
        }, heartbeatSeconds * 1000);
        heartbeatTimer.unref();
      }

      // Item 5 / mvp-design.md §15.2's `logs` promise ("resolved inputs, effective command
      // line..."): persist the dispatch plan `logs` will later read, right before the dispatcher
      // actually spends anything. Best-effort — a plan file that could not be written must never
      // abort a real dispatch (the attempt itself is far more important than its own log entry).
      try {
        const plan = dispatcher.describe(request);
        const planPath = dispatchPlanPath(ctx.layout.logs, runId, current.cycleIndex, current.nodeId, current.attempt);
        mkdirSync(join(ctx.layout.logs, runId), { recursive: true });
        writeFileSync(planPath, `${redact(JSON.stringify({ ...plan, inputs }, null, 2))}\n`, "utf8");
      } catch {
        // best-effort, see above.
      }

      try {
        completionEnvelope = await dispatcher.dispatch(request, clock);
      } catch (err) {
        if (err instanceof LoopmillError && err.code === "dispatch_failed") {
          // Item 2: the rejection's own code, not a hardcoded literal — currently always
          // "dispatch_failed" (the only code this catch matches), kept as `err.code` rather than
          // inlined so a dispatcher that rejects with a more specific LoopmillError code in the
          // future carries it straight through without another edit here.
          completionEnvelope = buildDispatchFailedEnvelope({
            snapshot,
            runId,
            current,
            backendId,
            deadlineAt,
            dedupeKey,
            causationId: dispatchedEnvelope.eventId,
            code: err.code,
            message: err.message,
            now: clock.now(),
          });
        } else {
          throw err;
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }

      // §7.2 step 6 / §18: one commit per successful `local` node (mvp-design.md §18, corrected
      // 2026-09-08 to match this — a per-cycle commit would leave the tree uncommitted when the
      // reviewer node in the readme-freshness loop runs `git diff <base>...HEAD`, m1-plan.md §6).
      if (backendId === "local" && completionEnvelope.eventType === "node-completed") {
        const message = `loopmill: ${ctx.loop.slug} cycle ${current.cycleIndex} (${runId})`;
        const commit = commitCycle(worktreePath, message);
        if (commit) {
          completionEnvelope = withCommitRef(completionEnvelope, commit.commit);
        }
      }
    }

    const completionStep = applyStep({ ctx, envelope: completionEnvelope, clock, sweepFirst: false, skipLockCheck: true, policy });
    if (!completionStep.result || completionStep.exitCode !== 0) {
      // Item 2: exit 4 is reserved for the case where even a `dispatch-failed` completion could
      // not be recorded (a store-level conflict/invalid on top of an already-failed dispatch) —
      // every other completion keeps the existing exit 2 (invalid)/3 (lock conflict) mapping.
      const exitCode = completionEnvelope.eventType === "dispatch-failed" ? 4 : completionStep.exitCode === 3 ? 3 : 2;
      printSummary(stdout, json, { exitCode, runId, outcome: null, state: null, message: "the completion could not be applied" });
      return { exitCode, runId, outcome: null, state: null };
    }
    result = completionStep.result;
  }

  // Phase 7: decide the exit from the resulting snapshot's state.
  const finalSnapshot = result.snapshot;
  if (finalSnapshot.status === "WAITING_HUMAN") {
    const pending = finalSnapshot.pendingApproval;
    const gateLine = pending
      ? `gate: ${pending.mode} approval required for nodes.${pending.subject.ref} (${pending.subject.kind}) — expires ${pending.expiresAt}`
      : "gate: waiting on a human decision";
    stdout.write(`${gateLine}\n`);
    printSummary(stdout, json, { exitCode: 20, runId, outcome: null, state: finalSnapshot.status });
    return { exitCode: 20, runId, outcome: null, state: finalSnapshot.status };
  }
  if (finalSnapshot.status === "WAITING_FOR_QUOTA") {
    printSummary(stdout, json, { exitCode: 21, runId, outcome: null, state: finalSnapshot.status, message: "waiting for quota" });
    return { exitCode: 21, runId, outcome: null, state: finalSnapshot.status };
  }
  if (finalSnapshot.status === "INTERRUPTED") {
    printSummary(stdout, json, { exitCode: 23, runId, outcome: null, state: finalSnapshot.status, message: "interrupted" });
    return { exitCode: 23, runId, outcome: null, state: finalSnapshot.status };
  }
  if (isTerminalRun(finalSnapshot.status)) {
    writeRunReport({ layout: ctx.layout, store: ctx.store, loop: ctx.loop, runId, snapshot: finalSnapshot });
    const outcome = finalSnapshot.outcome;
    const exitCode = outcome ? outcomeExitCode(outcome) : 1;
    printSummary(stdout, json, { exitCode, runId, outcome, state: finalSnapshot.status });
    return { exitCode, runId, outcome, state: finalSnapshot.status };
  }

  // Not terminal, not waiting, and nothing left to dispatch: an internal invariant broke.
  throw new LoopmillError("internal_invariant", `run left in unexpected state ${finalSnapshot.status} with no dispatch, wait or finish`);
}

// ---------------------------------------------------------------------------------------------
// --dry-run (A16)
// ---------------------------------------------------------------------------------------------

/** Exported so `cli/main.ts` can call it directly for `run --dry-run` without ever opening a
 * store (`context.ts`'s `resolveDryRunContext` builds exactly a `LoopishContext`) — `runLoop`'s
 * own phase 2 below calls it too, with the full `RunContext` it was already given. */
export function printDryRun(ctx: LoopishContext, stdout: Writer, json: boolean | undefined): void {
  const repoRoot = resolveRepoRoot(ctx);
  const worktreePath = join(ctx.layout.worktrees, "<runId>");
  const branch = `loopmill/${ctx.loop.slug}/<runId>`;

  const plans: unknown[] = [];
  for (const node of Object.values(ctx.loop.nodes)) {
    if (!isDispatchableNode(node)) continue;
    const dispatcher = defaultDispatcherFor(ctx, node.backend);
    const placeholderInputs: Record<string, JsonValue> = {};
    for (const name of Object.keys(node.inputs)) {
      placeholderInputs[name] = `<${name}>`;
    }
    const request: DispatchRequest = {
      runId: "<runId>",
      loopId: ctx.loop.slug,
      loopVersion: ctx.loop.loopVersion,
      slug: ctx.loop.slug,
      cycleIndex: 0,
      nodeId: node.id,
      attempt: 1,
      node,
      inputs: placeholderInputs,
      workspace: { repoRoot, worktreePath, branch, baseCommit: "<baseCommit>" },
      env: ctx.loop.env,
      deadlineAt: "<deadlineAt>",
      timeoutMs: node.timeoutMs ?? null,
      dedupeKey: "<dedupeKey>",
    };
    if (!dispatcher) {
      plans.push({ nodeId: node.id, backend: node.backend, error: `no dispatcher registered for backend "${node.backend}"` });
      continue;
    }
    const plan = dispatcher.describe(request);
    plans.push({ nodeId: node.id, backend: node.backend, ...plan });
  }

  if (json) {
    stdout.write(`${JSON.stringify({ loop: ctx.loop.slug, dryRun: true, plans })}\n`);
    return;
  }
  stdout.write(`dry run: ${ctx.loop.slug} (${Object.keys(ctx.loop.nodes).length} nodes)\n`);
  for (const p of plans as Array<{ nodeId: string; backend: string; argv?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number | null; notes?: string[]; error?: string }>) {
    stdout.write(`\n- ${p.nodeId} (${p.backend})\n`);
    if (p.error) {
      stdout.write(`  error: ${p.error}\n`);
      continue;
    }
    stdout.write(`  argv: ${JSON.stringify(p.argv)}\n`);
    stdout.write(`  cwd: ${p.cwd}\n`);
    stdout.write(`  env: ${JSON.stringify(p.env)}\n`);
    stdout.write(`  timeoutMs: ${String(p.timeoutMs)}\n`);
    for (const note of p.notes ?? []) stdout.write(`  note: ${note}\n`);
  }
}

/** `--dry-run` needs a dispatcher purely to call `.describe()` — `cli/main.ts` does not build a
 * live dispatcher map at all for a dry run, so this builds a throwaway `local` one from
 * `dispatchers.ts`'s own defaults (memoised per `RunContext`, since printing every node's plan
 * would otherwise construct one per node for no reason). `fake`-backed nodes have no script to
 * replay in a dry run and are reported as such, matching `defaultDispatchers`' own rule that a
 * `fake` entry only exists when a script was given. */
function defaultDispatcherFor(ctx: LoopishContext, backendId: string): Dispatcher | undefined {
  if (backendId !== "local") return undefined;
  if (!cachedLocalDispatcher || cachedLocalDispatcher.ctxRepoRoot !== ctx.repoRoot) {
    cachedLocalDispatcher = { ctxRepoRoot: ctx.repoRoot, dispatcher: defaultDispatchers({ layout: ctx.layout }).local! };
  }
  return cachedLocalDispatcher.dispatcher;
}

let cachedLocalDispatcher: { ctxRepoRoot: string; dispatcher: Dispatcher } | undefined;
