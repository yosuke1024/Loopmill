// Loads one recorded/hand-written usage fixture's `expected.attempts[0].usage` block
// (docs/spec/usage-fixtures/*.json), for `FakeStep.usageFixture` to replay through
// `usage/fake.ts`'s `usageFromFixture`. Resolved relative to this module's own location, the
// same way `envelope/schema.ts` and `loop-file/schema.ts` resolve their own `docs/spec/` reads.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UsageRecord } from "../../types/usage.ts";
import { LoopmillError } from "../../util/errors.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE_FIXTURES_DIR = join(HERE, "..", "..", "..", "docs", "spec", "usage-fixtures");

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** `id` may be given with or without the `.json` extension. Throws `LoopmillError`
 * (`fake_usage_fixture_not_found` / `fake_usage_fixture_invalid`) rather than returning
 * `undefined` -- a script naming a fixture that does not exist, or one with no usage block, is a
 * fixture-authoring mistake worth failing loudly on. */
export function loadUsageFixture(id: string): UsageRecord {
  const fileName = id.endsWith(".json") ? id : `${id}.json`;
  const path = join(USAGE_FIXTURES_DIR, fileName);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new LoopmillError(
      "fake_usage_fixture_not_found",
      `could not read usage fixture "${id}" (resolved to ${path})`,
      { cause: err },
    );
  }

  const expected = isRecord(raw) ? raw["expected"] : undefined;
  const attempts = isRecord(expected) ? expected["attempts"] : undefined;
  const first = Array.isArray(attempts) ? attempts[0] : undefined;
  const usage = isRecord(first) ? first["usage"] : undefined;
  if (!isRecord(usage)) {
    throw new LoopmillError(
      "fake_usage_fixture_invalid",
      `usage fixture "${id}" has no expected.attempts[0].usage block`,
    );
  }
  return usage as unknown as UsageRecord;
}
