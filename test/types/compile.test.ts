// Compile-only test: constructs one literal value of each of the five core shared types from
// the spec's own examples/fixtures. Its purpose is that `npm run typecheck` fails the moment a
// type in src/types/ drifts from the spec — the runtime assertions below are deliberately
// shallow (typeof === 'object'), since correctness here is enforced by `tsc`, not by `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Envelope, LoopFile, ResolvedLoop, RunSnapshot, UsageRecord } from "../../src/types/index.ts";

test("Envelope compiles: shape of docs/spec/envelope-examples/node-completed.json", () => {
  const envelope: Envelope = {
    schemaVersion: "1.0.0",
    eventId: "06G7BWHT4089ZN8MD96260DEPE",
    eventType: "node-completed",
    occurredAt: "2026-09-06T09:41:12.740Z",
    producer: "backend:github-actions",
    loopId: "article-review",
    loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
    correlationId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
    causationId: "06G7BWHJA04BZ0ZGMKCKH6JRW7",
    cycle: 1,
    nodeId: "implement",
    attempt: 1,
    result: {
      status: "succeeded",
      exitCode: 0,
      structured: {
        changed: true,
        filesChanged: 4,
        testsAdded: 2,
        notes: "Adds the retry-edge counter and its regression test.",
      },
      summary: "Implemented the retry-edge counter; 4 files changed, 2 tests added.",
    },
    artifactRefs: [
      { kind: "branch", ref: "loopmill/run/06G7BWH2P07RDEMGG3JAG9HSRS" },
      {
        kind: "commit",
        ref: "3b91d0c6e5f4a2b8c7d6e5f4a3b2c1d0e9f8a7b6",
        digest: "sha256:d5466900c345767133d5072efc8e1f2ff336a62a437c8dff1f0fe09c384c2b7a",
      },
      {
        kind: "actions-artifact",
        ref: "loopmill-node-log-06G7BWH2P07RDEMGG3JAG9HSRS-1-implement-1",
        digest: "sha256:d52afa3d24c979d7f9e933190e113b52e3384bd3ad719274930f552f00e78315",
      },
    ],
    usage: {
      runtime: "claude-code",
      model: "claude-opus-5",
      freshInputTokens: 1820,
      cacheWriteTokens: 24110,
      cacheReadTokens: 402331,
      outputTokens: 5904,
      totalInputTokens: 428261,
      totalTokens: 434165,
      provenance: "reported",
      provenanceNote: "result.usage; modelUsage absent",
      source: { runtimeVersion: "2.4.1", eventKind: "result.usage" },
      complete: true,
      usageBasis: "result.usage",
      sessionRef: null,
      usageAtAttemptStart: null,
      listPriceEquivalentUsd: null,
      perModel: null,
    },
  };
  assert.equal(typeof envelope, "object");
});

test("UsageRecord compiles: docs/spec/usage-fixtures/codex-recorded-success.json expected.attempts[0].usage", () => {
  const usage: UsageRecord = {
    runtime: "codex",
    model: null,
    freshInputTokens: 3879,
    cacheWriteTokens: 0,
    cacheReadTokens: 12928,
    outputTokens: 10,
    reasoningTokens: 0,
    totalInputTokens: 16807,
    totalTokens: 16817,
    provenance: "derived",
    provenanceNote:
      "turn.completed cumulative (input 16807, cached 12928, cache_write 0, output 10) minus " +
      "usageAtAttemptStart, clamped at 0 field-by-field; fresh = max(0, 16807 - 12928 - 0) = 3879",
    source: { runtimeVersion: "codex-cli 0.153.4", eventKind: "turn.completed" },
    complete: true,
    usageBasis: "turn.completed",
    sessionRef: { kind: "codex-thread", id: "01a076dd-9058-7eb1-b4e5-d431a80b06c8" },
    usageAtAttemptStart: {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    },
    listPriceEquivalentUsd: null,
    perModel: null,
  };
  assert.equal(typeof usage, "object");
});

test("LoopFile compiles: the minimal loop of loop-file.md §15.2", () => {
  const loopFile: LoopFile = {
    schemaVersion: "0.6.0",
    slug: "tidy-changelog",
    name: "Tidy the changelog",
    trigger: { kind: "manual" },
    repos: [{ id: "app", path: ".", defaultBase: "main" }],
    defaults: { backend: "local", runtime: "claude-code", authMode: "subscription-oauth" },
    nodes: {
      tidy: {
        kind: "agent",
        prompt: "Rewrite CHANGELOG.md so every entry has a date and a link. Change nothing else.",
        next: "done",
      },
      done: { kind: "end", outcome: "success" },
    },
  };
  assert.equal(typeof loopFile, "object");
});

test("ResolvedLoop compiles: the same loop, with defaults resolved", () => {
  const resolvedLoop: ResolvedLoop = {
    slug: "tidy-changelog",
    name: "Tidy the changelog",
    loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    entry: "tidy",
    nodes: {
      tidy: {
        kind: "agent",
        id: "tidy",
        runtime: "claude-code",
        backend: "local",
        auth: "subscription-oauth",
        permissionProfile: "workspace",
        sessionPolicy: "fresh",
        prompt: "Rewrite CHANGELOG.md so every entry has a date and a link. Change nothing else.",
        inputs: {},
        onFailure: "fail_run",
        effects: "none",
        next: "done",
      },
      done: {
        kind: "end",
        id: "done",
        outcome: "success",
      },
    },
    edges: {},
    budget: {
      maxAttempts: 2,
      maxRuntime: "PT4H",
      maxRuntimeMs: 14_400_000,
      maxUnmeasuredExecutions: 0,
      maxRunsPerWindow: { count: 1, window: "PT5H", windowMs: 18_000_000 },
      minInterval: "PT1H",
      minIntervalMs: 3_600_000,
    },
    env: {
      deny: ["ANTHROPIC_API_KEY"],
      preserve: ["PATH"],
      inject: {},
    },
    approval: { policy: "gated" },
    trigger: { kind: "manual" },
    repos: [{ id: "app", path: ".", defaultBase: "main" }],
  };
  assert.equal(typeof resolvedLoop, "object");
});

test("RunSnapshot compiles: one node, one attempt, in flight", () => {
  const snapshot: RunSnapshot = {
    schemaVersion: "1.0.0",
    snapshotOf: 3,
    eventSeq: 3,
    runId: "run_06G7BWH2P07RDEMGG3JAG9HSRS",
    loopId: "article-review",
    loopVersion: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    loopDigest: "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
    trigger: { kind: "manual", requestedAt: "2026-09-06T09:00:00.000Z" },
    status: "RUNNING",
    outcome: null,
    startedAt: "2026-09-06T09:00:01.000Z",
    updatedAt: "2026-09-06T09:41:12.740Z",
    finishedAt: null,
    cycleIndex: 1,
    maxCycleIndex: 1,
    traversals: {},
    freeTraversals: {},
    noProgressStreak: 0,
    changeFingerprints: {},
    verdictFingerprints: {},
    current: { nodeId: "implement", cycleIndex: 1, attempt: 1, nodeState: "RUNNING" },
    nodes: {
      "1:implement": {
        nodeId: "implement",
        cycleIndex: 1,
        state: "RUNNING",
        attemptsUsed: 1,
        startedAt: "2026-09-06T09:00:02.000Z",
        finishedAt: null,
        summary: null,
        filesChanged: 0,
        changeFingerprint: null,
        artifactRefs: [],
        structured: null,
        stdout: null,
        exitCode: null,
      },
    },
    attempts: {
      "1:implement:1": {
        cycleIndex: 1,
        nodeId: "implement",
        attempt: 1,
        state: "DISPATCHED",
        classification: null,
        dispatchedAt: "2026-09-06T09:00:02.000Z",
        finishedAt: null,
        deadlineAt: "2026-09-06T09:32:02.000Z",
        usage: null,
        artifactRefs: [],
        error: null,
        exitCode: null,
        signal: null,
      },
    },
    chargedAttempts: { "1:implement": 1 },
    quota: null,
    pendingApproval: null,
    approvals: {},
    observe: null,
    lease: {
      kind: "attempt",
      holder: "1:implement:1",
      acquiredAt: "2026-09-06T09:00:02.000Z",
      heartbeatAt: "2026-09-06T09:00:32.000Z",
      expiresAt: "2026-09-06T09:32:02.000Z",
    },
    interrupted: null,
    budget: {
      stepsUsed: 3,
      activeMs: 2_412_740,
      waitMs: 0,
      measuredTokens: 0,
      agentExecutions: 0,
      measuredExecutions: 0,
      unmeasuredExecutions: 0,
    },
    artifactRefs: [],
    appliedEventIds: ["06G7BWHAG0BA4Y3D336ASKYHE2"],
    ignoredEventIds: [],
    emittedEventIds: [],
    terminalEventKeys: [],
  };
  assert.equal(typeof snapshot, "object");
});
