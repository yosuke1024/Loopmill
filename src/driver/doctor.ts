// `loopmill doctor` (m1 subset, mvp-design.md §15.2, §7.5): resolved binaries and versions,
// login state, the env deny/preserve simulation for the loop's own nodes, worktree health, and
// lock/lease state. Stable check ids, `--json`-able, exits non-zero on any failed check.
// `--scheduler` is m2 — accepted and reported as not implemented, never silently ignored.

import { accessSync, constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";

import { buildChildEnv } from "../backends/local/env.ts";
import { BUILTIN_ENV_DENY } from "../loop-file/index.ts";
import type { Layout, SqliteStore } from "../store/index.ts";
import type { ResolvedLoop } from "../types/loop.ts";

/** Deliberately narrower than the full `RunContext` (`context.ts`): `loopmill doctor`'s own CLI
 * surface (`mvp-design.md` §15.2) takes no loop/slug argument at all, unlike every other
 * `driver/` entrypoint, so `cli/main.ts` may have no single loop to resolve — a fresh repository
 * with no `.loopmill/*.loop.yaml` committed yet still has binaries, logins, a worktrees
 * directory and a lock table worth checking. `loop: null` skips only the per-node env
 * deny/preserve simulation (the one check that needs a loop's own nodes); every other check
 * still runs. Decision (not in sheet), m1. `store: null` — item 4, m1 follow-up: `doctor` must
 * never create `.loopmill/state.sqlite` just to run; a repository that has never had a real run
 * yet has no store to open, so the one check that reads it (`lock.state`) is skipped rather than
 * forcing one into existence. */
export interface DoctorContext {
  layout: Layout;
  store: SqliteStore | null;
  loop: ResolvedLoop | null;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
  scheduler: "not_implemented_in_m1" | null;
}

export interface DoctorBinaries {
  claude?: string;
  codex?: string;
  gh?: string;
  git?: string;
  node?: string;
}

export type DoctorExec = (bin: string, args: string[]) => { ok: boolean; stdout: string; stderr: string };

function defaultExec(bin: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString().trim() : "",
      stderr: (e.stderr ? e.stderr.toString().trim() : "") || e.message,
    };
  }
}

export interface RunDoctorOptions {
  ctx: DoctorContext;
  binaries?: DoctorBinaries;
  /** Injectable for tests — never spawns a real CLI when given (docs/design/m1-plan.md's own
   * instruction: "injectable binaries and exec for tests"). Defaults to `execFileSync`. */
  exec?: DoctorExec;
  scheduler?: boolean;
}

export function runDoctor(opts: RunDoctorOptions): DoctorResult {
  const { ctx } = opts;
  const exec = opts.exec ?? defaultExec;
  const bin = {
    claude: opts.binaries?.claude ?? "claude",
    codex: opts.binaries?.codex ?? "codex",
    gh: opts.binaries?.gh ?? "gh",
    git: opts.binaries?.git ?? "git",
    node: opts.binaries?.node ?? process.execPath,
  };

  const checks: DoctorCheck[] = [];

  // -- resolved binaries and versions -----------------------------------------------------
  for (const [name, versionArgs] of [
    ["claude", ["--version"]],
    ["codex", ["--version"]],
    ["gh", ["--version"]],
    ["git", ["--version"]],
    ["node", ["--version"]],
  ] as const) {
    const result = exec(bin[name], [...versionArgs]);
    checks.push({
      id: `binary.${name}`,
      ok: result.ok,
      detail: result.ok ? result.stdout.split("\n")[0]! : `not resolvable: ${result.stderr}`,
    });
  }

  // -- login state (read-only, quota-free) -------------------------------------------------
  const claudeLogin = exec(bin.claude, ["auth", "status", "--json"]);
  checks.push({ id: "login.claude", ok: claudeLogin.ok, detail: claudeLogin.ok ? claudeLogin.stdout : claudeLogin.stderr });

  const codexLogin = exec(bin.codex, ["login", "status"]);
  checks.push({ id: "login.codex", ok: codexLogin.ok, detail: codexLogin.ok ? codexLogin.stdout : codexLogin.stderr });

  const ghLogin = exec(bin.gh, ["auth", "status"]);
  checks.push({ id: "login.gh", ok: ghLogin.ok, detail: ghLogin.ok ? ghLogin.stdout : ghLogin.stderr });

  // -- env deny/preserve simulation, per node (A15) ----------------------------------------
  if (ctx.loop) {
    for (const node of Object.values(ctx.loop.nodes)) {
      if (node.kind !== "agent" && node.kind !== "command") continue;
      const { env, denied, injected } = buildChildEnv(process.env, ctx.loop.env, node);
      const leaked = BUILTIN_ENV_DENY.filter((name) => Object.prototype.hasOwnProperty.call(env, name));
      checks.push({
        id: `env.node.${node.id}`,
        ok: leaked.length === 0,
        detail:
          leaked.length === 0
            ? `denied: [${denied.join(", ")}], injected: [${injected.join(", ")}]`
            : `vendor-auth variable(s) leaked into the child env: ${leaked.join(", ")}`,
      });
    }
  }

  // -- worktree health ----------------------------------------------------------------------
  try {
    accessSync(ctx.layout.worktrees, fsConstants.W_OK);
    checks.push({ id: "worktree.health", ok: true, detail: `writable: ${ctx.layout.worktrees}` });
  } catch (err) {
    checks.push({ id: "worktree.health", ok: false, detail: `not writable: ${ctx.layout.worktrees} (${(err as Error).message})` });
  }

  // -- lock / lease state ---------------------------------------------------------------------
  if (ctx.loop && ctx.store) {
    const lock = ctx.store.readLock(ctx.loop.slug);
    checks.push({
      id: "lock.state",
      ok: true, // informational — a live lock is not itself a failure
      detail: lock ? `held by pid ${lock.ownerPid} on ${lock.host} until ${lock.leaseUntil} (run ${lock.runId})` : "no active lock",
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks, scheduler: opts.scheduler ? "not_implemented_in_m1" : null };
}
