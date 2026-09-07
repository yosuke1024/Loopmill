// Shared forward-graph plumbing for `validate.ts` (LM-VAL-005/008/009/010/011/012/014/023) and
// `resolve.ts` (entry derivation, §4.2). Not part of the module's public API (not re-exported by
// `index.ts`): both callers need the same notion of "forward edge" and "who routes into a Retry
// Edge", and computing it twice would be the one way these two modules could quietly disagree
// about what the graph looks like.

import type { LoopFile, NodeSpec } from "../types/loop.ts";

/** A node's forward targets: `then`/`else` for a `condition` node, `next` for every other kind
 * that has one. Routing into a Retry Edge id is a forward target syntactically (it appears in
 * `next`/`then`/`else`) but is never a forward *node* edge -- callers split it out themselves by
 * checking `edgeIds` before treating a target as a node id (mirrors
 * `docs/spec/validate-examples.mjs`'s `forwardTargets`). */
export function forwardTargets(node: NodeSpec): string[] {
  if (node.kind === "condition") {
    return [node.then, node.else].filter((t): t is string => typeof t === "string" && t.length > 0);
  }
  if ("next" in node && typeof node.next === "string" && node.next.length > 0) {
    return [node.next];
  }
  return [];
}

export interface Graph {
  ids: string[];
  /** Forward node-to-node edges only; a target that is a Retry Edge id or an unknown id is
   * excluded (callers that care about unknown targets, i.e. `validate.ts`, check that
   * themselves -- `resolve.ts` only ever calls this on an already-valid file). */
  succ: Map<string, string[]>;
  /** Retry Edge id -> the node ids that route into it via `next`/`then`/`else` or
   * `onFailure: retry_edge:<id>`. */
  routesIntoEdge: Map<string, string[]>;
  edgeIds: Set<string>;
}

/** Builds the forward graph and the retry-edge routing map for `file`. `strict: true` (the
 * default) drops a target that names neither a node nor an edge silently, which is correct once
 * `validate.ts` has already reported it as LM-VAL-006 -- `resolve.ts` only ever sees a file that
 * passed validation. */
export function buildGraph(file: Pick<LoopFile, "nodes" | "edges">): Graph {
  const nodes = file.nodes;
  const ids = Object.keys(nodes);
  const edgeIds = new Set((file.edges ?? []).map((e) => e.id));
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  const routesIntoEdge = new Map<string, string[]>();

  const addRoute = (edgeId: string, from: string) => {
    const existing = routesIntoEdge.get(edgeId);
    if (existing) existing.push(from);
    else routesIntoEdge.set(edgeId, [from]);
  };

  for (const [id, node] of Object.entries(nodes)) {
    for (const target of forwardTargets(node)) {
      if (edgeIds.has(target)) {
        addRoute(target, id);
      } else if (nodes[target]) {
        succ.get(id)!.push(target);
      }
      // else: unknown target -- validate.ts's LM-VAL-006, not this module's concern.
    }
    const onFailure = "onFailure" in node ? node.onFailure : undefined;
    if (typeof onFailure === "string" && onFailure.startsWith("retry_edge:")) {
      const edgeId = onFailure.slice("retry_edge:".length);
      if (edgeIds.has(edgeId)) addRoute(edgeId, id);
    }
  }

  return { ids, succ, routesIntoEdge, edgeIds };
}

/** Node ids with in-degree zero in `succ`: the candidates for a derived `entry` (§4.2). */
export function findRoots(ids: string[], succ: Map<string, string[]>): string[] {
  const inDegree = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) {
    for (const target of succ.get(id) ?? []) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }
  return ids.filter((id) => inDegree.get(id) === 0);
}

/** Every node forward-reachable from `entry` (via `succ`), plus -- for every Retry Edge whose
 * `from` is reachable -- its `to`, since traversing the edge reaches `to` even though `to` -> `from`
 * is a forward path and not the other way around. Mirrors
 * `docs/spec/validate-examples.mjs`'s reachability pass exactly, including checking each edge
 * only once (not to a fixed point): with a well-formed Retry Edge (LM-VAL-008: `from` is
 * forward-reachable from `to`) `to` is already on the normal forward walk from `entry`, so the
 * single pass is not a source of false negatives in practice. */
export function reachableFrom(entry: string, succ: Map<string, string[]>, edges: LoopFile["edges"]): Set<string> {
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const target of succ.get(id) ?? []) {
      if (!seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  for (const edge of edges ?? []) {
    if (seen.has(edge.from) && !seen.has(edge.to)) seen.add(edge.to);
  }
  return seen;
}

/** Classic iterative dominator computation over the forward graph (`succ`), rooted at `entry`.
 * Returns, for every node, the set of node ids that dominate it (every node dominates itself).
 * Ported from `docs/spec/validate-examples.mjs`'s `computeDominators`. */
export function computeDominators(nodeIds: string[], entry: string, succ: Map<string, string[]>): Map<string, Set<string>> {
  const pred = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const id of nodeIds) {
    for (const target of succ.get(id) ?? []) {
      pred.get(target)?.push(id);
    }
  }
  const all = new Set(nodeIds);
  const dom = new Map<string, Set<string>>(nodeIds.map((id) => [id, id === entry ? new Set([entry]) : new Set(all)]));

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of nodeIds) {
      if (id === entry) continue;
      const preds = (pred.get(id) ?? []).filter((p) => dom.has(p));
      let next: Set<string>;
      if (preds.length === 0) {
        next = new Set([id]);
      } else {
        const first = dom.get(preds[0]!)!;
        next = new Set(first);
        for (const p of preds.slice(1)) {
          const domP = dom.get(p)!;
          for (const candidate of [...next]) {
            if (!domP.has(candidate)) next.delete(candidate);
          }
        }
      }
      next.add(id);
      const prev = dom.get(id)!;
      if (prev.size !== next.size || [...next].some((x) => !prev.has(x))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return dom;
}
