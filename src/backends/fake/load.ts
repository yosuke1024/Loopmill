// Loads a `FakeScript` from a JSON file (docs/design/m1-plan.md `backends/` row: "Also
// `loadFakeScript(path)` (JSON)"). No validation beyond JSON parsing -- a malformed step is
// caught the same way a mistyped fixture id is: `FakeDispatcher.dispatch` fails loudly rather
// than this loader guessing at a repair.

import { readFileSync } from "node:fs";
import type { FakeScript } from "./dispatcher.ts";

export function loadFakeScript(path: string): FakeScript {
  return JSON.parse(readFileSync(path, "utf8")) as FakeScript;
}
