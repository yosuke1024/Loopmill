// claude-code usage normalization. docs/spec/usage-normalization.md §2.1, in full: the
// modelUsage-vs-result.usage precedence (R1/R2), the field mapping table, the zeroed-crash rule
// and the `aborted_streaming` completeness rule (both `Decision (not in sheet)`), and the
// no-result failure shapes of §2.5 (SIGTERM/SIGKILL, a stream that never reached a terminal
// event).

import type { UsageRecord } from "../types/usage.ts";
import { unavailableRecord } from "./record.ts";

export interface NormalizeClaudeCodeResultInput {
  /** The claude-code terminal `result` message (parsed JSON), or `null`/`undefined` when the
   * process produced none (killed, or the stream closed mid-turn). */
  result: unknown | null;
  exitCode: number | null;
  signal: string | null;
  runtimeVersion: string | null;
  /** Every other stream-json line the invocation produced, in order. Never a usage source
   * (§2.1, invariant I7) — read only for the `system`/`init` line's `model` and `session_id`,
   * which are the sole fallback when no result exists or the result's basis is `result.usage`
   * with no per-call model info of its own. */
  streamLines?: unknown[];
}

// -------------------------------------------------------------------------------------------
// Small, local type guards over `unknown`. The vendor result object is never trusted as a typed
// shape beyond what is read here.
// -------------------------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function numOrZero(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function strOrNull(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

function isCostBasis(x: unknown): x is "list" | "managed" | "unknown" {
  return x === "list" || x === "managed" || x === "unknown";
}

interface StreamInit {
  model: string | null;
  sessionId: string | null;
}

/** Finds the `system`/`init` stream line, if any. Not a usage source (I7) — only identity
 * metadata (`model`, `session_id`) is ever read from it. */
function findSystemInit(streamLines: unknown[]): StreamInit | null {
  for (const line of streamLines) {
    if (isRecord(line) && line["type"] === "system" && line["subtype"] === "init") {
      return { model: strOrNull(line["model"]), sessionId: strOrNull(line["session_id"]) };
    }
  }
  return null;
}

interface ModelUsageEntry {
  key: string;
  freshInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  listPriceEquivalentUsd: number | null;
  costBasis: "list" | "managed" | "unknown" | null;
}

function readModelUsageEntries(modelUsage: Record<string, unknown>): ModelUsageEntry[] {
  const out: ModelUsageEntry[] = [];
  for (const key of Object.keys(modelUsage)) {
    const raw = modelUsage[key];
    if (!isRecord(raw)) continue;
    out.push({
      key,
      freshInputTokens: numOrZero(raw["inputTokens"]),
      cacheWriteTokens: numOrZero(raw["cacheCreationInputTokens"]),
      cacheReadTokens: numOrZero(raw["cacheReadInputTokens"]),
      outputTokens: numOrZero(raw["outputTokens"]),
      reasoningTokens: typeof raw["thinkingTokens"] === "number" ? raw["thinkingTokens"] : null,
      listPriceEquivalentUsd: numOrNull(raw["costUSD"]),
      costBasis: isCostBasis(raw["costBasis"]) ? raw["costBasis"] : null,
    });
  }
  return out;
}

function buildNoResultNote(signal: string | null, exitCode: number | null): string {
  if (signal) {
    const exitPart = typeof exitCode === "number" ? ` (exit ${exitCode})` : "";
    return (
      `process terminated by ${signal}${exitPart}; no result message was emitted, so no usage ` +
      "exists to normalize. Tokens were certainly consumed."
    );
  }
  const exitPart = typeof exitCode === "number" ? `exit ${exitCode}` : "an unknown exit";
  return (
    `process ended (${exitPart}) with no result message; no usage exists to normalize. Tokens ` +
    "were certainly consumed."
  );
}

/** §2.1 R6 (the `Decision (not in sheet)` completeness rule): `aborted_streaming` is always
 * incomplete; `error_max_budget_usd` requires the `modelUsage` basis to be complete; every other
 * terminal shape claude-code can reach (success, max_turns, schema-retry exhaustion, an ordinary
 * `error_during_execution` that is not a SIGINT abort) is complete once a non-zero usage record
 * has been written at all. */
function computeComplete(
  terminalReason: string | null,
  subtype: string | null,
  basis: "modelUsage" | "result.usage",
): boolean {
  if (terminalReason === "aborted_streaming") return false;
  if (subtype === "error_max_budget_usd") return basis === "modelUsage";
  return true;
}

export function normalizeClaudeCodeResult(input: NormalizeClaudeCodeResultInput): UsageRecord {
  const streamLines = input.streamLines ?? [];
  const init = findSystemInit(streamLines);
  const initSessionRef: UsageRecord["sessionRef"] = init?.sessionId
    ? { kind: "claude-session", id: init.sessionId }
    : null;

  if (input.result === null || input.result === undefined) {
    return unavailableRecord({
      runtime: "claude-code",
      runtimeVersion: input.runtimeVersion,
      eventKind: null,
      note: buildNoResultNote(input.signal, input.exitCode),
      model: init?.model ?? null,
      sessionRef: initSessionRef,
    });
  }

  if (!isRecord(input.result)) {
    return unavailableRecord({
      runtime: "claude-code",
      runtimeVersion: input.runtimeVersion,
      eventKind: "result",
      note: "result message was not a JSON object; nothing to normalize",
      model: init?.model ?? null,
      sessionRef: initSessionRef,
    });
  }

  const result = input.result;
  const sessionRef: UsageRecord["sessionRef"] = strOrNull(result["session_id"])
    ? { kind: "claude-session", id: strOrNull(result["session_id"]) as string }
    : initSessionRef;
  const listPriceEquivalentUsd = numOrNull(result["total_cost_usd"]);
  const terminalReason = strOrNull(result["terminal_reason"]);
  const subtype = strOrNull(result["subtype"]);

  const modelUsageRaw = result["modelUsage"];
  const hasModelUsage = isRecord(modelUsageRaw) && Object.keys(modelUsageRaw).length > 0;
  const usageRaw = result["usage"];
  const hasUsage = isRecord(usageRaw);

  if (!hasModelUsage && !hasUsage) {
    return unavailableRecord({
      runtime: "claude-code",
      runtimeVersion: input.runtimeVersion,
      eventKind: "result",
      note: "result present but carries neither modelUsage nor usage; nothing to normalize",
      model: init?.model ?? null,
      sessionRef,
    });
  }

  let fresh: number;
  let write: number;
  let read: number;
  let output: number;
  let reasoning: number | null;
  let basis: "modelUsage" | "result.usage";
  let model: string | null;
  let perModel: UsageRecord["perModel"];
  let provenanceNote: string;

  if (hasModelUsage) {
    const modelUsage = modelUsageRaw;
    const entries = readModelUsageEntries(modelUsage);
    fresh = entries.reduce((s, e) => s + e.freshInputTokens, 0);
    write = entries.reduce((s, e) => s + e.cacheWriteTokens, 0);
    read = entries.reduce((s, e) => s + e.cacheReadTokens, 0);
    output = entries.reduce((s, e) => s + e.outputTokens, 0);
    const everyEntryHasThinking = entries.length > 0 && entries.every((e) => e.reasoningTokens !== null);
    reasoning = everyEntryHasThinking
      ? entries.reduce((s, e) => s + (e.reasoningTokens ?? 0), 0)
      : null;
    basis = "modelUsage";
    model = null; // §1.3: several models may have contributed; perModel carries the split.
    perModel = entries.map((e) => {
      const totalInputTokens = e.freshInputTokens + e.cacheWriteTokens + e.cacheReadTokens;
      return {
        model: e.key,
        freshInputTokens: e.freshInputTokens,
        cacheWriteTokens: e.cacheWriteTokens,
        cacheReadTokens: e.cacheReadTokens,
        outputTokens: e.outputTokens,
        reasoningTokens: e.reasoningTokens,
        totalInputTokens,
        totalTokens: totalInputTokens + e.outputTokens,
        listPriceEquivalentUsd: e.listPriceEquivalentUsd,
        costBasis: e.costBasis,
      };
    });
    provenanceNote =
      `basis=modelUsage (§2.1 precedence 1: present and non-empty); summed element-wise over ` +
      `${entries.length} model(s) (${entries.map((e) => e.key).join(", ")}): ` +
      `freshInputTokens=${fresh}, cacheWriteTokens=${write}, cacheReadTokens=${read}, ` +
      `outputTokens=${output} -> totalInputTokens=${fresh + write + read}, ` +
      `totalTokens=${fresh + write + read + output}.`;
  } else {
    const usage = usageRaw as Record<string, unknown>;
    fresh = numOrZero(usage["input_tokens"]);
    write = numOrZero(usage["cache_creation_input_tokens"]);
    read = numOrZero(usage["cache_read_input_tokens"]);
    output = numOrZero(usage["output_tokens"]);
    const details = usage["output_tokens_details"];
    reasoning = isRecord(details) && typeof details["thinking_tokens"] === "number"
      ? details["thinking_tokens"]
      : null;
    basis = "result.usage";
    model = init?.model ?? null;
    perModel = null;
    provenanceNote =
      "basis=result.usage (modelUsage absent or empty): " +
      `freshInputTokens=${fresh} (input_tokens), cacheWriteTokens=${write} ` +
      `(cache_creation_input_tokens), cacheReadTokens=${read} (cache_read_input_tokens), ` +
      `outputTokens=${output} (output_tokens).`;
  }

  const totalInputTokens = fresh + write + read;
  const totalTokens = totalInputTokens + output;

  // §2.1 "Decision (not in sheet)" zeroed-crash rule: a would-be `reported` record whose total
  // input is zero is a crash/auth failure wearing a measurement's label, not a measured zero.
  if (totalInputTokens === 0) {
    return unavailableRecord({
      runtime: "claude-code",
      runtimeVersion: input.runtimeVersion,
      eventKind: "result",
      note:
        "result present but all usage fields zero; treated as unavailable, not as a measurement of zero",
      model,
      sessionRef,
    });
  }

  const complete = computeComplete(terminalReason, subtype, basis);
  if (!complete) {
    provenanceNote +=
      terminalReason === "aborted_streaming"
        ? " terminal_reason=aborted_streaming: the interrupted response's tokens are absent " +
          "from every usage field, so this record is a lower bound (complete=false)."
        : " complete=false: error_max_budget_usd without the modelUsage basis omits the " +
          "response that crossed the cap.";
  }

  const record: UsageRecord = {
    runtime: "claude-code",
    model,
    freshInputTokens: fresh,
    cacheWriteTokens: write,
    cacheReadTokens: read,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalInputTokens,
    totalTokens,
    provenance: "reported",
    provenanceNote,
    source: { runtimeVersion: input.runtimeVersion, eventKind: "result" },
    complete,
    usageBasis: basis,
    sessionRef,
    usageAtAttemptStart: null,
    listPriceEquivalentUsd,
    perModel,
  };
  return record;
}
