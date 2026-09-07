// Routing decisions (loop-file.md §12.1, §9.2): where a just-succeeded node goes next
// (`route`), a condition node's own then/else decision (`conditionBranch`), the Retry Edge
// `when`-assertion (`evaluateRetryEdgeWhen`), and the `ReferenceContext` every input resolution
// in `transition.ts` is built from (`referenceContextFor`). Pure: no I/O, no clock.

import {
  evaluateExpression,
  parseExpression,
  parseReference,
  resolveInputs,
  resolveReference,
  type NodeOutput,
  type ReferenceContext,
} from "../loop-file/index.ts";
import type { JsonValue, ResolvedConditionNode, ResolvedLoop, RetryEdge } from "../types/loop.ts";
import type { NodeExecutionRecord, RunSnapshot } from "../types/state.ts";

export interface RouteError {
  code: string;
  message: string;
}

export type RouteResult =
  | { kind: "next"; nodeId: string }
  | { kind: "retryEdge"; edge: RetryEdge }
  | { kind: "end"; label: string; nodeId: string }
  | { kind: "humanGate"; nodeId: string }
  | { kind: "error"; error: RouteError };

export type ConditionBranchResult = { branch: "then" | "else"; target: string } | { error: RouteError };

/**
 * The facts `referenceContextFor` needs beyond what `RunSnapshot` already carries:
 * `RunSnapshot.trigger` is the reduced subset `{kind, source?, dedupeKey?, requestedAt}`
 * (state-machine.md §5.6), not the full `TriggerPayload` the `run-requested` envelope carried
 * (`actor`, `ref`, `scheduledFor` are not persisted on the snapshot at all) — `trigger.<path>`
 * references (loop-file.md §9.1) need the full original payload, so the caller (`transition.ts`,
 * which still has the `run-requested` envelope in scope when it first builds a Run) supplies it
 * here. Decision (not in sheet), m1: `RunSnapshot.trigger` not carrying the full payload is a
 * gap this works around rather than one this module can fix (`src/types/state.ts` is out of
 * scope for this agent) — reported.
 */
export interface RunReferenceInfo {
  trigger: JsonValue;
}

/**
 * Builds the `ReferenceContext` (loop-file.md §9.1-§9.2) `resolveInputs`/`resolveReference` need.
 * `nodeOutput` implements §9.2's resolution rule as "the highest recorded `cycleIndex` for the
 * named node" (see its own inline comment for why that is the correct reading, not "search
 * downward from the current cycle") — this covers both cases the spec prose calls out ("for a
 * node inside the current Retry Edge body that is the current Cycle; for a node outside it... the
 * last Cycle in which that node actually ran") without needing to know which nodes are inside
 * which edge's body: a node runs at most once per cycle (I-02), and cycle numbers for one nodeId
 * only ever increase as the Run progresses, so the highest one recorded so far is always the most
 * recent one, however the referencing node's own `cycleIndex` compares to it.
 *
 * `run.retryHint = "no_progress"` (§6.6: added to inputs after a free traversal) is **not**
 * exposed here. `loop-file/references.ts`'s `Reference` grammar for `kind: 'run'` only admits
 * `name: "id" | "loop" | "version" | "trigger"` (`RUN_NAMES`), so `run.retryHint` cannot be
 * parsed by `parseReference` at all — a prompt that names it would fail with
 * `reference_invalid` before this context is ever consulted, and adding a fifth field to
 * `ReferenceContext.run` would not change that. Decision (not in sheet), m1: skipped rather than
 * added as dead weight on the context object; **report**: `loop-file/references.ts` would need
 * `"retryHint"` added to `RUN_NAMES`/`Reference`'s `run` variant and to `ReferenceContext.run`'s
 * shape for a prompt to ever see it.
 */
export function referenceContextFor(
  snapshot: RunSnapshot,
  loop: ResolvedLoop,
  cycleIndex: number,
  runInfo: RunReferenceInfo,
): ReferenceContext {
  void loop;
  return {
    run: {
      id: snapshot.runId,
      loop: snapshot.loopId,
      version: snapshot.loopVersion,
      trigger: snapshot.trigger.kind,
    },
    cycleIndex,
    trigger: runInfo.trigger,
    nodeOutput: (nodeId: string): NodeOutput | undefined => {
      // §9.2's "most recent execution" is, unconditionally, the highest recorded `cycleIndex`
      // for this `nodeId`: a Node Execution key is unique per (cycle, nodeId) and cycle numbers
      // for one nodeId only ever increase as the Run progresses, so the highest one recorded so
      // far *is* the most recent one — whether the referencing node is still inside the same
      // Retry Edge body (the common case, where that also happens to equal `cycleIndex` itself)
      // or has already left it (`cycleIndex` reset to 0 per §6.2, while the referenced node's
      // last execution stayed at whatever cycle the body last ran, e.g. `implement` referenced
      // from `approve-pr` at cycle 0 after the body finished at cycle 3). Decision (not in
      // sheet), m1: an earlier draft searched only downward from the *current* `cycleIndex`,
      // which cannot find a referenced node's execution recorded at a *higher* cycle number than
      // the referencing node's own — exactly the leaving-the-body case.
      let best: import("../types/state.ts").NodeExecutionRecord | undefined;
      for (const record of Object.values(snapshot.nodes)) {
        if (record.nodeId !== nodeId) continue;
        if (!best || record.cycleIndex > best.cycleIndex) best = record;
      }
      return best ? toNodeOutput(best) : undefined;
    },
  };
}

function toNodeOutput(record: NodeExecutionRecord): NodeOutput {
  const out: NodeOutput = { filesChanged: record.filesChanged };
  if (record.structured !== null) out.structured = record.structured;
  if (record.stdout !== null) out.stdout = record.stdout;
  if (record.exitCode !== null) out.exitCode = record.exitCode;
  return out;
}

/**
 * A condition node's own `then`/`else` decision (loop-file.md §8.3, §11). Never throws: a
 * missing or non-conforming input is reported as `{ error }` with `code: 'condition_error'`
 * (loop-file.md §11.2, "onFailure does not apply to condition nodes: a Loop that cannot decide
 * must stop" — the caller, `transition.ts`, is the one that turns this into `FAILED`).
 */
export function conditionBranch(
  loop: ResolvedLoop,
  snapshot: RunSnapshot,
  node: ResolvedConditionNode,
  cycleIndex: number,
  runInfo: RunReferenceInfo,
): ConditionBranchResult {
  try {
    const ctx = referenceContextFor(snapshot, loop, cycleIndex, runInfo);
    const inputs = resolveInputs(node.inputs, ctx);
    const expr = parseExpression(node.expr);
    const value = evaluateExpression(expr, inputs);
    return value ? { branch: "then", target: node.then } : { branch: "else", target: node.else };
  } catch (err) {
    return { error: { code: "condition_error", message: messageOf(err) } };
  }
}

/**
 * loop-file.md §12.1: a Retry Edge's `when` is an assertion, not a router — evaluated over the
 * edge's own `from` node's resolved inputs at the moment of traversal, and MUST be true. A false
 * (or unresolvable) assertion fails the Run. loop-file.md's own prose names
 * `failureReason: retry_edge_guard_failed`, which is not a member of `state.ts`'s closed
 * `FailureReason` enum (`src/types/state.ts` is out of scope for this agent to extend); per this
 * task's explicit instruction, mapped instead to the existing `condition_error` reason — the
 * closest fit ("a Loop that cannot decide must stop", loop-file.md §11.2), transcribed here as
 * **Decision (not in sheet), m1**; **report**: `FailureReason` should probably gain
 * `retry_edge_guard_failed` to match loop-file.md's own text exactly.
 */
export function evaluateRetryEdgeWhen(
  loop: ResolvedLoop,
  snapshot: RunSnapshot,
  edge: RetryEdge,
  cycleIndex: number,
  runInfo: RunReferenceInfo,
): { ok: true } | { ok: false; error: RouteError } {
  if (edge.when === undefined) return { ok: true };
  const fromNode = loop.nodes[edge.from];
  if (!fromNode || !("inputs" in fromNode)) {
    return {
      ok: false,
      error: { code: "condition_error", message: `retry edge "${edge.id}" declares "when" but its from-node "${edge.from}" has no inputs to evaluate it against` },
    };
  }
  try {
    const ctx = referenceContextFor(snapshot, loop, cycleIndex, runInfo);
    const inputs = resolveInputs(fromNode.inputs, ctx);
    const expr = parseExpression(edge.when);
    const ok = evaluateExpression(expr, inputs);
    if (!ok) {
      return { ok: false, error: { code: "condition_error", message: `retry edge "${edge.id}"'s when-assertion evaluated false` } };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: "condition_error", message: messageOf(err) } };
  }
}

/**
 * The single-hop routing decision for a node that just terminated successfully (loop-file.md
 * §12.1; state-machine.md §4 preamble's `route(node, result)`). Resolves `nodeId`'s own
 * `then`/`else` (condition nodes, via `conditionBranch`) or `next` (agent/command/human nodes) to
 * a raw target, then classifies that target: an edge id is `retryEdge`; a `human`-kind node is
 * `humanGate`; an `end`-kind node is `end`; anything else is an ordinary `next`. `transition.ts`
 * calls this once per hop and, when the result is itself `next` to a *condition* node, calls it
 * again on that node — this is what implements D-13's "goes PENDING -> terminal inside one step"
 * for a chain of condition nodes, entirely inside one `transition()` call.
 *
 * `result` (the completed node's own outcome payload) is accepted for signature parity with the
 * spec's `route(node, result)` but is not read: D-14 means routing is driven only by a
 * *condition* node's own declared `inputs` (which reference an EARLIER node's `structured`
 * output, never the routing node's own result) — `result` carries nothing `route` itself needs.
 */
export function route(
  loop: ResolvedLoop,
  snapshot: RunSnapshot,
  nodeId: string,
  cycleIndex: number,
  result: unknown,
  runInfo: RunReferenceInfo,
): RouteResult {
  void result;
  const node = loop.nodes[nodeId];
  if (!node) {
    return { kind: "error", error: { code: "internal_invariant", message: `route: unknown nodeId ${JSON.stringify(nodeId)}` } };
  }

  let target: string;
  if (node.kind === "condition") {
    const branch = conditionBranch(loop, snapshot, node, cycleIndex, runInfo);
    if ("error" in branch) return { kind: "error", error: branch.error };
    target = branch.target;
  } else if (node.kind === "end") {
    return { kind: "error", error: { code: "internal_invariant", message: `route: "${nodeId}" is an end node and cannot route further` } };
  } else if (node.next !== undefined) {
    target = node.next;
  } else {
    return { kind: "error", error: { code: "internal_invariant", message: `node "${nodeId}" has no routing target ("next")` } };
  }

  if (Object.prototype.hasOwnProperty.call(loop.edges, target)) {
    return { kind: "retryEdge", edge: loop.edges[target]! };
  }
  const targetNode = loop.nodes[target];
  if (!targetNode) {
    return { kind: "error", error: { code: "internal_invariant", message: `routing target "${target}" does not exist in this loop` } };
  }
  if (targetNode.kind === "human") {
    return { kind: "humanGate", nodeId: target };
  }
  if (targetNode.kind === "end") {
    return { kind: "end", label: targetNode.outcome, nodeId: target };
  }
  return { kind: "next", nodeId: target };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
