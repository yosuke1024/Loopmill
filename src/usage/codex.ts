// codex usage normalization. docs/spec/usage-normalization.md §2.2, in full: subset arithmetic
// (cached/cache-write tokens are subsets of input_tokens, not siblings of it), the per-process
// rule (SPIKE-4 D4: a resumed thread's process reports only its own usage, so
// `usageAtAttemptStart` is all-zero for every MVP attempt and the "last turn.completed minus
// start, clamped at 0" delta collapses to the cumulative itself), and the failure shapes of
// §2.5 (a signal mid-turn, `turn.failed` with no preceding `turn.completed`).
//
// This is a faithful TypeScript port of the pure normaliser proven out in
// spikes/spike-4-codex-cli/normalize.mjs (`normalizeCodexStream`) and its tests
// (spikes/spike-4-codex-cli/test/normalize.test.mjs); it does not import from `spikes/`.

import type { UsageRecord } from "../types/usage.ts";

export interface NormalizeCodexStreamInput {
  /** Parsed `codex exec --json` JSONL events, in stream order, for ONE attempt (one process). */
  events: unknown[];
  exitCode: number | null;
  signal: string | null;
  runtimeVersion: string | null;
  /** The vendor-shaped cumulative usage object recorded when this attempt was dispatched.
   * All-zero for every MVP attempt (§2.2b: a process counts only itself). `null`/omitted is
   * treated as all-zero. */
  usageAtAttemptStart?: Record<string, number> | null;
  model?: string | null;
}

export interface NormalizeCodexStreamDiagnostics {
  lineCount?: number;
  parseErrors?: number;
  eventTypes: string[];
  turnCompletedCount: number;
  lastCumulative: Record<string, number> | null;
  threadId: string | null;
}

export interface NormalizeCodexStreamResult {
  usage: UsageRecord;
  diagnostics: NormalizeCodexStreamDiagnostics;
}

function zeroUsage(): Record<string, number> {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function num(obj: Record<string, unknown> | undefined, key: string): number {
  const v = obj ? obj[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function describeEventType(ev: unknown): string {
  if (!isRecord(ev)) return "UNKNOWN";
  const type = typeof ev["type"] === "string" ? ev["type"] : "UNKNOWN";
  if (
    (type === "item.started" || type === "item.updated" || type === "item.completed") &&
    isRecord(ev["item"]) &&
    typeof ev["item"]["type"] === "string"
  ) {
    return `${type}:${ev["item"]["type"]}`;
  }
  return type;
}

/**
 * Pure normaliser: turns one attempt's parsed `codex exec --json` event stream into a canonical
 * `UsageRecord` (§1.1/§1.2) plus a small diagnostics block. No filesystem access, no clock reads.
 */
export function normalizeCodexStream(input: NormalizeCodexStreamInput): NormalizeCodexStreamResult {
  const events = input.events;
  const signal = input.signal || null;
  const model = input.model === undefined ? null : input.model;
  const start = input.usageAtAttemptStart && typeof input.usageAtAttemptStart === "object"
    ? input.usageAtAttemptStart
    : zeroUsage();
  const runtimeVersion = input.runtimeVersion || null;

  let threadId: string | null = null;
  let lastTurnCompleted: Record<string, unknown> | null = null;
  let turnCompletedCount = 0;
  let sawTurnFailed = false;
  const eventTypes: string[] = [];

  for (const ev of events) {
    eventTypes.push(describeEventType(ev));
    if (!isRecord(ev)) continue;
    if (ev["type"] === "thread.started" && typeof ev["thread_id"] === "string" && !threadId) {
      threadId = ev["thread_id"];
    }
    if (ev["type"] === "turn.completed") {
      turnCompletedCount++;
      lastTurnCompleted = ev;
    }
    if (ev["type"] === "turn.failed") {
      sawTurnFailed = true;
    }
  }

  const sessionRef: UsageRecord["sessionRef"] = threadId ? { kind: "codex-thread", id: threadId } : null;
  const lastCumulativeRaw = lastTurnCompleted ? lastTurnCompleted["usage"] : null;
  const lastCumulative: Record<string, number> | null = isRecord(lastCumulativeRaw)
    ? Object.fromEntries(
        Object.entries(lastCumulativeRaw).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      )
    : null;

  const diagnostics: NormalizeCodexStreamDiagnostics = {
    eventTypes,
    turnCompletedCount,
    lastCumulative,
    threadId,
  };

  // -----------------------------------------------------------------------------------------
  // No turn.completed at all: unavailable (§2.5).
  // -----------------------------------------------------------------------------------------
  if (!lastTurnCompleted) {
    const notes: string[] = [];
    if (signal) notes.push(`process ended via signal ${signal}`);
    else if (input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0) {
      notes.push(`process exited ${input.exitCode}`);
    }
    notes.push(
      sawTurnFailed
        ? "turn.failed with no preceding turn.completed on this thread"
        : "stream ended without turn.completed",
    );

    const usage: UsageRecord = {
      runtime: "codex",
      model,
      freshInputTokens: null,
      cacheWriteTokens: null,
      cacheReadTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalInputTokens: null,
      totalTokens: null,
      provenance: "unavailable",
      provenanceNote: notes.join("; "),
      source: { runtimeVersion, eventKind: sawTurnFailed ? "turn.failed" : null },
      complete: false,
      usageBasis: "none",
      sessionRef,
      usageAtAttemptStart: start,
      listPriceEquivalentUsd: null,
      perModel: null,
    };
    return { usage, diagnostics };
  }

  // -----------------------------------------------------------------------------------------
  // turn.completed present: derived, via subset arithmetic and the (all-zero, in the MVP)
  // thread-delta rule.
  // -----------------------------------------------------------------------------------------
  const cum = isRecord(lastTurnCompleted["usage"]) ? lastTurnCompleted["usage"] : {};
  const cacheWriteMissing = !("cache_write_input_tokens" in cum) || !("cache_write_input_tokens" in start);

  let clampFired = false;
  const delta = (key: string): number => {
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

  const notes: string[] = [];
  notes.push(
    `turn.completed cumulative (input ${num(cum, "input_tokens")}, cached ${num(cum, "cached_input_tokens")}, ` +
      `cache_write ${num(cum, "cache_write_input_tokens")}, output ${num(cum, "output_tokens")}) minus ` +
      "usageAtAttemptStart, clamped at 0 field-by-field",
  );
  notes.push(`fresh = max(0, ${inputDelta} - ${cachedDelta} - ${cacheWriteDelta}) = ${fresh}`);
  if (cacheWriteMissing) notes.push("cache_write_input_tokens missing on at least one side; treated as 0");
  if (freshClamped) notes.push(`fresh subtraction went negative (raw ${freshRaw}); clamped to 0`);

  const complete = input.exitCode === 0 && !signal && !clampFired;
  if (!complete) {
    if (clampFired) {
      notes.push(
        "complete=false: the fresh clamp fired, so totalInputTokens no longer equals the delta of input_tokens",
      );
    } else if (signal) {
      notes.push(`complete=false: process ended via signal ${signal}`);
    } else if (input.exitCode !== 0) {
      notes.push(`complete=false: process exited ${input.exitCode}`);
    } else {
      notes.push("complete=false");
    }
  }

  const usage: UsageRecord = {
    runtime: "codex",
    model,
    freshInputTokens: fresh,
    cacheWriteTokens: cacheWriteDelta,
    cacheReadTokens: cachedDelta,
    outputTokens: outputDelta,
    reasoningTokens: reasoningDelta,
    totalInputTokens,
    totalTokens,
    provenance: "derived",
    provenanceNote: notes.join("; "),
    source: { runtimeVersion, eventKind: "turn.completed" },
    complete,
    usageBasis: "turn.completed",
    sessionRef,
    usageAtAttemptStart: start,
    listPriceEquivalentUsd: null,
    perModel: null,
  };
  return { usage, diagnostics };
}

export interface ParseCodexJsonlResult {
  events: unknown[];
  parseErrors: number;
  /** True iff the final non-empty line failed to parse AND the text did not end in a newline —
   * the shape a process killed mid-write leaves behind, distinguished from an ordinary malformed
   * line elsewhere in the stream. */
  lastLineTruncated: boolean;
}

/** Parses a `codex exec --json` JSONL stream. Never throws: a line that fails to parse is
 * counted in `parseErrors` and excluded from `events` (§2.5: "a malformed line MUST NOT be
 * partially salvaged"). */
export function parseCodexJsonl(text: string): ParseCodexJsonlResult {
  const endsWithNewline = text.endsWith("\n");
  let lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  const events: unknown[] = [];
  let parseErrors = 0;
  let lastLineTruncated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      parseErrors++;
      if (i === lines.length - 1 && !endsWithNewline) {
        lastLineTruncated = true;
      }
    }
  }

  return { events, parseErrors, lastLineTruncated };
}
