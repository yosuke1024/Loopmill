#!/usr/bin/env node
// Entry point. During development the CLI runs from the TypeScript sources through Node's type
// stripping (Node >= 22.18); a built package points this at dist/ instead.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// `node:sqlite` (imported transitively by `src/store/sqlite.ts`, the first time `driver/`
// opens a store) logs a one-line `ExperimentalWarning: SQLite is an experimental feature...` on
// import. `docs/design/m1-plan.md`'s own instruction is to suppress *this* warning without
// hiding any other one an operator's script should still see (an unrelated deprecation warning,
// say). Chosen approach, and why: `process.removeAllListeners("warning")` followed by a
// filtered re-listener, rather than re-exec'ing with `--disable-warning=ExperimentalWarning`.
// The flag form needs Node to already be running with it *before* `node:sqlite` is imported,
// which would mean re-executing this very script as a child process with an extra argv0 flag
// (`process.execArgv`), an extra process spawn on every invocation for one suppressed line.
// The listener form runs in-process, works identically on Node 22.18 (where `--disable-warning`
// was still quite new) and Node 25, and is easy to reason about: it never swallows a warning
// this process did not itself intend to filter.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) {
    return; // the one warning this wrapper suppresses.
  }
  console.error(warning.stack ?? `${warning.name}: ${warning.message}`);
});

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "cli", "main.js");
const src = join(here, "..", "src", "cli", "main.ts");
const target = existsSync(dist) ? dist : src;
const { main } = await import(target);
process.exitCode = await main(process.argv.slice(2));
