// `loopmill`'s command-line surface (mvp-design.md §15.2). Hand-written argument parsing — no
// dependency, per `docs/design/m1-plan.md` decision 4. Every command has a human layout and a
// `--json` layout (the fields are the contract, not the human text's exact wording).

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyStep,
  decideGate,
  defaultDispatchers,
  layoutFor,
  logsOf,
  listRunsView,
  openRunContext,
  printDryRun,
  resolveDryRunContext,
  resolveLoopPath,
  resumeDue,
  resumeRun,
  runDoctor,
  runLoop,
  statusOf,
  type Clock,
  type DoctorContext,
  type RunContext,
} from "../driver/index.ts";
import { fold, DEFAULT_POLICY_FULL } from "../engine/index.ts";
import { loadLoop } from "../loop-file/index.ts";
import { loadFakeScript } from "../backends/fake/index.ts";
import { BACKEND_CAPABILITIES } from "../backends/index.ts";
import { ensureLayout, openStore, resolveLoopmillHome, type Layout, type ListRunsOptions } from "../store/index.ts";
import type { ResolvedLoop } from "../types/loop.ts";
import type { Envelope, TriggerPayload } from "../types/envelope.ts";
import type { Dispatcher } from "../types/interfaces.ts";
import { LoopmillError } from "../util/errors.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");

const realClock: Clock = { now: () => new Date().toISOString() };

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOL_FLAGS = new Set(["dry-run", "json", "last", "scheduler", "due"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) {
        throw new LoopmillError("cli_usage", `--${name} needs a value`, { exitCode: 2 });
      }
      flags[name] = next;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------------

function resolveRepoRootArg(explicit: string | undefined): string {
  if (explicit !== undefined) return resolvePath(process.cwd(), explicit);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return process.cwd();
  }
}

/** `status --last`, `doctor` and `runs` (no `--loop`) all need a slug when none was given on the
 * command line — this repo's own dogfooding case has exactly one loop, either already committed
 * at `.loopmill/<slug>.loop.yaml` or (before that copy happens) at
 * `examples/<slug>.loop.yaml` (the same fallback `driver/context.ts`'s `openRunContext`
 * documents). Decision (not in sheet), m1: picks the first `.loop.yaml` found, alphabetically —
 * these commands' own contract (mvp-design.md §15.2) does not name a `--loop` default for a
 * repository with more than one loop file, so "first, alphabetically" is a defined tie-break
 * rather than an unspecified one. */
function resolveDefaultSlug(layout: Layout, repoRoot: string): string | null {
  for (const dir of [layout.loopsDir, join(repoRoot, "examples")]) {
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".loop.yaml")).sort();
      if (files.length > 0) return files[0]!.slice(0, -".loop.yaml".length);
    } catch {
      // directory does not exist yet — try the next one.
    }
  }
  return null;
}

/** `status <runId>`, `approve`/`reject`, `logs` and `rebuild-snapshot` all take a bare `runId`
 * with no loop/slug argument (mvp-design.md §15.2's command table). The run's own stored header
 * already names its `loopId`, so this peeks the store once (a second, short-lived connection —
 * WAL allows any number of readers) to learn it, then opens the full context normally. */
async function openContextForRun(repoRoot: string, env: NodeJS.ProcessEnv, clock: Clock, runId: string): Promise<RunContext> {
  const home = resolveLoopmillHome({ repoRoot, env });
  const layout = await ensureLayout(home.home);
  const peek = openStore(layout.stateDb);
  let loopId: string | null;
  try {
    loopId = peek.readRunHeader(runId)?.loopId ?? null;
  } finally {
    peek.close();
  }
  if (loopId === null) {
    throw new LoopmillError("run_not_found", `no run ${runId} in ${layout.stateDb}`, { exitCode: 2 });
  }
  return openRunContext({ repoRoot, env, clock, slug: loopId });
}

/** Item 4: `status`, `runs`, `logs`, `rebuild-snapshot`, `export` and `doctor` must never create
 * `.loopmill/` — only `run` (non-dry), `step`, `approve` and `reject` do. This is
 * `openContextForRun`'s read-only counterpart: `layoutFor` (pure path arithmetic, no mkdir)
 * instead of `ensureLayout`, and it never opens the store at all when `state.sqlite` does not
 * exist yet — `null` in that case, for the caller to report "no runs recorded for this
 * repository" itself (the right exit code differs: 0 for `status --last`/`runs`, 2 for a command
 * that names a `<runId>`, so this function does not print or choose one). */
async function openExistingContextForRun(repoRoot: string, env: NodeJS.ProcessEnv, clock: Clock, runId: string): Promise<RunContext | null> {
  const home = resolveLoopmillHome({ repoRoot, env });
  const layout = layoutFor(home.home);
  if (!existsSync(layout.stateDb)) return null;
  const peek = openStore(layout.stateDb);
  let loopId: string | null;
  try {
    loopId = peek.readRunHeader(runId)?.loopId ?? null;
  } finally {
    peek.close();
  }
  if (loopId === null) {
    throw new LoopmillError("run_not_found", `no run ${runId} in ${layout.stateDb}`, { exitCode: 2 });
  }
  const loopPath = resolveLoopPath({ repoRoot, slug: loopId }, layout);
  const { loop, file } = await loadLoop(loopPath);
  const store = openStore(layout.stateDb);
  return { layout, store, loop, file, loopPath, repoRoot, clock, close: () => store.close() };
}

/** Item 3: `run`, `approve` and `reject` all accept `--fake-script <file>` the same way — a
 * script path resolved against the cwd, registering the `fake` backend alongside `local`
 * (`defaultDispatchers`' own rule: `fake` is only ever registered when a script was actually
 * given). Shared so the three commands' option parsing cannot drift apart (`resume` needs the
 * same in m2, per this task's own instruction). */
function resolveDispatchersFromFlags(ctx: { layout: Layout }, flags: Record<string, string | boolean>): Record<string, Dispatcher> {
  const fakeScriptPath = flagString(flags, "fake-script");
  return fakeScriptPath
    ? defaultDispatchers({ layout: ctx.layout, fakeScript: loadFakeScript(isAbsolute(fakeScriptPath) ? fakeScriptPath : resolvePath(process.cwd(), fakeScriptPath)) })
    : defaultDispatchers({ layout: ctx.layout });
}

function printError(err: unknown): number {
  if (err instanceof LoopmillError) {
    process.stderr.write(`loopmill: ${err.code}: ${err.message}\n`);
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`loopmill: internal_error: ${message}\n`);
  return 1;
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

function printHelp(): void {
  process.stdout.write(
    [
      "loopmill <command> [options]",
      "",
      "Commands:",
      "  validate [<file>]",
      "  run <slug|path> [--dry-run] [--json] [--fake-script <file>] [--repo <dir>] [--trigger manual|schedule]",
      "  step [--event-file <path>] [--json]        (stdin otherwise)",
      "  approve <runId> [--reason <text>] [--actor <name>] [--fake-script <file>] [--repo <dir>]",
      "  reject <runId> [--reason <text>] [--actor <name>] [--fake-script <file>] [--repo <dir>]",
      "  cancel <runId> [--reason <text>] [--actor <name>] [--fake-script <file>] [--repo <dir>]",
      "  resume <runId> [--decision retry|skip|fail] [--actor <name>] [--json] [--fake-script <file>] [--repo <dir>]",
      "  resume --due [--json] [--repo <dir>]",
      "  status [<runId>|--last] [--json]",
      "  runs [--loop <slug>] [--since <rfc3339>] [--json]",
      "  logs <runId> [--node <id>] [--cycle <n>] [--json]",
      "  backends [--json]",
      "  rebuild-snapshot <runId>",
      "  export <runId>",
      "  doctor [--json] [--scheduler]",
      "  --version",
      "  help",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function cmdValidate(positional: string[]): Promise<number> {
  const target = positional[0];
  if (!target) {
    process.stderr.write("loopmill: cli_usage: validate needs a <file>\n");
    return 2;
  }
  const path = isAbsolute(target) ? target : resolvePath(process.cwd(), target);
  try {
    const { findings } = await loadLoop(path, { allowInvalid: true });
    if (findings.length > 0) {
      for (const f of findings) {
        process.stderr.write(`loopmill: ${f.code}: ${f.message}${f.path ? ` (${f.path})` : ""}\n`);
      }
      return 2;
    }
    process.stdout.write(`ok: ${target} is a valid loop file\n`);
    return 0;
  } catch (err) {
    return printError(err);
  }
}

async function cmdRun(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const target = positional[0];
  if (!target) {
    process.stderr.write("loopmill: cli_usage: run needs a <slug|path>\n");
    return 2;
  }
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  const asPath = isAbsolute(target) ? target : resolvePath(process.cwd(), target);
  const openOpts = existsSync(asPath) ? { loopPath: asPath } : { slug: target };

  // A16: `--dry-run` never opens the store at all — `resolveDryRunContext` resolves the layout
  // and loads the loop file the same way `openRunContext` would, but skips `openStore` entirely.
  if (flagBool(flags, "dry-run")) {
    try {
      const dryCtx = await resolveDryRunContext({ repoRoot, env: process.env, ...openOpts });
      printDryRun(dryCtx, { write: (s) => void process.stdout.write(s) }, flagBool(flags, "json"));
      return 0;
    } catch (err) {
      return printError(err);
    }
  }

  let ctx: RunContext;
  try {
    ctx = await openRunContext({ repoRoot, env: process.env, clock: realClock, ...openOpts });
  } catch (err) {
    return printError(err);
  }

  try {
    const dispatchers = resolveDispatchersFromFlags(ctx, flags);

    const triggerKind = flagString(flags, "trigger") ?? "manual";
    if (triggerKind !== "manual" && triggerKind !== "schedule") {
      process.stderr.write(`loopmill: cli_usage: --trigger must be "manual" or "schedule", got ${JSON.stringify(triggerKind)}\n`);
      return 2;
    }
    const trigger: TriggerPayload = { kind: triggerKind, source: "cli" };

    const result = await runLoop({
      ctx,
      trigger,
      dispatchers,
      dryRun: flagBool(flags, "dry-run"),
      json: flagBool(flags, "json"),
    });
    return result.exitCode;
  } finally {
    ctx.close();
  }
}

function readStdinSync(): string {
  return readFileSync(0, "utf8");
}

async function cmdStep(flags: Record<string, string | boolean>): Promise<number> {
  const eventFile = flagString(flags, "event-file");
  const raw = eventFile ? readFileSync(isAbsolute(eventFile) ? eventFile : resolvePath(process.cwd(), eventFile), "utf8") : readStdinSync();

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch (err) {
    process.stderr.write(`loopmill: envelope_invalid: could not parse JSON: ${(err as Error).message}\n`);
    return 2;
  }
  if (typeof envelope.loopId !== "string" || envelope.loopId.length === 0) {
    process.stderr.write("loopmill: envelope_invalid: envelope has no loopId\n");
    return 2;
  }

  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  let ctx: RunContext;
  try {
    ctx = await openRunContext({ repoRoot, env: process.env, clock: realClock, slug: envelope.loopId });
  } catch (err) {
    return printError(err);
  }

  try {
    const out = applyStep({ ctx, envelope, clock: ctx.clock });
    const payload = {
      classification: out.result?.kind ?? (out.exitCode === 3 ? "lock_conflict" : null),
      runId: envelope.runId,
      status: out.result?.snapshot.status ?? null,
      outcome: out.result?.snapshot.outcome ?? null,
    };
    if (flagBool(flags, "json")) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stdout.write(`${payload.classification ?? "unhandled"}${payload.status ? ` ${payload.status}` : ""}\n`);
    }
    return out.exitCode;
  } finally {
    ctx.close();
  }
}

/** Shared by `approve`/`reject` (mvp-design.md §12, §15.2) and `cancel` (state-machine.md event
 * row 10: `human.decision` is `'approve' | 'reject' | 'cancel'`, and `decideGate`'s own
 * `DecideGateInput.decision` already accepts all three — `cancel` was simply never wired to a CLI
 * command). One function rather than a fourth `cmdCancel`, per this task's own preference: the
 * three decisions are identical in every way that matters here (same lock, same envelope shape,
 * same exit-code table), so a fourth near-duplicate function would only invite the three to drift. */
async function cmdGate(decision: "approve" | "reject" | "cancel", positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const runId = positional[0];
  if (!runId) {
    process.stderr.write(`loopmill: cli_usage: ${decision} needs a <runId>\n`);
    return 2;
  }
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  let ctx: RunContext;
  try {
    ctx = await openContextForRun(repoRoot, process.env, realClock, runId);
  } catch (err) {
    return printError(err);
  }
  try {
    const reason = flagString(flags, "reason");
    const dispatchers = resolveDispatchersFromFlags(ctx, flags);
    const result = await decideGate({
      ctx,
      runId,
      decision,
      actor: flagString(flags, "actor") ?? "operator",
      clock: ctx.clock,
      dispatchers,
      ...(reason !== undefined ? { note: reason } : {}),
      json: flagBool(flags, "json"),
    });
    return result.exitCode;
  } finally {
    ctx.close();
  }
}

const RESUME_DECISIONS = new Set(["retry", "skip", "fail"]);

function isResumeDecision(value: string): value is "retry" | "skip" | "fail" {
  return RESUME_DECISIONS.has(value);
}

/** `loopmill resume [<runId> | --due] [--json]` (mvp-design.md §15.2, §534). The two forms are
 * mutually exclusive — `--due` drains every `WAITING_FOR_QUOTA` Run whose `resumeDueAt` has
 * passed (`resumeDue`), a bare `<runId>` resumes exactly that one Run (`resumeRun`) — so this
 * function validates the flag combination itself rather than letting `resumeRun`/`resumeDue`
 * each guess what an absent argument on the other command's behalf would mean. */
async function cmdResume(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const runId = positional[0];
  const due = flagBool(flags, "due");

  if (due && runId) {
    process.stderr.write("loopmill: cli_usage: resume takes either <runId> or --due, not both\n");
    return 2;
  }
  if (!due && !runId) {
    process.stderr.write("loopmill: cli_usage: resume needs a <runId> or --due\n");
    return 2;
  }

  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));

  if (due) {
    // Item 4's own rule, mirrored from `cmdStatus`: a repository with no `state.sqlite` yet has
    // no Runs to drain — report that on stdout and exit 0 without conjuring `.loopmill/` into
    // existence, the same way `status --last`/`runs` do for the identical fact.
    const home = resolveLoopmillHome({ repoRoot, env: process.env });
    const layout = layoutFor(home.home);
    if (!existsSync(layout.stateDb)) {
      process.stdout.write("no runs recorded for this repository\n");
      return 0;
    }
    const store = openStore(layout.stateDb);
    try {
      const result = await resumeDue({
        store,
        // Decision (not in sheet), m2: a loop file that fails to load (deleted, or now invalid)
        // must not abort the whole drain — every other loop this scan can still resolve keeps
        // draining. `resumeDue`'s own contract already treats a `null` here as `loop_unresolved`
        // (`docs/design/m2-plan.md`'s W0b framing: a loop this process cannot resolve is left for
        // one that can), so any failure to open a context collapses to the same `null`.
        resolveContext: async (loopId) => {
          try {
            return await openRunContext({ repoRoot, env: process.env, clock: realClock, slug: loopId });
          } catch {
            return null;
          }
        },
        clock: realClock,
        json: flagBool(flags, "json"),
      });
      return result.exitCode;
    } finally {
      store.close();
    }
  }

  let ctx: RunContext;
  try {
    ctx = await openContextForRun(repoRoot, process.env, realClock, runId!);
  } catch (err) {
    return printError(err);
  }
  try {
    const decisionRaw = flagString(flags, "decision");
    if (decisionRaw !== undefined && !isResumeDecision(decisionRaw)) {
      process.stderr.write(`loopmill: cli_usage: --decision must be "retry", "skip" or "fail", got ${JSON.stringify(decisionRaw)}\n`);
      return 2;
    }
    const actor = flagString(flags, "actor");
    const dispatchers = resolveDispatchersFromFlags(ctx, flags);
    const result = await resumeRun({
      ctx,
      runId: runId!,
      ...(decisionRaw !== undefined ? { decision: decisionRaw } : {}),
      ...(actor !== undefined ? { actor } : {}),
      clock: ctx.clock,
      dispatchers,
      json: flagBool(flags, "json"),
    });
    return result.exitCode;
  } finally {
    ctx.close();
  }
}

async function cmdStatus(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  const runIdArg = positional[0];

  // Item 4: `status` never creates `.loopmill/` — a repository that has never run anything yet
  // has, by definition, nothing to report; `--last`/`runs` says so on stdout and exits 0, a bare
  // `<runId>` says so on stderr and exits 2 (the same "no runs recorded" fact, phrased for the
  // exit code each case documents).
  const home = resolveLoopmillHome({ repoRoot, env: process.env });
  const layout = layoutFor(home.home);
  if (!existsSync(layout.stateDb)) {
    if (runIdArg) {
      process.stderr.write("loopmill: run_not_found: no runs recorded for this repository\n");
      return 2;
    }
    process.stdout.write("no runs recorded for this repository\n");
    return 0;
  }

  let ctx: RunContext;
  let which: string | "last";
  try {
    if (runIdArg) {
      const found = await openExistingContextForRun(repoRoot, process.env, realClock, runIdArg);
      if (!found) {
        process.stderr.write("loopmill: run_not_found: no runs recorded for this repository\n");
        return 2;
      }
      ctx = found;
      which = runIdArg;
    } else {
      const slug = resolveDefaultSlug(layout, repoRoot);
      if (!slug) {
        process.stderr.write("loopmill: loop_not_found: no loop to report status for — pass a runId, or add a loop file\n");
        return 2;
      }
      ctx = await openRunContext({ repoRoot, env: process.env, clock: realClock, slug });
      which = "last";
    }
  } catch (err) {
    return printError(err);
  }

  try {
    const view = statusOf(ctx, which);
    if (!view) {
      process.stderr.write("loopmill: run_not_found: no matching run\n");
      return 2;
    }
    if (flagBool(flags, "json")) {
      process.stdout.write(`${JSON.stringify(view)}\n`);
    } else {
      process.stdout.write(`${view.runId}   ${view.loopId}   loopVersion ${view.loopVersion}\n`);
      process.stdout.write(`State        ${view.state}${view.currentNode ? ` (${view.currentNode}, cycle ${view.cycleIndex})` : ""}\n`);
      process.stdout.write(`Duration     ${view.activeMs}ms active / ${view.waitMs}ms waiting\n`);
      process.stdout.write(`Cycles       ${view.maxCycleIndex}\n`);
      process.stdout.write(`Tokens       ${view.tokensRendered}   Coverage ${view.coverage}\n`);
      process.stdout.write(`Next         ${view.next}\n`);
    }
    return 0;
  } finally {
    ctx.close();
  }
}

async function cmdRuns(flags: Record<string, string | boolean>): Promise<number> {
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  const loopSlug = flagString(flags, "loop");
  const since = flagString(flags, "since");

  // Item 4: `runs` never creates `.loopmill/` — a repository with no `state.sqlite` yet has no
  // runs to list, full stop, regardless of `--loop`.
  const home = resolveLoopmillHome({ repoRoot, env: process.env });
  const layout = layoutFor(home.home);
  if (!existsSync(layout.stateDb)) {
    process.stdout.write("no runs recorded for this repository\n");
    return 0;
  }

  if (loopSlug) {
    const ctx = await openRunContext({ repoRoot, env: process.env, clock: realClock, slug: loopSlug });
    try {
      const opts: ListRunsOptions = { loopId: ctx.loop.slug };
      if (since !== undefined) opts.since = since;
      const rows = listRunsView(ctx, opts);
      printRuns(rows, flagBool(flags, "json"));
    } finally {
      ctx.close();
    }
    return 0;
  }

  // No `--loop`: list across every loop in the store (Decision (not in sheet), m1 — see
  // `resolveDefaultSlug`'s own comment: mvp-design.md §15.2 does not say what an unscoped `runs`
  // does in a multi-loop repository). Tokens/coverage are not rendered here since interpreting
  // which node executions are "agent" ones needs each row's own resolved loop file. `state.sqlite`
  // is already known to exist (checked above), so opening it here creates nothing.
  const store = openStore(layout.stateDb);
  try {
    const opts: ListRunsOptions = {};
    if (since !== undefined) opts.since = since;
    const rows = store.listRuns(opts);
    if (flagBool(flags, "json")) {
      process.stdout.write(`${JSON.stringify(rows)}\n`);
    } else {
      for (const r of rows) {
        process.stdout.write(`${r.runId}  ${r.loopId}  ${r.status ?? "(no snapshot)"}  ${r.createdAt}\n`);
      }
    }
  } finally {
    store.close();
  }
  return 0;
}

function printRuns(rows: ReturnType<typeof listRunsView>, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return;
  }
  for (const r of rows) {
    process.stdout.write(`${r.runId}  ${r.status ?? "(no snapshot)"}  tokens ${r.tokensRendered} coverage ${r.coverage}  ${r.createdAt}\n`);
  }
}

async function cmdLogs(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const runId = positional[0];
  if (!runId) {
    process.stderr.write("loopmill: cli_usage: logs needs a <runId>\n");
    return 2;
  }
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  let ctx: RunContext;
  try {
    const found = await openExistingContextForRun(repoRoot, process.env, realClock, runId);
    if (!found) {
      process.stderr.write("loopmill: run_not_found: no runs recorded for this repository\n");
      return 2;
    }
    ctx = found;
  } catch (err) {
    return printError(err);
  }
  try {
    const opts: { node?: string; cycle?: number } = {};
    const node = flagString(flags, "node");
    const cycle = flagString(flags, "cycle");
    if (node !== undefined) opts.node = node;
    if (cycle !== undefined) opts.cycle = Number(cycle);
    const views = logsOf(ctx, runId, opts);
    if (flagBool(flags, "json")) {
      process.stdout.write(`${JSON.stringify(views)}\n`);
    } else {
      for (const v of views) {
        process.stdout.write(`\n${v.nodeId} (cycle ${v.cycleIndex}) — ${v.state}\n`);
        if (v.structured !== null && v.structured !== undefined) process.stdout.write(`  structured output: ${JSON.stringify(v.structured)}\n`);
        if (v.stdout !== null) process.stdout.write(`  stdout: ${v.stdout}\n`);
        if (v.exitCode !== null) process.stdout.write(`  exitCode: ${v.exitCode}\n`);
        for (const a of v.attempts) {
          process.stdout.write(`  attempt ${a.attempt}: ${a.state}\n`);
          if (a.plan) {
            process.stdout.write(`    resolved inputs: ${JSON.stringify(a.plan.inputs)}\n`);
            process.stdout.write(`    argv: ${JSON.stringify(a.plan.argv)}\n`);
            process.stdout.write(`    cwd: ${a.plan.cwd}\n`);
            for (const note of a.plan.notes) process.stdout.write(`    ${note}\n`);
          }
          process.stdout.write(`    stdout: ${a.stdoutPath}\n`);
          if (a.stdoutTail) process.stdout.write(`    stdout tail: ${a.stdoutTail}\n`);
          process.stdout.write(`    stderr: ${a.stderrPath}\n`);
          if (a.stderrTail) process.stdout.write(`    stderr tail: ${a.stderrTail}\n`);
          if (a.usage) process.stdout.write(`    usage: ${JSON.stringify(a.usage)}\n`);
          if (a.error) process.stdout.write(`    error: ${JSON.stringify(a.error)}\n`);
          if (a.artifactRefs.length > 0) process.stdout.write(`    artifactRefs: ${JSON.stringify(a.artifactRefs)}\n`);
        }
      }
    }
    return 0;
  } finally {
    ctx.close();
  }
}

async function cmdBackends(flags: Record<string, string | boolean>): Promise<number> {
  const records = Object.entries(BACKEND_CAPABILITIES).map(([id, caps]) => ({ id, ...caps }));
  if (flagBool(flags, "json")) {
    process.stdout.write(`${JSON.stringify(records)}\n`);
  } else {
    for (const r of records) process.stdout.write(`${r.id}: ${JSON.stringify(r)}\n`);
  }
  return 0;
}

async function cmdRebuildSnapshot(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const runId = positional[0];
  if (!runId) {
    process.stderr.write("loopmill: cli_usage: rebuild-snapshot needs a <runId>\n");
    return 2;
  }
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  let ctx: RunContext;
  try {
    const found = await openExistingContextForRun(repoRoot, process.env, realClock, runId);
    if (!found) {
      process.stderr.write("loopmill: run_not_found: no runs recorded for this repository\n");
      return 2;
    }
    ctx = found;
  } catch (err) {
    return printError(err);
  }
  try {
    const result = ctx.store.rebuildSnapshot(runId, (rows) => fold(rows, { loop: ctx.loop, policy: DEFAULT_POLICY_FULL }).snapshot);
    if (result.identical) {
      process.stdout.write(`ok: ${runId}'s stored snapshot matches fold(events)\n`);
      return 0;
    }
    process.stderr.write(`loopmill: snapshot_mismatch: ${runId} differs from its stored snapshot at line ${result.firstDifferingLine}\n`);
    return 1;
  } finally {
    ctx.close();
  }
}

async function cmdExport(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  const runId = positional[0];
  if (!runId) {
    process.stderr.write("loopmill: cli_usage: export needs a <runId>\n");
    return 2;
  }
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  const home = resolveLoopmillHome({ repoRoot, env: process.env });
  const layout = layoutFor(home.home);
  if (!existsSync(layout.stateDb)) {
    process.stderr.write("loopmill: run_not_found: no runs recorded for this repository\n");
    return 2;
  }
  const store = openStore(layout.stateDb);
  try {
    const header = store.readRunHeader(runId);
    if (!header) {
      process.stderr.write(`loopmill: run_not_found: no run ${runId}\n`);
      return 2;
    }
    const body = { run: header, events: store.readEvents(runId), snapshot: store.read(runId) };
    const path = join(layout.archive, `${runId}.json`);
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ${path}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdDoctor(flags: Record<string, string | boolean>): Promise<number> {
  // Item 4: `doctor` never creates `.loopmill/` either — it must be safe to run as the very
  // first command in a fresh repository, reporting what is actually there (binaries, logins, the
  // env simulation for any committed loop file) without conjuring a store or worktrees directory
  // into existence just to look complete.
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  const home = resolveLoopmillHome({ repoRoot, env: process.env });
  const layout = layoutFor(home.home);
  const slug = resolveDefaultSlug(layout, repoRoot);

  let loop: ResolvedLoop | null = null;
  try {
    if (slug) {
      const loopPath = resolveLoopPath({ repoRoot, slug }, layout);
      ({ loop } = await loadLoop(loopPath));
    }
  } catch (err) {
    return printError(err);
  }

  const store = existsSync(layout.stateDb) ? openStore(layout.stateDb) : null;
  const doctorCtx: DoctorContext = { layout, store, loop };
  const close = (): void => {
    if (store) store.close();
  };

  try {
    const result = runDoctor({ ctx: doctorCtx, scheduler: flagBool(flags, "scheduler") });
    if (flagBool(flags, "json")) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      for (const c of result.checks) {
        process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.id}: ${c.detail}\n`);
      }
      if (result.scheduler) process.stdout.write("scheduler: not implemented in m1\n");
    }
    return result.ok ? 0 : 1;
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  try {
    const { positional, flags } = parseArgs(rest);
    switch (command) {
      case "validate":
        return await cmdValidate(positional);
      case "run":
        return await cmdRun(positional, flags);
      case "step":
        return await cmdStep(flags);
      case "approve":
        return await cmdGate("approve", positional, flags);
      case "reject":
        return await cmdGate("reject", positional, flags);
      case "cancel":
        return await cmdGate("cancel", positional, flags);
      case "resume":
        return await cmdResume(positional, flags);
      case "status":
        return await cmdStatus(positional, flags);
      case "runs":
        return await cmdRuns(flags);
      case "logs":
        return await cmdLogs(positional, flags);
      case "backends":
        return await cmdBackends(flags);
      case "rebuild-snapshot":
        return await cmdRebuildSnapshot(positional, flags);
      case "export":
        return await cmdExport(positional, flags);
      case "doctor":
        return await cmdDoctor(flags);
      default:
        process.stderr.write(`loopmill: cli_usage: unknown command "${command}"\n`);
        return 2;
    }
  } catch (err) {
    return printError(err);
  }
}
