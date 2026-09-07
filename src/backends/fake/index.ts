// Public API of `backends/fake/` (docs/design/mvp-design.md §6.2 "fake"; docs/design/m1-plan.md
// §2 "backends/"). Re-exports only.

export { FakeDispatcher, type FakeScript, type FakeScriptKey, type FakeStep } from "./dispatcher.ts";
export { loadFakeScript } from "./load.ts";
export { loadUsageFixture } from "./fixture-usage.ts";
