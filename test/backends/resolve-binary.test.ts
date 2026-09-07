// Unit tests for `src/backends/local/resolve-binary.ts` -- the PATH resolver behind A16
// (mvp-design.md §20.3: "`--dry-run`... resolves every binary... to an absolute path").
// `test/backends/describe.test.ts` and `test/backends/binary-resolution.test.ts` cover the same
// contract through `LocalDispatcher`; this file pins the resolver's own rules in isolation, with
// no dispatcher, no worktree, and a synthetic PATH the test fully controls (never the real one),
// so none of it depends on what happens to be installed on the machine running the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { resolveBinary } from "../../src/backends/local/resolve-binary.ts";

function withStubDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "loopmill-resolve-binary-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeExecutable(path: string, mode = 0o755): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
}

test("resolveBinary: an already-absolute name is returned unchanged, found:true, with no PATH walk", () => {
  // No PATH at all -- if this resolved by searching, it would have nothing to search and would
  // have to report not-found; an absolute name is never searched for in the first place.
  const result = resolveBinary("/definitely/does/not/exist/claude", undefined);
  assert.deepEqual(result, { argv0: "/definitely/does/not/exist/claude", found: true });
});

test("resolveBinary: a name containing a path separator (relative, not bare) is returned unchanged, found:true", () => {
  assert.deepEqual(resolveBinary("./claude", "/usr/bin"), { argv0: "./claude", found: true });
  assert.deepEqual(resolveBinary("bin/claude", "/usr/bin"), { argv0: "bin/claude", found: true });
});

test("resolveBinary: a bare name resolves to the first PATH entry that has it, absolute and executable", () => {
  withStubDir((dir) => {
    writeExecutable(join(dir, "gh"));
    const result = resolveBinary("gh", dir);
    assert.equal(result.found, true);
    assert.equal(result.argv0, join(dir, "gh"));
  });
});

test("resolveBinary: PATH is searched left to right -- the first matching directory wins", () => {
  withStubDir((first) => {
    withStubDir((second) => {
      writeExecutable(join(first, "gh"));
      writeExecutable(join(second, "gh"));
      const result = resolveBinary("gh", [first, second].join(delimiter));
      assert.equal(result.argv0, join(first, "gh"), "the earlier PATH entry must win");
    });
  });
});

test("resolveBinary: a bare name nowhere on PATH resolves found:false, argv0 unchanged (the bare name)", () => {
  withStubDir((dir) => {
    writeExecutable(join(dir, "npm")); // present, but not what we ask for
    const result = resolveBinary("gh", dir);
    assert.deepEqual(result, { argv0: "gh", found: false });
  });
});

test("resolveBinary: an empty PATH resolves found:false rather than throwing", () => {
  assert.deepEqual(resolveBinary("gh", ""), { argv0: "gh", found: false });
  assert.deepEqual(resolveBinary("gh", undefined), { argv0: "gh", found: false });
});

test("resolveBinary: a same-named directory on PATH is not a match -- only a regular file counts", () => {
  withStubDir((dir) => {
    mkdirSync(join(dir, "gh")); // a directory named "gh", not a binary
    const result = resolveBinary("gh", dir);
    assert.equal(result.found, false, "a directory must never be reported as the resolved binary");
  });
});

test("resolveBinary: a present-but-not-executable file on PATH is skipped, not reported as resolved", () => {
  withStubDir((dir) => {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 0\n"); // default mode: no execute bit added
    chmodSync(join(dir, "gh"), 0o644);
    const result = resolveBinary("gh", dir);
    assert.equal(result.found, false);
  });
});

test("resolveBinary: an empty PATH element (leading/trailing/doubled ':') is skipped, never read as the current directory", () => {
  withStubDir((dir) => {
    writeExecutable(join(dir, "gh"));
    // POSIX shells treat an empty PATH component as ".", but execvp's own PATH search does not
    // -- and this resolver exists to predict execvp/spawn, not a shell (see the module's own doc
    // comment). `::dir:` has two empty components either side of the real one.
    const result = resolveBinary("gh", `${delimiter}${delimiter}${dir}${delimiter}`);
    assert.equal(result.found, true);
    assert.equal(result.argv0, join(dir, "gh"));
  });
});

test("resolveBinary: a symlink to an executable file resolves as found (fs.statSync follows links)", () => {
  withStubDir((dir) => {
    const real = join(dir, "real-gh");
    writeExecutable(real);
    const link = join(dir, "gh");
    symlinkSync(real, link);
    const result = resolveBinary("gh", dir);
    assert.equal(result.found, true);
    assert.equal(result.argv0, link, "argv0 is the PATH entry itself, not the symlink's target");
  });
});
