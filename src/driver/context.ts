// The driver's own entrypoint context: resolves `.loopmill/`'s layout, opens the store, and
// loads+validates the loop file every other `driver/` module operates against
// (docs/design/mvp-design.md §7, §9; docs/design/m1-plan.md `driver/` row).

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { ensureLayout, layoutFor, openStore, resolveLoopmillHome, type Layout, type SqliteStore } from "../store/index.ts";
import { loadLoop } from "../loop-file/index.ts";
import type { LoopFile, ResolvedLoop } from "../types/loop.ts";
import { LoopmillError } from "../util/errors.ts";

/** The one clock every driver module reads instead of the wall clock directly (frozen by tests;
 * `{ now: () => new Date().toISOString() }` in production — `docs/design/m1-plan.md` §3:
 * "`clock` is `{ now(): string }` injected everywhere"). */
export interface Clock {
  now(): string;
}

export interface RunContext {
  layout: Layout;
  store: SqliteStore;
  loop: ResolvedLoop;
  file: LoopFile;
  loopPath: string;
  /** The resolved repository root every workspace path (`repos[].path`, worktrees) is anchored
   * against — the value `--repo` resolved to, or the git toplevel of the cwd (`cli/main.ts`). */
  repoRoot: string;
  /** Threaded through so every later driver call (`run.ts`, `step.ts`, `gates.ts`) shares one
   * clock without re-deriving it; each of those still accepts its own `clock` parameter too
   * (per `docs/design/m1-plan.md`'s own per-function signatures) for a caller that wants to
   * decouple the two, but the CLI (`cli/main.ts`) always just passes this one through. */
  clock: Clock;
  close(): void;
}

export interface OpenRunContextOptions {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  /** An explicit path to a `.loop.yaml` file. Takes precedence over `slug`. */
  loopPath?: string;
  /** Resolved against `<home>/<slug>.loop.yaml` first, then — the documented dogfooding
   * fallback — `<repoRoot>/examples/<slug>.loop.yaml` (mvp-design.md §9.1: loop definitions are
   * committed at `.loopmill/<slug>.loop.yaml`; the reference loop ships under `examples/`
   * instead until an operator copies or symlinks it into `.loopmill/`). */
  slug?: string;
}

/** Exported (beyond `openRunContext`'s own use) so a caller that must not open the store yet
 * — `cli/main.ts`'s `run --dry-run` (A16: "spending zero tokens", never touching the store) —
 * can still resolve which loop file it is looking at. */
export function resolveLoopPath(opts: Pick<OpenRunContextOptions, "repoRoot" | "loopPath" | "slug">, layout: Layout): string {
  if (opts.loopPath !== undefined) {
    return isAbsolute(opts.loopPath) ? opts.loopPath : resolve(opts.repoRoot, opts.loopPath);
  }
  if (opts.slug === undefined) {
    throw new LoopmillError("loop_not_found", "openRunContext needs either loopPath or slug", { exitCode: 2 });
  }
  const homePath = join(layout.loopsDir, `${opts.slug}.loop.yaml`);
  if (existsSync(homePath)) return homePath;

  // Decision (not in sheet), m1: documented fallback for dogfooding the reference loop before an
  // operator has copied it into `.loopmill/` — mvp-design.md §9.1 names `.loopmill/<slug>.loop.yaml`
  // as the committed home, but `examples/daily-content-improvement.loop.yaml` is where this
  // milestone's own reference loop actually lives.
  const examplesPath = join(opts.repoRoot, "examples", `${opts.slug}.loop.yaml`);
  if (existsSync(examplesPath)) return examplesPath;

  throw new LoopmillError(
    "loop_not_found",
    `no loop file for slug "${opts.slug}": looked at ${homePath} and ${examplesPath}`,
    { exitCode: 2 },
  );
}

/**
 * Resolves `.loopmill/`'s layout (creating it if needed), opens the SQLite store, and loads +
 * validates the loop file every other `driver/` call needs. Async because `ensureLayout` and
 * `loadLoop` both are (`store/layout.ts`, `loop-file/loop.ts`).
 */
export async function openRunContext(opts: OpenRunContextOptions): Promise<RunContext> {
  const home = resolveLoopmillHome({ repoRoot: opts.repoRoot, env: opts.env });
  const layout = await ensureLayout(home.home);
  const loopPath = resolveLoopPath(opts, layout);
  const { loop, file } = await loadLoop(loopPath);
  const store = openStore(layout.stateDb);
  return {
    layout,
    store,
    loop,
    file,
    loopPath,
    repoRoot: opts.repoRoot,
    clock: opts.clock,
    close: () => store.close(),
  };
}

/** Pure path arithmetic re-export, for a caller (e.g. `cli/main.ts`'s `validate` command) that
 * needs the layout without opening a store or loading a loop. */
export { layoutFor };

export interface DryRunLoopContext {
  layout: Layout;
  loop: ResolvedLoop;
  repoRoot: string;
}

/**
 * Everything `--dry-run` needs (mvp-design.md acceptance criterion A16: "spending zero tokens",
 * and this task's own instruction to exit 0 "without touching the store") — resolves the layout
 * and loads the loop file exactly like `openRunContext`, but never calls `openStore`, so
 * `state.sqlite` is never created or opened for a run that must touch nothing. Item 4, m1
 * follow-up: nor does it create `.loopmill/` itself — `layoutFor` is pure path arithmetic
 * (`ensureLayout`'s own `mkdir`/`.gitignore` write is reserved for a real `run`/`step`/`approve`/
 * `reject`), so a `--dry-run` in a repository that has never run anything leaves the filesystem
 * exactly as it found it.
 */
export async function resolveDryRunContext(
  opts: Pick<OpenRunContextOptions, "repoRoot" | "env" | "loopPath" | "slug">,
): Promise<DryRunLoopContext> {
  const home = resolveLoopmillHome({ repoRoot: opts.repoRoot, env: opts.env });
  const layout = layoutFor(home.home);
  const loopPath = resolveLoopPath(opts, layout);
  const { loop } = await loadLoop(loopPath);
  return { layout, loop, repoRoot: opts.repoRoot };
}
