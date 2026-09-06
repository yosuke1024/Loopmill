// `command` node execution (docs/spec/loop-file.md §8.2; docs/design/mvp-design.md §7.2, §11).
// `argv` renders through `renderArgv` (one `${name}` per argv element, never re-parsed), runs
// with `shell: false` inside the worktree, and its stdout travels back to later nodes inside
// `result.structured.stdout` -- the Decision recorded in `src/types/state.ts`'s
// `NodeExecutionRecord` doc comment, since the Envelope has no dedicated slot for a command's
// output.

import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { renderArgv } from "../../loop-file/template.ts";
import { LoopmillError } from "../../util/errors.ts";
import { redact } from "../../util/redact.ts";
import type { JsonScalar } from "../../types/loop.ts";
import type { CancelStep } from "./spawn.ts";
import { runProcess } from "./spawn.ts";
import type { CapturedStreams } from "./logs.ts";

/** command nodes have no runtime CLI to cancel gracefully -- one SIGTERM, then SIGKILL after the
 * same 10s grace every other cancel sequence in this module uses. */
export const COMMAND_CANCEL_SEQUENCE: CancelStep[] = [
  { signal: "SIGTERM", afterMs: 0 },
  { signal: "SIGKILL", afterMs: 10_000 },
];

/** envelope.md §7.6's 8 KiB structured-output rule, applied unconditionally to a command node's
 * `stdout` per this task's Decision recorded in `state.ts`: capped in place inside `structured`,
 * never moved to a file artifact the way an oversized agent `structured` would be. */
const STDOUT_TRUNCATE_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "…[truncated]";

/** Truncates already-redacted stdout to at most 8 KiB UTF-8 bytes, appending the marker when it
 * does. Byte-based, and cuts on a UTF-8 boundary (never emits a split multi-byte character). */
export function truncateStdout(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= STDOUT_TRUNCATE_BYTES) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, STDOUT_TRUNCATE_BYTES - markerBytes);
  return buf.subarray(0, budget).toString("utf8") + TRUNCATION_MARKER;
}

/**
 * Resolves a command node's `cwd` (repo-relative, loop-file.md §8.2) against the worktree root,
 * rejecting an absolute path or one that escapes the worktree via `..` (also loop-file.md §8.2:
 * "Absolute paths and `..` segments are rejected").
 */
export function resolveCommandCwd(worktreePath: string, nodeCwd: string): string {
  if (isAbsolute(nodeCwd)) {
    throw new LoopmillError("command_cwd_invalid", `command node cwd must be repo-relative, got an absolute path: ${nodeCwd}`);
  }
  const resolved = resolvePath(worktreePath, nodeCwd);
  const rel = relative(worktreePath, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new LoopmillError("command_cwd_invalid", `command node cwd escapes the worktree: ${nodeCwd}`);
  }
  return resolved;
}

/** Converts the engine's already-resolved `Record<string, JsonValue>` inputs to the
 * `Record<string, JsonScalar>` `renderArgv`/`renderTemplate` require. Every reference the
 * loop-file grammar can produce resolves to a scalar (loop-file.md §9.1: "An input is a local
 * name bound to one dotted reference" over `structured.*`/`stdout`/`exitCode`/`filesChanged`,
 * every one of them a JSON scalar); a non-scalar value reaching this function means the engine's
 * own resolution has a bug, not that the dispatcher hit a normal runtime condition, so this
 * throws rather than silently stringifying or dropping the input.
 */
export function toScalarInputs(inputs: Record<string, unknown>): Record<string, JsonScalar> {
  const out: Record<string, JsonScalar> = {};
  for (const [name, value] of Object.entries(inputs)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[name] = value;
      continue;
    }
    throw new LoopmillError(
      "input_not_scalar",
      `input "${name}" resolved to a non-scalar value; every declared input must be a JSON scalar (loop-file.md §9.1)`,
    );
  }
  return out;
}

export interface RunCommandInput {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number | null;
  signal?: AbortSignal;
  logs: CapturedStreams;
}

export interface RunCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Full, redacted stdout (untruncated -- the caller decides how much of it becomes
   * `structured.stdout`; the log file on disk always has the whole thing). */
  stdout: string;
}

/** Spawns the rendered `argv` with `shell: false`, capturing both streams through `logs`
 * (redacted line by line as they arrive, per `local/logs.ts`). Never throws for the process's own
 * outcome; rejects (via `runProcess`) only when the binary itself could not be spawned. */
export async function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const stdoutChunks: Buffer[] = [];
  const result = await runProcess({
    argv: input.argv,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs,
    cancelSequence: COMMAND_CANCEL_SEQUENCE,
    ...(input.signal ? { signal: input.signal } : {}),
    onStdout: (chunk) => {
      stdoutChunks.push(chunk);
      input.logs.write("stdout", chunk);
    },
    onStderr: (chunk) => {
      input.logs.write("stderr", chunk);
    },
  });

  const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    durationMs: result.durationMs,
    stdout: redact(rawStdout),
  };
}
