// The `codex` runtime adapter (docs/design/mvp-design.md §6.3, §11; docs/spikes/README.md §6;
// docs/spec/usage-fixtures/codex-recorded-*.json). Builds `codex exec`'s argv, parses its JSONL
// event stream, and turns that plus the injected `classify` into the pieces `local/executor.ts`
// needs to build a completion envelope.

import type { PermissionProfile, ResolvedAgentNode } from "../../../types/loop.ts";
import type { ClassifyInput, ClassifyOutput, PatternTable } from "../../../types/state.ts";
import type { JsonValue } from "../../../types/loop.ts";
import { normalizeCodexStream, parseCodexJsonl, type ParseCodexJsonlResult } from "../../../usage/codex.ts";
import type { RuntimeCompletion } from "../completion.ts";
import { classificationToCompletion } from "../completion.ts";

/**
 * Builds `codex exec`'s argv (measured CLI contract: `docs/spikes/README.md` §6, `codex exec
 * --json --color never -s <mode> -C <dir> [--output-schema <file>] -o <last-message-file>
 * [-m <model>] <prompt>`, matching `spikes/spike-4-codex-cli/run.sh`'s D1/D2 invocations).
 * `argv[0]` is the literal binary name `"codex"`; `local/executor.ts` substitutes the configured
 * binary path (`binaries.codex`) before spawning. `lastMessagePath` is always passed (`-o`) even
 * though this adapter never reads the file back -- the same information is already in the JSONL
 * stream's `item.completed:agent_message` event, and `-o` is part of the CLI's own contract for
 * where it writes its final answer.
 *
 * `Decision (not in sheet), m1`: the sandbox-mode mapping is exactly what this task was briefed
 * with, pending the maintainer's own confirmation. `readonly` -> `-s read-only`; `workspace` (the
 * loop-file default) -> `-s workspace-write`; `full` -> `-s danger-full-access`.
 */
export function buildCodexArgv(
  node: ResolvedAgentNode,
  prompt: string,
  schemaPath: string | null,
  lastMessagePath: string,
  cwd: string,
): string[] {
  const argv = ["codex", "exec", "--json", "--color", "never", "-s", sandboxFlag(node.permissionProfile), "-C", cwd];
  if (schemaPath) {
    argv.push("--output-schema", schemaPath);
  }
  argv.push("-o", lastMessagePath);
  if (node.model) {
    argv.push("-m", node.model);
  }
  argv.push(prompt);
  return argv;
}

function sandboxFlag(profile: PermissionProfile): string {
  switch (profile) {
    case "readonly":
      return "read-only";
    case "workspace":
      return "workspace-write";
    case "full":
      return "danger-full-access";
  }
}

/** Parses `codex exec --json`'s JSONL stdout (docs/spec/usage-normalization.md §2.2, §2.5 -- a
 * malformed line is counted and dropped, never partially salvaged). Thin re-export of
 * `usage/codex.ts`'s `parseCodexJsonl` under this adapter's own name, so a caller of
 * `local/adapters/codex.ts` never has to reach into `usage/` directly for it. */
export function parseCodexStream(stdout: string): ParseCodexJsonlResult {
  return parseCodexJsonl(stdout);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** The last `item.completed` event whose item is an `agent_message`, per SPIKE-4's D2/D4 finding
 * that a turn may emit more than one and only the last is the model's final answer. `null` when
 * the stream carries no agent message at all (a turn that failed before saying anything). */
function lastAgentMessageText(events: unknown[]): string | null {
  let last: string | null = null;
  for (const ev of events) {
    if (
      isRecord(ev) &&
      ev["type"] === "item.completed" &&
      isRecord(ev["item"]) &&
      ev["item"]["type"] === "agent_message" &&
      typeof ev["item"]["text"] === "string"
    ) {
      last = ev["item"]["text"];
    }
  }
  return last;
}

/** The event `classify`'s `result` parameter names in its own doc comment as "codex
 * turn.completed|turn.failed": the stream's `turn.completed` event when one exists (SUCCESS is
 * impossible without it -- state-machine.md §7.2 row 5), else its `turn.failed` event, else
 * `null` (a signal killed the process before either arrived -- state-machine.md §2.5/D5 SIGTERM
 * exits 0 with neither). */
function terminalEventOf(events: unknown[]): unknown | null {
  let turnCompleted: unknown | null = null;
  let turnFailed: unknown | null = null;
  for (const ev of events) {
    if (!isRecord(ev)) continue;
    if (ev["type"] === "turn.completed") turnCompleted = ev;
    if (ev["type"] === "turn.failed") turnFailed = ev;
  }
  return turnCompleted ?? turnFailed ?? null;
}

export interface CodexCompletionInput {
  stdout: string;
  exitCode: number | null;
  signal: string | null;
  runtimeVersion: string;
  cancelRequested: boolean;
  timeoutFired: boolean;
  patterns: PatternTable;
  classify: (input: ClassifyInput) => ClassifyOutput;
}

/**
 * Turns one finished `codex exec` invocation into the pieces `local/executor.ts` needs: usage
 * (`normalizeCodexStream`, per-process per §2.2), the injected `classify`'s verdict (fed the full
 * event stream as `streamEvents`, since unlike `claude-code`'s `--output-format json` this
 * transport always streams), and an unvalidated structured-output candidate parsed from the last
 * `agent_message`. Never throws -- a stream with no `agent_message` at all, or one whose text is
 * not valid JSON, simply yields `structuredCandidate: null`.
 */
export function codexCompletion(input: CodexCompletionInput): RuntimeCompletion {
  const { events } = parseCodexJsonl(input.stdout);

  const { usage } = normalizeCodexStream({
    events,
    exitCode: input.exitCode,
    signal: input.signal,
    runtimeVersion: input.runtimeVersion,
  });

  const classifyOutput: ClassifyOutput = input.classify({
    runtimeId: "codex",
    runtimeVersion: input.runtimeVersion,
    exitCode: input.exitCode,
    signal: input.signal,
    result: terminalEventOf(events),
    streamEvents: events,
    cancelRequested: input.cancelRequested,
    timeoutFired: input.timeoutFired,
    deadlineMissed: false,
    patterns: input.patterns,
  });

  const lastMessage = lastAgentMessageText(events);
  let structuredCandidate: JsonValue | null = null;
  if (lastMessage !== null) {
    try {
      structuredCandidate = JSON.parse(lastMessage) as JsonValue;
    } catch {
      structuredCandidate = null;
    }
  }

  return classificationToCompletion({
    classifyOutput,
    exitCode: input.exitCode,
    usage,
    structuredCandidate,
    summary: lastMessage,
  });
}
