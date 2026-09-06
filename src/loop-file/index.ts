// Public API of `loop-file/` (docs/design/m1-plan.md §2). Re-exports only -- no logic lives
// here. Types are re-exported with `export type` to keep the erasure explicit under
// `verbatimModuleSyntax`; the handful of runtime values (functions, and the `BACKEND_CAPABILITIES`
// re-export from `backends/`) use a plain `export`.

export { loadLoopFile, type LoadedLoopFile } from "./load.ts";

export { validateAgainstSchema, LOOP_FILE_SCHEMA_PATH, type SchemaFindingLocation, type SchemaValidationResult } from "./schema.ts";

export {
  validateLoopDocument,
  type Finding,
  type ValidateLoopOptions,
  type ValidateLoopResult,
} from "./validate.ts";

export { canonicalizeLoopFile, loopVersionOf } from "./canonical.ts";

export { resolveLoop, BUILTIN_ENV_DENY, BUILTIN_ENV_PRESERVE } from "./resolve.ts";

export { loadLoop, type LoadLoopOptions, type LoadLoopResult } from "./loop.ts";

export {
  parseReference,
  resolveReference,
  resolveInputs,
  type Reference,
  type ReferenceContext,
  type NodeOutput,
  type ResolveResult,
} from "./references.ts";

export { templatePlaceholders, renderTemplate, renderArgv } from "./template.ts";

export {
  parseExpression,
  expressionPaths,
  evaluateExpression,
  type Expr,
  type CompareOp,
} from "./expr.ts";
