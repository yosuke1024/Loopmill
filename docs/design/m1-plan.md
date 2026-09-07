# m1 plan — local execution core

**Status:** in progress, started 2026-09-06 against the contracts frozen in `m0-contract-freeze.md`.
This file is the working map for m1 (`mvp-design.md` §20.2): what is being built, in which order, by
which conventions, and where each piece stands. It is updated as work lands; it is not a contract.

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **TypeScript, strict, ESM**, run directly by Node's type stripping (`erasableSyntaxOnly`, `.ts` import specifiers); `tsc --noEmit` type-checks, `tsc -p tsconfig.build.json` emits `dist/` for the package | The design's interfaces are already TypeScript; no build step is needed to run or test; the package ships compiled JS in m3 |
| 2 | **Node ≥ 22.18** | `node:sqlite` (22.13+) and default type stripping (22.18+) |
| 3 | **`node --test`** for every test; no test framework | zero dependencies, runs `.ts` directly, subtests and snapshots are enough |
| 4 | **Dependencies:** `yaml`, `ajv`, `ajv-formats`. Nothing else at runtime | YAML 1.2 and JSON Schema 2020-12 are not worth hand-rolling; everything else in the design (ULIDs, canonical JSON, SQLite, subprocesses, git) is in Node |
| 5 | **The schemas are read from `docs/spec/` at run time** (`loop-file.schema.json`, `envelope.schema.json`, `state-machine.json`), which the package includes in `files` | one copy of each frozen artefact; a test would otherwise have to prove two copies equal |
| 6 | **Every test is offline** — no network, no `claude`, no `codex`, no tokens. Anything that must touch a real CLI or GitHub is an *integration* test under `test/live/`, skipped unless `LOOPMILL_LIVE=1`, and run only with the maintainer's go-ahead | A31, and the quota rule of `CLAUDE.md` |
| 7 | **The work stays on `claude/loopmill-mvp-design-feul8d`** until the maintainer decides how to land it on `main` | `main` carries only the spike workflows; the design and the code belong together for now |

## 2. Module map (`src/`)

| Module | Responsibility | Normative source | Tests |
|---|---|---|---|
| `types/` | The shared TypeScript types: `LoopFile` / `ResolvedLoop`, `Envelope` and its payloads, `RunSnapshot` and the state enums, `Outcome`, `Action`, `TransitionResult`, `StaleReason`, `Classification`, `Usage` / `UsageRecord`, `BackendCapabilities`, `StateStore`, `Dispatcher`. **No logic.** | `loop-file.schema.json`, `envelope.schema.json`, `state-machine.md` §2, §5, §7.1, §8.2, §10.1, `usage-normalization.md` §1, `mvp-design.md` §6.1, §7.6 | type-checked by every other module |
| `util/` | canonical JSON, sha256, ULID (random and the deterministic form of D-16), RFC 3339, ISO-8601 durations, the credential backstop and persistence-time redaction, `LoopmillError` | `state-machine.md` §5.2 (P-2, D-16), `envelope.md` §7.6, TV-5, `mvp-design.md` §13.4 | unit |
| `loop-file/` | load YAML, validate against the schema, the semantic rules `LM-VAL-001`-`LM-VAL-029`, canonicalisation and `loopVersion`, defaults → `ResolvedLoop`, the reference grammar, `${name}` templating with the argv rule, the condition-expression parser and evaluator | `loop-file.md` (all), `docs/spec/validate-examples.mjs` (the reference implementation of the rules) | `examples/`, `docs/spec/examples/`, one negative fixture per `LM-VAL` code |
| `envelope/` | schema validation, producer policy, `eventId` derivation, canonical wire form and the size rule, the credential backstop | `envelope.md` §3-§7, §11, §13 | `docs/spec/envelope-examples/`, TV-1-TV-7 |
| `usage/` | per-runtime normalisation (`claude-code`: `modelUsage` basis; `codex`: per-process `turn.completed`), aggregation, coverage, the `+` rendering rules | `usage-normalization.md` (all) | every file under `docs/spec/usage-fixtures/` |
| `engine/` | the pure `transition(snapshot, event, ctx)`; `classifyFailure` with its pattern table; `fold(events)`; `preDispatch` budget checks; condition evaluation; the stale test | `state-machine.md` (all), `state-machine.json` | the worked traces 13.1-13.6, invariants I-01-I-30, one test per transition-table row |
| `store/` | the SQLite store (`runs`, `events`, `snapshots`, `attempts`, `locks`), one transaction per applied event, the lock row with heartbeat and lease, the sweep, `rebuild-snapshot`, the `.loopmill/` layout and its `.gitignore` | `mvp-design.md` §7.5, §9; `state-machine.md` §10, D-29, D-30 | A4, A8, A10, A11, A35 at store level |
| `backends/` | the capability records; `fake` (fixture replay); `local` (git worktree, environment policy, spawn with stdin from `/dev/null`, timeout and cancel, stream capture with redaction, the `claude-code` and `codex` adapters, structured-output re-validation, `command` nodes with `shell: false`) | `mvp-design.md` §6, §7.2, §11, §13, §18; `state-machine.md` §7; the recorded fixtures | `fake` end to end; `local` against stub CLIs on `PATH` |
| `driver/` | `run`, `step`, `resume` (m2), the sweep at every entrypoint, `--dry-run`, exit codes | `mvp-design.md` §7; `state-machine.md` §12 | A10-A13, A16 with `fake` |
| `cli/` | `loopmill validate | run | step | status | runs | logs | backends | rebuild-snapshot | doctor` (m1 subset) | `mvp-design.md` §15.2 | smoke tests on the `fake` reference loop |

## 3. Conventions

- **Imports carry `.ts` extensions**; no default exports; functions and interfaces, classes only where a resource needs a lifecycle (the store).
- **Pure modules take `now` as a parameter** (`engine`, `usage`, `loop-file`); only `driver`, `store` and `backends` read the clock or touch I/O.
- **Canonical JSON** (`util/canonical-json.ts`: recursively key-sorted, 2-space indent, trailing newline) is the serialisation for every snapshot, envelope and digest.
- **Errors** are `LoopmillError` with a stable `code` and the exit code the CLI maps it to; user-facing messages name the file, node and rule.
- **Redaction happens at the persistence boundary** (`util/redact.ts`): captured streams, envelopes and reports pass through it before they touch `.loopmill/`.
- **Fixtures**: the spec's own files under `docs/spec/` are the primary fixtures and are never copied; module-specific fixtures live under `test/fixtures/<module>/`.
- **Tests** mirror `src/`: `test/<module>/<file>.test.ts`; subtests name the rule or invariant they assert (`LM-VAL-007`, `I-06`, `TV-4`).

## 4. Waves and status

| Wave | Contents | Depends on | Status |
|---|---|---|---|
| W0 | skeleton (`package.json`, `tsconfig`, `bin/`), `types/`, `util/`, this plan | — | done 2026-09-06 (67 tests) |
| W1 | `loop-file/`, `envelope/`, `usage/`, `store/` — four independent modules | W0 | done 2026-09-06 (362 tests in total; envelope schema amended to 1.1.0 for `outcome`; the store is synchronous by design) |
| W2 | `engine/` | W0, `types/` from W1 | done 2026-09-07 (177 tests; four spec amendments recorded in the freeze log) |
| W3 | `backends/` (`fake`, then `local`), `driver/`, `cli/` | W1, W2 | done 2026-09-07 (615 tests in total); a follow-up fixes the defects a manual run exposed |
| W4 | the reference loop end to end on `fake` (A31); then, with the maintainer's go-ahead, a live run on the maintainer's machine that lands a PR (the m1 cut-line) | W3 | **done 2026-09-07.** A31 green in `test/driver/e2e-fake.test.ts`; the live run landed [PR #2](https://github.com/yosuke1024/Loopmill/pull/2) — see section 6 |

## 5. Acceptance criteria this milestone must meet

A1-A13 (`mvp-design.md` §20.3 A-B) in full; of C-E, the parts that do not need a scheduler: A14 (no-TTY spawn, already measured by SPIKE-1/4), A15 (key scrubbing), A16 (`--dry-run`), A18 (`unavailable` usage), A20 (worktree isolation), A21 (bootstrap), A22-A25 (loop semantics on `fake`), A28 (codex per-process usage), A29 (coverage rendering), A31 (the reference loop green on `fake` with no network). A17, A19, A26-A27 and A30 belong to m2 in full but their engine halves land here.

### 5.1 Audit, 2026-09-08

All 31 of the above were audited against the code, the tests and the two real runs, one criterion at
a time, each verdict required to cite a test by name and file, a command and its output, or a code
path. Every shortfall was then given to a second, adversarial pass told to refute it. **21 met, 8
partial, 2 not met.** All eight shortfalls that were adversarially re-checked were upheld; A19 and
A26 hit the re-check cap and carry a first-pass verdict only.

Met, with evidence recorded in the audit: A1, A2, A5, A6, A7, A8, A9, A10, A14, A15, A18, A20, A21,
A22, A23, A24, A28, A29, and the engine halves of A17, A27 and A30.

| # | Verdict | What is missing |
|---|---|---|
| A3 | not met | The criterion names its own proof shape: purity "proven by a property test". No property test exists. I-12 in `test/engine/invariants.test.ts` is a `todo` stub with an empty body whose comment says purity is "asserted by construction", which is code review, not a test |
| A25 | not met | The published finding schema does not exist at all. The review verdict is `{approved, reasons}` with `reasons` as prose; A25 asks for per-finding path, line, severity, suggested change and a stable id, the verdict bound to the commit SHA it judged, and the next cycle recording which finding ids it addressed. This is an absence, not a partial implementation |
| A4 | partial | `rebuild-snapshot` is verified for a handful of driven scenarios, not for "every run in the fixture corpus" — no such enumerated corpus of committed run journals exists. Four of the six §13 worked traces are checked only through the engine's in-memory `drive()`/`fold` identity, never through the real store |
| A11 | partial | The m1 half holds when probed by hand, but nothing in the suite exercises `driver/sweep.ts`'s `runSweep()` or drives a killed process to an `INTERRUPTED` report, so a regression would not be caught. The `resume --due` half is m2 by design |
| A12 | partial | Exit 23 (`INTERRUPTED`) and exit 4 (backend dispatch failed) have reachable code paths and no test; `step`'s own `applyStep` declares 4 in its return type but no branch returns it |
| A13 | partial | The mechanism works and is tested, but `mvp-design.md` §20.3 and §8.3 call the outcome `FAILED(step_cap_exceeded)` while the frozen `state-machine.md` (D-28, §11.2 step 6) and the code both produce `BUDGET_EXCEEDED(maxStepsPerRun)`. The string `step_cap_exceeded` exists nowhere outside `mvp-design.md`. The design document contradicts the frozen contract, so the document is what is wrong |
| A16 | partial | Everything except one clause: the graph is validated, `cwd` is absolute, the argv and post-scrub environment are printed and no tokens are spent, but `argv[0]` stays the bare binary name. "Resolves every binary to an absolute path" is not implemented |
| A31 | partial | The reference loop is green offline with no network and no tokens, but not "in CI": `.github/workflows/` holds only the two pre-m1 spike harnesses, and nothing re-runs the suite on push or pull request |
| A19 engine half | partial | The denial mechanism is unit-tested at argv level only. The criterion asks for a planted instruction inside reviewed content to cause no `gh` or `git push` invocation, "as a passing red-team test, not a manual check". No such test exists |
| A26 engine half | partial | The digest check is mode-agnostic and tested, but "in all three modes" is a claim about the shipped system, and only `cli` has a producer. Nothing mints a `human-decided` event from a label or a pull request review; that is the m2 ingestion |

Two of these need a decision before they can be worked, and are not the implementer's to make: A25
(whether the finding schema is m1 scope or moves to m2 alongside the retry-feedback problem section 6
records) and the commit-granularity contradiction section 6 records. The other eight have no
alternatives to weigh.

---

## 6. The first live run (the m1 cut-line)

**Target.** `.loopmill/readme-freshness.loop.yaml`, written for this milestone: Codex (read-only)
checks `README.md` against the repository it describes, Claude Code fixes exactly the statements
that have gone stale, `npm ci` and `npm test` run in the Run's own worktree, Codex reviews the
committed diff, a human gate (`mode: cli`) stands in front of the two external effects, and `git
push` + `gh pr create` open a pull request into `claude/loopmill-mvp-design-feul8d`. It never
merges. The reference loop under `examples/` was not used: it is content-site oriented, and its
`mode: label` gate needs the GitHub ingestion that lands in m2.

**Result.** `SUCCEEDED`, exit 0, one cycle, 649,485 measured tokens, usage coverage 3/3 (100%),
159 s active plus 59 s waiting on the human.
[PR #2](https://github.com/yosuke1024/Loopmill/pull/2) from
`loopmill/readme-freshness/run_01M1YFH5GTHRT9N1WZCC1SMD72`, merged by the maintainer into
`claude/loopmill-mvp-design-feul8d` on 2026-09-08 as `4a2fbea`. The Codex reviewer approved the diff on
its own evidence, and the operator checked both corrected statements against the repository before
approving the gate.

**What it cost to get there.** A dry run, an adversarial pre-flight over the loop and the code path
it takes, and one failed live run found five defects, none of which the 619 tests then in the suite
covered. Every one of them would have shipped:

| # | Defect | How it was found | Fix |
|---|---|---|---|
| 1 | `claude --json-schema` takes the schema's JSON text **inline**; the executor was handing it a temp-file path, so no `structuredOutput` node would ever have been validated | pre-flight, against `claude --help` 2.1.263 — and this repository's own SPIKE-1 check C3 had already measured the inline form | `buildClaudeArgv` takes the schema text; the temp file is codex-only (`--output-schema <FILE>` genuinely wants a path) |
| 2 | `--disallowedTools` is variadic, so emitting it twice risked the second occurrence replacing the first and silently dropping the `Bash(gh *)` denial | dry run | one occurrence, two values |
| 3 | A `command` node failing under `onFailure: continue` lost its exit code: the engine replaced the whole Node Execution record with a synthetic one, so a downstream condition reading `nodes.<id>.exitCode` ended the Run `FAILED(condition_error)`. This is the pattern the reference loop itself is built on | pre-flight | the failed record is kept and relabelled `SKIPPED`; terminal failures also keep the attempt's own `error` and `exitCode` |
| 4 | `claude` cannot find its subscription login without `USER` in its environment, and the built-in preserve list did not carry it | **the first live run failed on it** — Codex succeeded, Claude Code returned `Not logged in · Please run /login` in 165 ms | amendment: `USER` added to the preserve list (`m0-contract-freeze.md` §6, 2026-09-07) |
| 5 | No transition ever wrote `snapshot.artifactRefs`, so `run-finished` carried an empty list and the run report said "Artifacts (none)" for a Run that had just produced a commit, a branch and a pull request | **the successful live run's own report** | node completions accumulate their durable (non-`file`) artifactRefs onto the Run, per `state-machine.md` §8 |

Two more the pre-flight found and this milestone accepted rather than fixed: a `verify` failure and a
`review` rejection share one retry edge (so a red suite spends a cycle on the implementer), and
`budget.maxAttempts` is loop-wide, so the only way to stop an automatic redispatch of a
non-idempotent `gh pr create` is to set it to 1 for the whole loop — which this loop does, and
documents.

**Confirmed against the real CLIs.** The permission-profile mapping this milestone was briefed with
is now measured, not assumed: `workspace` → `--permission-mode acceptEdits` + one variadic
`--disallowedTools "Bash(gh *)" "Bash(git push *)"` + `--permission-prompts none` lets the agent read
and edit inside the worktree with no permission denials, and `readonly` → `codex exec -s read-only`
lets the reviewer read the tree and run `git diff`. `--permission-prompts none` also denies the
`Bash` tool outright under `acceptEdits`, which is stricter than `mvp-design.md` §13.1's wording and
deliberately left that way.

**Still open after this run.**

- No `pr` or `branch` `artifactRef` is ever created. `gh pr create` prints the pull request URL on
  stdout and the command node captures it in `result.structured.stdout`, but a `command` node is
  opaque to the backend by design, so nothing turns that URL into an artifact. Belongs with the
  GitHub ingestion in m2.
- The driver commits after **every** successful `local` node, not once per cycle as `mvp-design.md`
  §18 says. It coincides for this loop (only `implement` touches tracked files) and for the
  reference loop, but the two statements are not the same rule.
- A retry cannot see why the reviewer refused: `review` does not dominate `implement`, so
  `nodes.review.structured.reasons` is not a legal input of the node being retried. The only
  signals a second cycle gets are `cycle.index` and the engine's NO_PROGRESS hint.
- `loopmill rebuild-snapshot` reports a mismatch for both runs recorded on 2026-09-07: their stored
  snapshots were written by the engine as it stood before defects 3 and 5 were fixed. That is the
  tool working, not failing.
- **Both** runs left a worktree and a local branch behind, not only the failed one:
  `.loopmill/worktrees/run_01M1YF4RKPTT6HGYW9J2X4SSH2` (3.2 MB) and
  `.loopmill/worktrees/run_01M1YFH5GTHRT9N1WZCC1SMD72` (40 MB, most of it the `node_modules/` the
  `install` node created), plus their two `loopmill/readme-freshness/<runId>` branches. On the
  remote there is nothing left: the successful run's branch went with the pull request merge, and
  the failed run never pushed one. Nothing collects any of this locally yet; `gc` is m3.

