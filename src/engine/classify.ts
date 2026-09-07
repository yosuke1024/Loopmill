// `classifyFailure` (state-machine.md §7.1-§7.4): the pure, versioned, data-driven verdict a
// backend's terminal report (or the sweep's silence) resolves to, in the fixed
// `classifyFailureOrder` of `state-machine.json`: LOST -> TIMEOUT -> CANCELLED -> QUOTA ->
// SUCCESS -> FAILED. Also the two small wire-mapping helpers `classificationOfError` (§7.1's
// table, envelope `error.classified` -> `Classification`) and `errorPayloadFor` (the reverse:
// what `transition.ts` puts on an emitted `node-completed`/`node-failed`'s... no — `errorPayloadFor`
// builds the `ErrorPayload` a `ClassifyOutput` implies, for callers that need to synthesise one).

import type { ErrorPayload } from "../types/envelope.ts";
import type { ClassifyInput, ClassifyOutput, Classification, PatternTable } from "../types/state.ts";
import { loadStateMachineJson } from "./policy.ts";

// ---------------------------------------------------------------------------------------------
// Pattern table
// ---------------------------------------------------------------------------------------------

/**
 * `state-machine.json`'s `quotaPatterns` ships one flat pattern set per runtime, not the
 * array-of-version-ranges `PatternTable` type allows for (state.ts: "keyed by runtimeId, then by
 * the runtime-version range the pattern set was verified against"). Decision (not in sheet), m1:
 * wrapped here as a single entry per runtime with `versionRange: "*"` (matches any version) —
 * only one verified range exists per runtime today (claude-code 2.1.263 `[V]`, codex 0.153.4
 * `[V]`); a second range is added by giving that runtime a second array entry, not by changing
 * this function's shape.
 */
export function loadPatternTable(): PatternTable {
  const { quotaPatterns } = loadStateMachineJson();
  const table: PatternTable = {};
  for (const [runtimeId, patterns] of Object.entries(quotaPatterns)) {
    table[runtimeId] = [{ versionRange: "*", patterns }];
  }
  return table;
}

function patternsFor(patterns: PatternTable, runtimeId: string): PatternTable[string][number]["patterns"] | undefined {
  const entries = patterns[runtimeId];
  if (!entries || entries.length === 0) return undefined;
  // Single verified range in the MVP (see loadPatternTable's Decision above): the first entry
  // whose versionRange is "*" always matches; a future multi-range table would need a real
  // range check here instead.
  return entries[0]?.patterns;
}

// ---------------------------------------------------------------------------------------------
// Small structural readers over the untyped `result`/`streamEvents` blobs
// ---------------------------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const CLAUDE_QUOTA_POSITIVE_RE = /You've hit your (session|weekly|Opus|Sonnet|Fable|usage credit) limit/;
const CLAUDE_QUOTA_RESET_SUFFIX_RE = /·\s*resets at\s+(.+)$/;
const CLAUDE_QUOTA_NEGATIVE_RES: RegExp[] = [/Server is temporarily limiting requests/, /Request rejected \(429\)/];

function isClaudeApiRetryLeadingIndicator(event: unknown): boolean {
  const rec = asRecord(event);
  if (!rec) return false;
  const type = asString(rec.type);
  if (type !== "system/api_retry" && !(asString(rec.event) === "api_retry")) return false;
  const error = asString(rec.error);
  return error === "rate_limit" || error === "billing_error";
}

interface QuotaMatch {
  matched: boolean;
  resetsAt?: string;
  window?: string;
  source?: "reported" | "derived-window";
  limitName?: string;
}

/** claude-code — §7.3. */
function claudeCodeQuota(input: ClassifyInput): QuotaMatch {
  const resultRec = asRecord(input.result);
  const text = asString(resultRec?.result) ?? asString(resultRec?.message) ?? "";

  // Negative look-alikes force FAILED even if a positive pattern also happened to match.
  if (CLAUDE_QUOTA_NEGATIVE_RES.some((re) => re.test(text))) {
    return { matched: false };
  }

  const positiveMatch = CLAUDE_QUOTA_POSITIVE_RE.exec(text);
  if (!positiveMatch) {
    // A leading-indicator-only stream event (system/api_retry) is never terminal by itself
    // (§7.3: "on its own is never terminal"); classifyFailure is only ever asked to classify a
    // terminal report, so with no positive text match there is nothing to upgrade.
    return { matched: false };
  }

  const limitName = positiveMatch[1] ?? "session";
  const suffixMatch = CLAUDE_QUOTA_RESET_SUFFIX_RE.exec(text);
  if (suffixMatch?.[1]) {
    const parsed = tryParseDate(suffixMatch[1].trim());
    if (parsed) {
      return { matched: true, resetsAt: parsed, source: "reported", limitName };
    }
  }

  // rate_limit_event (structured signal, §7.3): supporting evidence for quotaResetsAt.
  for (const evt of input.streamEvents) {
    const rec = asRecord(evt);
    if (!rec || asString(rec.type) !== "rate_limit_event") continue;
    const info = asRecord(rec.rate_limit_info);
    const windows = asRecord(info?.unifiedWindows);
    const windowKey = limitNameToWindowKey(limitName);
    const window = asRecord(windows?.[windowKey]);
    const resetsAtEpochSeconds = window?.resetsAt;
    if (typeof resetsAtEpochSeconds === "number") {
      return {
        matched: true,
        resetsAt: new Date(resetsAtEpochSeconds * 1000).toISOString(),
        window: windowKey,
        source: "reported",
        limitName,
      };
    }
  }

  return { matched: true, limitName };
}

function limitNameToWindowKey(limitName: string): string {
  return limitName === "session" ? "five_hour" : "seven_day";
}

/** codex — §7.3. `result` for codex is modelled as the last `turn.completed` / `turn.failed`
 * message: `{ type?: string; error?: { message?: string }; message?: string; codexErrorInfo?:
 * string; willRetry?: boolean }` — a reasonable shape for the fields §7.1-§7.4 name explicitly
 * (`turn.failed.error.message`, `error.message`, `codexErrorInfo`, `rate_limit_exceeded` +
 * `willRetry`); the exact envelope codex's app-server/exec JSONL uses beyond these fields is out
 * of scope for classify.ts (SPIKE-4's fixtures own that). */
function codexQuota(input: ClassifyInput): QuotaMatch {
  const resultRec = asRecord(input.result);
  const errorRec = asRecord(resultRec?.error);
  const message = asString(errorRec?.message) ?? asString(resultRec?.message) ?? "";
  const codexErrorInfo = asString(resultRec?.codexErrorInfo);
  const willRetry = resultRec?.willRetry === true;

  // codex — negative: rate_limit_exceeded with willRetry: true.
  if (/rate_limit_exceeded/i.test(message) && willRetry) {
    return { matched: false };
  }

  const positive = /usage limit/i.test(message) || codexErrorInfo === "usageLimitExceeded";
  if (!positive) {
    return { matched: false };
  }

  const resetsAtSeconds = resultRec?.resetsAt;
  const windowMins = resultRec?.windowDurationMins;
  if (typeof resetsAtSeconds === "number") {
    return {
      matched: true,
      resetsAt: new Date(resetsAtSeconds * 1000).toISOString(),
      ...(typeof windowMins === "number" ? { window: `${windowMins}m` } : {}),
      source: "reported",
    };
  }
  return { matched: true };
}

function tryParseDate(text: string): string | undefined {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * D-05: when the limit name matched but no reset time is present, derive it from the runtime's
 * documented window measured from the classification instant. Needs a "now" — the failure
 * instant — which `classifyFailure` does not otherwise take (it is pure over `ClassifyInput`
 * alone per state-machine.md §7.1's signature). Decision (not in sheet), m1: `classifyFailure`
 * therefore does NOT itself resolve the derived-window case to an absolute timestamp — it has no
 * clock to measure "from the failure instant" against, and state-machine.md §5.2 P-1 forbids one.
 * It returns `QUOTA` with `quotaSource: 'derived-window'` and `quotaWindow` set to the window
 * name/seconds, and leaves resolving `quotaResetsAt = ctx.now + window` to `transition.ts`, which
 * already carries `ctx.now`. `quotaResetsAt` is therefore optional on `ClassifyOutput` even for a
 * `QUOTA` verdict — exactly as the type already allows.
 */
function deriveWindowSeconds(patterns: { derivedWindowSeconds?: Record<string, number> } | undefined, limitName: string | undefined): number | undefined {
  if (!patterns?.derivedWindowSeconds || !limitName) return undefined;
  const key = `${limitName} limit`;
  if (patterns.derivedWindowSeconds[key] !== undefined) return patterns.derivedWindowSeconds[key];
  if (patterns.derivedWindowSeconds[limitName] !== undefined) return patterns.derivedWindowSeconds[limitName];
  if (limitName === "session" && patterns.derivedWindowSeconds["primary"] !== undefined) {
    return patterns.derivedWindowSeconds["primary"];
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// CANCELLED (§7.2 row 3)
// ---------------------------------------------------------------------------------------------

function isCancelled(input: ClassifyInput): boolean {
  if (!input.cancelRequested) return false;
  if (input.runtimeId === "claude-code") {
    const rec = asRecord(input.result);
    return rec?.is_error === true && (rec.terminal_reason === "aborted_streaming" || rec.subtype === "error_during_execution");
  }
  if (input.runtimeId === "codex") {
    // "cancelRequested plus the absence of a terminal event is the discriminator" — a
    // turn.completed present means the run actually finished despite the cancel request.
    const rec = asRecord(input.result);
    const type = asString(rec?.type);
    return type !== "turn.completed";
  }
  // Unknown runtimeId: never inferred from a signal alone (§7.2); cancelRequested plus process
  // end (no well-formed result) is the same discriminator as codex's.
  return input.result === null;
}

// ---------------------------------------------------------------------------------------------
// SUCCESS (§7.2 row 5) — structured-output validity is NOT checked here (ClassifyInput carries
// no schema); that is N-08/N-09/N-10's job in transition.ts, evaluated only once classifyFailure
// has already returned SUCCESS.
// ---------------------------------------------------------------------------------------------

function isSuccess(input: ClassifyInput): boolean {
  if (input.exitCode !== 0) return false;
  const rec = asRecord(input.result);
  if (!rec) return false;
  if (input.runtimeId === "claude-code") {
    return rec.is_error === false;
  }
  if (input.runtimeId === "codex") {
    // exit 0 without turn.completed -> FAILED, never SUCCESS (SIGTERM-ed `codex exec`, §7.2).
    return asString(rec.type) === "turn.completed";
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------------------------

/**
 * state-machine.md §7.1-§7.4, evaluated in `classifyFailureOrder` (state-machine.json): LOST ->
 * TIMEOUT -> CANCELLED -> QUOTA -> SUCCESS -> FAILED, first match wins. Pure: no I/O, no clock
 * (P-1) — see `deriveWindowSeconds`'s comment for why a derived-window `quotaResetsAt` is left
 * unresolved here rather than computed against a "now" this function does not have.
 */
export function classifyFailure(input: ClassifyInput): ClassifyOutput {
  if (input.deadlineMissed) {
    return { classification: "LOST", code: "deadline_missed", message: "no completion arrived by the attempt's deadline; the sweep declared it lost" };
  }

  if (input.timeoutFired) {
    return { classification: "TIMEOUT", code: "node_timeout", message: "the node's own timeout fired before a terminal report arrived" };
  }

  if (isCancelled(input)) {
    return { classification: "CANCELLED", code: "cancelled", message: "the attempt was cancelled" };
  }

  const patterns = patternsFor(input.patterns, input.runtimeId);
  const quota = input.runtimeId === "codex" ? codexQuota(input) : claudeCodeQuota(input);
  if (quota.matched) {
    if (quota.resetsAt) {
      return {
        classification: "QUOTA",
        quotaResetsAt: quota.resetsAt,
        ...(quota.window !== undefined ? { quotaWindow: quota.window } : {}),
        quotaSource: quota.source ?? "reported",
        code: "quota",
        message: "the runtime reported a usage-limit refusal with a resolvable reset time",
      };
    }
    const derivedSeconds = deriveWindowSeconds(patterns, quota.limitName);
    if (derivedSeconds !== undefined) {
      return {
        classification: "QUOTA",
        quotaWindow: String(derivedSeconds),
        quotaSource: "derived-window",
        code: "quota",
        message: "the runtime reported a usage-limit refusal with no reset time; derived from the documented window (D-05)",
      };
    }
    // Unresolvable: classification stays QUOTA (I-25), but with no quotaResetsAt the Run
    // consequence transition.ts computes is FAILED(quota_unclassifiable), never a wait (R-24).
    return { classification: "QUOTA", code: "quota_unclassifiable", message: "a usage-limit refusal was recognised but its reset time could not be resolved" };
  }

  if (isSuccess(input)) {
    return { classification: "SUCCESS", code: "success", message: "exit 0 with a well-formed terminal result" };
  }

  return { classification: "FAILED", code: "unclassified_failure", message: "no positive match for LOST/TIMEOUT/CANCELLED/QUOTA/SUCCESS (the ambiguity rule, §7.2)" };
}

// ---------------------------------------------------------------------------------------------
// Wire mapping (§7.1's table)
// ---------------------------------------------------------------------------------------------

/**
 * envelope `error.classified` -> internal `Classification`, exactly the table in state-machine.md
 * §7.1. `quotaResetsAt` must be supplied for `classified: "quota"` to map to `QUOTA` — without it
 * (a schema-valid envelope can technically omit it) the wire classification degrades to `FAILED`,
 * matching I-25 ("classifyFailure returns FAILED for every input that does not positively match a
 * table row").
 */
export function classificationOfError(error: ErrorPayload, quotaResetsAt?: string): Classification {
  switch (error.classified) {
    case "quota":
      return quotaResetsAt !== undefined ? "QUOTA" : "FAILED";
    case "timeout":
      return "TIMEOUT";
    case "cancelled":
      return "CANCELLED";
    default:
      return "FAILED";
  }
}

/** The reverse of the row above, for callers building an `ErrorPayload` from a `ClassifyOutput`
 * (e.g. `transition.ts` synthesising the `error` block of an emitted `node-failed`, or a test
 * fixture). `SUCCESS` and `LOST` have no `error.classified` counterpart (state-machine.md §7.1);
 * `LOST` maps to `"transient"` here since the sweep's own verdict has no dedicated wire code and
 * `transient` is the closest of the six FAILED-mapped classifications ("the sweep found no
 * completion" is exactly a transient infrastructure fact, not an input, auth, artifact or
 * runtime-logic problem). Decision (not in sheet), m1.
 */
export function errorPayloadFor(output: ClassifyOutput): ErrorPayload {
  switch (output.classification) {
    case "QUOTA":
      return { code: output.code, message: output.message, classified: "quota" };
    case "TIMEOUT":
      return { code: output.code, message: output.message, classified: "timeout" };
    case "CANCELLED":
      return { code: output.code, message: output.message, classified: "cancelled" };
    case "LOST":
      return { code: output.code, message: output.message, classified: "transient" };
    case "SUCCESS":
      throw new Error("errorPayloadFor: classification SUCCESS has no ErrorPayload");
    case "FAILED":
    default:
      return { code: output.code, message: output.message, classified: "unknown" };
  }
}
