// The NO_PROGRESS fingerprints (state-machine.md §6.6, D-08): `changeFingerprint`,
// `verdictFingerprint`, `progressFingerprint`, and the `noProgressFires` predicate N-09's guard
// reads. Pure: every input is already resolved data, nothing here touches the clock or I/O.

import type { ResolvedLoop } from "../types/loop.ts";
import type { RunSnapshot } from "../types/state.ts";
import { canonicalJson } from "../util/canonical-json.ts";
import { sha256Hex } from "../util/hash.ts";
import { isTerminalNode, nodeKey } from "./snapshot.ts";

/** §6.6: `changeFingerprint(cycle, nodeId) = sha256(canonicalJson(sorted(filesChanged.map(f =>
 * [f.path, f.blobSha]))))`. An empty change-set hashes the empty array (a value, not a null).
 * `filesChanged` comes from the completion envelope's `artifactRefs` of kind `file` (`ref` =
 * path, `digest` = blob sha) — the contract agreed with the `local`/`fake` backends (contributed
 * by the `src/backends/` agent working alongside this one); see `route.ts`'s
 * `referenceContextFor` for the same convention on the read side. */
export function changeFingerprint(filesChanged: Array<{ path: string; digest: string }>): string {
  const pairs = filesChanged.map((f): [string, string] => [f.path, f.digest]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return sha256Hex(canonicalJson(pairs));
}

/**
 * §6.6's pseudocode defines this over "failing verdicts" (`failingVerdicts.map(v => [v.nodeId,
 * v.status, v.evidence])`) — a filter the engine cannot compute generically, since "failing"
 * verdict shape is loop-specific data buried inside each agent's own `structuredOutput`, not
 * something `RunSnapshot`/`ResolvedLoop` name. **Decision (not in sheet), m1** (the maintainer
 * will fold this into the spec): implemented instead as the sha256 of the sorted
 * `[nodeId, canonicalJson(structured)]` pairs of every **agent** Node Execution recorded so far
 * **in this exact cycle** (`nodeExec.cycleIndex === cycle`), other than `excludeNodeId` (the node
 * being fingerprinted) — never a node's own structured output about itself. `cycle` is read
 * literally (not "the most recent execution of each node up to this point", which §9.2 uses for
 * ordinary references): in the reference loop this means `verdictFingerprint` is the empty-array
 * hash every time `implement` is checked (it runs before `review-changes` in the same cycle, so
 * no sibling agent execution exists yet in that cycle at the point `implement`'s own NO_PROGRESS
 * guard runs) — `noProgressFires` for this loop's shape is therefore driven by
 * `changeFingerprint` alone. A loop whose retry-edge target runs *after* another agent node in
 * the same cycle body would see this function actually vary; this deviation is called out for
 * the maintainer to reconcile against the "evidence-inclusive" intent of D-08's prose.
 */
export function verdictFingerprint(cycle: number, excludeNodeId: string, snapshot: RunSnapshot, loop: ResolvedLoop): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, record] of Object.entries(snapshot.nodes)) {
    if (record.cycleIndex !== cycle) continue;
    if (record.nodeId === excludeNodeId) continue;
    const node = loop.nodes[record.nodeId];
    if (!node || node.kind !== "agent") continue;
    void key;
    pairs.push([record.nodeId, canonicalJson(record.structured ?? null)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return sha256Hex(canonicalJson(pairs));
}

/** §6.6: `progressFingerprint(cycle, nodeId) = sha256(changeFingerprint || verdictFingerprint)` —
 * `||` is string concatenation of the two hex digests, not boolean-or. */
export function progressFingerprint(changeFp: string, verdictFp: string): string {
  return sha256Hex(changeFp + verdictFp);
}

/**
 * The three conditions of §6.6, all required:
 *
 * 1. the node lies in the body of at least one Retry Edge — equivalent to `cycle > 0` (§6.2:
 *    nodes outside every body run in cycle 0; nothing outside a body can ever be re-entered, so
 *    an execution with `cycle > 0` is, by construction, inside the body of whichever edge's
 *    traversal produced that cycle);
 * 2. a terminal execution of the *same* `nodeId` exists in the *previous* cycle (cycle 1 can
 *    never be NO_PROGRESS — there is nothing to compare against);
 * 3. `progressFingerprint(cycle, nodeId) == progressFingerprint(cycle - 1, nodeId)`.
 *
 * `filesChanged` is this cycle's own change-set (the caller has it fresh, from the completion
 * envelope being processed); the previous cycle's `changeFingerprint` is read back from
 * `snapshot.changeFingerprints` (already persisted when that execution completed) rather than
 * recomputed.
 */
export function noProgressFires(
  snapshot: RunSnapshot,
  loop: ResolvedLoop,
  cycle: number,
  nodeId: string,
  filesChanged: Array<{ path: string; digest: string }>,
): boolean {
  if (cycle <= 0) return false;

  const prevRecord = snapshot.nodes[nodeKey(cycle - 1, nodeId)];
  if (!prevRecord || !isTerminalNode(prevRecord.state)) return false;

  const prevChangeFp = snapshot.changeFingerprints[nodeKey(cycle - 1, nodeId)];
  if (prevChangeFp === undefined) return false;

  const curChangeFp = changeFingerprint(filesChanged);
  const curVerdictFp = verdictFingerprint(cycle, nodeId, snapshot, loop);
  const prevVerdictFp = verdictFingerprint(cycle - 1, nodeId, snapshot, loop);

  const curProgress = progressFingerprint(curChangeFp, curVerdictFp);
  const prevProgress = progressFingerprint(prevChangeFp, prevVerdictFp);
  return curProgress === prevProgress;
}
