// Semantic validation (docs/spec/loop-file.md §13): one fixture per LM-VAL code, cross-checked
// against `docs/spec/validate-examples.mjs` -- the reference implementation of these rules -- as
// an oracle, plus the reference Loop and the spec's own negative fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLoopFile } from "../../src/loop-file/load.ts";
import { validateLoopDocument } from "../../src/loop-file/validate.ts";
import { BACKEND_CAPABILITIES } from "../../src/backends/capabilities.ts";
import type { BackendCapabilities } from "../../src/types/capabilities.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "test", "fixtures", "loop-file");
const ORACLE_SCRIPT = path.join(REPO_ROOT, "docs", "spec", "validate-examples.mjs");
const REFERENCE_LOOP = path.join(REPO_ROOT, "examples", "daily-content-improvement.loop.yaml");
const INVALID_RETRY_EDGE = path.join(REPO_ROOT, "docs", "spec", "examples", "invalid-retry-edge.loop.yaml");

/** Every code the fixtures under `test/fixtures/loop-file/` cover: 002-029, 020 retired. */
const ALL_CODES = Array.from({ length: 28 }, (_, i) => i + 2)
  .filter((n) => n !== 20)
  .map((n) => `LM-VAL-${String(n).padStart(3, "0")}`);

/** Runs the oracle script against one file and returns the distinct `LM-VAL-nnn` codes it
 * reports as actual findings -- i.e. only from lines the script marks with its own `!`/`-`
 * finding markers, never from the summary line's own prose (which can itself contain the string
 * "LM-VAL-018" as in "expected LM-VAL-018, got no findings" without that being a real finding). */
function oracleCodes(file: string): Set<string> {
  let output: string;
  try {
    output = execFileSync(process.execPath, [ORACLE_SCRIPT, file], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch (err) {
    // The oracle exits non-zero when its own `# expect:` gate does not see a single clean code;
    // that is expected for fixtures whose rule is also caught by the schema (LM-VAL-001 comes
    // along too) -- stdout still carries every finding it reported.
    output = (err as { stdout?: string }).stdout ?? "";
  }
  const codes = new Set<string>();
  for (const line of output.split("\n")) {
    const m = /^\s*[!-]\s+(LM-VAL-\d{3})\b/.exec(line);
    if (m) codes.add(m[1]!);
  }
  return codes;
}

async function findingsFor(file: string, capabilities?: Record<string, BackendCapabilities>): Promise<Set<string>> {
  const { document } = await loadLoopFile(file);
  const result = validateLoopDocument(document, capabilities ? { path: file, capabilities } : { path: file });
  return new Set(result.findings.map((f) => f.code));
}

test("validateLoopDocument: the reference loop yields zero findings", async () => {
  const { document } = await loadLoopFile(REFERENCE_LOOP);
  const result = validateLoopDocument(document, { path: REFERENCE_LOOP });
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
  assert.notEqual(result.file, null);
});

test("validateLoopDocument: docs/spec/examples/invalid-retry-edge.loop.yaml fails with exactly LM-VAL-007", async () => {
  const { document } = await loadLoopFile(INVALID_RETRY_EDGE);
  const result = validateLoopDocument(document, { path: INVALID_RETRY_EDGE });
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.code, "LM-VAL-007");
  assert.equal(result.findings[0]!.path, "edges.retry-implementation");
  // Compare the message with the reference script's own output for the identical mistake
  // (loop-file.md §15.3): both must name `has-diff` as the offending target and say why.
  assert.match(result.findings[0]!.message, /to "has-diff" is a condition node, which runs on the control plane \(retryable: false\)/);
});

test("docs/spec/validate-examples.mjs still reports RESULT: pass on its own default fixtures (examples/, docs/spec/examples/)", () => {
  const output = execFileSync(process.execPath, [ORACLE_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.match(output, /RESULT: pass/);
});

test("one fixture per LM-VAL code (002-029, 020 retired)", async (t) => {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".loop.yaml"))
    .sort();

  // Every code in ALL_CODES has exactly one fixture file named for it.
  const codesFromFilenames = files.map((f) => f.replace(/\.loop\.yaml$/, "").toUpperCase());
  assert.deepEqual(codesFromFilenames, ALL_CODES, "test/fixtures/loop-file/ must have exactly one file per LM-VAL code");

  for (const file of files) {
    const code = file.replace(/\.loop\.yaml$/, "").toUpperCase() as `LM-VAL-${string}`;
    const fullPath = path.join(FIXTURES_DIR, file);

    await t.test(code, async () => {
      // LM-VAL-018 only fires against a backend that declares `structuredOutput: false`; no MVP
      // backend in `BACKEND_CAPABILITIES` does (loop-file.md §8.1), so this one fixture is
      // validated against a deliberately modified capability record instead of the real
      // defaults. The oracle script has no such override mechanism, so it is skipped for this
      // one code (see the fixture's own header comment).
      const capabilities =
        code === "LM-VAL-018"
          ? { ...BACKEND_CAPABILITIES, fake: { ...BACKEND_CAPABILITIES.fake, structuredOutput: false } }
          : undefined;

      const codes = await findingsFor(fullPath, capabilities);

      // LM-VAL-021 cannot reach the semantic layer at all under the frozen 0.6.0 schema: its
      // `sessionPolicy` enum already restricts every schema-valid document to "fresh", so this
      // fixture's actual, current behaviour is LM-VAL-001 -- both this implementation and the
      // reference script agree on that (see the fixture's own header comment and the report for
      // this finding). Assert the documented reality rather than the code that cannot fire.
      if (code === "LM-VAL-021") {
        assert.ok(codes.has("LM-VAL-001"), `expected LM-VAL-001 (the schema catching it first), got: ${[...codes].join(", ") || "(none)"}`);
      } else {
        assert.ok(codes.has(code), `expected ${code} in findings, got: ${[...codes].join(", ") || "(none)"}`);
      }

      if (code === "LM-VAL-018") return; // see above

      // Cross-check against the reference implementation: the exact set of codes it reports for
      // this file must match ours.
      const oracle = oracleCodes(fullPath);
      assert.deepEqual([...codes].sort(), [...oracle].sort(), `mine: ${[...codes].join(",")} vs. oracle: ${[...oracle].join(",")}`);
    });
  }
});
