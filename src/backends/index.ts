// Public API of `backends/` (docs/design/m1-plan.md §2 "backends/"). Re-exports only.

export { BACKEND_CAPABILITIES, capabilitiesFor } from "./capabilities.ts";
export * from "./fake/index.ts";
export * from "./local/index.ts";
