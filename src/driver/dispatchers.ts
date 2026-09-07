// Builds the default `{ backendId: Dispatcher }` map the driver picks a node's dispatcher from
// (docs/design/m1-plan.md `driver/` row: "construct the default dispatcher map in
// `dispatchers.ts`"). `local` is always present; `fake` only when a script was actually given —
// a `Dispatcher` needs a script to replay, and a driver that silently registered an empty one
// would let a loop that names `backend: fake` "succeed" without ever exercising anything.

import { classifyFailure } from "../engine/index.ts";
import { FakeDispatcher, LocalDispatcher, type FakeScript } from "../backends/index.ts";
import type { Dispatcher } from "../types/interfaces.ts";
import type { Layout } from "../store/index.ts";

export interface DefaultDispatchersOptions {
  layout: Layout;
  /** Defaults to `process.env`; overridable so tests never depend on the real process env
   * (mirrors `LocalDispatcherOptions.parentEnv`). */
  parentEnv?: NodeJS.ProcessEnv;
  binaries?: { claude?: string; codex?: string };
  /** When given, registers the `fake` backend, replaying this script. */
  fakeScript?: FakeScript;
}

export function defaultDispatchers(opts: DefaultDispatchersOptions): Record<string, Dispatcher> {
  const dispatchers: Record<string, Dispatcher> = {
    local: new LocalDispatcher({
      layout: { logsDir: opts.layout.logs, worktreesDir: opts.layout.worktrees },
      classify: classifyFailure,
      ...(opts.binaries !== undefined ? { binaries: opts.binaries } : {}),
      ...(opts.parentEnv !== undefined ? { parentEnv: opts.parentEnv } : {}),
    }),
  };
  if (opts.fakeScript !== undefined) {
    dispatchers.fake = new FakeDispatcher(opts.fakeScript);
  }
  return dispatchers;
}
