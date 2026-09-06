# m0 contract freeze — 2026-09-06

**Status:** recorded 2026-09-06, at the end of milestone m0 (`docs/design/mvp-design.md` §20.2), on
branch `claude/loopmill-mvp-design-feul8d`. The five decisions in section 4 were confirmed by the
maintainer the same day; everything below is frozen as written, and m1 may start against it.

**Why this file exists.** m0's cut-line reads "contracts frozen; nothing in m1 starts before they are
written down". This is the writing-down: which documents are the contracts, at which version, backed
by which evidence, with which residuals, and how they may change from here on. It is a record, not a
new source of truth — every normative statement stays in the file it names.

---

## 1. What "frozen" means

- **m1 code is written against the versions in section 2.** The validators, fixtures, test vectors and
  invariants those documents name are the contract tests m1 must carry from its first commit.
- **A frozen contract changes only by amendment.** An amendment is one change set that (a) edits the
  normative source and marks the change `Decision (not in sheet)` or, for a reversal of a frozen
  point, `Amendment (m0+)`; (b) updates the fixture, example, schema or test vector that would
  otherwise contradict it; (c) adds a dated line to section 6 of this file. Version rules: the loop
  file's `schemaVersion` follows `loop-file.md` (additive → minor); the Envelope's `schemaVersion`
  follows `envelope.md` §12; `state-machine.json` bumps `schemaVersion` when a table changes.
- **Editorial changes are not amendments** — wording, cross-references, typos, a clarifying sentence
  that changes no rule. They need no entry here.
- **Not frozen:** the post-MVP row of §20.2; the reserved surfaces (`github-actions`, `observed`,
  `WAITING_OBSERVED`, `OBSERVING`, `repository_dispatch`, `signature`) — kept in the enums, rejected
  by validation, changeable without amendment as long as they stay unreachable; the read-only UI
  (§15.3); notifications (§17.3); the unmeasured scheduler cases named in 2.7.

---

## 2. The frozen contracts

| # | Contract | Normative source, at the frozen version | Evidence | Residuals (known, not blocking) |
|---|---|---|---|---|
| 2.1 | **Provider contract** — how a runtime adapter invokes a CLI, reads its result, classifies failure and quota, and what it may assume about authentication | `mvp-design.md` §6.3-6.5, §13.2, §14.2; `state-machine.md` §7 (result evaluation, D-15; quota tables 7.3-7.4, D-05-D-07); `usage-normalization.md` §2.1-2.2, §2.5 | SPIKE-1 (claude-code 2.1.263: hosted run 34024962852, and locally as SPIKE-4 D10); SPIKE-4 D1-D8 (codex 0.153.4); recorded fixtures `claude-recorded-*.json`, `codex-recorded-*.json` | The quota **refusal** shape is unobserved for both runtimes (`[U]`, `state-machine.md` §7.3); A17 is met with hand-written fixtures until a refusal is recorded. The codex app-server transport is not used. The tested version ranges (m1 sets them) start at claude-code 2.1.263 and codex 0.153.4 |
| 2.2 | **Loop-file schema** | `loop-file.md` Version 0.6 (2026-09-06); `loop-file.schema.json` `$id` `https://loopmill.dev/schema/loop-file/0.6.json`, `schemaVersion` 0.6.x; validation codes `LM-VAL-001`-`LM-VAL-029` (020 retired); §16 decision index (17 rows) | `validate-examples.mjs`: 2 files, `RESULT: pass` (2026-09-06, ajv 8 borrowed) | `trigger.kind: event` and `backend: github-actions` are reserved ids, rejected by validation, not by the schema |
| 2.3 | **Envelope** (the journal record) | `envelope.md` schema version **1.0.0** (2026-09-06); `envelope.schema.json`; test vectors TV-1-TV-7; 13 inline decisions | `validate-envelopes.mjs`: 19 checked, 0 problems, 17/17 event types (2026-09-06); SPIKE-3 (size and CAS properties, reserved transport) | `envelope.md` §14: dispatch permission scopes of the reserved integration unconfirmed; the comment-body limit is a soft number; `signature` reserved. None affects the MVP |
| 2.4 | **State machines** (Run, Node Execution, Attempt), events, guards | `state-machine.md` (decisions D-01-D-30, invariants I-01-I-30, worked traces 13.1-13.6); `state-machine.json` `schemaVersion` 1.0.0, `specVersion` v0.6 | SPIKE-3 (21/21 local, 44 hosted runs: CAS, duplicates, concurrency, interruption); the fixture traces | `WAITING_OBSERVED` / `OBSERVING` stay in the enums as reserved and unreachable (D-21, D-27) |
| 2.5 | **Usage record**, coverage and budget | `usage-normalization.md` §1 (`Usage`, `UsageRecord`), §2 (per-runtime mapping; codex is **per process**, SPIKE-4 D4), §3-§6, invariants I1-I18, decision index §10 (17 + 1 reconciliation); 19 fixtures under `docs/spec/usage-fixtures/` each naming the invariants it asserts | SPIKE-1 C2/C5a/C6 recordings; SPIKE-4 D1-D8 recordings; `spikes/spike-4-codex-cli/test` 7/7 | `estimated` exists only through the `fake` backend (no estimator ships); the weighted view's profile is a display choice |
| 2.6 | **Terminal semantics** — exit codes and cancellation | `mvp-design.md` §7.3, `state-machine.md` §12 (D-17: `run` 0 / 10-15 / 20-23, `step` 0-4, node executor 0 when it reported); cancellation per runtime: claude-code SIGINT keeps a result (`aborted_streaming`, exit 0, partial usage), SIGTERM exits 143 with none; codex SIGINT exits 1 and SIGTERM exits **0**, neither with `turn.completed` — a terminal event, never the exit code, decides completion | SPIKE-1 C6 (hosted and local); SPIKE-4 D3, D5; `claude-recorded-sigint.json`, `claude-killed.json`, `codex-recorded-sigint.json`, `codex-recorded-sigterm.json` | none |
| 2.7 | **Execution host contract** — one user-managed host, non-resident driver, SQLite journal, OS scheduler | ADR-002 D1, D2, D3, D6, D9; `mvp-design.md` §7.1-7.6, §9, §13.1; the subprocess gets stdin from `/dev/null` (§7.2); the scheduler unit carries `PATH` or absolute argv (§7.5) | SPIKE-3 (the transition/journal/concurrency properties, carried onto SQLite per ADR-002 Appendix B); SPIKE-4 D9: a `launchd` user agent on a locked screen reached both CLIs' logins and `gh`, 3/3 fires (macOS 26.5) | Unmeasured, documented as preparation steps in §7.5: a `LaunchDaemon` with no login session; `systemd --user` on Linux. Four of the five decisions in section 4 belong here |
| 2.8 | **Credential assumptions** | ADR-002 D5; `mvp-design.md` §6.4 (modes), §6.5 (`api-key` opt-in), §13.2 (deny / preserve / inject — mandatory), §13.4 (redaction), §19 (the verbatim vendor texts, R11) | SPIKE-1 C8 (an inherited `ANTHROPIC_API_KEY` silently replaces the login: the deny list is load-bearing); SPIKE-4 D0/D9 (on macOS every login is a keychain item; `codex` with `cli_auth_credentials_store = "keyring"` has no `auth.json`); R11 (OpenAI Terms of Use 2026-01-01, Usage Policies 2025-10-29, the Codex CI/CD-auth and Scheduled-tasks pages) | The interpretive residual of §19.1 (the "programmatically extract data or Output" clause; OpenAI's stated preference for API keys in automation) is the maintainer's to confirm before any public launch (§19.2 rule 4). OpenAI's docs require the file credential store before any headless use of `auth.json`; Loopmill ships no feature for that and only documents it |

The differentiator and scope statements that depend on these contracts stand as written in
`mvp-design.md` §2 and §20.1: `local` + `claude-code` + `subscription-oauth` is the baseline,
`local` + `codex` + `subscription-login` is verified, `fake` and `control-plane` ship, `api-key` is
opt-in, `github-actions` is reserved.

---

## 3. STOP conditions, evaluated in writing

`mvp-design.md` §22 requires each STOP condition to be evaluated in writing at the end of m0, with
the evidence attached.

- **(a) No supported AI CLI can execute unattended on a user-managed host under subscription
  authentication — not triggered.** Claude Code: measured headless on a hosted runner with an OAuth
  token only (SPIKE-1, run 34024962852, 2.1.263) and reproduced on the maintainer's macOS host
  (SPIKE-4 D10, C1-C4, C6, C7). Codex: `codex exec` ran on the same host under its ChatGPT login only
  (SPIKE-4 D1-D7, 0.153.4). Scheduler-started: a `launchd` user agent on a locked screen ran both CLIs
  under their own logins (SPIKE-4 D9, three fires). Two cases stay unmeasured — a Mac with nobody
  logged in, and Linux — and they decide preparation steps, not this condition.
- **(b) No cross-vendor path exists under subscriptions, and the only working shape is GitHub Actions
  plus API keys — retired** (ADR-002 D10): it was a statement about hosted runners, and both CLIs now
  run under subscriptions on the host.
- **(c) Vendor terms, read verbatim, forbid the single-user unattended use Loopmill relies on — not
  triggered on the text read** (R11, 2026-09-06, `mvp-design.md` §19.1 and §22). Anthropic's position
  is documented and quoted; OpenAI's Terms of Use, Usage Policies, CI/CD-auth page and Scheduled-tasks
  page were read in full and quoted with access times. The residual is interpretive and is recorded for
  the maintainer to confirm before launch.

**Conclusion:** the MVP proceeds as designed in v0.6.

---

## 4. Decisions awaiting the maintainer's confirmation

These five are design choices the documents already state, which the maintainer had flagged as
needing their explicit yes. **All five were confirmed by the maintainer on 2026-09-06**; they are frozen
as written, and reversing one later is an amendment (section 1).

| # | Decision, as frozen | Where | Why the design chose it | If reversed |
|---|---|---|---|---|
| 4.1 | **SQLite is the source of truth**: `<repo>/.loopmill/state.sqlite` (WAL, `node:sqlite`), tables `runs` / `events` / `snapshots` / `attempts` / `locks`; `export` writes JSON; a git-branch mirror is post-MVP | ADR-002 D3; `mvp-design.md` §9 | One host has a filesystem, and the lock needs a transaction; a SQLite transaction gives the atomicity that compare-and-swap gave two GitHub jobs. Plain JSON files would need a separate lock protocol | Re-prove A4, A8, A10, A11 and A35 on the replacement; the sweep and lease design (§7.5) is rewritten around it |
| 4.2 | **`.loopmill/` lives inside the repository**: loop files committed, everything else ignored through a `.loopmill/.gitignore` Loopmill writes; `LOOPMILL_HOME` overrides the location | `mvp-design.md` §9.1 | One place per repository, discoverable by `loopmill` from the checkout, portable with the repo; worktrees and logs stay next to the store they belong to | Loop definitions need a new committed home and `run <slug>` a new lookup rule; `gc` and worktree paths move; nothing in the journal changes |
| 4.3 | **Human gates have a `cli` mode and a `target`**: `loopmill approve|reject <runId>` on the host alongside `label` and `pull-request-review`; `target` names the node whose Issue or PR carries the label or review, defaulting to the Run's most recent one | `mvp-design.md` §12; `loop-file.md` (`human.target`, added in 0.6.0); `state-machine.md` D-01-D-03 | A non-resident local driver has no job for GitHub to hold, so a local decision path is needed for dogfooding without a browser; `target` makes the GitHub modes unambiguous once a Run has produced more than one artefact | A26 narrows to two modes; the reference loop's gate keeps `label`; `target` can stay as a no-op default |
| 4.4 | **A second `run` of the same loop while a lock row is live finishes `SKIPPED(overlapping_run)`, exit 15**, and touches nothing | `mvp-design.md` §7.5, §7.3; `state-machine.md` D-17, D-18; A10 | The driver is non-resident, so there is nothing to queue into; skipping is honest and visible in `loopmill runs`, and `minInterval` / `maxRunsPerWindow` bound the cadence anyway | A queued or waiting second run means a process that waits, i.e. a resident component — the thing D9 forbids; the alternative is a documented "retry on the next fire" |
| 4.5 | **`resume --due` is registered with the OS scheduler every 15 minutes** as the documented default cadence, next to the loop's own schedule | `mvp-design.md` §12 ("Draining the gates"), §24 item 2 | Approved gates and passed quota windows need a process to notice them, and the OS scheduler is the only thing allowed to start one; 15 minutes bounds the latency of a decision without a resident poller | Only the documented default changes; the mechanism (idempotent, concurrency-safe, A37) does not |

Maintainer's answers: **yes to all five, 2026-09-06.** A later reversal becomes a section 6 entry.

---

## 5. Reconciliation with the v0.5 decision sheet

v0.5 was pinned against a binding decision sheet that lives outside the repository. v0.6's decisions
live in ADR-002 and the design document, and `CHANGELOG-v0.6.md` §4 leaves the reconciliation into an
updated sheet to the maintainer. For that task, the specs mark every choice the sheet did not make:

| Document | Markers |
|---|---|
| `loop-file.md` | 17 `Decision (not in sheet)` items, indexed in §16 |
| `state-machine.md` | D-01-D-30, indexed in §15 |
| `envelope.md` | 13 inline `Decision (not in sheet)` items (unnumbered) |
| `usage-normalization.md` | 17 decisions and 1 `Reconciliation (both in sheet)`, indexed in §10 |

Where v0.6 supersedes the sheet outright (execution host, store, backends, gates, security boundary),
ADR-002 and `CHANGELOG-v0.6.md` §1 are the record. Reconciling the sheet does not reopen the freeze;
a sheet entry that contradicts a frozen point is handled as an amendment.

---

## 6. Amendment log

| Date | Change | Kind |
|---|---|---|
| 2026-09-06 | `envelope.schema.json`: the `backendId` description said "MVP: github-actions, observed, local, fake"; it now names `local` and `fake` as the MVP backends and the other two as reserved ids kept in the enum. No validation semantics changed; the Envelope stays at 1.0.0 | editorial |
| 2026-09-06 | Status lines of the four specs marked "frozen at m0"; `state-machine.json` `specVersion` v0.5 → v0.6 (the tables had already been aligned to v0.6 in the same change set as ADR-002) | editorial |
| 2026-09-06 | `envelope.schema.json` 1.0.0 → 1.1.0: `$defs.outcome` gains the per-state fields of `state-machine.md` §2.2 so `run-finished` can carry the engine's `Outcome` in full; additive | amendment |

---

## 7. What m1 starts from

The m1 row of `mvp-design.md` §20.2, built against the contracts above, with these tests in place from
the first commit: `loopmill validate` reproducing `LM-VAL-001`-`LM-VAL-029` on the examples; the
Envelope test vectors TV-1-TV-7 on `docs/spec/envelope-examples/`; the state-machine invariants
I-01-I-30 on the worked traces and `state-machine.json`; the usage invariants I1-I18 on every fixture
under `docs/spec/usage-fixtures/`; and the acceptance criteria A1-A13 of §20.3 as the m1 exit. The
`fake` backend replays the recorded fixtures, so all of this runs with no network and no tokens (A31).
