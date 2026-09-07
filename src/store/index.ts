// Barrel re-export of `src/store/`'s public API (docs/design/m1-plan.md `store/` row).

export type { Layout, LoopmillHomeSource, ResolvedLoopmillHome } from "./layout.ts";
export { ensureLayout, layoutFor, resolveLoopmillHome } from "./layout.ts";

export type {
  AcquireLockInput,
  AcquireLockResult,
  CreateRunInput,
  ListRunsOptions,
  LockRecord,
  OpenStoreOptions,
  ReadEventsOptions,
  RebuildResult,
  RunHeader,
  RunListEntry,
  StoredEvent,
  VerifyChainResult,
} from "./sqlite.ts";
export { openStore, SqliteStore } from "./sqlite.ts";
