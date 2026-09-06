// Shared fixture: the reference loop (examples/daily-content-improvement.loop.yaml), loaded and
// resolved once per test process. v0.6: both codex nodes (`review-content`, `review-changes`)
// run on `local` per the loop file's own `defaults.backend: local` — see docs/spec/state-machine.md
// §13's annotation ("the v0.6 reference loop instead runs both Codex nodes on `local`... this
// task's own instruction: "encode the traces against the v0.6 loop, where those nodes are
// ordinary `local` agent nodes").

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLoop } from "../../../src/loop-file/index.ts";
import type { ResolvedLoop } from "../../../src/types/loop.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
export const REFERENCE_LOOP_PATH = path.join(REPO_ROOT, "examples", "daily-content-improvement.loop.yaml");

const { loop } = await loadLoop(REFERENCE_LOOP_PATH);

/** The resolved reference loop, shared (read-only) across every test file that imports it. */
export const REFERENCE_LOOP: ResolvedLoop = loop;

/** node ids, transcribed from state-machine.md §13 for readability at call sites. */
export const NODES = {
  reviewContent: "review-content",
  needsIssue: "needs-issue",
  endNoChange: "end-no-change",
  createIssue: "create-issue",
  implement: "implement",
  runTests: "run-tests",
  reviewChanges: "review-changes",
  reviewVerdict: "review-verdict",
  approvePr: "approve-pr",
  createPr: "create-pr",
  endShipped: "end-shipped",
} as const;

export const RETRY_EDGE_ID = "retry-implementation";
