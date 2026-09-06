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
  logsOf,
  listRunsView,
  openRunContext,
  printDryRun,
  resolveDryRunContext,
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
import type { Envelope, TriggerPayload } from "../types/envelope.ts";
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

const BOOL_FLAGS = new Set(["dry-run", "json", "last", "scheduler"]);

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
      "  approve <runId> [--reason <text>] [--actor <name>]",
      "  reject <runId> [--reason <text>] [--actor <name>]",
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
    const fakeScriptPath = flagString(flags, "fake-script");
    const dispatchers = fakeScriptPath
      ? defaultDispatchers({ layout: ctx.layout, fakeScript: loadFakeScript(isAbsolute(fakeScriptPath) ? fakeScriptPath : resolvePath(process.cwd(), fakeScriptPath)) })
      : defaultDispatchers({ layout: ctx.layout });

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

async function cmdGate(decision: "approve" | "reject", positional: string[], flags: Record<string, string | boolean>): Promise<number> {
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
    const result = await decideGate({
      ctx,
      runId,
      decision,
      actor: flagString(flags, "actor") ?? "operator",
      clock: ctx.clock,
      ...(reason !== undefined ? { note: reason } : {}),
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
  let ctx: RunContext;
  let which: string | "last";
  try {
    if (runIdArg) {
      ctx = await openContextForRun(repoRoot, process.env, realClock, runIdArg);
      which = runIdArg;
    } else {
      const home = resolveLoopmillHome({ repoRoot, env: process.env });
      const layout = await ensureLayout(home.home);
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
  // which node executions are "agent" ones needs each row's own resolved loop file.
  const home = resolveLoopmillHome({ repoRoot, env: process.env });
  const layout = await ensureLayout(home.home);
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
    ctx = await openContextForRun(repoRoot, process.env, realClock, runId);
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
        for (const a of v.attempts) {
          process.stdout.write(`  attempt ${a.attempt}: ${a.state}\n`);
          process.stdout.write(`    stdout: ${a.stdoutPath}\n`);
          process.stdout.write(`    stderr: ${a.stderrPath}\n`);
          if (a.stderrTail) process.stdout.write(`    stderr tail: ${a.stderrTail}\n`);
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
    ctx = await openContextForRun(repoRoot, process.env, realClock, runId);
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
  const layout = await ensureLayout(home.home);
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
  const repoRoot = resolveRepoRootArg(flagString(flags, "repo"));
  const home = resolveLoopmillHome({ repoRoot, env: process.env });
  const layout = await ensureLayout(home.home);
  const slug = resolveDefaultSlug(layout, repoRoot);

  let doctorCtx: DoctorContext;
  let close: () => void;
  if (slug) {
    const ctx = await openRunContext({ repoRoot, env: process.env, clock: realClock, slug });
    doctorCtx = ctx;
    close = () => ctx.close();
  } else {
    const store = openStore(layout.stateDb);
    doctorCtx = { layout, store, loop: null };
    close = () => store.close();
  }

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
