// Resolves a bare executable name (`"claude"`, `"npm"`, `"gh"`, ...) to the absolute path the OS
// would actually execute, for A16 ("`--dry-run`... resolves every binary and working directory to
// an absolute path", mvp-design.md §20.3). Pure filesystem probing -- no execution, no shell, and
// (Decision (not in sheet), m1, see `resolveBinary`'s own doc comment on why) no exception for a
// name that cannot be found anywhere on `PATH`.
//
// This module duplicates a search Node's own `child_process.spawn` already performs internally
// (POSIX: an unqualified `argv[0]` is handed to `execvp(3)`, which walks the child's own `PATH`)
// -- ahead of time, over the exact same input, purely so `--dry-run` can print the resolved path
// before anything is spawned and the real dispatch can hand `spawn` an `argv[0]` that already
// agrees with the plan `describe()` showed for the same request (`local/executor.ts` calls this
// from both). It is not a second, independent PATH search whose result might disagree with the
// child's own -- `resolveBinary` and `execvp` are given the identical `PATH` string and the
// identical name, so they can only disagree if `PATH` names something between the two calls (a
// symlink is swapped out mid-dispatch, an ENOENT on the real exec after a passing `access` here,
// ...), a TOCTOU window this module accepts rather than papering over: `dispatch()` still lets the
// real `spawn` fail on its own terms if that happens (`spawn.ts`'s own `dispatch_failed` on
// `ENOENT`), exactly as it does today for a binary this module never got to resolve.

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

export interface ResolvedBinary {
  /** The `argv[0]` to actually spawn: the absolute path this module found on `PATH`, or -- when
   * `name` was already absolute/qualified, or nothing on `PATH` matched -- `name` unchanged. */
  argv0: string;
  /** True iff `argv0` is an absolute path this module itself resolved or was handed already
   * resolved. False means `name` was a bare executable name and nothing on `PATH` was both
   * present and executable -- `argv0` is `name`, unchanged, so a real spawn still gets exactly
   * the bare name it would have gotten before this module existed (and so still fails with the
   * OS's own ENOENT, the "the way a missing binary already fails today" this task's brief asks
   * for) and a dry-run plan still shows a usable value rather than nothing at all. */
  found: boolean;
}

/**
 * Resolves `name` against `pathEnv` -- the CHILD's own `PATH` (`local/env.ts`'s `buildChildEnv`
 * result), never the parent process's, since that is what the child's own `execvp` will actually
 * search once spawned; the two can legitimately differ (`PATH` is not denied by default, but a
 * loop file's `env.preserve`/`env.deny`/a command node's own `env` allowlist can still change
 * what a given node's child sees) and printing a resolution the child would not itself reach
 * would fail A16's "prints the exact child command line" half while satisfying its "resolves
 * every binary" half.
 *
 * - `name` already absolute (`path.isAbsolute`) or already qualified (contains a `path.sep` or a
 *   forward slash, e.g. `./claude`, `bin/claude`, `C:\tools\claude.exe`) is returned unchanged,
 *   `found: true` -- POSIX `execvp` never searches `PATH` for such a name either (it is used
 *   directly, and fails on its own if it does not exist), so resolving it further would be a
 *   filesystem check this function was not asked to make and a verdict ("exists" / "does not
 *   exist") that belongs to the spawn itself, not to the dry-run plan. This is also exactly why
 *   the existing `spawn-failure.test.ts` cases (an already-absolute, deliberately nonexistent
 *   `binaries.claude`) keep failing the same way after this module exists: nothing here ever
 *   touches an already-qualified path's own existence.
 * - Otherwise, walks `pathEnv`'s entries (`path.delimiter`-separated: `:` on POSIX, `;` on
 *   Windows -- this module makes no other Windows accommodation, see the file doc comment) left
 *   to right -- the same precedence order POSIX `PATH` search and every POSIX shell use -- and
 *   returns the first entry `<dir>/<name>` that is a regular file with at least one executable
 *   bit set for the current process (`fs.constants.X_OK`). No entry found: `argv0: name`,
 *   `found: false`.
 *
 * Never throws: a malformed or empty `pathEnv`, a directory entry that cannot be `stat`'d
 * (removed mid-walk, permission denied, ...), all resolve to "not found there", not an error --
 * this function's whole reason to exist is to make a missing binary a plain, reportable value
 * (A16's dry-run half) rather than an exception standing between validation and printing.
 */
export function resolveBinary(name: string, pathEnv: string | undefined): ResolvedBinary {
  if (name.length === 0 || isAbsolute(name) || name.includes(sep) || name.includes("/")) {
    return { argv0: name, found: true };
  }
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir.length === 0) continue; // an empty PATH element is "the current directory" in POSIX
    // shell semantics, but never for execvp's own PATH search (the syscall doc is explicit that
    // an empty component is skipped, not treated as "."); Decision (not in sheet), m1: this
    // resolver matches execvp's (and therefore Node's own spawn's) behaviour, not the shell's,
    // since it exists to predict what `spawn()` will do, not what a user's shell would.
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) {
      return { argv0: candidate, found: true };
    }
  }
  return { argv0: name, found: false };
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    // ENOENT (nothing there), EACCES (not executable / not readable), or any other `stat`/
    // `access` failure -- all mean "not a usable candidate", never a reason to abort the walk.
    return false;
  }
}
