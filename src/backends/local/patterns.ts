// A default `PatternTable` for `classify` (docs/spec/state-machine.md §7.1, §7.3), read from
// `docs/spec/state-machine.json`'s own `quotaPatterns` field the same way `envelope/schema.ts`
// and `loop-file/schema.ts` read their schemas from `docs/spec/` at run time
// (docs/design/m1-plan.md §2 decision 5).
//
// Decision (not in sheet), m1: `classifyFailure`'s pattern table is `engine/` territory
// (docs/design/m1-plan.md §2: "`engine/` ... `classifyFailure` with its pattern table"), not
// `backends/`'s -- but `ClassifyInput.patterns` (state.ts) is a required field of the object this
// module must build on every call to the injected `classify` function, and nothing about the
// `LocalDispatcher` constructor this task specifies gives a place to inject a table from outside.
// `docs/spec/state-machine.json`'s `quotaPatterns.claude-code` / `.codex` objects already carry
// exactly `QuotaPatternSet`'s fields (`positive`, `negative`, `resetSuffix`/`resetSource`,
// `derivedWindowSeconds`) -- reading them here needs no interpretation, only a `versionRange`
// wrapper (`"*"`: this specification file carries no version-range breakdown of its own). Whoever
// builds the real `classifyFailure` is free to ignore this value and use its own table; this one
// exists so `ClassifyInput` is never built with an empty, useless `patterns: {}` in the meantime.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PatternTable, QuotaPatternSet } from "../../types/state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_MACHINE_JSON_PATH = join(HERE, "..", "..", "..", "docs", "spec", "state-machine.json");

let cached: PatternTable | undefined;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** Loads and memoises the default `PatternTable`, tolerant of `state-machine.json` not shipping a
 * `quotaPatterns` field at all (an empty table, not a throw -- `classify` still gets a
 * well-typed, if useless, input). */
export function loadDefaultPatternTable(): PatternTable {
  if (cached) return cached;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(STATE_MACHINE_JSON_PATH, "utf8"));
  } catch {
    cached = {};
    return cached;
  }
  const quotaPatterns = isRecord(raw) && isRecord(raw["quotaPatterns"]) ? raw["quotaPatterns"] : {};

  const table: PatternTable = {};
  for (const [runtimeId, patterns] of Object.entries(quotaPatterns)) {
    if (!isRecord(patterns)) continue;
    table[runtimeId] = [{ versionRange: "*", patterns: patterns as unknown as QuotaPatternSet }];
  }
  cached = table;
  return table;
}
