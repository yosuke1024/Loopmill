// `LocalDispatcher`: the `local` backend's node executor (docs/design/mvp-design.md §6.2, §7.2,
// §9.1, §13; docs/spec/state-machine.md §7, §10.4). A subprocess of `loopmill run` itself, not a
// separate job (envelope.md §9.1): spawns the runtime CLI (or a `command` node's own argv)
// directly in the Run's worktree and owns the only first-hand account of what happened.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

import type { BackendCapabilities } from "../../types/capabilities.ts";
import type { ArtifactRef, Envelope } from "../../types/envelope.ts";
import type { DispatchPlan, DispatchRequest, Dispatcher } from "../../types/interfaces.ts";
import type { JsonScalar, JsonValue, ResolvedAgentNode, ResolvedCommandNode } from "../../types/loop.ts";
import type { ClassifyInput, ClassifyOutput } from "../../types/state.ts";
import type { UsageRecord } from "../../types/usage.ts";
import { makeEnvelope } from "../../envelope/build.ts";
import { renderArgv, renderTemplate } from "../../loop-file/template.ts";
import { LoopmillError } from "../../util/errors.ts";
import { redact } from "../../util/redact.ts";
import { sha256Prefixed } from "../../util/hash.ts";
import { BACKEND_CAPABILITIES } from "../capabilities.ts";
import { noAgentRanUsage, SUMMARY_TEXT_MAX, TEXT_MAX, toEnvelopeUsage, truncateForSchema } from "../envelope-helpers.ts";
import { buildClaudeArgv, claudeCompletion } from "./adapters/claude-code.ts";
import { buildCodexArgv, codexCompletion } from "./adapters/codex.ts";
import type { RuntimeCompletion } from "./completion.ts";
import { runCommand, resolveCommandCwd, toScalarInputs, truncateStdout } from "./command.ts";
import { buildChildEnv } from "./env.ts";
import { openCapturedStreams, tail } from "./logs.ts";
import { loadDefaultPatternTable } from "./patterns.ts";
import { resolveBinary } from "./resolve-binary.ts";
import type { CancelStep } from "./spawn.ts";
import { runProcess } from "./spawn.ts";
import { changedFiles, ensureWorktree, resetToCycleBase } from "./worktree.ts";

const CLAUDE_CANCEL_SEQUENCE: CancelStep[] = [
  { signal: "SIGINT", afterMs: 0 },
  { signal: "SIGKILL", afterMs: 10_000 },
];
const CODEX_CANCEL_SEQUENCE: CancelStep[] = [
  { signal: "SIGTERM", afterMs: 0 },
  { signal: "SIGKILL", afterMs: 10_000 },
];

const RETRY_HINT_NOTE = "Note: the previous cycle changed nothing.";
const TAIL_SUMMARY_BYTES = 400;

export interface LocalDispatcherLayout {
  logsDir: string;
  worktreesDir: string;
}

export interface LocalDispatcherOptions {
  layout: LocalDispatcherLayout;
  /** The engine's `classifyFailure` (state-machine.md §7.1), injected -- this module calls it, it
   * does not implement one. */
  classify: (input: ClassifyInput) => ClassifyOutput;
  binaries?: { claude?: string; codex?: string };
  /** Defaults to `process.env`. Overridable so tests never depend on the real process env. */
  parentEnv?: NodeJS.ProcessEnv;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isAgentOrCommandNode(node: DispatchRequest["node"]): node is ResolvedAgentNode | ResolvedCommandNode {
  return node.kind === "agent" || node.kind === "command";
}

/**
 * A16 (mvp-design.md §20.3: "`--dry-run`... resolves every binary... to an absolute path"):
 * rewrites `argv[0]` in place to the absolute path `resolve-binary.ts`'s `resolveBinary` finds on
 * `pathEnv` -- the CHILD's own scrubbed `PATH` (`env.PATH` from `buildChildEnv`, a parameter here
 * rather than something this function reaches for itself), never the parent process's, so the
 * printed plan and the real spawn agree on what would actually run. Both `describe()` (the
 * dry-run plan) and every real dispatch path call this SAME function on the SAME computed `env`,
 * per this task's own instruction that "a dry run that printed a path the spawn did not use would
 * be worse than the current honest bare name" -- there is exactly one place this resolution
 * happens, not two that could drift apart.
 *
 * Decision (not in sheet), m1: when nothing on `PATH` resolves, `argv[0]` is left as the bare
 * name it already was (`resolveBinary`'s own `found: false` case), never replaced with a
 * sentinel or thrown as an error here -- the two callers want different things done with that
 * fact and both get enough information to do it: `describe()` sees `found: false` and adds a
 * plain-language note ("say plainly that the binary was not found, rather than throwing" -- this
 * task's own instruction), while a real dispatch path only uses `argv`, so an unresolved binary
 * reaches `runProcess`/`spawn()` exactly as bare as it always has, and fails with the OS's own
 * `ENOENT` -- "a real dispatch should fail the way a missing binary already fails today" (same
 * instruction), not a new failure mode this change invents.
 */
function resolveArgv0(argv: string[], pathEnv: string | undefined): { argv: string[]; found: boolean } {
  if (argv.length === 0) return { argv, found: true };
  const resolved = resolveBinary(argv[0]!, pathEnv);
  return { argv: [resolved.argv0, ...argv.slice(1)], found: resolved.found };
}

/** Turns a spawn/setup problem (a bad prompt file, a `git` failure, ENOENT on the binary, ...)
 * into the one shape `Dispatcher.dispatch` may reject with. `runProcess`/`worktree.ts` already
 * throw `LoopmillError`s of their own; anything else is wrapped so a caller can rely on
 * `dispatch()` never rejecting with something that is not a `dispatch_failed` `LoopmillError`. */
function toDispatchFailed(err: unknown): LoopmillError {
  if (err instanceof LoopmillError) {
    return new LoopmillError("dispatch_failed", err.message, { cause: err, details: err.details });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LoopmillError("dispatch_failed", message, { cause: err });
}

/** `docs/spec/envelope.schema.json` `$defs.machineToken`: lowercase snake_case, starting with a
 * letter, at most 64 characters. `classify`/`command.ts` are injected/derived from process state
 * this module does not fully control, so `error.code` is sanitized to this shape defensively
 * rather than trusting every caller to already produce it -- a malformed code would otherwise
 * make `makeEnvelope` throw, turning a node failure into a dispatch crash. */
function sanitizeErrorCode(code: string): string {
  let out = code.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (out.length === 0 || !/^[a-z]/.test(out)) {
    out = `x_${out}`;
  }
  return out.slice(0, 64);
}

export class LocalDispatcher implements Dispatcher {
  readonly #layout: LocalDispatcherLayout;
  readonly #classify: (input: ClassifyInput) => ClassifyOutput;
  readonly #binaries: { claude: string; codex: string };
  readonly #parentEnv: NodeJS.ProcessEnv;

  constructor(options: LocalDispatcherOptions) {
    this.#layout = options.layout;
    this.#classify = options.classify;
    this.#binaries = { claude: options.binaries?.claude ?? "claude", codex: options.binaries?.codex ?? "codex" };
    this.#parentEnv = options.parentEnv ?? process.env;
  }

  capabilities(): BackendCapabilities {
    return BACKEND_CAPABILITIES.local;
  }

  describe(request: DispatchRequest): DispatchPlan {
    const node = request.node;
    if (!isAgentOrCommandNode(node)) {
      return {
        argv: [],
        cwd: request.workspace.worktreePath,
        env: {},
        stdin: "/dev/null",
        timeoutMs: request.timeoutMs,
        notes: [`the local backend cannot dispatch a "${node.kind}" node -- it runs on control-plane`],
      };
    }

    const { env, denied, injected } = buildChildEnv(this.#parentEnv, request.env, node);
    const notes = [
      `env denied: ${denied.length > 0 ? denied.join(", ") : "(none present)"}`,
      `env injected: ${injected.length > 0 ? injected.join(", ") : "(none)"}`,
    ];

    if (node.kind === "command") {
      let cwd: string;
      let argv: string[];
      try {
        const scalars = toScalarInputs(request.inputs);
        argv = renderArgv(node.argv, scalars);
        cwd = resolveCommandCwd(request.workspace.worktreePath, node.cwd);
      } catch (err) {
        notes.push(`could not fully resolve this plan: ${err instanceof Error ? err.message : String(err)}`);
        argv = node.argv;
        cwd = request.workspace.worktreePath;
      }
      const resolved = resolveArgv0(argv, env.PATH);
      argv = resolved.argv;
      if (!resolved.found) {
        notes.push(`binary not found on PATH: ${JSON.stringify(argv[0])}`);
      }
      return { argv, cwd, env, stdin: "/dev/null", timeoutMs: request.timeoutMs, notes };
    }

    // agent
    let argv: string[];
    try {
      const scalars = toScalarInputs(request.inputs);
      const prompt = this.#resolvePrompt(request, node, scalars);
      if (node.runtime === "claude-code") {
        // claude-code's `--json-schema` takes the schema's JSON text inline, not a path (see
        // `adapters/claude-code.ts`'s `buildClaudeArgv` doc comment) -- no temp file to plan for.
        const schemaJson = node.structuredOutput ? JSON.stringify(node.structuredOutput) : null;
        argv = buildClaudeArgv(node, prompt, schemaJson);
      } else {
        const schemaPath = node.structuredOutput ? this.#codexSchemaTempPath(request) : null;
        argv = buildCodexArgv(node, prompt, schemaPath, this.#lastMessageTempPath(request), request.workspace.worktreePath);
      }
      argv[0] = node.runtime === "claude-code" ? this.#binaries.claude : this.#binaries.codex;
    } catch (err) {
      notes.push(`could not fully resolve this plan: ${err instanceof Error ? err.message : String(err)}`);
      argv = [node.runtime === "claude-code" ? this.#binaries.claude : this.#binaries.codex];
    }
    const resolvedAgentArgv0 = resolveArgv0(argv, env.PATH);
    argv = resolvedAgentArgv0.argv;
    if (!resolvedAgentArgv0.found) {
      notes.push(`binary not found on PATH: ${JSON.stringify(argv[0])}`);
    }
    return { argv, cwd: request.workspace.worktreePath, env, stdin: "/dev/null", timeoutMs: request.timeoutMs, notes };
  }

  async dispatch(request: DispatchRequest, clock: { now(): string }): Promise<Envelope> {
    const node = request.node;
    if (!isAgentOrCommandNode(node)) {
      throw new LoopmillError("dispatch_failed", `the local backend cannot dispatch a "${node.kind}" node`);
    }

    try {
      ensureWorktree({
        repoRoot: request.workspace.repoRoot,
        worktreePath: request.workspace.worktreePath,
        branch: request.workspace.branch,
        baseRef: request.workspace.baseCommit,
      });
      resetToCycleBase(request.workspace.worktreePath, request.workspace.baseCommit);
    } catch (err) {
      throw toDispatchFailed(err);
    }

    let scalars: Record<string, JsonScalar>;
    try {
      scalars = toScalarInputs(request.inputs);
    } catch (err) {
      throw toDispatchFailed(err);
    }

    const { env } = buildChildEnv(this.#parentEnv, request.env, node);
    const logs = openCapturedStreams(this.#layout.logsDir, request.runId, request.cycleIndex, request.nodeId, request.attempt);

    try {
      const completion =
        node.kind === "command"
          ? await this.#dispatchCommand(request, node, scalars, env, logs)
          : await this.#dispatchAgent(request, node, scalars, env, logs);
      await logs.close();
      return this.#buildEnvelope(request, node, completion, logs, clock);
    } catch (err) {
      await logs.close().catch(() => undefined);
      throw toDispatchFailed(err);
    }
  }

  // -----------------------------------------------------------------------------------------
  // command nodes
  // -----------------------------------------------------------------------------------------

  async #dispatchCommand(
    request: DispatchRequest,
    node: ResolvedCommandNode,
    scalars: Record<string, JsonScalar>,
    env: Record<string, string>,
    logs: ReturnType<typeof openCapturedStreams>,
  ): Promise<RuntimeCompletion> {
    // A16: `argv[0]` is resolved to the absolute path the child's own scrubbed `PATH` (`env`,
    // this method's own parameter) would have `execvp`'d anyway -- see `resolveArgv0`'s doc
    // comment for why this is the identical resolution `describe()` printed, not a second one.
    const argv = resolveArgv0(renderArgv(node.argv, scalars), env.PATH).argv;
    const cwd = resolveCommandCwd(request.workspace.worktreePath, node.cwd);

    const result = await runCommand({
      argv,
      cwd,
      env,
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
      logs,
    });

    const usage: UsageRecord = noAgentRanUsage();

    const structured: JsonValue = { stdout: truncateStdout(result.stdout) };

    // Decision (not in sheet), m1: `classify`/`ClassifyInput` is an agent-runtime concept
    // (`runtimeId: "claude-code" | "codex"`, state-machine.md §7.1) with nothing to classify for
    // a `command` node, which has no runtime CLI and no quota to hit -- its outcome is fully
    // determined by its own exit code, signal, timeout and cancel flags. `classify` is therefore
    // never called here; mvp-design.md §7.2 step 6 gives this rule directly: "a non-zero exit is
    // `node-failed` with `error.classified: runtime_error` and `code: exit_<n>`".
    if (result.timedOut) {
      return {
        eventType: "node-timed-out",
        status: "timed_out",
        exitCode: result.exitCode,
        structuredCandidate: structured,
        summary: `command timed out: ${argv.join(" ")}`,
        usage,
        error: { code: "node_timeout", message: "command did not finish within its timeout", classified: "timeout" },
      };
    }
    if (result.cancelled) {
      return {
        eventType: "node-failed",
        status: "cancelled",
        exitCode: result.exitCode,
        structuredCandidate: structured,
        summary: `command cancelled: ${argv.join(" ")}`,
        usage,
        error: { code: "cancelled", message: "command was cancelled", classified: "cancelled" },
      };
    }
    if (result.exitCode === 0) {
      return {
        eventType: "node-completed",
        status: "succeeded",
        exitCode: result.exitCode,
        structuredCandidate: structured,
        summary: `command exited 0: ${argv.join(" ")}`,
        usage,
      };
    }

    const exitLabel = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.exitCode}`;
    return {
      eventType: "node-failed",
      status: "failed",
      exitCode: result.exitCode,
      structuredCandidate: structured,
      summary: `command exited with ${exitLabel}: ${argv.join(" ")}`,
      usage,
      error: {
        code: result.exitCode === null ? `signal_${(result.signal ?? "unknown").toLowerCase()}` : `exit_${result.exitCode}`,
        message: `command exited with ${exitLabel}: ${argv.join(" ")}`,
        classified: "runtime_error",
      },
    };
  }

  // -----------------------------------------------------------------------------------------
  // agent nodes
  // -----------------------------------------------------------------------------------------

  async #dispatchAgent(
    request: DispatchRequest,
    node: ResolvedAgentNode,
    scalars: Record<string, JsonScalar>,
    env: Record<string, string>,
    logs: ReturnType<typeof openCapturedStreams>,
  ): Promise<RuntimeCompletion> {
    const prompt = this.#resolvePrompt(request, node, scalars);

    const runtimeVersion = "unknown"; // Decision (not in sheet), m1 -- see the class doc comment.
    const cancelSequence = node.runtime === "claude-code" ? CLAUDE_CANCEL_SEQUENCE : CODEX_CANCEL_SEQUENCE;

    // The two runtimes take a node's `structuredOutput` schema differently (measured against each
    // CLI's own `--help`, see `adapters/claude-code.ts`'s `buildClaudeArgv` doc comment): claude's
    // `--json-schema` wants the schema's JSON text inline, so no temp file is written for it here;
    // codex's `--output-schema` genuinely wants a file path, so that temp file is still written.
    let argv: string[];
    if (node.runtime === "claude-code") {
      const schemaJson = node.structuredOutput ? JSON.stringify(node.structuredOutput) : null;
      argv = buildClaudeArgv(node, prompt, schemaJson);
      argv[0] = this.#binaries.claude;
    } else {
      let schemaPath: string | null = null;
      if (node.structuredOutput) {
        schemaPath = this.#codexSchemaTempPath(request);
        writeFileSync(schemaPath, JSON.stringify(node.structuredOutput), "utf8");
      }
      const lastMessagePath = this.#lastMessageTempPath(request);
      argv = buildCodexArgv(node, prompt, schemaPath, lastMessagePath, request.workspace.worktreePath);
      argv[0] = this.#binaries.codex;
    }
    // A16: same resolution `describe()` printed for this node, over the same scrubbed `env` --
    // see `resolveArgv0`'s doc comment.
    argv = resolveArgv0(argv, env.PATH).argv;

    const stdoutChunks: Buffer[] = [];
    const runResult = await runProcess({
      argv,
      cwd: request.workspace.worktreePath,
      env,
      timeoutMs: request.timeoutMs,
      cancelSequence,
      ...(request.signal ? { signal: request.signal } : {}),
      onStdout: (chunk) => {
        stdoutChunks.push(chunk);
        logs.write("stdout", chunk);
      },
      onStderr: (chunk) => {
        logs.write("stderr", chunk);
      },
    });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const patterns = loadDefaultPatternTable();

    const completion =
      node.runtime === "claude-code"
        ? claudeCompletion({
            stdout,
            exitCode: runResult.exitCode,
            signal: runResult.signal,
            runtimeVersion,
            cancelRequested: runResult.cancelled,
            timeoutFired: runResult.timedOut,
            patterns,
            classify: this.#classify,
          })
        : codexCompletion({
            stdout,
            exitCode: runResult.exitCode,
            signal: runResult.signal,
            runtimeVersion,
            cancelRequested: runResult.cancelled,
            timeoutFired: runResult.timedOut,
            patterns,
            classify: this.#classify,
          });

    // Only a node that declares `structuredOutput` ever reports `result.structured` (loop-file.md
    // §8.1) -- a plain-text agent reply that happens to parse as JSON (codex) or a coincidental
    // stray `structured_output` key is not a structured answer this node asked for.
    const scoped: RuntimeCompletion = node.structuredOutput ? completion : { ...completion, structuredCandidate: null };
    return this.#revalidateStructuredOutput(node, scoped);
  }

  /**
   * mvp-design.md §11: "`structuredOutput`... [is] **re-validated by Loopmill** for both
   * runtimes -- a runtime's own validation is a convenience, not a contract." When the node
   * declares a schema and the completion otherwise succeeded, this re-checks the candidate value
   * against it with `ajv` and downgrades a non-conforming (or entirely missing) candidate to
   * `node-failed`, `error.classified: "artifact_invalid"` -- overriding what `classify` said,
   * since `classify`'s own `ClassifyInput` carries no schema to check against (state-machine.md
   * §7.1's `result: unknown` is the raw runtime message, not a validated value).
   */
  #revalidateStructuredOutput(node: ResolvedAgentNode, completion: RuntimeCompletion): RuntimeCompletion {
    if (!node.structuredOutput || completion.eventType !== "node-completed") {
      return completion;
    }
    const candidate = completion.structuredCandidate;
    if (candidate === null || !isRecord(candidate)) {
      return {
        ...completion,
        eventType: "node-failed",
        status: "failed",
        structuredCandidate: null,
        error: {
          code: "structured_output_invalid",
          message: "the node declares structuredOutput but no structured answer was produced",
          classified: "artifact_invalid",
        },
      };
    }
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(node.structuredOutput as unknown as Record<string, unknown>);
    if (!validate(candidate)) {
      const detail = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`).join("; ");
      return {
        ...completion,
        eventType: "node-failed",
        status: "failed",
        structuredCandidate: null,
        error: {
          code: "structured_output_invalid",
          message: `structured output does not validate against the node's schema: ${detail}`,
          classified: "artifact_invalid",
        },
      };
    }
    return completion;
  }

  // -----------------------------------------------------------------------------------------
  // envelope construction
  // -----------------------------------------------------------------------------------------

  #buildEnvelope(
    request: DispatchRequest,
    node: ResolvedAgentNode | ResolvedCommandNode,
    completion: RuntimeCompletion,
    logs: ReturnType<typeof openCapturedStreams>,
    clock: { now(): string },
  ): Envelope {
    const now = clock.now();

    let changed: ReturnType<typeof changedFiles> = [];
    try {
      changed = changedFiles(request.workspace.worktreePath);
    } catch {
      // A worktree read failure here must not turn a real completion into a dispatch crash; the
      // envelope simply reports no file artifactRefs.
      changed = [];
    }

    const artifactRefs: ArtifactRef[] = [
      ...changed.map((f) => fileArtifactRef(request.workspace.worktreePath, f.path)),
      logFileArtifactRef(logs.stdoutPath),
      logFileArtifactRef(logs.stderrPath),
    ];

    // "summary = a short redacted tail" -- the last TAIL_SUMMARY_BYTES bytes of whatever the
    // adapter/command runner reported, redacted (defence in depth: the stream itself was already
    // redacted line by line on its way to disk, but `completion.summary` is built independently,
    // straight from the parsed result) and capped to the schema's `summaryText` limit.
    const summary = completion.summary
      ? truncateForSchema(tail(redact(completion.summary), TAIL_SUMMARY_BYTES), SUMMARY_TEXT_MAX)
      : undefined;

    const errorPayload = completion.error
      ? {
          code: sanitizeErrorCode(completion.error.code),
          message: truncateForSchema(completion.error.message, TEXT_MAX),
          classified: completion.error.classified,
        }
      : undefined;

    const base = {
      eventType: completion.eventType,
      producer: "backend:local" as const,
      loopId: request.loopId,
      loopVersion: request.loopVersion,
      runId: request.runId,
      cycle: request.cycleIndex,
      nodeId: request.nodeId,
      attempt: request.attempt,
      ...(request.causationId ? { causationId: request.causationId } : {}),
      correlationId: request.runId,
      result: {
        status: completion.status,
        // Decision (not in sheet), m1: `result.exitCode` is populated for `command` nodes only,
        // matching `src/types/state.ts`'s own `NodeExecutionRecord` doc comment ("for command
        // nodes the executor reports stdout... and the exit code as result.exitCode") -- an agent
        // node's exit code is not part of the I/O contract loop-file.md §11 gives later nodes,
        // and `docs/spec/envelope-examples/node-timed-out.json` (an agent node) omits `exitCode`
        // entirely rather than reporting `-1`. `-1` is `envelope.schema.json`'s own documented
        // value for "killed by a signal", used here whenever a command was.
        ...(node.kind === "command" ? { exitCode: completion.exitCode ?? -1 } : {}),
        ...(completion.structuredCandidate !== null ? { structured: completion.structuredCandidate as Record<string, JsonValue> } : {}),
        ...(summary ? { summary } : {}),
      },
      artifactRefs,
      usage: toEnvelopeUsage(completion.usage),
      ...(errorPayload ? { error: errorPayload } : {}),
      ...(completion.error?.classified === "quota" && completion.quotaResetsAt
        ? { quotaResetsAt: completion.quotaResetsAt }
        : {}),
    };

    return makeEnvelope(base, { now });
  }

  // -----------------------------------------------------------------------------------------
  // small helpers
  // -----------------------------------------------------------------------------------------

  #resolvePrompt(request: DispatchRequest, node: ResolvedAgentNode, scalars: Record<string, JsonScalar>): string {
    let template: string;
    if (node.prompt !== undefined) {
      template = node.prompt;
    } else if (node.promptFile !== undefined) {
      const promptPath = resolvePath(request.workspace.repoRoot, node.promptFile);
      template = readFileSync(promptPath, "utf8");
    } else {
      throw new LoopmillError("agent_prompt_missing", `agent node "${node.id}" declares neither prompt nor promptFile`);
    }
    let prompt = renderTemplate(template, scalars);
    if (request.retryHint === "no_progress") {
      prompt = `${prompt}\n${RETRY_HINT_NOTE}`;
    }
    return prompt;
  }

  /** codex-only: `codex exec --output-schema` takes a file path (unlike claude-code's
   * `--json-schema`, which takes the schema's JSON text inline -- see `adapters/claude-code.ts`'s
   * `buildClaudeArgv` doc comment for the measured `--help` evidence behind the split). */
  #codexSchemaTempPath(request: DispatchRequest): string {
    return join(tmpdir(), `loopmill-codex-schema-${request.runId}-${request.cycleIndex}-${request.nodeId}-${request.attempt}.json`);
  }

  #lastMessageTempPath(request: DispatchRequest): string {
    return join(tmpdir(), `loopmill-codex-last-${request.runId}-${request.cycleIndex}-${request.nodeId}-${request.attempt}.txt`);
  }
}

/** One changed file's `artifactRef`. Decision (not in sheet), m1: `digest` here is a fresh
 * `sha256Prefixed` of the file's own current bytes, NOT `worktree.ts`'s `changedFiles()` digest
 * (git's own `hash-object`, whatever algorithm the repository uses -- SHA-1 unless the repo opted
 * into `--object-format=sha256`). `envelope.schema.json`'s `artifactRef.digest` must match
 * `$defs.sha256` (`^sha256:[0-9a-f]{64}$`); verified empirically that a plain git SHA-1 fails
 * that pattern. `changedFiles()`'s own digest stays git-native (acceptance test 3 pins it to
 * `git hash-object`'s literal output) for whatever internal fingerprinting the engine builds from
 * it; the wire `artifactRef` needs its own, independently sha256-shaped value. Omitted (not `""`)
 * for a file this attempt deleted, or one that could not be read for any reason -- an absent
 * digest is legal on `ArtifactRef`, an empty string is not a valid `sha256:` value. */
function fileArtifactRef(worktreePath: string, relativePath: string): ArtifactRef {
  let digest: string | undefined;
  try {
    digest = sha256Prefixed(readFileSync(join(worktreePath, relativePath)));
  } catch {
    digest = undefined;
  }
  return { kind: "file", ref: relativePath, ...(digest ? { digest } : {}) };
}

/** One captured log file's `artifactRef`, digested the same way (see `fileArtifactRef`) over the
 * file's on-disk (already redacted) bytes. */
function logFileArtifactRef(path: string): ArtifactRef {
  let digest: string | undefined;
  try {
    digest = sha256Prefixed(readFileSync(path));
  } catch {
    digest = undefined;
  }
  return { kind: "file", ref: path, ...(digest ? { digest } : {}) };
}
