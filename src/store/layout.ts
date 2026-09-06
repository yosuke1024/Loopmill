// The `.loopmill/` directory layout: where the store's database, worktrees, reports, logs and
// archive live for one repository, and the `LOOPMILL_HOME` override that moves all of it outside
// the repository. Transcribed from docs/design/mvp-design.md §9.1. No I/O beyond `ensureLayout`
// (`resolveLoopmillHome` and `layoutFor` are pure path arithmetic).

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Where `resolveLoopmillHome` got `home` from: the env override, or the repo-relative default. */
export type LoopmillHomeSource = "LOOPMILL_HOME" | "repo";

export interface ResolvedLoopmillHome {
  home: string;
  source: LoopmillHomeSource;
}

/**
 * `LOOPMILL_HOME` overrides `<repoRoot>/.loopmill` (mvp-design.md §9.1: "`LOOPMILL_HOME`
 * overrides the directory for operators who keep state outside the repository"). Both forms are
 * resolved to an absolute path — `LOOPMILL_HOME` may itself be relative (resolved against the
 * process's cwd, matching how a shell would expand a relative path in an env var), and
 * `repoRoot` is not otherwise guaranteed absolute by every caller.
 */
export function resolveLoopmillHome(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}): ResolvedLoopmillHome {
  const override = input.env.LOOPMILL_HOME;
  if (override !== undefined && override !== "") {
    return { home: resolve(override), source: "LOOPMILL_HOME" };
  }
  return { home: resolve(input.repoRoot, ".loopmill"), source: "repo" };
}

/** The paths `mvp-design.md` §9.1 lists under `.loopmill/`, resolved against `home`. Pure — does
 * not check whether any of these exist. */
export interface Layout {
  home: string;
  /** Loop definitions live directly under `home`: `<home>/<slug>.loop.yaml` (§9.1). */
  loopsDir: string;
  stateDb: string;
  worktrees: string;
  reports: string;
  logs: string;
  archive: string;
  gitignore: string;
}

export function layoutFor(home: string): Layout {
  const absoluteHome = isAbsolute(home) ? home : resolve(home);
  return {
    home: absoluteHome,
    loopsDir: absoluteHome,
    stateDb: join(absoluteHome, "state.sqlite"),
    worktrees: join(absoluteHome, "worktrees"),
    reports: join(absoluteHome, "reports"),
    logs: join(absoluteHome, "logs"),
    archive: join(absoluteHome, "archive"),
    gitignore: join(absoluteHome, ".gitignore"),
  };
}

// Written once, by ensureLayout, the first time a repository's .loopmill/ is created
// (mvp-design.md §9.1: "written by Loopmill; ignores everything below"). Everything under
// .loopmill/ is Loopmill's own state (the database, worktrees, reports, logs, archive) except
// the loop definitions themselves, which are committed (§9.1: ".loopmill/<slug>.loop.yaml —
// loop definitions — committed") and this file, which must stay tracked to keep taking effect.
const GITIGNORE_CONTENTS = `# Written by Loopmill (src/store/layout.ts). Ignores everything below except the loop
# definitions and this file itself — see docs/design/mvp-design.md §9.1.
*
!.gitignore
!*.loop.yaml
`;

/**
 * Creates every directory `layoutFor` names (except `stateDb`, a file `sqlite.ts` creates on
 * first open) and writes `home/.gitignore` if it does not exist yet. Never rewrites an existing
 * `.gitignore` — an operator may have hand-edited it, and `sqlite.ts`/callers must be able to
 * call this idempotently on every entrypoint (mvp-design.md §7.5: "the sweep runs first,
 * everywhere") without clobbering that edit.
 */
export async function ensureLayout(home: string): Promise<Layout> {
  const layout = layoutFor(home);
  await mkdir(layout.home, { recursive: true });
  await Promise.all([
    mkdir(layout.worktrees, { recursive: true }),
    mkdir(layout.reports, { recursive: true }),
    mkdir(layout.logs, { recursive: true }),
    mkdir(layout.archive, { recursive: true }),
  ]);
  try {
    // "wx": create-exclusive — throws EEXIST instead of overwriting, which is exactly the
    // "never rewrites an existing file" rule; every other error (e.g. a permissions problem)
    // still propagates.
    await writeFile(layout.gitignore, GITIGNORE_CONTENTS, { flag: "wx" });
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
  return layout;
}
