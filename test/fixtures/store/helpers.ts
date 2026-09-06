// Shared literal factories for src/store/ tests: a minimal valid Envelope, RunSnapshot and
// AttemptRecord, each overridable. Keeps every test/store/*.test.ts file from re-typing the full
// RunSnapshot shape (docs/spec/state-machine.md §5.6) for every fixture.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUlid } from "../../../src/util/ulid.ts";
import type { Envelope, EventType } from "../../../src/types/envelope.ts";
import type { AttemptRecord, RunSnapshot } from "../../../src/types/state.ts";

export const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
export const NOW = "2026-09-06T09:00:00.000Z";

export function makeEnvelope(
  overrides: Partial<Envelope> & { eventType: EventType; runId: string },
): Envelope {
  return {
    schemaVersion: "1.0.0",
    eventId: randomUlid(),
    occurredAt: NOW,
    producer: "control-plane",
    loopId: "test-loop",
    loopVersion: ZERO_DIGEST,
    ...overrides,
  };
}

export function makeSnapshot(
  overrides: Partial<RunSnapshot> & { runId: string; loopId: string; snapshotOf: number },
): RunSnapshot {
  const base: RunSnapshot = {
    schemaVersion: "1.0.0",
    snapshotOf: overrides.snapshotOf,
    eventSeq: overrides.snapshotOf,
    runId: overrides.runId,
    loopId: overrides.loopId,
    loopVersion: ZERO_DIGEST,
    loopDigest: ZERO_DIGEST,
    trigger: { kind: "manual", requestedAt: NOW },
    status: "RUNNING",
    outcome: null,
    startedAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    cycleIndex: 0,
    maxCycleIndex: 0,
    traversals: {},
    freeTraversals: {},
    noProgressStreak: 0,
    changeFingerprints: {},
    verdictFingerprints: {},
    current: null,
    nodes: {},
    attempts: {},
    chargedAttempts: {},
    quota: null,
    pendingApproval: null,
    approvals: {},
    observe: null,
    lease: null,
    interrupted: null,
    budget: {
      stepsUsed: 0,
      activeMs: 0,
      waitMs: 0,
      measuredTokens: 0,
      agentExecutions: 0,
      measuredExecutions: 0,
      unmeasuredExecutions: 0,
    },
    artifactRefs: [],
    appliedEventIds: [],
    ignoredEventIds: [],
    emittedEventIds: [],
    terminalEventKeys: [],
  };
  return { ...base, ...overrides };
}

export function makeAttempt(
  overrides: Partial<AttemptRecord> & { cycleIndex: number; nodeId: string; attempt: number },
): AttemptRecord {
  const base: AttemptRecord = {
    cycleIndex: overrides.cycleIndex,
    nodeId: overrides.nodeId,
    attempt: overrides.attempt,
    state: "DISPATCHED",
    classification: null,
    dispatchedAt: NOW,
    finishedAt: null,
    deadlineAt: null,
    usage: null,
    artifactRefs: [],
    error: null,
    exitCode: null,
    signal: null,
  };
  return { ...base, ...overrides };
}

/** A fresh temp directory (`fs.mkdtemp`) and, inside it, a `state.sqlite` path — one per test. */
export async function freshDb(): Promise<{ dir: string; dbPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "loopmill-store-test-"));
  return { dir, dbPath: join(dir, "state.sqlite"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
