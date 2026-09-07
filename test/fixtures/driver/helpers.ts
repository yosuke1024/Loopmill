// Shared plumbing for test/driver/*.test.ts: a scratch git repository (never the Loopmill repo
// itself), clocks (frozen and advancing), and small wrappers around `openRunContext` that keep
// individual test files short.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openRunContext, type Clock, type RunContext } from "../../../src/driver/index.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));

export const NOW = "2026-09-06T06:00:00.000Z";

/** A clock that never advances — every call returns the same instant. Safe to use with a loop
 * file that sets a small `maxRuntime`, since `budget.activeMs` never grows against it
 * (`engine/budget.ts`'s `accrueClock`: `now - snapshot.updatedAt` is always 0). */
export function fixedClock(now: string = NOW): Clock {
  return { now: () => now };
}

/** A clock that jumps forward by `stepMs` (default 5 minutes) on every `.now()` call — the only
 * way to drive the engine's own active clock past a small `maxRuntime` without a real-time sleep
 * (this task's own instruction: "if the engine's active clock cannot be driven without real
 * time, use the frozen clock's `now()` advancing per call"). */
export function advancingClock(start: string = NOW, stepMs = 5 * 60_000): Clock {
  let t = Date.parse(start);
  return {
    now: () => {
      t += stepMs;
      return new Date(t).toISOString();
    },
  };
}

export interface ScratchRepo {
  repoRoot: string;
  cleanup: () => Promise<void>;
}

/** A fresh temp git repository, one commit on `main` — the "operator's checkout" every driver
 * test isolates worktrees against. Never the Loopmill repository itself. */
export async function makeScratchRepo(prefix = "loopmill-driver-test-"): Promise<ScratchRepo> {
  const repoRoot = await mkdtemp(join(tmpdir(), prefix));
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
  return { repoRoot, cleanup: () => rm(repoRoot, { recursive: true, force: true }) };
}

export function headCommitOf(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function statusPorcelain(repoRoot: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function currentBranch(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** Opens a `RunContext` for `loopPath` against `repo.repoRoot`, with `LOOPMILL_HOME` never set
 * (so `.loopmill/` lands inside the scratch repo, exactly where a real checkout would keep it). */
export async function openTestContext(repo: ScratchRepo, loopPath: string, clock: Clock = fixedClock()): Promise<RunContext> {
  return openRunContext({ repoRoot: repo.repoRoot, env: {}, clock, loopPath });
}

export const FIXTURES_DIR = HERE;
export const CLI_GATE_LOOP_PATH = join(HERE, "daily-content-improvement.loop.yaml");
export const EXIT_CODES_LOOP_PATH = join(HERE, "exit-codes.loop.yaml");
export const LOCAL_MINI_LOOP_PATH = join(HERE, "local-mini.loop.yaml");

export const REFERENCE_HAPPY_SCRIPT = join(HERE, "..", "backends", "fake", "reference-happy.json");
export const REFERENCE_TWO_RETRIES_SCRIPT = join(HERE, "..", "backends", "fake", "reference-two-retries.json");
export const SUCCESS_SCRIPT_PATH = join(HERE, "success-script.json");
