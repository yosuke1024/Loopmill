// Reads a Loop file and parses it as YAML 1.2 into a plain JSON value (docs/spec/loop-file.md
// §2, §3.1 step 1). This is the only place in `loop-file/` that touches the filesystem or a
// non-deterministic input; everything downstream (`schema.ts`, `validate.ts`, `canonical.ts`,
// `resolve.ts`) is a pure function of the parsed document.

import { readFile } from "node:fs/promises";
import { LoopmillError } from "../util/errors.ts";
import { parseDocument } from "yaml";

/** What `loadLoopFile` returns: the path it was asked to read, the raw text (kept for callers
 * that want to re-derive something from the source, e.g. a line/column in their own errors),
 * and the parsed document as a plain JSON value -- `unknown` until `schema.ts` says otherwise. */
export interface LoadedLoopFile {
  path: string;
  text: string;
  document: unknown;
}

/**
 * Reads `path` and parses it as YAML 1.2 (docs/spec/loop-file.md §3.1 step 1: anchors and
 * aliases expanded, merge keys resolved, core schema). Duplicate mapping keys are a parse error
 * (`uniqueKeys: true`, LM-VAL-003's "duplicate YAML key" case) rather than silent last-wins.
 *
 * Any YAML error -- a duplicate key included, since by the time a document exists as a plain JS
 * value there is no way to tell "last-wins" from "never duplicated" -- becomes a `LoopmillError`
 * with code `loop_yaml_invalid`, `exitCode: 2`, and every offending line/column folded into the
 * message (the `yaml` package's own `YAMLParseError#message` already reads "... at line N,
 * column M" with a source code frame, so it is used verbatim rather than re-derived).
 */
export async function loadLoopFile(path: string): Promise<LoadedLoopFile> {
  const text = await readFile(path, "utf8");
  const parsed = parseDocument(text, { uniqueKeys: true, merge: true });
  if (parsed.errors.length > 0) {
    const messages = parsed.errors.map((e) => e.message).join("\n");
    throw new LoopmillError("loop_yaml_invalid", `${path}: ${messages}`, {
      exitCode: 2,
      details: parsed.errors.map((e) => ({ code: e.code, message: e.message })),
    });
  }
  const document = parsed.toJS() as unknown;
  return { path, text, document };
}
