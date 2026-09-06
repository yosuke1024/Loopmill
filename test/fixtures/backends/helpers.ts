// Shared helpers for test/backends/*.test.ts: loading the reference loop
// (examples/daily-content-improvement.loop.yaml) and building `DispatchRequest`s against it, a
// fixed clock, and a scratch git repo for the worktree/local tests.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, ResolvedEnvPolicy, ResolvedLoop, ResolvedNode } from "../../../src/types/loop.ts";
import type { DispatchRequest } from "../../../src/types/interfaces.ts";
import { loadLoop } from "../../../src/loop-file/loop.ts";
import { newRunId } from "../../../src/util/ulid.ts";
import type { ClassifyInput, ClassifyOutput } from "../../../src/types/state.ts";
import { ensureWorktree } from "../../../src/backends/local/worktree.ts";

export const NOW = "2026-09-06T21:00:00.000Z";

export function fixedClock(now: string = NOW): { now(): string } {
  return { now: () => now };
}

const REFERENCE_LOOP_PATH = join(import.meta.dirname, "../../../examples/daily-content-improvement.loop.yaml");

let cachedLoop: ResolvedLoop | undefined;

/** Loads and memoises `examples/daily-content-improvement.loop.yaml`, resolved. */
export async function loadReferenceLoop(): Promise<ResolvedLoop> {
  if (cachedLoop) return cachedLoop;
  const { loop } = await loadLoop(REFERENCE_LOOP_PATH);
  cachedLoop = loop;
  return loop;
}

export function nodeOf(loop: ResolvedLoop, nodeId: string): ResolvedNode {
  const node = loop.nodes[nodeId];
  if (!node) throw new Error(`reference loop has no node "${nodeId}"`);
  return node;
}

export interface MakeDispatchRequestOptions {
  runId?: string;
  loopId?: string;
  loopVersion?: string;
  slug?: string;
  cycleIndex?: number;
  attempt?: number;
  inputs?: Record<string, JsonValue>;
  workspace?: Partial<DispatchRequest["workspace"]>;
  timeoutMs?: number | null;
  retryHint?: "no_progress";
  causationId?: string;
  signal?: AbortSignal;
  /** Defaults to the loop's own resolved env policy. Tests that need to hand a value through to
   * a stub CLI (e.g. `STUB_MODE`) override this with `inject`, since an arbitrary env var is
   * otherwise scrubbed by `local/env.ts`'s preserve/deny lists like any other unlisted name. */
  env?: ResolvedEnvPolicy;
}

/** Builds a `DispatchRequest` for one node of `loop`, with sane test defaults for everything the
 * caller does not override. `env` defaults to the loop's own resolved env policy. */
export function makeDispatchRequest(
  loop: ResolvedLoop,
  nodeId: string,
  workspaceDefaults: DispatchRequest["workspace"],
  opts: MakeDispatchRequestOptions = {},
): DispatchRequest {
  const node = nodeOf(loop, nodeId);
  const request: DispatchRequest = {
    runId: opts.runId ?? newRunId(),
    loopId: opts.loopId ?? loop.slug,
    loopVersion: opts.loopVersion ?? loop.loopVersion,
    slug: opts.slug ?? loop.slug,
    cycleIndex: opts.cycleIndex ?? 0,
    nodeId,
    attempt: opts.attempt ?? 1,
    node,
    inputs: opts.inputs ?? {},
    workspace: { ...workspaceDefaults, ...opts.workspace },
    env: opts.env ?? loop.env,
    deadlineAt: "2026-09-06T22:00:00.000Z",
    timeoutMs: opts.timeoutMs === undefined ? 30_000 : opts.timeoutMs,
    dedupeKey: `test:${nodeId}`,
    ...(opts.retryHint ? { retryHint: opts.retryHint } : {}),
    ...(opts.causationId ? { causationId: opts.causationId } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  return request;
}

export interface ScratchRepo {
  repoRoot: string;
  cleanup: () => Promise<void>;
}

/** A fresh temp git repository with one commit on `main` -- the "operator's checkout" a worktree
 * test isolates against. Never the Loopmill repository itself. */
export async function makeScratchRepo(): Promise<ScratchRepo> {
  const repoRoot = await mkdtemp(join(tmpdir(), "loopmill-backends-test-"));
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "Loopmill Test"]);
  run(["config", "user.email", "test@loopmill.local"]);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(repoRoot, "README.md"), "# scratch repo\n");
  run(["add", "README.md"]);
  run(["commit", "-q", "-m", "initial commit"]);
  return {
    repoRoot,
    cleanup: () => rm(repoRoot, { recursive: true, force: true }),
  };
}

export function headCommitOf(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** A minimal env policy that preserves `PATH`/`HOME` (so the stub CLI itself can run and, for
 * `print-env`, see them) and injects `STUB_MODE` -- the only way to hand a value through to the
 * stub CLI, since `local/env.ts` scrubs any name not in its preserve/inject/deny accounting. */
export function stubEnvPolicy(stubMode: string, extraInject: Record<string, string> = {}): ResolvedEnvPolicy {
  return { deny: [], preserve: ["PATH", "HOME"], inject: { STUB_MODE: stubMode, ...extraInject } };
}

export interface LocalWorkspace {
  repo: ScratchRepo;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  /** A `LocalDispatcher` layout whose `logsDir` is unique to this workspace (a sibling of the
   * scratch repo, named after `id`) -- NOT a fixed `"logs"` name, which every workspace sharing
   * the same OS temp directory as its parent would otherwise collide on and leak into. */
  layout: { logsDir: string; worktreesDir: string };
  cleanup: () => Promise<void>;
}

/** A scratch repo plus an already-created worktree, ready to hand to `LocalDispatcher.dispatch`
 * as `request.workspace` (`dispatch()` also calls `ensureWorktree` itself -- idempotent, so
 * calling it here too just lets a test inspect `baseCommit` before dispatching). */
export async function makeLocalWorkspace(id: string): Promise<LocalWorkspace> {
  const repo = await makeScratchRepo();
  const worktreePath = join(repo.repoRoot, "..", `wt-local-${id}`);
  const logsDir = join(repo.repoRoot, "..", `logs-local-${id}`);
  const branch = `loopmill/test-loop/run_${id}`;
  const base = headCommitOf(repo.repoRoot);
  const { baseCommit } = ensureWorktree({ repoRoot: repo.repoRoot, worktreePath, branch, baseRef: base });
  return {
    repo,
    worktreePath,
    branch,
    baseCommit,
    layout: { logsDir, worktreesDir: repo.repoRoot },
    cleanup: async () => {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(logsDir, { recursive: true, force: true }).catch(() => undefined);
      await repo.cleanup();
    },
  };
}

/**
 * A small, faithful-enough stand-in for the engine's real `classifyFailure`
 * (state-machine.md §7.1-§7.2), for tests that need SOME classify function but are not
 * exercising `classifyFailure` itself (that belongs to `test/engine/`). Implements the same
 * evaluation order: `LOST` (deadlineMissed) -> `TIMEOUT` -> `CANCELLED` -> `QUOTA` (a tiny
 * substring check over the patterns actually given) -> `SUCCESS` -> `FAILED`.
 */
export function testClassify(input: ClassifyInput): ClassifyOutput {
  if (input.deadlineMissed) {
    return { classification: "LOST", code: "lease_expired", message: "the sweep found no completion by the deadline" };
  }
  if (input.timeoutFired) {
    return { classification: "TIMEOUT", code: "node_timeout", message: "the node's own timeout fired" };
  }

  const result = input.result as Record<string, unknown> | null;
  const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

  if (input.runtimeId === "claude-code") {
    const terminalReason = isRecord(result) ? result["terminal_reason"] : undefined;
    if (input.cancelRequested && terminalReason === "aborted_streaming") {
      return { classification: "CANCELLED", code: "cancelled", message: "claude-code aborted after SIGINT" };
    }
    if (isRecord(result) && result["is_error"] === false) {
      return { classification: "SUCCESS", code: "success", message: "claude-code result is_error=false" };
    }
    return { classification: "FAILED", code: "claude_code_failed", message: "claude-code did not report a well-formed success" };
  }

  // codex
  if (input.cancelRequested && !(isRecord(result) && result["type"] === "turn.completed")) {
    return { classification: "CANCELLED", code: "cancelled", message: "codex ended after a cancel with no turn.completed" };
  }
  if (isRecord(result) && result["type"] === "turn.completed") {
    return { classification: "SUCCESS", code: "success", message: "codex reported turn.completed" };
  }
  return { classification: "FAILED", code: "codex_failed", message: "codex did not report a turn.completed" };
}
