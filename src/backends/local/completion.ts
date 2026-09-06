// The runtime-agnostic shape both adapters (`claude-code.ts`, `codex.ts`) reduce to, and the
// `Classification` -> envelope mapping shared between them (docs/spec/state-machine.md §7.1's
// table, read in the direction it does not spell out -- see `classificationToCompletion`'s doc
// comment). `local/executor.ts` is the only consumer: it takes a `RuntimeCompletion`, re-validates
// structured output when the node declares one, and builds the actual `Envelope`.

import type { ErrorPayload, ResultPayload } from "../../types/envelope.ts";
import type { ClassifyOutput } from "../../types/state.ts";
import type { JsonValue } from "../../types/loop.ts";
import type { UsageRecord } from "../../types/usage.ts";

export interface RuntimeCompletion {
  /** Which of the three completion event types this attempt reduces to. */
  eventType: "node-completed" | "node-failed" | "node-timed-out";
  status: ResultPayload["status"];
  /** The process's own exit code, `null` when it was killed by a signal before it could exit on
   * its own -- `local/executor.ts` maps `null` to the envelope schema's documented `-1` ("killed
   * by a signal") when it builds `result.exitCode`. */
  exitCode: number | null;
  structuredCandidate: JsonValue | null;
  /** A short, human-readable summary (never a log, never a diff -- envelope.md §4.2). `null`
   * when nothing meaningful was said (an empty or malformed result). Truncated to the
   * `summaryText` limit by `local/executor.ts`, which also runs it through `redact`. */
  summary: string | null;
  usage: UsageRecord;
  error?: { code: string; message: string; classified: ErrorPayload["classified"] };
  /** Only meaningful when `error.classified === "quota"`. */
  quotaResetsAt?: string;
}

export interface ClassificationToCompletionInput {
  classifyOutput: ClassifyOutput;
  exitCode: number | null;
  usage: UsageRecord;
  structuredCandidate: JsonValue | null;
  summary: string | null;
}

/**
 * `state-machine.md` §7.1 gives the envelope-`error.classified` -> internal-`Classification`
 * mapping (the direction a receiver reading an envelope needs); this is that table read the other
 * way, which is what a producer building one needs. `QUOTA`/`TIMEOUT`/`CANCELLED` invert cleanly
 * (each `Classification` has exactly one `error.classified` counterpart in the table). `FAILED`
 * does not: five distinct `error.classified` values (`auth`, `invalid_input`, `artifact_invalid`,
 * `backend_error`, `runtime_error`, `transient`, `unknown`, or `quota` without a reset time) all
 * collapse to the single internal `FAILED` bucket, and nothing in `ClassifyOutput` says which one
 * a given failure actually was. `Decision (not in sheet), m1`: `FAILED` -> `"runtime_error"`, the
 * most general of the seven and the one every recorded example failure (a bad exit code, a
 * malformed result) would file under; a `dispatch_failed`-shape problem (the binary could not even
 * be spawned) never reaches this function at all, since `local/spawn.ts` rejects the whole
 * `dispatch()` call before any classification happens. `SUCCESS` carries no `error` object.
 * `LOST` never reaches here -- state-machine.md §7.1: "`LOST` is minted by the sweep", never by a
 * runtime adapter.
 */
export function classificationToCompletion(input: ClassificationToCompletionInput): RuntimeCompletion {
  const { classifyOutput, exitCode, usage, structuredCandidate, summary } = input;

  if (classifyOutput.classification === "SUCCESS") {
    return {
      eventType: "node-completed",
      status: "succeeded",
      exitCode,
      structuredCandidate,
      summary,
      usage,
    };
  }

  if (classifyOutput.classification === "TIMEOUT") {
    return {
      eventType: "node-timed-out",
      status: "timed_out",
      exitCode,
      structuredCandidate,
      summary,
      usage,
      error: { code: classifyOutput.code, message: classifyOutput.message, classified: "timeout" },
    };
  }

  if (classifyOutput.classification === "CANCELLED") {
    return {
      eventType: "node-failed",
      status: "cancelled",
      exitCode,
      structuredCandidate,
      summary,
      usage,
      error: { code: classifyOutput.code, message: classifyOutput.message, classified: "cancelled" },
    };
  }

  if (classifyOutput.classification === "QUOTA") {
    return {
      eventType: "node-failed",
      status: "failed",
      exitCode,
      structuredCandidate,
      summary,
      usage,
      error: { code: classifyOutput.code, message: classifyOutput.message, classified: "quota" },
      ...(classifyOutput.quotaResetsAt !== undefined ? { quotaResetsAt: classifyOutput.quotaResetsAt } : {}),
    };
  }

  // FAILED (and LOST, unreachable here -- see the doc comment).
  return {
    eventType: "node-failed",
    status: "failed",
    exitCode,
    structuredCandidate,
    summary,
    usage,
    error: { code: classifyOutput.code, message: classifyOutput.message, classified: "runtime_error" },
  };
}
