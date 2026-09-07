// JSON Schema validation for a parsed Loop file document (docs/spec/loop-file.schema.json,
// LM-VAL-001). The schema is read from `docs/spec/` at run time rather than copied into this
// package (docs/design/m1-plan.md §2 decision 5), resolved relative to this module's own
// location so it works the same under `src/` and under the built `dist/`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormatsDefault from "ajv-formats";
import type { ValidateFunction } from "ajv";

// `ajv-formats`' default export types as `typeof import(...)` rather than the plugin function
// under this toolchain's CJS/ESM interop (matching `src/envelope/schema.ts`, which hits the same
// quirk); the runtime value is the plugin function `addFormats(ajv)` in every ajv/ajv-formats
// release this package pins, so the cast is to the function's own documented shape, not to `any`.
type AddFormatsFn = (ajv: InstanceType<typeof Ajv2020>) => void;
const addFormats = ajvFormatsDefault as unknown as AddFormatsFn;

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the normative schema file, resolved relative to this module so it is found
 * the same way whether the package runs from `src/` or from `dist/` (both sit two directories
 * under the package root; `docs/spec/*.schema.json` ships in package.json's `files`). */
export const LOOP_FILE_SCHEMA_PATH: string = join(HERE, "..", "..", "docs", "spec", "loop-file.schema.json");

export interface SchemaFindingLocation {
  path: string;
  message: string;
}

export type SchemaValidationResult = { ok: true } | { ok: false; errors: SchemaFindingLocation[] };

let cached: ValidateFunction | undefined;

/** Compiles the ajv 2020-12 validator once and memoises it; `ajv-formats` is registered so the
 * schema's `date-time`-shaped strings (none in this schema today, kept for parity with the
 * envelope/state-machine schemas that share the toolchain) are recognised. `strict: false`
 * matches `docs/spec/validate-examples.mjs`, the reference implementation of these rules. */
function getValidator(): ValidateFunction {
  // Narrowed through a local so TS's control-flow analysis can prove the return is defined (a
  // module-scope `let` is not narrowed the same way across the assignment below; see
  // `src/envelope/schema.ts` for the same pattern against the same quirk).
  let validator = cached;
  if (!validator) {
    const schema = JSON.parse(readFileSync(LOOP_FILE_SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validator = ajv.compile(schema);
    cached = validator;
  }
  return validator;
}

/**
 * Validates `document` against `docs/spec/loop-file.schema.json`. On failure, returns one entry
 * per ajv error with `path` as the ajv `instancePath` rewritten from JSON Pointer form
 * (`/nodes/implement/prompt`) to the dotted form the rest of `loop-file/` uses
 * (`nodes.implement.prompt`); the root document itself is the empty string. `validate.ts` turns
 * each entry into an `LM-VAL-001` `Finding`.
 */
export function validateAgainstSchema(document: unknown): SchemaValidationResult {
  const validate = getValidator();
  if (validate(document)) {
    return { ok: true };
  }
  const errors = (validate.errors ?? []).map((e) => ({
    path: dottedPath(e.instancePath),
    message: `${e.message ?? "is invalid"}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`,
  }));
  return { ok: false, errors };
}

function dottedPath(instancePath: string): string {
  if (!instancePath) return "";
  return instancePath
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}
