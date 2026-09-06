import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureLayout, layoutFor, resolveLoopmillHome } from "../../src/store/layout.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "loopmill-layout-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resolveLoopmillHome: defaults to <repoRoot>/.loopmill when LOOPMILL_HOME is unset", async () => {
  await withTempDir(async (repoRoot) => {
    const resolved = resolveLoopmillHome({ repoRoot, env: {} });
    assert.equal(resolved.home, join(repoRoot, ".loopmill"));
    assert.equal(resolved.source, "repo");
  });
});

test("resolveLoopmillHome: LOOPMILL_HOME overrides the repo-relative default", async () => {
  await withTempDir(async (repoRoot) => {
    await withTempDir(async (override) => {
      const resolved = resolveLoopmillHome({ repoRoot, env: { LOOPMILL_HOME: override } });
      assert.equal(resolved.home, override);
      assert.equal(resolved.source, "LOOPMILL_HOME");
    });
  });
});

test("resolveLoopmillHome: an empty-string LOOPMILL_HOME is treated as unset", async () => {
  await withTempDir(async (repoRoot) => {
    const resolved = resolveLoopmillHome({ repoRoot, env: { LOOPMILL_HOME: "" } });
    assert.equal(resolved.home, join(repoRoot, ".loopmill"));
    assert.equal(resolved.source, "repo");
  });
});

test("layoutFor: every path is resolved under home", () => {
  const layout = layoutFor("/tmp/example/.loopmill");
  assert.equal(layout.home, "/tmp/example/.loopmill");
  assert.equal(layout.loopsDir, "/tmp/example/.loopmill");
  assert.equal(layout.stateDb, "/tmp/example/.loopmill/state.sqlite");
  assert.equal(layout.worktrees, "/tmp/example/.loopmill/worktrees");
  assert.equal(layout.reports, "/tmp/example/.loopmill/reports");
  assert.equal(layout.logs, "/tmp/example/.loopmill/logs");
  assert.equal(layout.archive, "/tmp/example/.loopmill/archive");
  assert.equal(layout.gitignore, "/tmp/example/.loopmill/.gitignore");
});

test("ensureLayout: creates every directory (worktrees, reports, logs, archive)", async () => {
  await withTempDir(async (repoRoot) => {
    const home = join(repoRoot, ".loopmill");
    const layout = await ensureLayout(home);
    for (const dir of [layout.home, layout.worktrees, layout.reports, layout.logs, layout.archive]) {
      const entries = await readdir(dir);
      assert.deepEqual(entries, entries, `${dir} exists and is readable`);
    }
  });
});

test("ensureLayout: writes .gitignore that ignores everything below except loop files and itself", async () => {
  await withTempDir(async (repoRoot) => {
    const home = join(repoRoot, ".loopmill");
    const layout = await ensureLayout(home);
    const contents = await readFile(layout.gitignore, "utf8");
    assert.match(contents, /^\*$/m, "a bare `*` ignores everything below");
    assert.match(contents, /^!\.gitignore$/m);
    assert.match(contents, /^!\*\.loop\.yaml$/m);
  });
});

test("ensureLayout: never rewrites an existing .gitignore", async () => {
  await withTempDir(async (repoRoot) => {
    const home = join(repoRoot, ".loopmill");
    const layout = layoutFor(home);
    await ensureLayout(home); // creates home/ so the hand-edited file below can live in it
    const handEdited = "# hand-edited by the operator\ncustom-rule\n";
    await writeFile(layout.gitignore, handEdited, "utf8");

    await ensureLayout(home); // must not clobber it on a second call

    const contents = await readFile(layout.gitignore, "utf8");
    assert.equal(contents, handEdited);
  });
});

test("ensureLayout: idempotent — calling it twice on a fresh home does not throw", async () => {
  await withTempDir(async (repoRoot) => {
    const home = join(repoRoot, ".loopmill");
    await ensureLayout(home);
    await assert.doesNotReject(() => ensureLayout(home));
  });
});

test("ensureLayout: returns the same layout layoutFor(home) would compute", async () => {
  await withTempDir(async (repoRoot) => {
    const home = join(repoRoot, ".loopmill");
    const returned = await ensureLayout(home);
    assert.deepEqual(returned, layoutFor(home));
  });
});
