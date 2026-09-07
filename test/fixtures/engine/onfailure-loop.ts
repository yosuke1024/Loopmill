// A minimal synthetic loop exercising `onFailure: retry_edge:<id>` and `onFailure: continue` on
// a real dispatched (non-condition) node, and a human gate with the same two `onFailure` values
// on rejection — combinations the reference loop's own topology does not happen to reach (its
// only retry edge is entered via a condition's `else`, and its only `onFailure: continue` node is
// a command, not an agent). Built via `resolveLoop` (loop-file/resolve.ts, imported not edited)
// so every default this engine relies on (budget, env, approval, node defaults) is filled in
// exactly the way a real loop file would be.

import { resolveLoop } from "../../../src/loop-file/index.ts";
import type { LoopFile } from "../../../src/types/loop.ts";

const RAW: LoopFile = {
  schemaVersion: "0.6.0",
  slug: "onfailure-fixture",
  name: "onFailure fixture",
  trigger: { kind: "manual" },
  repos: [{ id: "app", path: ".", defaultBase: "main" }],
  defaults: { backend: "local", runtime: "claude-code", authMode: "subscription-oauth" },
  budget: { maxAttempts: 2, maxIterations: 5 },
  nodes: {
    step: {
      kind: "agent",
      prompt: "do the step",
      onFailure: "retry_edge:back-edge",
      next: "gate",
    },
    gate: {
      kind: "human",
      mode: "cli",
      subject: "nodes.step",
      onFailure: "retry_edge:back-edge",
      next: "finish",
    },
    finish: { kind: "end", outcome: "success" },
  },
  edges: [{ id: "back-edge", from: "step", to: "step", maxIterations: 2 }],
};

export const ONFAILURE_LOOP = resolveLoop(RAW);

// A second variant where `step`'s onFailure is `continue` instead, to test the SKIPPED-on-
// continue path on a real dispatched (agent) node rather than the reference loop's `run-tests`
// (a command node).
const RAW_CONTINUE: LoopFile = {
  ...RAW,
  nodes: {
    step: { ...(RAW.nodes.step as object), onFailure: "continue" } as LoopFile["nodes"][string],
    gate: RAW.nodes.gate!,
    finish: RAW.nodes.finish!,
  },
};

export const ONFAILURE_CONTINUE_LOOP = resolveLoop(RAW_CONTINUE);

// A `command` node with `onFailure: continue`, feeding a downstream `condition` that reads its
// `exitCode` with no `default` -- the exact shape the engine bug (transition.ts's
// `finishNodeWithFailure`/`recordControlPlaneCompletion` discarding a failed execution's own
// outputs) defeated: `ONFAILURE_CONTINUE_LOOP` above is deliberately an *agent* node (its own
// comment says so), so it never exercised `nodes.<id>.exitCode`/`.stdout` at all. `run-cmd`'s
// `argv` is never actually spawned by `transition()` (a pure state machine reacting to scripted
// envelopes, not a process runner) -- it exists only so the node validates as a real `command`
// node. `then`/`else` route to distinct `end` nodes so a test can tell which branch a condition
// actually took without inspecting `snapshot.nodes` at all.
const COMMAND_ONFAILURE_CONTINUE_RAW: LoopFile = {
  schemaVersion: "0.6.0",
  slug: "command-onfailure-continue-fixture",
  name: "command onFailure:continue fixture",
  trigger: { kind: "manual" },
  repos: [{ id: "app", path: ".", defaultBase: "main" }],
  defaults: { backend: "local", runtime: "claude-code", authMode: "subscription-oauth" },
  budget: { maxAttempts: 2, maxIterations: 5 },
  nodes: {
    "run-cmd": {
      kind: "command",
      argv: ["npm", "test"],
      onFailure: "continue",
      next: "verdict",
    },
    verdict: {
      kind: "condition",
      inputs: { tests_exit: "nodes.run-cmd.exitCode" },
      expr: "tests_exit == 0",
      then: "end-clean",
      else: "end-dirty",
    },
    "end-clean": { kind: "end", outcome: "clean" },
    "end-dirty": { kind: "end", outcome: "dirty" },
  },
};

export const COMMAND_ONFAILURE_CONTINUE_LOOP = resolveLoop(COMMAND_ONFAILURE_CONTINUE_RAW);

// A small loop with a one-iteration Retry Edge, dedicated to the NO_PROGRESS rows (R-15..R-17):
// setup -> implement -> verdict(condition on implement's own `changed`) -> then: finish, else:
// the edge back to implement. `setup` exists only so `implement`'s first execution is reached via
// an ordinary forward edge (§6.2's ordinary first-entry rule) rather than being the loop's own
// entry node — deliberately simpler than the reference loop otherwise (no reviewer/test nodes)
// since NO_PROGRESS short-circuits the rest of the body regardless of what they would have said.
const NO_PROGRESS_RAW: LoopFile = {
  schemaVersion: "0.6.0",
  slug: "no-progress-fixture",
  name: "NO_PROGRESS fixture",
  trigger: { kind: "manual" },
  repos: [{ id: "app", path: ".", defaultBase: "main" }],
  defaults: { backend: "local", runtime: "claude-code", authMode: "subscription-oauth" },
  budget: { maxAttempts: 2, maxIterations: 1 },
  nodes: {
    setup: { kind: "command", argv: ["true"], next: "implement" },
    implement: {
      kind: "agent",
      prompt: "fix it",
      structuredOutput: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"], additionalProperties: false },
      next: "verdict",
    },
    verdict: {
      kind: "condition",
      inputs: { changed: "nodes.implement.structured.changed" },
      expr: "changed == true",
      then: "finish",
      else: "back-edge",
    },
    finish: { kind: "end", outcome: "success" },
  },
  edges: [{ id: "back-edge", from: "verdict", to: "implement", maxIterations: 1 }],
};

export const NO_PROGRESS_LOOP = resolveLoop(NO_PROGRESS_RAW);
export const NO_PROGRESS_EDGE_ID = "back-edge";

/** Same shape, a roomier `maxIterations` (5 instead of 1) — for invariant/scenario tests that
 * need to interleave a genuine-progress (paid) traversal with NO_PROGRESS (free) ones without
 * the paid cap alone refusing the dispatch before the NO_PROGRESS question is ever asked. */
export const NO_PROGRESS_ROOMY_LOOP = resolveLoop({
  ...NO_PROGRESS_RAW,
  slug: "no-progress-roomy-fixture",
  budget: { maxAttempts: 2, maxIterations: 5 },
  edges: [{ id: "back-edge", from: "verdict", to: "implement", maxIterations: 5 }],
});
