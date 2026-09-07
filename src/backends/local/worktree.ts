// Git worktree isolation (docs/design/mvp-design.md §7.2, §13.1, §18; docs/spec/state-machine.md
// §10.4). Every Run works in `.loopmill/worktrees/<runId>`, cut from `repos[].defaultBase`; the
// operator's own checkout is never touched, and a duplicate dispatch starts from the cycle's last
// commit. All `git` invocations go through `node:child_process`'s `execFileSync`/`spawnSync`,
// never a shell -- no word splitting, no injection surface from a branch name or commit message.
// Synchronous by design, matching `docs/design/m1-plan.md` §3's rationale for `store/`: a git
// worktree operation is inherently blocking OS work, always called serially (once per attempt, or
// once per cycle for the commit), and wrapping it in `Promise` would buy nothing.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { LoopmillError } from "../../util/errors.ts";

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    throw new LoopmillError(
      "git_failed",
      `git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || e.message}`,
      { cause: err },
    );
  }
}

/** Runs `git <args>` for its exit code alone (never throws on a non-zero exit -- some git
 * subcommands use the exit code as a boolean answer, e.g. `diff --cached --quiet`). */
function gitExitCode(args: string[], cwd: string): number {
  const res = spawnSync("git", args, { cwd, stdio: "ignore" });
  if (res.error) {
    throw new LoopmillError("git_failed", `git ${args.join(" ")} failed in ${cwd}: ${res.error.message}`, {
      cause: res.error,
    });
  }
  return res.status ?? 1;
}

function refExists(repoRoot: string, ref: string): boolean {
  return gitExitCode(["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], repoRoot) === 0;
}

export interface EnsureWorktreeInput {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  /** A ref name or a commit sha to cut `branch` from when it does not already exist. The caller
   * (`local/executor.ts`) passes the engine's own resolved `workspace.baseCommit` here -- `git`
   * accepts either shape identically. */
  baseRef: string;
}

export interface EnsureWorktreeResult {
  /** The worktree's current `HEAD` once this call returns -- the base commit an attempt should
   * reset to before it runs (`resetToCycleBase`), NOT necessarily `baseRef` itself: a worktree
   * that already existed (a duplicate dispatch, or a later cycle re-entering the same Run) may
   * have advanced past it. */
  baseCommit: string;
}

/**
 * Idempotent: creates the branch (from `baseRef`, only if the branch does not already exist) and
 * adds the worktree (only if the directory does not already exist); a second call against the
 * same `worktreePath` is a no-op beyond reading `HEAD`. Never touches the operator's own checkout
 * in `repoRoot` (mvp-design.md §13.1: "the operator's checked-out branch and working tree are
 * never touched") -- `git worktree add` only ever writes a new `worktrees` entry and the new
 * directory, never the primary checkout's index or `HEAD`.
 */
export function ensureWorktree(input: EnsureWorktreeInput): EnsureWorktreeResult {
  const { repoRoot, worktreePath, branch, baseRef } = input;

  if (!existsSync(worktreePath)) {
    if (refExists(repoRoot, branch)) {
      git(["worktree", "add", worktreePath, branch], repoRoot);
    } else {
      git(["worktree", "add", "-b", branch, worktreePath, baseRef], repoRoot);
    }
  }

  return { baseCommit: git(["rev-parse", "HEAD"], worktreePath).trim() };
}

/**
 * `git reset --hard <commit>` followed by `git clean -fd`, run in the worktree before every
 * attempt (state-machine.md §10.4: "`local` resets the Run's worktree to the cycle's last commit
 * before every attempt, so a duplicate re-dispatch starts from the same tree and cannot compound
 * a half-finished change"). Discards a stray untracked file left by a killed or interrupted
 * previous attempt as well as any tracked-file edit.
 */
export function resetToCycleBase(worktreePath: string, commit: string): void {
  git(["reset", "--hard", commit], worktreePath);
  git(["clean", "-fd"], worktreePath);
}

export interface ChangedFile {
  path: string;
  /** `git hash-object`'s own object id for the file's current contents -- whatever hash algorithm
   * the repository uses (SHA-1 unless the repo opted into `--object-format=sha256`), unprefixed.
   * `""` for a deleted file (there is no content left to hash). This is a git-native content
   * identifier for internal fingerprinting use, deliberately NOT what `local/executor.ts` embeds
   * as an envelope `artifactRef.digest` -- see that module's own digest handling for why. */
  digest: string;
  /** The two-character `git status --porcelain` status code for this entry (e.g. `"M"`, `"A"`,
   * `"D"`, `"??"`), trimmed of trailing whitespace only. */
  status: string;
}

function unquotePorcelainPath(raw: string): string {
  // `git status --porcelain` quotes a path containing special characters as a C-style string
  // literal (`"a\tb"`) -- valid JSON-string syntax for every escape git actually emits, so
  // JSON.parse round-trips it exactly.
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  }
  return raw;
}

/** `git status --porcelain`, one entry per changed/added/deleted/renamed file, each carrying its
 * `git hash-object` digest (empty for a deletion). A rename (`R  old -> new`) is reported under
 * its new path only. */
export function changedFiles(worktreePath: string): ChangedFile[] {
  const raw = git(["status", "--porcelain"], worktreePath);
  const out: ChangedFile[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const status = line.slice(0, 2);
    let filePath = line.slice(3);
    const renameSplit = filePath.indexOf(" -> ");
    if (renameSplit !== -1) {
      filePath = filePath.slice(renameSplit + 4);
    }
    filePath = unquotePorcelainPath(filePath);
    const deleted = status.includes("D");
    const digest = deleted ? "" : git(["hash-object", filePath], worktreePath).trim();
    out.push({ path: filePath, digest, status: status.trim() });
  }
  return out;
}

/**
 * `git add -A` then one commit, message `<message>` verbatim (mvp-design.md §18: "one commit per
 * cycle"), unless nothing is staged after the add -- then `null`, no commit is made (a cycle that
 * changes nothing is `NO_PROGRESS`, the engine's concern, not this function's). Returns the new
 * `HEAD`.
 */
export function commitCycle(worktreePath: string, message: string): { commit: string } | null {
  git(["add", "-A"], worktreePath);
  const nothingStaged = gitExitCode(["diff", "--cached", "--quiet"], worktreePath) === 0;
  if (nothingStaged) {
    return null;
  }
  git(["commit", "-m", message], worktreePath);
  return { commit: git(["rev-parse", "HEAD"], worktreePath).trim() };
}

/** The worktree's current `HEAD` commit sha. */
export function headCommit(worktreePath: string): string {
  return git(["rev-parse", "HEAD"], worktreePath).trim();
}
