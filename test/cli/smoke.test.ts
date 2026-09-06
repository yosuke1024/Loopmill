// CLI smoke tests (docs/design/mvp-design.md §15.2): `bin/loopmill.js validate` exits 0 on the
// real reference loop, `backends --json` lists all four backend records, `status --last` after
// an end-to-end `fake` run prints the state, and `doctor --json` (driven at the `driver/` level,
// with injected stub binaries/exec so no real CLI is ever spawned) reports stable check ids.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cp } from "node:fs/promises";

import { runDoctor, type DoctorContext } from "../../src/driver/index.ts";
import { ensureLayout, openStore, resolveLoopmillHome } from "../../src/store/index.ts";
import { EXIT_CODES_LOOP_PATH, SUCCESS_SCRIPT_PATH, makeScratchRepo } from "../fixtures/driver/helpers.ts";

const SUCCESS_SCRIPT = SUCCESS_SCRIPT_PATH;

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BIN = join(REPO_ROOT, "bin", "loopmill.js");
const EXAMPLE_LOOP = join(REPO_ROOT, "examples", "daily-content-improvement.loop.yaml");

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function captureMain(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { main } = await import("../../src/cli/main.ts");
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    const exitCode = await main(argv);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("cli smoke: bin/loopmill.js validate examples/daily-content-improvement.loop.yaml exits 0", () => {
  const result = runCli(["validate", EXAMPLE_LOOP]);
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /valid/);
});

test("cli smoke: --version and help exit 0", () => {
  assert.equal(runCli(["--version"]).code, 0);
  assert.equal(runCli(["help"]).code, 0);
});

test("cli smoke: backends --json lists four records", async () => {
  const { exitCode, stdout } = await captureMain(["backends", "--json"]);
  assert.equal(exitCode, 0);
  const records = JSON.parse(stdout) as Array<{ id: string }>;
  assert.equal(records.length, 4);
  const ids = records.map((r) => r.id).sort();
  assert.deepEqual(ids, ["control-plane", "fake", "github-actions", "local"]);
});

test("cli smoke: run --fake-script (no gate) then status --last / status <runId> report SUCCEEDED", async () => {
  // Decision (not in sheet), m1: `approve`/`reject`'s own CLI surface
  // (`loopmill approve|reject <runId> [--reason] [--actor]`) has no `--fake-script` flag — a
  // real gate is always continued against the real `local` backend, so this smoke test's
  // round trip through the CLI alone uses a gate-free loop (`exit-codes.loop.yaml`, `fake`
  // backend); the fake-then-approve continuation is covered driver-level, exhaustively, by
  // `test/driver/e2e-fake.test.ts`.
  const repo = await makeScratchRepo();
  try {
    // Committed at `.loopmill/<slug>.loop.yaml` (mvp-design.md §9.1), so `run <slug>` and the
    // later `status <runId>` — which resolves its loop by the run's own stored `loopId`, never
    // a path the operator typed once and never repeats — agree on where to find it.
    const home = resolveLoopmillHome({ repoRoot: repo.repoRoot, env: {} });
    const layout = await ensureLayout(home.home);
    await cp(EXIT_CODES_LOOP_PATH, join(layout.loopsDir, "exit-codes.loop.yaml"));

    const runOut = await captureMain(["run", "exit-codes", "--repo", repo.repoRoot, "--fake-script", SUCCESS_SCRIPT, "--json"]);
    assert.equal(runOut.exitCode, 0, `stderr: ${runOut.stderr}`);
    const runPayload = JSON.parse(runOut.stdout) as { runId: string; state: string };
    assert.equal(runPayload.state, "SUCCEEDED");

    const statusOut = await captureMain(["status", "--last", "--repo", repo.repoRoot]);
    assert.equal(statusOut.exitCode, 0, `stderr: ${statusOut.stderr}`);
    assert.match(statusOut.stdout, /SUCCEEDED/);

    const statusJsonOut = await captureMain(["status", runPayload.runId, "--repo", repo.repoRoot, "--json"]);
    assert.equal(statusJsonOut.exitCode, 0);
    const statusPayload = JSON.parse(statusJsonOut.stdout) as { state: string; runId: string };
    assert.equal(statusPayload.state, "SUCCEEDED");
    assert.equal(statusPayload.runId, runPayload.runId);
  } finally {
    await repo.cleanup();
  }
});

test("cli smoke: doctor --json (driven at driver level with injected binaries/exec) reports stable check ids", async () => {
  const repo = await makeScratchRepo();
  try {
    const home = resolveLoopmillHome({ repoRoot: repo.repoRoot, env: {} });
    const layout = await ensureLayout(home.home);
    const store = openStore(layout.stateDb);
    try {
      const ctx: DoctorContext = { layout, store, loop: null };
      const exec = (bin: string, args: string[]): { ok: boolean; stdout: string; stderr: string } => ({
        ok: true,
        stdout: `${bin} ${args.join(" ")} stub-version`,
        stderr: "",
      });
      const result = runDoctor({ ctx, exec, binaries: { claude: "claude-stub", codex: "codex-stub", gh: "gh-stub", git: "git-stub" } });
      assert.equal(result.ok, true);
      const ids = result.checks.map((c) => c.id).sort();
      assert.deepEqual(ids, [
        "binary.claude",
        "binary.codex",
        "binary.gh",
        "binary.git",
        "binary.node",
        "login.claude",
        "login.codex",
        "login.gh",
        "worktree.health",
      ]);
    } finally {
      store.close();
    }
  } finally {
    await repo.cleanup();
  }
});
