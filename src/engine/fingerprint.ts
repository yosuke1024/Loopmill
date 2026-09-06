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
 * something `RunSnapshot`/`ResolvedLoop` name. Implemented instead as the sha256 of the sorted
 * `[nodeId, canonicalJson(structured)]` pairs of every **agent** Node Execution recorded so far
 * in cycle `cycle` (`nodeExec.cycleIndex === cycle`), other than `excludeNodeId` (the node being
 * fingerprinted) — never a node's own structured output about itself.
 *
 * `cycle` is read literally: this function itself does not pick which cycle to look at (that is
 * `progressFingerprint`'s job, below). Amendment (m0+), 2026-09-07 — the fix for the bug this
 * function's callers used to have when they passed their *own* `cycle` (see `progressFingerprint`
 * and `noProgressFires`): in the reference loop, `implement` runs *before* `review-changes` in
 * every cycle, so `verdictFingerprint(cycle, "implement", ...)` for the *current, still-running*
 * cycle is always the empty-array hash (no sibling agent execution exists yet at the point
 * `implement`'s own NO_PROGRESS guard runs), while the *same* call for a *prior, already-complete*
 * cycle is not (that cycle's `review-changes` has long since run). Calling this with mismatched
 * cycles for the two sides of a NO_PROGRESS comparison made the comparison spuriously fail on the
 * verdict half every time, regardless of the change-set — the fix is entirely in what cycle
 * number `noProgressFires` passes here, not in this function.
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
 *
 * Amendment (m0+), 2026-09-07 (state-machine.md §6.6): `progressFingerprint(cycle, nodeId) =
 * sha256(changeFingerprint(cycle, nodeId) || verdictFingerprint(cycle - 1))` — condition 3 above
 * compares evidence one cycle *behind* each side's own change-set, not evidence from the same
 * cycle as that change-set. `verdictFingerprint(cycle - 1)` is "the evidence this node was handed
 * before it started cycle `cycle`'s own attempt": whatever sibling agent Node Executions cycle
 * `cycle - 1` recorded (a completed cycle by the time `cycle` dispatches, D-08's own "handed a
 * different verdict" reading), not the still-empty set of siblings that have run *so far in this
 * same, still-in-progress* cycle. The previous fix candidate — reading `verdictFingerprint(cycle)`
 * for the current side — degenerated to comparing an always-empty hash (nothing has run yet
 * alongside the node being fingerprinted, this cycle) against a near-always-non-empty one (the
 * *previous* cycle's siblings, by definition already complete), so the two verdict fingerprints
 * essentially never matched and NO_PROGRESS could not fire at all for a loop shaped like the
 * reference loop, regardless of whether the change-set repeated. Reading both sides one cycle back
 * fixes the asymmetry: `curVerdictFp` (evidence before cycle `cycle`) and `prevVerdictFp` (evidence
 * before cycle `cycle - 1`) are computed the same way, so an identical change-set now correctly
 * fires NO_PROGRESS only when the evidence that produced it was *also* identical, and does not
 * fire when the reviewer's verdict changed even though the agent produced the same diff again.
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
  // Amendment (m0+), 2026-09-07: both sides read the evidence available *before* the cycle whose
  // change-set they pair with — cycle - 1 for the current side, cycle - 2 for the previous side —
  // never the still-in-progress cycle's own (necessarily empty) sibling set.
  const curVerdictFp = verdictFingerprint(cycle - 1, nodeId, snapshot, loop);
  const prevVerdictFp = verdictFingerprint(cycle - 2, nodeId, snapshot, loop);

  const curProgress = progressFingerprint(curChangeFp, curVerdictFp);
  const prevProgress = progressFingerprint(prevChangeFp, prevVerdictFp);
  return curProgress === prevProgress;
}
