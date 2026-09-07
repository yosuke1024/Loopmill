// Envelope schema loading and compilation (docs/spec/envelope.md; docs/spec/envelope.schema.json).
// The schema is read from docs/spec/ at run time rather than copied into this package
// (docs/design/m1-plan.md §2 decision 5), resolved relative to this module's own location so it
// works the same whether run from `src/` or from the built `dist/` (docs/spec/*.schema.json ships
// in package.json's `files`). No producer policy, no credential backstop, no wire rules here —
// see policy.ts, validate.ts and wire.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormatsDefault from "ajv-formats";
import type { ValidateFunction } from "ajv";

// `ajv-formats`' default export types as `typeof import(...)` rather than the plugin function
// under this toolchain's CJS/ESM interop (matching how `ajv-formats` is a CJS module whose
// compiled default re-exports itself as its own `.default`); the runtime value is the plugin
// function `addFormats(ajv)` in every ajv/ajv-formats release this package pins, so the cast is
// to the function's own documented shape, not to `any`.
type AddFormatsFn = (ajv: InstanceType<typeof Ajv2020>) => void;
const addFormats = ajvFormatsDefault as unknown as AddFormatsFn;

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the normative schema file, resolved relative to this module. */
export const ENVELOPE_SCHEMA_PATH: string = join(HERE, "..", "..", "docs", "spec", "envelope.schema.json");

/** The envelope schema's own `schemaVersion` (envelope.md §12). 1.1.0 is additive over 1.0.0:
 * `$defs.outcome` gained the per-state fields of state-machine.md §2.2 (envelope.md §4.9). */
export const ENVELOPE_SCHEMA_VERSION = "1.1.0";

let cached: ValidateFunction | undefined;

/**
 * The compiled ajv 2020-12 validator for the envelope schema (`ajv-formats` supplies the
 * `date-time` format `occurredAt`/`quotaResetsAt`/`deadline` use), compiled once and memoised.
 * `strictRequired: false` matches `docs/spec/validate-envelopes.mjs`: the schema's conditional
 * `allOf` blocks declare `required` in `then` subschemas whose properties are declared once, at
 * the top level, which ajv's strict mode would otherwise flag as a false positive.
 */
export function getEnvelopeValidator(): ValidateFunction {
  // Narrowed through a local so TS's control-flow analysis can prove the return is defined
  // (a module-scope `let` is not narrowed the same way across the assignment below).
  let validator = cached;
  if (!validator) {
    const schema = JSON.parse(readFileSync(ENVELOPE_SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    addFormats(ajv);
    validator = ajv.compile(schema);
    cached = validator;
  }
  return validator;
}
