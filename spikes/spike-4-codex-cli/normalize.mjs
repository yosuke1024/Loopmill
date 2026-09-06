#!/usr/bin/env node
// normalize.mjs -- the codex usage normaliser for SPIKE-4 (docs/spec/usage-normalization.md section
// 2.2, worked examples A and B). Reads a `codex exec --json` JSONL stream (or two, for a resumed
// thread), applies the subset-arithmetic and thread-delta rules, and writes a canonical UsageRecord
// plus a small diagnostics block. It has no dependencies beyond Node's own `fs`/`path`.
//
// Two ways to use it:
//
//   1. As a library: `import { normalizeCodexStream, parseJsonlFile } from "./normalize.mjs"`.
//      `normalizeCodexStream` is a pure function -- no filesystem access, no Date.now() -- so
//      test/normalize.test.mjs can feed it a fixture's `input.events` directly and assert on the
//      result byte for byte (see docs/spec/usage-fixtures/codex-*.json).
//
//   2. As a CLI, from spikes/spike-4-codex-cli/run.sh (check D8):
//
//        node normalize.mjs --jsonl out/D1.json --exit-code 0 --signal none \
//          --runtime-version "codex-cli 0.144.6" --out out/D1.usage.json \
//          [--model gpt-5.6-codex] [--start out/D4a.usage-start.json] \
//          [--fixture success --fixture-out out/fixtures/codex-recorded-success.json \
//           --invocation "codex exec --json ..." --recording-json out/recording.json]
//
//      `--jsonl`, `--exit-code` and `--signal` may each be repeated; when repeated they are
//      positional (jsonl[0] pairs with exit-code[0]/signal[0], and so on). This is only exercised by
//      `--fixture two-turns`, which needs both attempts' raw streams to build the two-attempt fixture
//      shape of docs/spec/usage-fixtures/codex-two-turns-cumulative.json. Every other invocation
//      passes each flag once.
//
// Rules implemented here (usage-normalization.md section 2.2, exactly):
//
//   cacheReadTokens  = cached_input_tokens (delta)
//   cacheWriteTokens = cache_write_input_tokens (delta; missing on either side is treated as 0 and
//                      noted)
//   freshInputTokens = max(0, input_tokens(delta) - cached_input_tokens(delta) - cache_write_input_tokens(delta))
//   outputTokens     = output_tokens (delta)
//   reasoningTokens  = reasoning_output_tokens (delta) -- reference only, never summed into a total
//   totalInputTokens = freshInputTokens + cacheWriteTokens + cacheReadTokens
//   totalTokens      = totalInputTokens + outputTokens
//
// where every "(delta)" is `lastTurnCompletedCumulative - usageAtAttemptStart`, field by field,
// clamped at 0 (section 2.2b, the thread-delta rule). `complete` is `true` only when the process
// exited 0, no signal ended it, and neither clamp fired; otherwise it is `false` and the note says
// which condition was the reason. A stream with no `turn.completed` at all (killed before one, or a
// `turn.failed`) normalises to `provenance: "unavailable"`, every bucket `null`, per section 2.5.

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Pure normalisation
// ---------------------------------------------------------------------------

function zeroUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function num(obj, key) {
  const v = obj ? obj[key] : undefined;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Pure function: turns a parsed `codex exec --json` event stream for ONE attempt into a canonical
 * UsageRecord (docs/spec/usage-normalization.md section 1.1/1.2) plus a small diagnostics block.
 * No filesystem access, no clock reads -- safe to call directly from tests.
 *
 * @param {object} args
 * @param {object[]} args.events - parsed JSONL events, in stream order.
 * @param {number|null} [args.exitCode] - the codex process's exit code.
 * @param {string|null} [args.signal] - the signal that ended the process ("SIGINT", "SIGTERM",
 *   "SIGKILL"), or null/omitted if none.
 * @param {string|null} [args.runtimeVersion] - `codex --version` output, stored verbatim.
 * @param {object|null} [args.usageAtAttemptStart] - the vendor-shaped cumulative usage object
 *   recorded when this attempt was dispatched (all-zero for a fresh thread).
 * @param {string|null} [args.model] - the model id, when known from the invocation.
 * @returns {{ usage: object, diagnostics: { turnCompletedCount: number, lastCumulative: object|null,
 *   threadId: string|null } }}
 */
export function normalizeCodexStream({ events, exitCode, signal, runtimeVersion, usageAtAttemptStart, model } = {}) {
  const evList = Array.isArray(events) ? events : [];
  const sig = signal || null;
  const mdl = model === undefined ? null : model;
  const start = usageAtAttemptStart && typeof usageAtAttemptStart === "object" ? usageAtAttemptStart : zeroUsage();
  const runtimeVer = runtimeVersion || null;

  let threadId = null;
  let lastTurnCompleted = null;
  let turnCompletedCount = 0;
  let sawTurnFailed = false;

  for (const ev of evList) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "thread.started" && ev.thread_id && !threadId) threadId = ev.thread_id;
    if (ev.type === "turn.completed") {
      turnCompletedCount++;
      lastTurnCompleted = ev;
    }
    if (ev.type === "turn.failed") {
      sawTurnFailed = true;
    }
  }

  const sessionRef = threadId ? { kind: "codex-thread", id: threadId } : null;
  const diagnostics = {
    turnCompletedCount,
    lastCumulative: lastTurnCompleted ? lastTurnCompleted.usage || null : null,
    threadId,
  };

  // -------------------------------------------------------------------------
  // No turn.completed at all: unavailable (section 2.5).
  // -------------------------------------------------------------------------
  if (!lastTurnCompleted) {
    const notes = [];
    if (sig) notes.push(`process ended via signal ${sig}`);
    else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) notes.push(`process exited ${exitCode}`);
    notes.push(sawTurnFailed ? "turn.failed with no preceding turn.completed on this thread" : "stream ended without turn.completed");

    return {
      usage: {
        runtime: "codex",
        model: mdl,
        freshInputTokens: null,
        cacheWriteTokens: null,
        cacheReadTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalInputTokens: null,
        totalTokens: null,
        provenance: "unavailable",
        provenanceNote: notes.join("; "),
        source: { runtimeVersion: runtimeVer, eventKind: sawTurnFailed ? "turn.failed" : null },
        complete: false,
        usageBasis: "none",
        sessionRef,
        usageAtAttemptStart: start,
        listPriceEquivalentUsd: null,
        perModel: null,
      },
      diagnostics,
    };
  }

  // -------------------------------------------------------------------------
  // turn.completed present: derived, via the thread-delta rule and subset arithmetic.
  // -------------------------------------------------------------------------
  const cum = lastTurnCompleted.usage || {};
  const cacheWriteMissing = !("cache_write_input_tokens" in cum) || !("cache_write_input_tokens" in start);

  let clampFired = false;
  const delta = (key) => {
    const d = num(cum, key) - num(start, key);
    if (d < 0) {
      clampFired = true;
      return 0;
    }
    return d;
  };

  const inputDelta = delta("input_tokens");
  const cachedDelta = delta("cached_input_tokens");
  const cacheWriteDelta = delta("cache_write_input_tokens");
  const outputDelta = delta("output_tokens");
  const reasoningDelta = delta("reasoning_output_tokens");

  const freshRaw = inputDelta - cachedDelta - cacheWriteDelta;
  const freshClamped = freshRaw < 0;
  if (freshClamped) clampFired = true;
  const fresh = Math.max(0, freshRaw);

  const totalInputTokens = fresh + cacheWriteDelta + cachedDelta;
  const totalTokens = totalInputTokens + outputDelta;

  const notes = [];
  notes.push(
    `turn.completed cumulative (input ${num(cum, "input_tokens")}, cached ${num(cum, "cached_input_tokens")}, ` +
      `cache_write ${num(cum, "cache_write_input_tokens")}, output ${num(cum, "output_tokens")}) minus ` +
      `usageAtAttemptStart, clamped at 0 field-by-field`
  );
  notes.push(`fresh = max(0, ${inputDelta} - ${cachedDelta} - ${cacheWriteDelta}) = ${fresh}`);
  if (cacheWriteMissing) notes.push("cache_write_input_tokens missing on at least one side; treated as 0");
  if (freshClamped) notes.push(`fresh subtraction went negative (raw ${freshRaw}); clamped to 0`);

  const complete = exitCode === 0 && !sig && !clampFired;
  if (!complete) {
    if (clampFired) notes.push("complete=false: the fresh clamp fired, so totalInputTokens no longer equals the delta of input_tokens");
    else if (sig) notes.push(`complete=false: process ended via signal ${sig}`);
    else if (exitCode !== 0) notes.push(`complete=false: process exited ${exitCode}`);
    else notes.push("complete=false");
  }

  return {
    usage: {
      runtime: "codex",
      model: mdl,
      freshInputTokens: fresh,
      cacheWriteTokens: cacheWriteDelta,
      cacheReadTokens: cachedDelta,
      outputTokens: outputDelta,
      reasoningTokens: reasoningDelta,
      totalInputTokens,
      totalTokens,
      provenance: "derived",
      provenanceNote: notes.join("; "),
      source: { runtimeVersion: runtimeVer, eventKind: "turn.completed" },
      complete,
      usageBasis: "turn.completed",
      sessionRef,
      usageAtAttemptStart: start,
      listPriceEquivalentUsd: null,
      perModel: null,
    },
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// JSONL parsing (filesystem-touching, kept separate from the pure function above)
// ---------------------------------------------------------------------------

function describeEventType(ev) {
  if (!ev || typeof ev !== "object") return "UNKNOWN";
  if ((ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed") && ev.item && ev.item.type) {
    return `${ev.type}:${ev.item.type}`;
  }
  return String(ev.type || "UNKNOWN");
}

/**
 * Parses a `codex exec --json` JSONL file (or any newline-delimited JSON text). Never throws on
 * malformed content: a line that fails to parse is counted in `parseErrors` and recorded as
 * "PARSE_ERROR" in `eventTypes`, but is not included in `events`. A truncated last line (no closing
 * brace, cut off mid-object -- the shape a killed process leaves behind) is indistinguishable from any
 * other malformed line at this layer and is counted the same way.
 *
 * @param {string} filePath
 * @returns {{ events: object[], lineCount: number, parseErrors: number, eventTypes: string[] }}
 */
export function parseJsonlFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  let lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines = lines.slice(0, -1);

  const events = [];
  const eventTypes = [];
  let parseErrors = 0;
  let lineCount = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    lineCount++;
    try {
      const obj = JSON.parse(line);
      events.push(obj);
      eventTypes.push(describeEventType(obj));
    } catch (e) {
      parseErrors++;
      eventTypes.push("PARSE_ERROR");
    }
  }

  return { events, lineCount, parseErrors, eventTypes };
}

// ---------------------------------------------------------------------------
// Fixture building (--fixture <name>)
// ---------------------------------------------------------------------------

const FIXTURE_META = {
  success: {
    checkId: "D1",
    title: "codex exec recorded: trivial prompt, clean success (SPIKE-4 D1)",
    nodeId: "implement",
    note:
      "codex exec --json against the prompt 'Reply with exactly: LOOPMILL-OK', a fresh thread. sessionPolicy fresh " +
      "is the MVP default: usageAtAttemptStart is zero, so the last turn.completed cumulative IS the attempt delta.",
  },
  structured: {
    checkId: "D2",
    title: "codex exec recorded: schema-validated structured output via --output-schema (SPIKE-4 D2)",
    nodeId: "review",
    note:
      "codex exec --json --output-schema schema.json against a structured pass/fail verdict prompt; the last " +
      "agent_message text is expected to parse as JSON and validate against schema.json.",
  },
  "turn-failed": {
    checkId: "D3b",
    title: "codex exec recorded: forced failure via an invalid --model (SPIKE-4 D3b)",
    nodeId: "implement",
    note:
      "codex exec --json -m loopmill-no-such-model against a trivial prompt. The runtime is expected to end the " +
      "turn with a turn.failed event (or, failing that, a non-JSON stderr message) and no turn.completed -- " +
      "whichever it is is itself the finding this fixture pins.",
  },
  sigint: {
    checkId: "D5-SIGINT",
    title: "codex exec recorded: SIGINT sent mid-turn (SPIKE-4 D5-SIGINT)",
    nodeId: "implement",
    note:
      "codex exec --json against a long counting prompt, SIGINT sent partway through streaming (the process was " +
      "confirmed alive at signal time). Whether a turn.completed still appears after SIGINT is itself the finding " +
      "this fixture records -- codex's SIGINT contract was not previously measured.",
  },
  sigterm: {
    checkId: "D5-SIGTERM",
    title: "codex exec recorded: SIGTERM sent mid-turn (SPIKE-4 D5-SIGTERM)",
    nodeId: "implement",
    note:
      "codex exec --json against a long counting prompt, SIGTERM sent partway through streaming (the process was " +
      "confirmed alive at signal time). Whether a turn.completed still appears after SIGTERM is itself the finding " +
      "this fixture records.",
  },
  worktree: {
    checkId: "D7",
    title: "codex exec recorded: file edit inside a git worktree, workspace-write (SPIKE-4 D7)",
    nodeId: "implement",
    note:
      "codex exec --json -s workspace-write -C <scratch worktree> creating SPIKE4.md with fixed content. Usage is " +
      "an ordinary single-turn derived record; recorded here to pin the shape for a workspace-write attempt " +
      "alongside the read-only checks.",
  },
};

function buildRunId(name) {
  const idUpper = String(name).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const base = `run_01SPIKE4${idUpper}RECORDED`;
  const targetLen = 30;
  const padLen = Math.max(0, targetLen - base.length);
  return base + "0".repeat(padLen);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function formatWithCommas(n) {
  return Number(n).toLocaleString("en-US");
}

function truncateEventsForFixture(events) {
  return (events || []).map((ev) => {
    if (ev && typeof ev === "object" && ev.item && typeof ev.item === "object" && ev.item.type === "agent_message" && typeof ev.item.text === "string" && ev.item.text.length > 2000) {
      return { ...ev, item: { ...ev.item, text: ev.item.text.slice(0, 2000), _truncated: true } };
    }
    return ev;
  });
}

function unmeasuredReason(usage) {
  if (usage.source && usage.source.eventKind === "turn.failed") return "turn.failed, no turn.completed";
  if (usage.provenance === "unavailable") return usage.provenanceNote || "stream ended without turn.completed";
  return usage.provenanceNote;
}

function mustNotEqualForDerived(usage) {
  return {
    totalIfCachedWereAddedToInput: usage.totalInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens,
    totalIfReasoningWereAddedToOutput: usage.totalTokens + (usage.reasoningTokens || 0),
  };
}

function buildDisplay(usage, measured) {
  if (usage.provenance === "unavailable") {
    return { nodeTotal: "—", measuredTokens: "0+", usageCoverage: "0/1 (0%)" };
  }
  if (measured) {
    return { measuredTokens: formatWithCommas(usage.totalTokens), usageCoverage: "1/1 (100%)" };
  }
  return { measuredTokens: `${formatWithCommas(usage.totalTokens)}+`, usageCoverage: "0/1 (0%)" };
}

function baseRecording({ checkId, runtimeVersion, nodeVersion, overrides }) {
  return Object.assign(
    {
      harness: `spikes/spike-4-codex-cli (check ${checkId})`,
      date: todayUtc(),
      host: "operator macOS host",
      runtimeVersion: runtimeVersion || null,
      nodeVersion: nodeVersion || process.version,
      authMode: "subscription-login",
      redaction: "token-shaped strings, e-mail addresses and home-directory names redacted by the harness; nothing else altered",
    },
    overrides || {}
  );
}

function buildSingleAttemptFixture({ name, usageResult, events, exitCode, signal, invocation, runtimeVersion, nodeVersion, recordingOverrides }) {
  const meta = FIXTURE_META[name];
  if (!meta) throw new Error(`normalize.mjs: unknown --fixture name '${name}' (expected one of: ${Object.keys(FIXTURE_META).concat(["two-turns"]).join(", ")})`);

  const usage = usageResult.usage;
  const measured = usage.provenance !== "unavailable" && usage.complete === true;
  const runId = buildRunId(name);
  const key = { runId, cycleIndex: 1, nodeId: meta.nodeId, attempt: 1 };

  const nodeExecution = {
    totalInputTokens: usage.totalInputTokens,
    totalTokens: usage.totalTokens,
    provenance: usage.provenance,
    measured,
  };

  const coverage = measured
    ? { agentExecutions: 1, measuredExecutions: 1, coverage: 1.0, unmeasured: [] }
    : {
        agentExecutions: 1,
        measuredExecutions: 0,
        coverage: 0.0,
        unmeasured: [{ cycleIndex: key.cycleIndex, nodeId: key.nodeId, attempt: key.attempt, runtime: "codex", reason: unmeasuredReason(usage) }],
      };

  const expected = {
    attempts: [{ key, usage }],
    nodeExecution,
    coverage,
    mustNotEqual: usage.provenance === "derived" ? mustNotEqualForDerived(usage) : { storedAsZero: 0 },
    display: buildDisplay(usage, measured),
  };

  return {
    fixtureId: `codex-recorded-${name}`,
    title: meta.title,
    handWritten: false,
    recording: baseRecording({ checkId: meta.checkId, runtimeVersion, nodeVersion, overrides: recordingOverrides }),
    spec: "docs/spec/usage-normalization.md",
    scenario: {
      backend: "local",
      runtime: "codex",
      authMode: "subscription-login",
      runId,
      cycleIndex: 1,
      nodeId: meta.nodeId,
      attempt: 1,
      sessionPolicy: "fresh",
      note: meta.note,
    },
    input: {
      invocation: invocation || null,
      exitCode: exitCode === undefined ? null : exitCode,
      signal: signal || null,
      usageAtAttemptStart: usage.usageAtAttemptStart,
      events: truncateEventsForFixture(events),
      ignoredStreamLines: [],
    },
    expected,
    assertsInvariants: usage.provenance === "unavailable" ? ["I2", "I4", "I9", "I12"] : ["I1", "I2", "I3", "I5", "I8", "I9"],
  };
}

function buildTwoTurnsFixture({ result1, result2, events1, events2, exitCodes, invocations, runtimeVersion, nodeVersion, recordingOverrides }) {
  const usage1 = result1.usage;
  const usage2 = result2.usage;
  const measured1 = usage1.provenance !== "unavailable" && usage1.complete === true;
  const measured2 = usage2.provenance !== "unavailable" && usage2.complete === true;

  const runId = buildRunId("two-turns");
  const key1 = { runId, cycleIndex: 1, nodeId: "implement", attempt: 1 };
  const key2 = { runId, cycleIndex: 2, nodeId: "implement", attempt: 1 };

  const run =
    measured1 && measured2
      ? {
          freshInputTokens: usage1.freshInputTokens + usage2.freshInputTokens,
          cacheWriteTokens: usage1.cacheWriteTokens + usage2.cacheWriteTokens,
          cacheReadTokens: usage1.cacheReadTokens + usage2.cacheReadTokens,
          outputTokens: usage1.outputTokens + usage2.outputTokens,
          totalInputTokens: usage1.totalInputTokens + usage2.totalInputTokens,
          totalTokens: usage1.totalTokens + usage2.totalTokens,
          provenance: "derived",
          note: "The sum of the two deltas equals the LAST cumulative reported on the thread. That identity is invariant I5.",
        }
      : null;

  const lastCumulative2 = result2.diagnostics.lastCumulative;
  const mustNotEqual =
    run && lastCumulative2
      ? {
          cycle2TotalIfCumulativeWereStoredRaw: num(lastCumulative2, "input_tokens") + num(lastCumulative2, "output_tokens"),
          runTotalIfCumulativesWereSummed: usage1.totalTokens + num(lastCumulative2, "input_tokens") + num(lastCumulative2, "output_tokens"),
          overcountIfCumulativesWereSummed: usage1.totalTokens,
        }
      : { storedAsZero: 0 };

  const coverage = {
    agentExecutions: 2,
    measuredExecutions: (measured1 ? 1 : 0) + (measured2 ? 1 : 0),
    coverage: ((measured1 ? 1 : 0) + (measured2 ? 1 : 0)) / 2,
    unmeasured: [
      ...(measured1 ? [] : [{ cycleIndex: 1, nodeId: "implement", attempt: 1, runtime: "codex", reason: unmeasuredReason(usage1) }]),
      ...(measured2 ? [] : [{ cycleIndex: 2, nodeId: "implement", attempt: 1, runtime: "codex", reason: unmeasuredReason(usage2) }]),
    ],
  };

  const display = run
    ? { measuredTokens: formatWithCommas(run.totalTokens), usageCoverage: "2/2 (100%)" }
    : {
        measuredTokens: `${formatWithCommas((usage1.totalTokens || 0) + (usage2.totalTokens || 0))}+`,
        usageCoverage: `${coverage.measuredExecutions}/2 (${Math.floor((100 * coverage.measuredExecutions) / 2)}%)`,
      };

  return {
    fixtureId: "codex-recorded-two-turns",
    title: "codex exec recorded: two sequential turns on one resumed thread (SPIKE-4 D4a+D4b)",
    handWritten: false,
    recording: baseRecording({ checkId: "D4a+D4b", runtimeVersion, nodeVersion, overrides: recordingOverrides }),
    spec: "docs/spec/usage-normalization.md",
    scenario: {
      backend: "local",
      runtime: "codex",
      authMode: "subscription-login",
      runId,
      sessionPolicy: "reuse",
      threadId: (usage2.sessionRef && usage2.sessionRef.id) || (usage1.sessionRef && usage1.sessionRef.id) || null,
      note:
        "Two attempts on the same Codex thread via codex exec resume: turn 1 a deliberately large output, turn 2 " +
        "'TURN-TWO'. turn.completed.usage is thread-cumulative, so attempt 2's usageAtAttemptStart is attempt 1's " +
        "last cumulative and the delta rule (usage-normalization.md section 2.2) recovers attempt 2's own tokens.",
    },
    input: {
      attempts: [
        {
          key: key1,
          invocation: (invocations && invocations[0]) || null,
          exitCode: exitCodes && exitCodes[0] !== undefined ? exitCodes[0] : null,
          usageAtAttemptStart: usage1.usageAtAttemptStart,
          events: truncateEventsForFixture(events1),
        },
        {
          key: key2,
          invocation: (invocations && invocations[1]) || null,
          exitCode: exitCodes && exitCodes[1] !== undefined ? exitCodes[1] : null,
          usageAtAttemptStart: usage2.usageAtAttemptStart,
          events: truncateEventsForFixture(events2),
        },
      ],
      ignoredStreamLines: [],
    },
    expected: {
      attempts: [
        { key: key1, usage: usage1 },
        { key: key2, usage: usage2 },
      ],
      run,
      coverage,
      mustNotEqual,
      display,
    },
    assertsInvariants: ["I1", "I2", "I3", "I5", "I8", "I9", "I10"],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MULTI_FLAGS = new Set(["jsonl", "exit-code", "signal", "invocation"]);

function parseArgs(argv) {
  const out = {};
  for (const key of MULTI_FLAGS) out[key] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    i++;
    if (MULTI_FLAGS.has(key)) out[key].push(val);
    else out[key] = val;
  }
  return out;
}

function pick(arr, i, def) {
  if (!arr || arr.length === 0) return def;
  return arr[i] !== undefined ? arr[i] : arr[0];
}

function parseExitCode(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parseSignalArg(v) {
  if (!v || v === "none") return null;
  return v;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const jsonlFiles = args.jsonl;
  if (!jsonlFiles || jsonlFiles.length === 0 || !jsonlFiles[0]) {
    console.error("normalize.mjs: --jsonl <file> is required");
    process.exit(1);
  }
  if (!args.out) {
    console.error("normalize.mjs: --out <file> is required");
    process.exit(1);
  }

  const runtimeVersion = args["runtime-version"] || null;
  const model = args.model || null;
  const nodeVersion = process.version;

  let usageAtAttemptStart = zeroUsage();
  if (args.start) {
    try {
      usageAtAttemptStart = JSON.parse(fs.readFileSync(args.start, "utf8"));
    } catch (e) {
      console.error(`normalize.mjs: failed to read --start ${args.start}: ${e && e.message}`);
    }
  }

  const parsed0 = parseJsonlFile(jsonlFiles[0]);
  const exitCode0 = parseExitCode(pick(args["exit-code"], 0, null));
  const signal0 = parseSignalArg(pick(args.signal, 0, null));

  const result0 = normalizeCodexStream({
    events: parsed0.events,
    exitCode: exitCode0,
    signal: signal0,
    runtimeVersion,
    usageAtAttemptStart,
    model,
  });

  const diagnostics0 = {
    lineCount: parsed0.lineCount,
    parseErrors: parsed0.parseErrors,
    eventTypes: parsed0.eventTypes,
    turnCompletedCount: result0.diagnostics.turnCompletedCount,
    lastCumulative: result0.diagnostics.lastCumulative,
    threadId: result0.diagnostics.threadId,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify({ usage: result0.usage, diagnostics: diagnostics0 }, null, 2) + "\n");

  if (args.fixture) {
    if (!args["fixture-out"]) {
      console.error("normalize.mjs: --fixture-out <file> is required with --fixture");
      process.exit(1);
    }

    let recordingOverrides = null;
    if (args["recording-json"]) {
      try {
        recordingOverrides = JSON.parse(fs.readFileSync(args["recording-json"], "utf8"));
      } catch (e) {
        console.error(`normalize.mjs: failed to read --recording-json ${args["recording-json"]}: ${e && e.message}`);
      }
    }

    let fixture;
    if (args.fixture === "two-turns") {
      if (jsonlFiles.length < 2 || !jsonlFiles[1]) {
        console.error("normalize.mjs: --fixture two-turns requires --jsonl given twice (attempt 1, then attempt 2)");
        process.exit(1);
      }
      const parsed1 = parseJsonlFile(jsonlFiles[1]);
      const exitCode1 = parseExitCode(pick(args["exit-code"], 1, exitCode0));
      const signal1 = parseSignalArg(pick(args.signal, 1, null));
      // Attempt 2's start is attempt 1's own last cumulative, per the delta rule -- not whatever
      // --start was given (that flag describes attempt 1's start, normally zero for a fresh thread).
      const result1 = normalizeCodexStream({
        events: parsed1.events,
        exitCode: exitCode1,
        signal: signal1,
        runtimeVersion,
        usageAtAttemptStart: result0.diagnostics.lastCumulative || zeroUsage(),
        model,
      });

      fixture = buildTwoTurnsFixture({
        result1: result0,
        result2: result1,
        events1: parsed0.events,
        events2: parsed1.events,
        exitCodes: [exitCode0, exitCode1],
        invocations: args.invocation && args.invocation.length ? args.invocation : null,
        runtimeVersion,
        nodeVersion,
        recordingOverrides,
      });
    } else {
      fixture = buildSingleAttemptFixture({
        name: args.fixture,
        usageResult: result0,
        events: parsed0.events,
        exitCode: exitCode0,
        signal: signal0,
        invocation: args.invocation && args.invocation.length ? args.invocation[0] : null,
        runtimeVersion,
        nodeVersion,
        recordingOverrides,
      });
    }

    fs.mkdirSync(path.dirname(args["fixture-out"]), { recursive: true });
    fs.writeFileSync(args["fixture-out"], JSON.stringify(fixture, null, 2) + "\n");
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch (e) {
    return false;
  }
})();

if (isMain) {
  main();
}
