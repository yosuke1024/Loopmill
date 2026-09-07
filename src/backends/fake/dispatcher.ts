// `FakeDispatcher`: the fixture-replaying backend, a first-class MVP deliverable
// (docs/design/mvp-design.md §6.2: "the whole reference loop must run green against it in CI
// with no network, no subscription and no tokens" -- acceptance criterion A31). Deterministic:
// the same `(script, request, clock)` always produces the same envelope, `eventId` included, so
// `fake`-backed tests never depend on real time or randomness.

import type { ArtifactRef, ErrorPayload, Envelope, EventType } from "../../types/envelope.ts";
import type { BackendCapabilities } from "../../types/capabilities.ts";
import type { DispatchPlan, DispatchRequest, Dispatcher } from "../../types/interfaces.ts";
import type { JsonValue } from "../../types/loop.ts";
import type { UsageRecord } from "../../types/usage.ts";
import { makeEnvelope } from "../../envelope/build.ts";
import { unavailableRecord } from "../../usage/record.ts";
import { usageFromFixture } from "../../usage/fake.ts";
import { LoopmillError } from "../../util/errors.ts";
import { deterministicEventId } from "../../util/ulid.ts";
import { BACKEND_CAPABILITIES } from "../capabilities.ts";
import { noAgentRanUsage, SUMMARY_TEXT_MAX, TEXT_MAX, toEnvelopeUsage, truncateForSchema } from "../envelope-helpers.ts";
import { loadUsageFixture } from "./fixture-usage.ts";

export type FakeScriptKey = `${number}:${string}:${number}`;

export interface FakeStep {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  structured?: JsonValue;
  stdout?: string;
  exitCode?: number;
  filesChanged?: Array<{ path: string; digest: string }>;
  /** id of a `docs/spec/usage-fixtures/*.json` file whose `expected.attempts[0].usage` is
   * replayed through `usageFromFixture` (the extension is optional, e.g. both
   * `"claude-recorded-success"` and `"claude-recorded-success.json"` work). */
  usageFixture?: string;
  usage?: UsageRecord;
  error?: { code: string; message: string; classified: ErrorPayload["classified"] };
  quotaResetsAt?: string;
  /** Milliseconds to wait (via a real `setTimeout`) before `dispatch()` resolves -- lets a test
   * exercise a slow step without a real subprocess. */
  delayMs?: number;
  summary?: string;
}

export interface FakeScript {
  steps: Record<FakeScriptKey, FakeStep>;
  default?: FakeStep;
}

function scriptKey(request: DispatchRequest): FakeScriptKey {
  return `${request.cycleIndex}:${request.nodeId}:${request.attempt}`;
}

function eventTypeFor(step: FakeStep): EventType {
  if (step.status === "succeeded") return "node-completed";
  if (step.status === "timed_out") return "node-timed-out";
  return "node-failed"; // failed | cancelled
}

function defaultErrorFor(step: FakeStep): { code: string; message: string; classified: ErrorPayload["classified"] } {
  switch (step.status) {
    case "timed_out":
      return { code: "node_timeout", message: "fake backend: step declared timed_out", classified: "timeout" };
    case "cancelled":
      return { code: "cancelled", message: "fake backend: step declared cancelled", classified: "cancelled" };
    case "failed":
    default:
      return { code: "fake_failed", message: "fake backend: step declared failed", classified: "runtime_error" };
  }
}

function structuredCandidateFor(step: FakeStep, node: DispatchRequest["node"]): JsonValue | null {
  if (step.structured !== undefined) return step.structured;
  if (node.kind === "command") {
    return { stdout: step.stdout ?? "" };
  }
  return null;
}

function resolveUsage(step: FakeStep, node: DispatchRequest["node"]): UsageRecord {
  if (step.usageFixture) {
    return usageFromFixture(loadUsageFixture(step.usageFixture));
  }
  if (step.usage) {
    return step.usage;
  }
  if (node.kind === "command") {
    return noAgentRanUsage();
  }
  return unavailableRecord({
    runtime: node.kind === "agent" ? node.runtime : "claude-code",
    runtimeVersion: null,
    eventKind: null,
    note: "fake backend: step declared no usage",
  });
}

function fileArtifactRefsFor(step: FakeStep): ArtifactRef[] {
  return (step.filesChanged ?? []).map((f) => ({ kind: "file" as const, ref: f.path, ...(f.digest ? { digest: f.digest } : {}) }));
}

export class FakeDispatcher implements Dispatcher {
  #script: FakeScript;

  constructor(script: FakeScript) {
    this.#script = script;
  }

  capabilities(): BackendCapabilities {
    return BACKEND_CAPABILITIES.fake;
  }

  describe(request: DispatchRequest): DispatchPlan {
    return {
      argv: ["fake", request.nodeId],
      cwd: request.workspace.worktreePath,
      env: {},
      stdin: "/dev/null",
      timeoutMs: request.timeoutMs,
      notes: [`fake backend: replays the script step for "${scriptKey(request)}" (or the script's default)`],
    };
  }

  async dispatch(request: DispatchRequest, clock: { now(): string }): Promise<Envelope> {
    const key = scriptKey(request);
    const step = this.#script.steps[key] ?? this.#script.default;
    if (!step) {
      throw new LoopmillError(
        "dispatch_failed",
        `fake backend: no script step for "${key}" and the script declares no default`,
      );
    }

    if (step.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    }

    const now = clock.now();
    const eventType = eventTypeFor(step);
    const usage = resolveUsage(step, request.node);
    const structuredCandidate = structuredCandidateFor(step, request.node);
    const artifactRefs = fileArtifactRefsFor(step);

    const error = step.status === "succeeded" ? undefined : step.error ?? defaultErrorFor(step);

    const eventId = deterministicEventId({
      nowRfc3339: now,
      runId: request.runId,
      eventType,
      cycle: request.cycleIndex,
      nodeId: request.nodeId,
      attempt: request.attempt,
      emitIndex: 0,
      causationEventId: request.causationId ?? null,
    });

    const base = {
      eventId,
      occurredAt: now,
      eventType,
      producer: "backend:fake" as const,
      loopId: request.loopId,
      loopVersion: request.loopVersion,
      runId: request.runId,
      cycle: request.cycleIndex,
      nodeId: request.nodeId,
      attempt: request.attempt,
      ...(request.causationId ? { causationId: request.causationId } : {}),
      correlationId: request.runId,
      result: {
        status: step.status,
        ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
        ...(structuredCandidate !== null ? { structured: structuredCandidate as Record<string, JsonValue> } : {}),
        ...(step.summary ? { summary: truncateForSchema(step.summary, SUMMARY_TEXT_MAX) } : {}),
      },
      ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
      usage: toEnvelopeUsage(usage),
      ...(error ? { error: { code: error.code, message: truncateForSchema(error.message, TEXT_MAX), classified: error.classified } } : {}),
      ...(error?.classified === "quota" && step.quotaResetsAt ? { quotaResetsAt: step.quotaResetsAt } : {}),
    };

    return makeEnvelope(base, { now });
  }
}
