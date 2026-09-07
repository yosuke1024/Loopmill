// The composition: read a Loop file, validate it, and resolve it. This is the entry point
// everything else in `loop-file/` exists to support; `loopmill validate` and the start of every
// `loopmill step` (docs/spec/loop-file.md §13) both go through this same path.

import type { BackendCapabilities } from "../types/capabilities.ts";
import type { LoopFile, ResolvedLoop } from "../types/loop.ts";
import { LoopmillError } from "../util/errors.ts";
import { loadLoopFile } from "./load.ts";
import { validateLoopDocument, type Finding } from "./validate.ts";
import { resolveLoop } from "./resolve.ts";

export interface LoadLoopOptions {
  /** Defaults to `BACKEND_CAPABILITIES`. */
  capabilities?: Record<string, BackendCapabilities>;
  /** When true, a Loop file with semantic findings is still resolved and returned (`findings`
   * carries what was wrong) instead of `loadLoop` throwing. A schema failure always throws:
   * there is then no `LoopFile`-shaped document to resolve, invalid or otherwise. */
  allowInvalid?: boolean;
}

export interface LoadLoopResult {
  loop: ResolvedLoop;
  file: LoopFile;
  findings: Finding[];
}

/**
 * Loads, validates and resolves the Loop file at `path`. Throws `LoopmillError` (code
 * `loop_invalid`, `exitCode: 2`, `details` carrying the `Finding[]`) when validation finds
 * anything wrong, unless `opts.allowInvalid` is set -- in which case a schema-valid-but-
 * semantically-wrong file is still resolved and returned with its findings attached, but a
 * schema failure still throws (a document is either shaped like a `LoopFile` or it is not
 * something `resolveLoop` can be asked to resolve at all).
 */
export async function loadLoop(path: string, opts: LoadLoopOptions = {}): Promise<LoadLoopResult> {
  const { document } = await loadLoopFile(path);
  const options: { path: string; capabilities?: Record<string, BackendCapabilities> } = { path };
  if (opts.capabilities !== undefined) options.capabilities = opts.capabilities;
  const result = validateLoopDocument(document, options);

  if (!result.file) {
    throw new LoopmillError("loop_invalid", `${path} does not match the loop file schema`, {
      exitCode: 2,
      details: result.findings,
    });
  }
  if (!result.ok && !opts.allowInvalid) {
    throw new LoopmillError(
      "loop_invalid",
      `${path} failed validation: ${result.findings.map((f) => f.code).join(", ")}`,
      { exitCode: 2, details: result.findings },
    );
  }

  const loop = resolveLoop(result.file);
  return { loop, file: result.file, findings: result.findings };
}
