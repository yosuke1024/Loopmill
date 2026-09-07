# Changelog — Loopmill MVP Design v0.6

**Date:** 2026-09-06. **Replaces:** `docs/design/mvp-design.md` v0.5.

**Why this document exists:** the maintainer adopted `docs/adr/ADR-002-local-self-hosted-execution.md`
after the SPIKE-1, SPIKE-2 and SPIKE-3 results landed (`docs/spikes/README.md`). SPIKE-1 and SPIKE-3
showed that the Claude Code CLI and a non-resident, event-sourced control plane both work on a
GitHub-hosted runner; SPIKE-2 showed that a second vendor on that same topology turns into a
credential-transport problem — moving a subscription login onto infrastructure Loopmill does not own —
which principle 3.1 forbids. The maintainer withdrew "progress while the user's PC is off" as an MVP
requirement (ADR-002 Context §3) and moved execution onto a machine the operator manages. This changelog
records what changed section by section. The measured spike results themselves are kept as history in
`docs/spikes/README.md`; only their architectural reading changes (ADR-002 Appendix B).

---

## 1. Headline changes

| # | Change | Why |
|---|---|---|
| 1 | **Execution host: GitHub-hosted ephemeral runners → a user-managed host.** Loopmill runs on the operator's own workstation, or on an always-on machine the operator runs; the host must be online while a Run executes | Every vendor past Claude Code turns hosted execution into a credential-transport problem (ADR-002 Context §2); the requirement it existed to satisfy — progress while the PC is off — is withdrawn (Context §3) |
| 2 | **Driver: non-resident `loopmill step` chained by Actions dispatch → `loopmill run <loop>`**, the product's entry point and the only thing the OS scheduler invokes. It composes the same single-transition `transition(snapshot, event)` primitive in one process; `step` survives for tests and ingestion | Removes "one step = one job" job-queue and runner-startup latency entirely (§7) |
| 3 | **State: the orphan git branch `loopmill/state` with compare-and-swap push → a SQLite journal** (`runs`/`events`/`snapshots`/`attempts`/`locks`) at `<repo>/.loopmill/state.sqlite`, one file per repository | One host has a filesystem; a SQLite transaction gives the same atomicity and concurrency guarantee CAS gave two GitHub jobs that shared none (§9, ADR-002 D3) |
| 4 | **Backends: `local` becomes primary; `github-actions` becomes reserved (not built); `observed` is removed outright** — not merely left ungated | SPIKE-1 and SPIKE-3 show `local` already gives everything `github-actions` gave; SPIKE-2 showed the `observed` backend's diff never leaves the vendor UI without a human click (§6.2, ADR-002 D4) |
| 5 | **GitHub's role narrows to repository, event source and result destination**, polled with the operator's own `gh` login, instead of the event bus that Loopmill-internal handoffs were chained through | A deploy key, a branch ruleset, two GitHub Environments and four workflows are no longer needed once nothing has to hop between two credential-separated jobs (§8.2, §13.1) |
| 6 | **Human gates: a GitHub Environment approval, a PR review, or a label → `cli` / `label` / `pull-request-review`**, with no Environment gate at all | An Environment approval exists to make a *job* wait; a non-resident local process has no job for GitHub to hold (§12) |
| 7 | **Scheduling: a `schedule:`-triggered GitHub Actions workflow → the operating system's own scheduler** (`launchd`, a `systemd` timer, `cron`) invoking `loopmill run` directly | Restores the OS as the sole scheduling authority; the OS-scheduler environment, session and keychain constraints v0.4 left unspecified become SPIKE-4's measured question, not an assumption (§7.5, ADR-002 D6) |
| 8 | **Security boundary: two GitHub jobs, two credentials → one host, one process**, stated honestly about what is and is not enforced (worktree isolation, permission profiles, a gate on every external effect) | On a single user-controlled host the agent, the state and the operator's `gh` login necessarily share a machine; D8 says plainly what that does and does not guarantee (§13.1, ADR-002 D8) |
| 9 | **STOP (b) is retired** — "no cross-vendor path exists under subscriptions, and the only working shape is GitHub Actions plus API keys" no longer applies once execution is not on hosted runners at all | It was a statement about hosted runners; cross-vendor becomes a differentiator claim (D2) that narrows to "Codex planned" rather than a shipping condition (§22) |
| 10 | **SPIKE-2b is superseded (not run); SPIKE-4 is added.** Whether a seeded `auth.json` survives refresh-token rotation on an ephemeral runner no longer matters once no credential is ever moved to a runner Loopmill does not own; the live question becomes whether `codex exec` and `claude -p` authenticate under the host's own login, including when started by the OS scheduler | Codex's viability question moves from "does a seeded credential survive rotation" to "does the CLI's own host login work non-interactively" — exactly what SPIKE-4 measures (`docs/spikes/README.md` §6) |

---

## 2. Section by section

**Legend:** *rewritten* = the subject is the same but the content is substantially new; *edited* = the
section's shape and most of its content survive, with specific passages updated; *unchanged* = carried
over because it does not depend on execution topology.

| v0.6 section | Status | What changed, and why |
|---|---|---|
| **1. Overview and problem** | rewritten | Adds the "What changed from v0.5" paragraph: hosted execution worked for Claude Code and the control plane, but every further vendor is a credential-transport problem; states plainly that the contracts (loop file, transition, journal, state machines, usage record, coverage arithmetic) survive intact while the host changes |
| **2. Positioning and differentiators** | edited | Same four differentiators (D1-D4); D2 (cross-vendor) now reads "Codex is `PLANNED / EXPERIMENTAL` until SPIKE-4 passes" instead of gating on SPIKE-2b; the "no server" non-differentiator restates the honest claim as "no Loopmill process between Runs... and the host must be online while a Run executes" |
| **3. Principles** | edited (3.3, 3.5 rewritten) | 3.3 replaces the git-branch CAS description with `loopmill run` driving `transition` through a `StateStore`/`Dispatcher` pair; 3.5 adds the "honest cost" paragraph — a Run advances only while its host is online, and 24/7 execution means an always-on machine the operator manages (ADR-002). 3.1, 3.2 and 3.4 are edited only to update cross-references |
| **4. Domain model** | edited | The `Execution Backend` identity narrows to `backendId`: `local`, `fake` in the MVP, `github-actions` reserved; every other concept, identity and the aggregation hierarchy are unchanged |
| **5. Loop definition** | edited | `trigger.schedule` is now executed by the OS scheduler rather than a GitHub Actions `schedule:` trigger (5.1); the reference loop's nodes (5.3) move to `backend: local` throughout, with the two Codex nodes marked `[S]` SPIKE-4 |
| **6. Runtimes, backends, auth, capabilities** | rewritten | The MVP backend table (6.2) is replaced wholesale — `local` / `fake` / `control-plane` / `github-actions` (reserved); `observed` is gone. Authentication modes (6.4) move from job-secret CI tokens to "the CLI's own login on the host"; `subscription-login` (`codex`) is marked `EXPERIMENTAL` until SPIKE-4 passes |
| **7. The driver: `loopmill run`** | rewritten (retitled; was "Control plane `loopmill step`") | `loopmill run` is now the product's entry point and the only thing the OS scheduler invokes; it composes `step` in one process; dispatch (7.2) is a local subprocess instead of a GitHub Actions job; concurrency and recovery (7.5) move from a per-run Actions concurrency group plus CAS to a `locks` table with heartbeat/lease and a sweep run at the top of every entrypoint |
| **8. Event journal and Envelope** | edited | The Envelope's required fields and the MVP event-type catalogue are unchanged; the transports table (8.2) demotes `repository_dispatch`/`workflow_dispatch` to "Reserved for the `github-actions` integration" and promotes the in-process handoff and stdin/`--event-file` to the paths Loopmill actually uses |
| **9. State persistence** | rewritten | The store moves from the orphan git branch `loopmill/state` (one commit per event) to `.loopmill/state.sqlite` (WAL) with `runs`/`events`/`snapshots`/`attempts`/`locks` tables (9.1); atomicity moves from a compare-and-swap push to a SQLite transaction plus the lock row (9.2); `gc`, export and the read model are adapted to the new layout (9.3-9.4) |
| **10. State machine** | unchanged (mechanism note only) | Every Run, Node Execution and Attempt state and its terminal outcomes are identical to v0.5; only the process that runs the sweep setting `INTERRUPTED` changes — the driver's own entrypoints instead of a scheduled GitHub Actions workflow |
| **11. Node I/O and templating** | unchanged | The persisted I/O record, the dotted reference grammar, `${name}` substitution, structured-output re-validation and `sessionPolicy: fresh` are pure engine logic that never mentions a backend, and carry over verbatim |
| **12. Human nodes** | edited | The three gate modes narrow to `cli` / `label` / `pull-request-review`; the GitHub Environment gate for "before execution" is dropped outright — "there is no job for GitHub to hold" — and a local `cli` mode (`loopmill approve`/`reject`) is added |
| **13. Security boundary and environment policy** | rewritten | 13.1 replaces the two-GitHub-job split (control-plane job vs. agent job, separate credentials, separate environments) with the one-host boundary of ADR-002 D8: worktree isolation, a permission profile, gated external effects. 13.2-13.4 (environment policy, untrusted input, redaction) carry over with the same rules |
| **14. Usage normalization, coverage, budget** | unchanged | The canonical per-Attempt record, the per-runtime mapping, the coverage formula and the seven-field budget are backend-independent and carry over exactly; `local` and the reserved `github-actions` both map through the same table |
| **15. Loop observability** | edited | The six metrics (15.1) and the read-only UI scope (15.3) are unchanged; the terminal commands (15.2) add `doctor --scheduler` (probes the environment a `launchd`/`systemd` unit would get) and demote `schedule install\|list\|remove` to "a later convenience" rather than an m1 deliverable |
| **16. Reference loop walkthrough** | rewritten | Every node's backend column becomes `local`; the two Codex nodes carry `[S]` SPIKE-4 instead of an `observed`/`github-actions` designation; the human gate narrates polling a GitHub label from the host instead of a GitHub Environment approval; "what the maintainer sees at 07:00" keeps its four shapes but no longer assumes GitHub ran anything |
| **17. Failure UX** | edited | The exit-code contract (17.1) and the run report (17.2) are unchanged; notifications (17.3) still ship none, by the same decision; "a fire that produced nothing" (17.4) moves from an `ingest` workflow's job summary plus `doctor --orphans` to `run` writing `run-requested` as its first local transaction plus `doctor --scheduler` reading the OS scheduler's own last-fire record |
| **18. Git, Issue and PR lifecycle** | edited | Branch naming, one-commit-per-cycle, `dedupeKey` and exhaustion labelling are unchanged; the worktree-isolation citation moves from the v0.4 review finding to ADR-002 D8 |
| **19. Compliance posture** | unchanged | The claim/evidence table (19.1) and the policy-page rules (19.2) describe vendor terms, not execution topology, and carry over exactly; the SPIKE-1 PASS result now backs the Anthropic rows with a concrete measured run |
| **20. MVP scope** | rewritten | Runtimes/backends in scope (20.1) drop `github-actions` from primary to reserved; the milestones (20.2) rewrite m0 around ADR-002 and SPIKE-4 and move the "dogfood cut-line" from hosted Actions runs to seven unattended nights on the maintainer's own machine; acceptance criteria (20.3) are reworded wherever their mechanism changed (state branch → SQLite, Environment gate → `cli`/`label`/`pull-request-review`, GitHub sweep → local lease sweep) but keep the stable A1-A40 numbering |
| **21. Non-goals** | edited | Rows are reworded to cite ADR-002: a Loopmill daemon/resident scheduler, hosted runners as an MVP path, and "progress while the host is off" — now explicitly "withdrawn as an MVP requirement" rather than simply out of scope |
| **22. Spikes and STOP conditions** | rewritten | SPIKE-2b's entry becomes "Superseded by ADR-002... Not run"; a new SPIKE-4 entry is added with its own pass/fail rule; STOP (b) is retired outright rather than "not triggered yet, pending SPIKE-2b"; STOP (a) and (c) keep their v0.5 wording with updated 2026-09-06 evaluations |
| **23. Prior art** | edited | The engine-decision survey (23.1) is unchanged; the vendor-product table (23.2) rewords the Codex Automations/Cloud-tasks row to state plainly why Loopmill drives `codex exec` on the host instead of a cloud task |
| **24. Open questions** | rewritten | The seven questions move from runner-overhead/`GITHUB_TOKEN`-chaining/cross-run-contention framing to: the scheduler context (SPIKE-4), two local entrypoints on one repository, notification when nothing touched GitHub, Codex's thread-cumulative usage on the host, missed fires under each OS scheduler, unbudgeted prompt engineering, and the n=1 dogfooding risk |
| **Appendix A — Glossary** | edited | The "Runner" and "Daemonless / Zero-idle / Local-first" rows are rewritten for the non-resident local driver, noting that ADR-002 D9 restores the v0.4 meaning of daemonless; "Missed Schedule Reconciliation" now credits the OS scheduler rather than GitHub Actions |
| **Appendix B — v0.4 section mapping** | edited | The "5.2 Local-first" row gains a note that local-first is "demoted in v0.5, restored as the MVP execution model in v0.6 (ADR-002)"; every other mapping is unchanged, since it maps v0.4 sections forward and v0.4 did not change |

---

## 3. What was kept unchanged on purpose

Recorded here so a future reader does not mistake a stable contract for an oversight.

- **Loop semantics.** Run, Cycle, Node Execution, Attempt and Retry Edge, and the routing rule that a set
  of verdicts maps to one of a fixed set of routes, are identical to v0.5 (§4, §10).
- **The pure `transition` function.** `transition(snapshot, event) -> {events[], snapshot'}` does no I/O
  and is unaware of where it runs; `loopmill run` and `loopmill step` are two different callers of the
  same function (§7.2, §3.3).
- **The event catalogue.** The Envelope's required fields and the MVP event types are unchanged; only
  which transports are primary versus reserved moved (§8.1-§8.2).
- **The three state machines.** Run, Node Execution and Attempt states and their terminal outcomes carry
  over verbatim from v0.5, including `INTERRUPTED`, `NO_PROGRESS`, `MAX_ITERATIONS_EXCEEDED` and
  `BUDGET_EXCEEDED` (§10).
- **The usage record and the coverage arithmetic.** The four disjoint token buckets, provenance
  (`reported`/`derived`/`estimated`/`unavailable`), the per-runtime mapping and the coverage formula are
  backend-independent and untouched (§14).
- **Compliance posture.** The vendor-quote table and the policy-page rules describe what Loopmill may
  claim about vendor terms, which does not depend on where the CLI runs (§19).
- **Acceptance-criteria numbering.** A1-A40 keep their v0.5 numbers; criteria whose mechanism changed are
  reworded in place, and none is renumbered or dropped (§20.3).

---

## 4. Open follow-ups

1. **Companion specs.** `docs/spec/loop-file.md` (+ schema), `docs/spec/state-machine.md`, and
   `docs/spec/envelope.md` (+ schema) are aligned to the v0.6 backend and driver model in this same change
   set, not left as a separate pass. `docs/spec/usage-normalization.md` needed no change, since the usage
   record did not move (§3 above).
2. **The SPIKE-4 harness.** `spikes/spike-4-codex-cli/` does not exist yet; `docs/spikes/README.md` §6
   specifies the D1-D10 checks and the pass rule it has to satisfy before the `codex` runtime can move
   from `PLANNED / EXPERIMENTAL` to `VERIFIED`.
3. **The v0.6 decision sheet.** v0.5 was pinned against a binding decision sheet that the design document
   could not overrule on its own; v0.6's decisions live in ADR-002 and in this design document instead.
   Reconciling them into an updated, binding decision sheet — the way v0.5's changelog §3 reconciled every
   "Decision (not in sheet)" item — is the maintainer's to do, and is not attempted here.
