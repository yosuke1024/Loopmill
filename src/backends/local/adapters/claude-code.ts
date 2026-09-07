// The `claude-code` runtime adapter (docs/design/mvp-design.md §6.3, §11; docs/spikes/README.md
// §3; docs/spec/usage-fixtures/claude-recorded-*.json). Builds the CLI's argv, parses its single
// terminal JSON result object, and turns that plus the injected `classify` into the pieces
// `local/executor.ts` needs to build a completion envelope.

import type { PermissionProfile, ResolvedAgentNode } from "../../../types/loop.ts";
import type { ClassifyInput, ClassifyOutput, PatternTable } from "../../../types/state.ts";
import type { JsonValue } from "../../../types/loop.ts";
import type { UsageRecord } from "../../../types/usage.ts";
import { normalizeClaudeCodeResult } from "../../../usage/claude-code.ts";
import type { RuntimeCompletion } from "../completion.ts";
import { classificationToCompletion } from "../completion.ts";

/**
 * Builds `claude`'s argv for one agent node (measured CLI contract: `docs/spikes/README.md` §3,
 * `claude -p <prompt> --output-format json [--json-schema <schema>] --permission-mode <mode>
 * --permission-prompts none [--model <model>]`). `argv[0]` is the literal binary name `"claude"`;
 * `local/executor.ts` substitutes the configured binary path (`binaries.claude`) before spawning,
 * so `describe()`'s dry-run plan and the real spawn agree on everything else.
 *
 * `Decision (not in sheet), m1`: the permission-profile mapping below. `readonly` ->
 * `--permission-mode plan` (the CLI never edits or runs a tool with side effects); `workspace`
 * (the loop-file default, loop-file.md §8.1) -> `--permission-mode acceptEdits` plus one
 * `--disallowedTools "Bash(gh *)" "Bash(git push *)"`, matching mvp-design.md §13.1's "the
 * default `workspace` denies `gh` and `git push` tool use to the agent"; `full` ->
 * `--permission-mode bypassPermissions`.
 *
 * Verified against `claude --help` on 2026-09-07, CLI 2.1.263, before the first live run:
 *
 *  - `--permission-mode <mode>` accepts exactly `acceptEdits`, `auto`, `bypassPermissions`,
 *    `manual`, `dontAsk`, `plan` -- all three targets above exist under those names.
 *  - `--disallowedTools, --disallowed-tools <tools...>` is **variadic**: "Comma or
 *    space-separated list of tool names to deny (e.g. \"Bash(git *) Edit\")". It therefore takes
 *    both patterns as two values of ONE occurrence. This function originally emitted the flag
 *    twice, once per pattern; whether a second occurrence of a variadic option appends to or
 *    replaces the first is a Commander implementation detail this repository has not measured,
 *    and a replacement would have silently dropped the `Bash(gh *)` denial -- a lost safety
 *    property, not a cosmetic difference. One occurrence with two values is the CLI's own
 *    documented form and is unambiguous either way.
 *  - `--permission-prompts none` means "nobody answers: anything that would prompt is denied
 *    automatically; the permission mode still decides everything else". Combined with
 *    `acceptEdits` (which auto-accepts file edits but not command execution) this denies the
 *    `Bash` tool outright rather than only the two patterns above -- stricter than §13.1's
 *    wording, and deliberately left that way: a node that needs to run commands declares a
 *    `command` node, which is where an external effect can be gated.
 *  - `--json-schema <schema>` takes the schema INLINE, not a file path: `claude --help`'s own
 *    entry reads "JSON Schema for structured output validation. Example:
 *    {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}". This is the
 *    opposite of `codex exec --output-schema <FILE>` ("Path to a JSON Schema file describing the
 *    model's final response shape") -- the two runtimes were measured to genuinely differ here,
 *    not just spelled differently, so `schemaJson` below carries the schema's JSON text and
 *    `local/executor.ts` never writes it to a temp file (unlike codex's `schemaPath`, which does).
 *    This repository's own earlier measurement agrees and is the stronger evidence: SPIKE-1's
 *    check C3 (`spikes/spike-1-claude-subscription/run.sh`, the hosted run recorded PASS in
 *    `docs/spikes/README.md` §3) builds its command as `claude -p ... --json-schema "$schema"`
 *    where `$schema` is a JSON literal, and measured `structured_output` coming back conformant.
 *    The path form this adapter originally passed was never measured against anything.
 */
export function buildClaudeArgv(
  node: ResolvedAgentNode,
  prompt: string,
  schemaJson: string | null,
): string[] {
  const argv = ["claude", "-p", prompt, "--output-format", "json"];
  argv.push(...permissionFlags(node.permissionProfile));
  argv.push("--permission-prompts", "none");
  if (schemaJson) {
    argv.push("--json-schema", schemaJson);
  }
  if (node.model) {
    argv.push("--model", node.model);
  }
  return argv;
}

function permissionFlags(profile: PermissionProfile): string[] {
  switch (profile) {
    case "readonly":
      return ["--permission-mode", "plan"];
    case "workspace":
      // One occurrence, two values: `--disallowedTools` is variadic (see the doc comment above).
      return ["--permission-mode", "acceptEdits", "--disallowedTools", "Bash(gh *)", "Bash(git push *)"];
    case "full":
      return ["--permission-mode", "bypassPermissions"];
  }
}

export interface ParseClaudeResultOutput {
  result: unknown | null;
  parseError?: string;
}

/**
 * `--output-format json` (not `stream-json`) writes exactly one JSON object to stdout and nothing
 * else (confirmed by every recorded fixture's own note: "the CLI writes a single terminal JSON
 * object to stdout and there is no stream of intermediate lines"). Empty stdout (a process killed
 * before it could write anything) is `{ result: null }`, matching `normalizeClaudeCodeResult`'s
 * own "no result was emitted" path -- not a parse error, since there was nothing to parse.
 */
export function parseClaudeResult(stdout: string): ParseClaudeResultOutput {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { result: null };
  }
  try {
    return { result: JSON.parse(trimmed) as unknown };
  } catch (err) {
    return { result: null, parseError: (err as Error).message };
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** The claude-code result's own `result` text field (the model's final reply), used for the
 * envelope's short `result.summary` when nothing more specific is available. */
function textResultOf(result: unknown): string | null {
  return isRecord(result) && typeof result["result"] === "string" ? result["result"] : null;
}

/** `--json-schema`'s validated answer, per loop-file.md §8.1: "the validated answer arrives in
 * the result's `structured_output` field". Returned as an unvalidated candidate --
 * `local/executor.ts` re-validates it against the node's own schema (mvp-design.md §11: "a
 * runtime's own validation is a convenience, not a contract"). */
function structuredCandidateOf(result: unknown): JsonValue | null {
  if (!isRecord(result)) return null;
  const value = result["structured_output"];
  return value === undefined ? null : (value as JsonValue);
}

export interface ClaudeCompletionInput {
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
 * Turns one finished `claude` invocation into the pieces `local/executor.ts` needs: usage
 * (`normalizeClaudeCodeResult`), the injected `classify`'s verdict, and an unvalidated structured-
 * output candidate. Never throws -- a parse failure is folded into `classify`'s input as
 * `result: null`, which the ambiguity rule (state-machine.md §7.2 row 6) turns into `FAILED`.
 */
export function claudeCompletion(input: ClaudeCompletionInput): RuntimeCompletion {
  const { result, parseError } = parseClaudeResult(input.stdout);

  const usage: UsageRecord = normalizeClaudeCodeResult({
    result,
    exitCode: input.exitCode,
    signal: input.signal,
    runtimeVersion: input.runtimeVersion,
    streamLines: [],
  });

  const classifyOutput = input.classify({
    runtimeId: "claude-code",
    runtimeVersion: input.runtimeVersion,
    exitCode: input.exitCode,
    signal: input.signal,
    result,
    streamEvents: [],
    cancelRequested: input.cancelRequested,
    timeoutFired: input.timeoutFired,
    deadlineMissed: false,
    patterns: input.patterns,
  });

  return classificationToCompletion({
    classifyOutput,
    exitCode: input.exitCode,
    usage,
    structuredCandidate: structuredCandidateOf(result),
    summary: parseError ? `claude-code result did not parse as JSON: ${parseError}` : textResultOf(result),
  });
}
