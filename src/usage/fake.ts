// The `fake` backend's usage path. docs/spec/usage-normalization.md §2.4: the fixture-replaying
// backend declares `usage: full`, and the fixture itself already carries a complete, valid
// `UsageRecord` — `reported`/`derived` fixtures exercise the real normalizers
// (`claude-code.ts`/`codex.ts`) directly, while an `estimated` or `unavailable` fixture is
// replayed as-is through this module, which exists only to stamp `usageBasis: "fixture"` and to
// validate the shape before it is trusted anywhere else in the engine.

import type { UsageRecord } from "../types/usage.ts";
import { assertRecordShape } from "./record.ts";

/**
 * Replays an already-built `UsageRecord` as the `fake` backend's usage. §2.4: "Loopmill ships no
 * token estimator. ... The `estimated` provenance value is reserved so that ... any future
 * heuristic have a label that already carries the 'never summed with measured values' rule."
 * `usageFromFixture` is the only MVP path that can ever produce an `estimated` (or otherwise
 * fixture-declared) record; it never invents numbers, it only validates and re-labels the ones
 * the fixture already carries.
 */
export function usageFromFixture(record: UsageRecord): UsageRecord {
  const replayed: UsageRecord = { ...record, usageBasis: "fixture" };
  assertRecordShape(replayed);
  return replayed;
}
