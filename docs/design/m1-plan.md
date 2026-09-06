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
| W2 | `engine/` | W0, `types/` from W1 | in progress |
| W3 | `backends/` (`fake`, then `local`), `driver/`, `cli/` | W1, W2 | `backends/` in progress alongside W2; `driver/` and `cli/` after both |
| W4 | the reference loop end to end on `fake` (A31); then, with the maintainer's go-ahead, a live run on the maintainer's machine that lands a PR (the m1 cut-line) | W3 | pending |

## 5. Acceptance criteria this milestone must meet

A1-A13 (`mvp-design.md` §20.3 A-B) in full; of C-E, the parts that do not need a scheduler: A14 (no-TTY spawn, already measured by SPIKE-1/4), A15 (key scrubbing), A16 (`--dry-run`), A18 (`unavailable` usage), A20 (worktree isolation), A21 (bootstrap), A22-A25 (loop semantics on `fake`), A28 (codex per-process usage), A29 (coverage rendering), A31 (the reference loop green on `fake` with no network). A17, A19, A26-A27 and A30 belong to m2 in full but their engine halves land here.
