# ADR-002: Execute on a user-managed host; GitHub is the repository and the collaboration surface, not the control plane

- **Status:** Accepted, 2026-09-06 (maintainer decision after the SPIKE-1, SPIKE-2 and SPIKE-3 results).
- **Supersedes:** ADR-001 decisions D2 (topology), D4 (GitHub as the event bus), D5 (state on a git
  branch), D6 (two job classes), D7 (the backend matrix) and D8 (the v0.5 meaning of "daemonless").
  ADR-001 D1 (three axes) and D3 (declared capabilities) stay in force. The pure `transition` function,
  the event catalogue, the Envelope as the event record and the three state machines are unchanged.
- **Records:** the design document is rewritten as v0.6 (`docs/design/mvp-design.md`);
  `docs/design/CHANGELOG-v0.6.md` lists what changed section by section.
- **Evidence:** `docs/spikes/README.md` §3-§5. The spike results are kept as measured; only their
  architectural reading changes (Appendix A).

---

## Context

### 1. What the spikes measured

- **SPIKE-1 (PASS).** The unmodified Claude Code CLI runs headless on a throwaway GitHub-hosted runner
  with nothing but a subscription OAuth token: machine-readable usage, structured output, a legible
  exit-code and signal contract, no TTY hang. Everything measured about the CLI itself — `is_error` and
  `terminal_reason`, `modelUsage`, thinking tokens, SIGINT/SIGTERM behaviour, the `rate_limit_event` —
  is a property of the CLI, not of the runner, and transfers to any host.
- **SPIKE-3 (PASS).** A non-resident control plane with an event-sourced store and compare-and-swap on a
  git branch stays correct on real GitHub under duplicate, concurrent and interrupted delivery; the
  per-run concurrency group drops events; hops cost 12-14 s each.
- **SPIKE-2 (NO-GO).** Codex Cloud can be dispatched unattended and reports a bounded completion
  signal, but its result never reaches GitHub as a change without a human click, and a
  `GITHUB_TOKEN`-authored `@codex` mention starts no task. The `observed` backend was dropped.

### 2. What the results mean for the v0.5 architecture

v0.5 put the control plane and the agent jobs on GitHub-hosted ephemeral runners so that a loop could
make progress while the maintainer's machine was off. The spikes show that this works for Claude Code
and for the control plane — and that every further vendor turns into a **credential-transport
problem**: Codex Cloud has no unattended delivery path; Codex on an ephemeral runner needs a seeded
`auth.json`, a recipe OpenAI documents as "advanced" and discourages in its own words (SPIKE-2 item 11c);
any future vendor would need its own equivalent. Under that architecture the main engineering question
per provider becomes "how do we move this vendor's subscription credential onto a runner we do not own",
and answering it means reading, copying and forwarding credentials — the one thing principle 3.1 says
Loopmill never does. That is not Loopmill's problem to solve.

### 3. The requirement that is withdrawn

ADR-001 exists to satisfy one requirement: **progress while the user's PC is off**. The maintainer
withdraws it from the MVP. The contract is now stated plainly: *while a Run executes, the host that
runs it must be online.* This is not "giving up unattended execution" — a Run started by the OS
scheduler at 06:00 on a machine that is on, or on an always-on machine the user manages, is unattended.
It is giving up execution on infrastructure Loopmill does not control.

### 4. What the v0.4 review found in the local shape, and how v0.6 carries the repairs

v0.4 was local-first and its review found four criticals in that shape: schedule installation and the
OS scheduler's environment, session and keychain constraints were unspecified (`daemonless-ops-1`); a
runner killed mid-node left the Run `RUNNING` for ever (`daemonless-ops-2`); no cross-process run lock
(`daemonless-ops-3`); and `loopmill run` had no exit-code contract (`failure-ux-and-notifications-1`).
The judge prescribed repairs inside the local shape: a lock with heartbeat and lease, an `INTERRUPTED`
state, a sweep at the top of every entrypoint, `schedule install` writing absolute argv and an
install-time environment snapshot, and Loopmill as the single catch-up authority. v0.5 built the lease,
`INTERRUPTED`, the sweep and the exit-code contract on GitHub; v0.6 keeps all four and moves them onto
the host (D3, D6). The keychain and session constraints become a measured item (SPIKE-4), not an
assumption.

---

## Decision

### D1. The execution host is a machine the user manages

Loopmill runs on a **developer workstation** (macOS, Linux) or on an **always-on machine the user
manages** (a Linux server, a Mac mini, a VPS). The minimum configuration is one laptop with `claude`
and `codex` logged in and `loopmill` installed; a user who wants 24/7 execution places the same
configuration on an always-on host. A self-hosted server is never required.

While a Run executes, the host must be online. A Run that is waiting — for a human, for a quota window,
for its next scheduled fire — has no process and needs no host.

### D2. `loopmill run` is the driver; it is non-resident and event-sourced

`loopmill run <loop>` starts, applies events until the Run is terminal or enters a wait state, and
exits with the outcome code (`docs/spec/state-machine.md` §12.2: `0` succeeded, `10`-`15` terminal
outcomes, `20`-`23` exited in a wait state). Internally it composes the single-transition primitive of
ADR-001 D2 — `transition(snapshot, event)`, one applied event per journal entry — and the same
seven-phase cycle: load, validate, apply, decide, dispatch, persist, continue-or-exit. `loopmill step`
survives as the one-envelope primitive used by tests and by GitHub ingestion; it is no longer the
product's entry point.

Dispatch on the `local` backend is a **subprocess of the same process**: `run-node` semantics stay
(the node executor invokes the CLI directly, captures usage, structured output and exit code, and
produces the completion envelope), but the completion travels in memory, not over GitHub.

**Alternative rejected — a resident `loopmilld`.** It would hold state in a process, need liveness
detection and an IPC channel, and be the always-on Loopmill component D9 forbids. The OS scheduler
starts processes for free.

### D3. State is a SQLite journal on the host; the snapshot is a fold of it

The store is `<repo>/.loopmill/state.sqlite` (WAL, `node:sqlite`), one file per repository, ignored by
git through a `.loopmill/.gitignore` that Loopmill writes. Tables: `runs` (immutable headers),
`events` (the append-only journal — one row per applied or emitted Envelope, hash-chained), `snapshots`
(the fold, rebuildable), `attempts` (usage and refs), `locks` (one row per active Run: owner pid, host,
heartbeat, lease expiry). Every applied event is one transaction, so a killed process leaves complete
journal rows or nothing.

The event-sourcing invariants of v0.5 are unchanged: `snapshot == fold(events)` for every run;
aggregates are a fold of immutable attempt records; the same fixtures drive the same tests. What changes
is the medium — a local database instead of a git ref — and the concurrency primitive — a SQLite
transaction plus the lock row instead of a compare-and-swap push.

`loopmill export <runId>` writes the run as the JSON event files of SPIKE-3's layout, and an optional
post-MVP integration may mirror them to a git branch. Neither is a source of truth.

**Alternative rejected — the orphan git branch as the store (ADR-001 D5).** Correct and measured, but
it exists to give two machines that share no filesystem a common medium. One host has a filesystem.
**Alternative rejected — plain JSON event files as the store.** Equivalent for the journal, worse for
the lock: a lock needs a transaction, and SQLite already provides one across processes on one host.

### D4. Backends: `local` is primary; `github-actions` is reserved; `observed` is removed

| Backend | Runtime | Status in v0.6 |
| --- | --- | --- |
| `local` | `claude-code`, `codex` | **MVP, primary.** The node executor on the host; isolation by git worktree; credential is the CLI's own login on the host |
| `fake` | `fake` | **MVP.** Fixture-replaying backend for tests and CI |
| `control-plane` | — | **MVP.** Pseudo-backend for `condition`, `human` and `end` |
| `github-actions` | any | **Reserved, post-MVP integration.** Measured viable for `claude-code` (SPIKE-1) with a working non-resident control plane (SPIKE-3); not an MVP execution host and not an MVP requirement |
| `observed` | — | **Removed** (SPIKE-2 NO-GO) |

The loop-file schema drops `observed` and marks `github-actions` reserved; the validator rejects any
(runtime, backend, authMode) triple outside the supported matrix, as before (ADR-001 D3).

### D5. Authentication is the CLI's own login state on the host

Loopmill invokes `claude` and `codex` as subprocesses and relies on whatever authentication each CLI
already has on that host: `claude` logged in (or `CLAUDE_CODE_OAUTH_TOKEN` exported by the user),
`codex login` completed. Loopmill never reads, copies, stores, forwards or redistributes a credential
file or token, and ships no feature that moves `auth.json` or an OAuth token to another host. The
environment policy (deny / preserve / inject) still scrubs every vendor auth-override variable from the
agent subprocess, so a subscription node cannot silently become a metered one; `api-key` remains an
explicit, labelled opt-in per node.

### D6. Scheduling is the operating system's; there is no Loopmill daemon

A loop with `trigger.kind: schedule` is started by the OS scheduler — `launchd` on macOS, a `systemd`
timer or `cron` on Linux — invoking `loopmill run <loop>`. In the MVP the user registers that job;
`loopmill schedule install|list|remove` is a later convenience that renders the OS unit from the loop
file (absolute argv, an install-time environment snapshot, the loop's `tz`) and never runs anything
itself.

Overlap and recovery are Loopmill's: the `locks` row prevents two Runs of one loop from executing at
once (the second is refused as `SKIPPED(skipReason: overlapping_run)`); `minInterval` and
`maxRunsPerWindow` bound the cadence; every entrypoint (`run`, `resume --due`, `status`) starts with the
**sweep**, which moves any Run whose lease expired to `INTERRUPTED`, so a machine that lost power
mid-run reports it on the next command and `resume --due` re-dispatches up to `maxAttempts`. A fire
that passes while the host is off is missed; what each scheduler does about it (launchd coalesces on
wake, `systemd` `Persistent=true` gives one catch-up, cron none) is documented, not papered over.

### D7. GitHub is the repository, the event source and the result destination

GitHub keeps four roles: the repository; a source of events (Issues, PRs, comments, reviews, labels)
that Loopmill **polls** with the user's own `gh` login; the destination for commits, Issues, PRs and
comments a Run produces; and the surface where collaborators read the result. It is not the executor,
not the bus and not the store.

Human gates stay on GitHub primitives where a collaborator is involved and gain a local mode:
`pull-request-review` (an approving review), `label` (`loopmill:approve` / `loopmill:reject` on the
Run's Issue or PR), and `cli` (`loopmill approve|reject <runId>` on the host). A gate parks the Run in
`WAITING_HUMAN` with no process; the decision is ingested — by polling `gh` or by the local command —
as a `human-decided` event with the same subject digest as the request, on the next `resume --due` or
`run` invocation. GitHub Environments, `repository_dispatch`, `workflow_dispatch` and the `ingest`
workflow are no longer part of the design; the Envelope's GitHub transports are recorded as an optional
integration for the reserved backend.

### D8. The security boundary on one host, stated honestly

There is no longer a job that holds the vendor credential and cannot write history, and a job that
writes history and never sees a credential: on a single user-controlled host the agent, the state and
the user's `gh` login share a machine. What Loopmill enforces instead:

- **Isolation.** Every Run works in a dedicated git worktree under `.loopmill/worktrees/<runId>`, cut
  from `repos[].defaultBase`; the user's checked-out branch and working tree are never touched.
- **Permission profiles.** `readonly` / `workspace` / `full` map to the CLIs' own sandbox and
  permission flags; the default `workspace` denies `gh` and `git push` tool use to the agent.
- **External effects are gated.** `effects: external` nodes (`gh issue create`, `gh pr create`) are
  Loopmill-run `command` nodes preceded by a human gate on every path unless pre-approved by name with a
  reason — exactly as in v0.5. The agent never performs the external effect itself.
- **Environment policy.** Deny / preserve / inject lists are mandatory; `GH_TOKEN` is denied to agent
  subprocesses.
- **Untrusted content** is marked, never sanitised; the gate is the real control.

What is *not* guaranteed: a planted instruction that escapes the CLI's permission profile has the
host user's access. Acceptance criterion A19 is therefore evidence about the permission profile plus
the gate, and the docs say so.

### D9. "Daemonless" in v0.6

> Loopmill runs no process between Runs or during a wait, and requires no server, daemon, queue,
> scheduler or cloud that Loopmill owns. The operating system starts Runs; GitHub holds the repository;
> the vendors' CLIs hold their own logins.

This is v0.4's meaning restored, with v0.5's stricter process model kept: every Loopmill process is
started by something else (the scheduler, the user, CI) and exits.

### D10. MVP condition and STOP conditions

The MVP is viable when **at least one supported AI CLI executes unattended on a user-managed host under
subscription authentication**, with the loop semantics, state, usage normalisation and observability of
this design around it. Claude Code satisfies the CLI half today (SPIKE-1, plus a local confirmation
in SPIKE-4). Cross-vendor execution is a differentiator, not a STOP condition: the provider abstraction
is mandatory, Codex is `VERIFIED` when SPIKE-4 passes and `PLANNED / EXPERIMENTAL` until then, and the
MVP proceeds either way. The STOP conditions become: **(a)** no supported CLI can run unattended on a
user-managed host under subscription auth; **(c)** vendor terms, read verbatim, forbid the single-user
unattended use Loopmill relies on. v0.5's (b) — "the only working shape is GitHub Actions plus API
keys" — is retired: it was a statement about hosted runners.

---

## Consequences

### Positive

- Provider-independent by construction: adding a runtime means writing a subprocess adapter and a usage
  mapping, never a credential transport.
- Subscription-native is kept without a single credential leaving the host; the compliance posture of
  `docs/design/mvp-design.md` §19 gets simpler, not weaker.
- Codex is a provider again, through `codex exec` on the host, with the thread-cumulative usage rule
  already specified.
- The engine is the same engine: pure transition, event journal, three state machines, fixtures. The
  git-branch store and the GitHub transports become adapters that are not built in the MVP.
- One host, one file, one lock: crash recovery is a transaction, not a distributed protocol.
- The first-run path is `claude login`, `codex login`, `npm i -g loopmill`, `loopmill run` — no deploy
  keys, rulesets, environments or workflows.

### Negative

- **A Run needs an online host.** Nothing advances while the machine that runs it is off; 24/7
  execution needs an always-on machine the user manages.
- No "it just runs" managed-cloud experience, and no progress on infrastructure Loopmill does not
  control.
- The OS scheduler's environment, session and keychain constraints are real and per-platform
  (SPIKE-4). A `launchd` job that cannot reach the login keychain cannot authenticate `claude`.
- The single-host security boundary is weaker than v0.5's two-job split; D8 states what is enforced.
- SPIKE-3's measured store and transport are shelved for the MVP; the 44 hosted runs remain the record
  for the reserved backend.

### Risks, and what retires each

| # | Risk | If it lands | Retired by |
| --- | --- | --- | --- |
| R1 | `codex exec` does not run non-interactively under a ChatGPT login with machine-readable results, usage and a terminal signal | Codex stays `PLANNED / EXPERIMENTAL`; the MVP ships Claude-only behind the same abstraction | **SPIKE-4** |
| R2 | A scheduler-started process cannot reach the CLI's login state (macOS keychain when the screen is locked or no user session; `CODEX_HOME` not found under a `systemd` unit) | Unattended scheduled runs fail at authentication on that platform until the environment is prepared; `doctor` must detect it before 06:00 | **SPIKE-4** (launchd/systemd probes), a `doctor` check |
| R3 | `claude -p` behaves differently on the user's host than on the hosted runner | Contract tests catch it | run the SPIKE-1 harness locally (SPIKE-4) |
| R4 | Two entrypoints race on one repository (scheduler plus a manual `run`, or `resume --due` plus `run`) | A double Run or a torn journal | the `locks` row (D6), acceptance criteria A10/A11 |
| R5 | Vendor terms forbid unattended single-user use | STOP (c) | R11 of SPIKE-2 (still open) |

---

## Appendix A — What happens to each ADR-001 decision

| ADR-001 | v0.6 disposition |
| --- | --- |
| D1 three axes (runtime × backend × authMode) | Kept; the supported matrix shrinks to `local` × {`claude-code`, `codex`} plus `fake` |
| D2 non-resident `loopmill step` | Kept as the primitive; `loopmill run` composes it on the host (D2 above) |
| D3 declared capabilities | Kept |
| D4 GitHub as the event bus | **Superseded**: GitHub is polled, not chained; transports become an optional integration (D7) |
| D5 state on `loopmill/state` | **Superseded** by the SQLite journal (D3); the layout survives as `loopmill export` |
| D6 two job classes | **Superseded** by the single-host boundary (D8) |
| D7 backend matrix | **Superseded** (D4) |
| D8 daemonless = no Loopmill-owned always-on infrastructure | **Narrowed** (D9): also no resident Loopmill process on the host |
| Compliance notes | Kept; the OpenAI rows stay `[L]` until R11 |

## Appendix B — How the spike results are read now

| Spike | Result | v0.6 reading |
| --- | --- | --- |
| SPIKE-1 | PASS | The Claude Code CLI contract Loopmill builds on — measured, and independent of the runner. GitHub-hosted execution itself is reserved, not primary |
| SPIKE-2 | NO-GO | Codex Cloud as an `observed` backend is out. Codex as a provider is not: it returns through `codex exec` on the host (SPIKE-4) |
| SPIKE-2b | superseded | Seeding `auth.json` on an ephemeral runner is no longer needed; not run |
| SPIKE-3 | PASS | The non-resident, event-sourced control plane and its concurrency properties are proven; the git-branch store and GitHub chaining are the reserved backend's mechanism, kept as a reference for a future remote integration |
