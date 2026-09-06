# ADR-001: Event-driven, non-resident control plane with pluggable execution backends

- **Status:** Proposed, 2026-09-06
- **Supersedes:** `docs/design/mvp-design.md` (MVP Design v0.4) for everything in the appendix mapping
- **Binding input:** the v0.5 decision sheet (2026-09-06). Where this ADR and the sheet disagree, the sheet wins.
  Decisions this ADR had to make because the sheet is silent are labelled **Decision (not in sheet)** so the
  maintainer can reconcile them.
- **Gated by:** SPIKE-1, SPIKE-2 / SPIKE-2b, SPIKE-3 (decision sheet §13). A spike failure may overturn parts of
  this ADR; the "Risks" table names which part.

---

## Context

### 1. What v0.4 decided

v0.4 is a local-first, daemonless design. Its four principles are subscription-native, local-first,
daemonless / zero-idle, and observable (v0.4 §5). Operationally that means: the loop lives as rows in a local
SQLite database (§30), a `loopmill run <workflow-id>` process is registered with the operating system's own
scheduler — launchd, a systemd timer, or Task Scheduler (§26) — runs the whole loop start to finish in one
resident process, writes results to SQLite, and exits (§27). A separate `loopmill ui` process reads the same
SQLite file when a human wants to look (§29, §31). Human actions travel through a `ControlCommand` table that
the runner polls "at safe points" (§32). Missed schedules are handled by `loopmill reconcile` (§28).

The v0.4 review found 95 confirmed issues, 15 of them critical. The cluster that matters here is operational:
nothing specifies how a schedule is installed or how launchd/systemd/Task Scheduler environment, session and
keychain constraints are satisfied (`daemonless-ops-1`, critical); a runner killed mid-node leaves the Run in
`RUNNING` for ever, with no lease, heartbeat or `INTERRUPTED` state (`daemonless-ops-2`, critical); there is no
cross-process run lock, so the OS scheduler, a manual run and `reconcile` can execute the same workflow
concurrently in one shared workspace (`daemonless-ops-3`, critical); and `loopmill run` has no exit-code
contract although that integer is the only thing all three OS schedulers keep
(`failure-ux-and-notifications-1`, critical). The three-plan judge accepted the local-first shape and
prescribed repairs inside it: a lock row with heartbeat and lease columns, an `INTERRUPTED` state, a sweep at
the top of every entrypoint, `loopmill schedule install` writing absolute argv and an install-time environment
snapshot, and Loopmill as the single catch-up authority (recommendation §2, items 14-17).

### 2. Why the local-first / daemonless design fails the requirement

Those repairs do not touch the load-bearing premise. All three OS schedulers do *some* missed-run catch-up, but
none of them runs a job on a machine that is off. On macOS, a job whose fire time passes while the Mac is
*asleep* is coalesced and runs on wake, but a job whose fire time passes while the Mac is *powered off* does not
run and is not queued — it waits for the next natural occurrence of the calendar interval (research brief
`os-scheduling-and-storage.md` 1.2, 1.3, verified). `systemd`'s `Persistent=true` gives exactly one catch-up run
after the timer becomes active again (2.2, likely); plain cron gives none (2.6, likely). Windows'
`TaskSettings.WakeToRun` wakes from sleep or hibernate and explicitly "does not revive a fully powered-off
machine" (3.2, verified).

So the v0.4 architecture's real contract is: **the loop advances only while the user's PC is on.** The v0.5
positioning brief rejects that contract. A control plane whose progress depends on a laptop lid is not a control
plane; it is a cron job with a UI. The same premise also removes the *unattended* part of the product: an
overnight loop that parks on quota at 06:12 and needs the machine awake at 11:12 to resume is, for the user,
indistinguishable from broken.

The v0.4 shape has a second, independent problem. Anthropic now ships Desktop scheduled tasks that run on the
user's machine with local file access, a 1-minute minimum interval, per-task permission mode and model, an
optional isolated git worktree, and missed-run reconciliation that starts exactly one catch-up run
(`claude-code-cli.md` #74, #75, verified; code.claude.com/docs/en/desktop-scheduled-tasks, accessed
2026-09-06). That is v0.4 §26-§28, free with the subscription. "Daemonless local scheduling" is therefore not
available as a differentiator either (review `product-scope-1`, high).

### 3. Why "GitHub Actions only" is rejected

The obvious reaction — "then just build it on GitHub Actions" — is rejected in two distinct senses.

- **As a product.** "GitHub Actions plus API keys" is what `claude-code-action` and `codex-action` already
  provide. Building Loopmill as a thin wrapper over them is explicitly the sheet's STOP condition (b): if the
  only working shape is metered CI agents, the product has no reason to exist. Loopmill's differentiators are
  bring-your-own subscriptions on native runtimes, cross-vendor and cross-backend loops, bounded loop semantics,
  and loop-level observability (decision sheet §1) — none of which is a CI feature.
- **As an architecture.** Encoding the loop semantics in workflow YAML makes GitHub the definition of "what a
  Run is". Then the `observed` backend (execution on the vendor's own cloud) and the `local` backend
  (execution on the maintainer's machine) cannot exist, because their semantics are not expressible as Actions
  steps; retries, cycles and budgets become YAML idioms rather than a validated model; and the loop cannot be
  replayed or tested offline. The sheet forecloses this: `step` "depends only on a StateStore interface
  (git-branch, local-dir) and a Dispatcher interface; GitHub Actions is the MVP executor, not the design"
  (decision sheet §6).

What GitHub *is* good for is the three things Loopmill would otherwise have to own and run: a resident scheduler,
a durable event bus, and a job runner with an identity and a secret store. Using them costs nothing at idle and
is not Loopmill infrastructure.

### 4. What the vendors ship, as of 2026-09-06

- **Anthropic, headless subscription auth.** `claude setup-token` mints a one-year OAuth token for CI and
  scripts, prints it once and stores it nowhere; the user exports it as `CLAUDE_CODE_OAUTH_TOKEN`. It requires a
  Pro/Max/Team/Enterprise plan and is inference-only (`claude-code-cli.md` #45, verified;
  code.claude.com/docs/en/authentication). Subscription billing applies. A **Claude Code GitHub Action** exists
  for schedule-triggered CI runs (#79, verified).
- **Anthropic, the trap.** `--bare` is documented as the recommended mode for scripted and SDK calls and "will
  become the default for `-p` in a future release"; in bare mode Claude Code never reads OAuth credentials or the
  system keychain and does **not** read `CLAUDE_CODE_OAUTH_TOKEN` (#22, verified). Loopmill must never pass
  `--bare`, must pin a runtime version, and `doctor` must fail loudly if a future `claude` makes it the `-p`
  default.
- **Anthropic, scheduling.** Cloud **Routines** run as full Claude Code cloud sessions on Anthropic-managed
  infrastructure, draw down subscription usage, have a minimum interval of 1 hour, and expose three trigger
  kinds including an **API trigger: a per-routine `/fire` endpoint with a bearer token** (#72, #73, verified;
  code.claude.com/docs/en/routines). A fire call is rate-limited and answers 429 with `Retry-After`.
- **OpenAI, headless subscription auth.** OpenAI documents "Maintain Codex account auth in CI/CD (advanced)":
  create `auth.json` once with `codex login`, place it on a trusted runner, seed it only if missing so refreshed
  tokens survive, and prefer a self-hosted runner with a persistent `CODEX_HOME`. The page carries its own
  caveat that "the right way to authenticate automation is with an API key… only use this if you specifically
  need to run the workflow as your Codex account" (SPIKE-2 item 11c, **LIKELY** — the page was EGRESS-BLOCKED
  from this environment, 403 on CONNECT, and is known only through search-index summaries).
- **OpenAI, cloud execution.** `codex cloud exec --env <ENV_ID>` creates a real Codex Cloud task from a
  non-interactive process, prints exactly one task URL on stdout and exits 0 (SPIKE-2 4a, VERIFIED against
  Codex CLI v0.153.4 and the `openai/codex` source). Cloud tasks are structurally subscription-only: API-key
  auth is refused on that surface (1a, VERIFIED). But there is **no public REST API, no webhook, no MCP tool and
  no app-server method for cloud tasks** (4c, VERIFIED absence) — there is no equivalent of Anthropic's Routines
  fire endpoint. Completion is pollable only through `codex cloud list --json` (`pending|ready|applied|error`,
  7b VERIFIED); `codex cloud status` has no `--json` and exits 1 for pending, error and applied alike (7c,
  VERIFIED). Cloud tasks expose **no token usage anywhere in the supported CLI** (8a, VERIFIED absence) and no
  quota signal (9a, VERIFIED absence). An `@codex` comment on a GitHub issue or PR dispatches a cloud task
  (3e, LIKELY), and an Actions job can post that comment with nothing but `GITHUB_TOKEN` (10b, LIKELY).
- **GitHub, the two rules the design turns on.** `repository_dispatch` triggers workflows only on the
  repository's default branch. Events created with the automatic `GITHUB_TOKEN` do not start new workflow runs,
  **except** `workflow_dispatch` and `repository_dispatch`. (Both carried from GitHub Docs; docs.github.com was
  unreachable from this environment, so both are re-verified by the SPIKE-3 GitHub run, not by a fetched page —
  see `.github/workflows/spike-3-step.yml` header.)

### 5. What is already settled, and what this ADR has to settle

Several pieces of the engine are settled independently of this ADR and are assumed by it. Loop semantics are a
pure function: a set of verdicts maps to one of a fixed set of routes (continue, traverse the retry edge,
replan, halt), with no I/O inside the decision. The run's history is an append-only, hash-chained event journal
from which the current state is a fold. Untrusted-content detection is a Loopmill-owned pattern table that
marks and never rewrites. Budgets are checked before a dispatch starts and may only be tightened, never
loosened, during a Run. Those are recorded in the decision sheet (§2, §5, §9, §10) and this ADR neither
restates nor changes them.

What none of that settles is the subject of this ADR: **topology**. Whether the decision function runs inside a
long-lived process or is started once per event; where the journal physically lives when two machines that
share no filesystem both need to append to it; who holds which credential while it happens; and how one
component tells another that something finished. Every design Loopmill has looked at — its own v0.4 included —
answers those four questions with resident-process assumptions: state held in a closure, a journal directory on
one machine's home directory, liveness inferred from a pid, human gates as local files or readline prompts, and
a local HTTP endpoint as the control surface. Each of those breaks the moment the loop has to make progress
while the machine that started it is off. The decisions below replace all four answers and leave the loop
semantics untouched.

---

## Decision

### D1. Separate the control plane from the execution backend; describe every Node Execution as a (Runtime × Backend × Authentication Mode) triple

The control plane decides *what happens next*. An execution backend decides *where and how a node runs*. They
are different components with different credentials, and they communicate only by Envelope (D4).

Three axes, orthogonal and separately identified (decision sheet §2):

- **Runtime** (`runtimeId`) — which agent CLI or product: `claude-code`, `codex` in the MVP.
- **Execution Backend** (`backendId`) — where and how a node runs, and what it can therefore promise:
  `github-actions`, `observed`, `local` in the MVP, plus `fake` for tests.
- **Authentication Mode** (`authMode`) — `subscription-oauth` (Claude `setup-token` or login),
  `subscription-login` (Codex ChatGPT login or seeded `auth.json`), `api-key` (explicitly opt-in, never default,
  never silent).

Not every triple is valid. The MVP matrix (decision sheet §4, §11):

| Runtime | Backend | Auth mode | Status |
| --- | --- | --- | --- |
| `claude-code` | `github-actions` | `subscription-oauth` (`CLAUDE_CODE_OAUTH_TOKEN`) | Supported; gated on SPIKE-1 |
| `claude-code` | `local` | `subscription-oauth` or interactive login | Supported |
| `codex` | `observed` (Codex Cloud) | `subscription-login`, credential vendor-side | MVP, gated on SPIKE-2 R-runs |
| `codex` | `github-actions` | `subscription-login` (seeded `auth.json` under `CODEX_HOME`) | **EXPERIMENTAL**, behind a flag, gated on SPIKE-2b |
| `codex` | `local` | `subscription-login` | Supported |
| any | any | `api-key` | Explicit opt-in only; shown as metered in every report |
| `fake` | `fake` | none | Tests and CI |

The triple is pinned in the loop file and therefore in `loopVersion`; it is never resolved at dispatch time from
ambient state.

**Decision (not in sheet):** `claude-code` on `observed` — using a Routine's per-routine `/fire` endpoint as an
observed backend — is **out of the MVP**, even though it is the only vendor cloud with an HTTP trigger. Reason:
the sheet names exactly one `observed` instance (Codex Cloud), a second one changes the usage-coverage story
(both would report `unavailable`), and Routines have no artifact contract Loopmill can match on. Recorded here
because it is the most obvious thing a reader will ask for.

**Alternative rejected — one axis, v0.4's `AgentRuntime` (§8).** v0.4's interface is `detect / authStatus /
execute / cancel` with no capabilities, no backend, no typed result and no session identity (review
`runtime-integration-5`, high). It cannot express "the same `claude-code` CLI, in a GitHub job versus on the
laptop", which differ in credential location, isolation, cancellability and quota signal — none of which is a
property of the CLI.

**Alternative rejected — backend as a deploy-time flag.** If the backend is chosen at run time, two Runs of the
same `loopVersion` are not comparable, and the validator cannot check the capability rules in D3 before the run
starts.

### D2. `loopmill step` is a non-resident, single-transition process

One invocation applies exactly one inbound Envelope and exits. Nothing stays resident between events; the only
durable thing is the event log (decision sheet §6).

**Input.** Exactly one Envelope, on stdin or via `--event-file`.

**Algorithm.**
1. Load the snapshot for `runId` (or create the Run, for `run-requested`).
2. Validate the envelope against the schema and against state: `eventId` not in `appliedEventIds` (else exit 0
   with `duplicate`); `(nodeId, cycle, attempt)` matches the expected in-flight attempt (else record an
   `ignored-stale` event and exit 0); the producer is allowed for the event type. `loopmill validate` runs over
   the loop file at the start of every step.
3. Apply the transition — a pure function `transition(snapshot, event) -> {events[], snapshot'}`.
4. Decide the next action: dispatch the next node, enter a wait, or finish.
5. Perform the dispatch: emit `node-dispatched`, then call the backend's dispatcher
   (`workflow_dispatch`/`repository_dispatch` for `github-actions`; a comment or `codex cloud exec` for
   `observed`; a process spawn for `local`).
6. Persist events and snapshot as **one commit** and push with compare-and-swap (fast-forward only; on rejection
   re-fetch, re-validate, re-apply, retry up to 5 times with jitter).
7. Exit.

**Exit codes.** `0` handled (applied, duplicate, or ignored-stale; details in stdout JSON); `2` invalid envelope
or loop file; `3` state conflict unresolved after retries; `4` backend dispatch failed (state already records
`dispatch-failed`); `1` unexpected error. **Terminal Run outcomes are not exit codes** of `step`; they are
events, surfaced by `loopmill status` and the job summary. (The SPIKE-3 prototype uses a wider code set for
test legibility; v0.5 collapses it to these five.)

**Idempotency keys.** `eventId` (exact duplicate); `(runId, nodeId, cycle, attempt, eventType)` (semantic
duplicate); `causationId` (audit). `node-dispatched` is written **before** the dispatch call; on a crash between
the two, the sweep re-dispatches after the lease expires, and the backend must tolerate a duplicate dispatch
(`github-actions`: the concurrency group; `observed`: a `dedupeKey` in the trigger text).

**Concurrency.** One GitHub Actions `concurrency` group per `runId` with `cancel-in-progress: false` is a
convenience; the CAS push is the correctness mechanism. A hard cap `maxStepsPerRun` (default 200) prevents
runaway chains.

**Portability.** `step` depends only on a `StateStore` interface (`git-branch`, `local-dir`) and a `Dispatcher`
interface. GitHub Actions is the MVP executor, not the design.

**Decision (not in sheet):** a dispatch records a **lease** = the node's `timeout` plus a 15-minute grace,
carried on the `node-dispatched` event; a scheduled sweep workflow on the default branch emits `lease-expired`
envelopes for expired leases, which is what moves a Run to `INTERRUPTED` and re-dispatches up to `maxAttempts`.
The sheet names the sweep and the lease but not the grace period or the sweep's trigger.

**Decision (not in sheet):** `loopmill step` never spawns an agent process. Agent execution is always
`loopmill run-node` in a separate job, process or vendor cloud. This is what keeps the vendor credential out of
the control-plane job (D6).

**Alternative rejected — a resident runner that owns the whole Run** (v0.4 §27). A killed
process leaves the Run `RUNNING` for ever (review `daemonless-ops-2`, critical) and requires liveness detection,
which in practice means pid checks that are wrong across machines and jobs.

**Alternative rejected — a SQLite lock row with heartbeat and lease columns** (the judge's consensus item 16).
Correct for one machine; two GitHub Actions jobs share no filesystem, so the lock has no medium. Replaced by
CAS on a git ref, which is the same guarantee over a medium both jobs already have.

**Alternative rejected — a durable workflow engine (Temporal, Restate, or similar).** It is exactly the
Loopmill-owned always-on infrastructure D8 forbids.

### D3. Backends declare capabilities; the validator enforces them before the run starts

Each backend declares a capability record in code, echoed by `loopmill backends --json` (decision sheet §4):

`invocation: on-demand | event | schedule-only`, `result: returned | streamed | observed`,
`usage: full | partial | none`, `quotaSignal: structured | classified | none`, `structuredOutput: bool`,
`retryable: bool`, `cancellable: bool`, `isolation: ephemeral | worktree | shared`,
`credentialLocation: job-secret | vendor-side | user-machine`.

`loopmill validate` — which also runs at the start of every `step` — rejects a loop file that asks a backend for
something it has not declared. The capability-dependent rules (decision sheet §3):

- Every Retry Edge body must contain at least one node whose backend is `retryable: true`, and the edge's `to`
  node's backend must be `retryable: true`; otherwise ERROR "retry edge targets non-retryable backend".
- Every `agent` node that sets `structuredOutput` must run on a backend declaring `structuredOutput: true`;
  otherwise ERROR. (This is what stops a Codex Cloud node from being asked for typed output — SPIKE-2 6a,
  VERIFIED absence.)
- Every `condition` input must reference a node that precedes it on all paths; a missing or non-conforming
  input is an ERROR, never a silent false.
- Every `effects: external` node must be preceded by a `human` node on every path, unless `approval.policy:
  auto` is set explicitly with a reason.
- Plus the structural rules: schema conformance, unique ids, every `next`/edge target exists, exactly one entry
  node, every Retry Edge has `maxIterations >= 1` with a reachable target, MVP one repo and sequential
  execution.
- Plus D1: the (runtime, backend, authMode) triple must be in the supported matrix.

**Alternative rejected — capability sniffing at dispatch time.** An unattended run must fail at validation, not
at 02:00 in cycle 3. Probing by parsing `--help` also produces false negatives: `--max-turns` is hidden from
`claude --help` in 2.1.261 while still working (`claude-code-cli.md` #6, verified).

**Alternative rejected — a lowest-common-denominator backend interface.** Flattening to what `observed` can do
would delete usage and structured output from the `github-actions` backend; flattening upward would force
`observed` to fabricate them, and a fabricated zero is exactly the defect the review found in v0.4
(`observability-data-4`: quota-killed, failed and cancelled nodes stored as 0 tokens).

### D4. GitHub is the event bus; the Envelope is the only inter-component contract

**The Envelope** (decision sheet §7). Required: `schemaVersion`, `eventId` (ULID), `eventType`, `occurredAt`
(RFC 3339, producer clock), `producer` (`control-plane` | `backend:<id>` | `human` | `trigger`), `loopId`,
`loopVersion`, `runId`. Per-node events add `cycle`, `nodeId`, `attempt`. Optional: `causationId`,
`correlationId` (= `runId` unless a sub-run exists), `result` `{status, exitCode?, structured?, summary?}`,
`artifactRefs[]` `{kind: commit|branch|pr|issue|comment|actions-artifact|file, ref, digest?}`, `usage`, `error`
`{code, message, classified}`, `signature` (reserved).

Event types (MVP): `run-requested`, `run-started`, `node-dispatched`, `node-started`, `node-completed`,
`node-failed`, `node-timed-out`, `node-observed`, `human-requested`, `human-decided`, `quota-parked`,
`retry-edge-taken`, `run-finished`, `ignored-stale`, `dispatch-failed`, `resumed`, `lease-expired`.

**Transports.**

| Transport | When | Constraint |
| --- | --- | --- |
| `repository_dispatch` `client_payload` | Default for Loopmill-internal handoffs; the MVP control workflow lives on the default branch | Triggers workflows **only on the default branch** — no ref selection exists |
| `workflow_dispatch` inputs | Feature branches and spikes, where an explicit `ref` is needed | The workflow file must also exist on the default branch to be dispatchable |
| GitHub comment | Human and vendor-cloud surfaces (`observed`) | Envelope only inside a fenced ```` ```loopmill ```` block with `schemaVersion` first, parsed strictly; free text around it is ignored |

Both dispatch transports carry the envelope as one JSON string field named `envelope`. **Size rule:** an
envelope is at most 32 KiB; anything larger travels by `artifactRefs`.

**No implicit chaining.** Loopmill never relies on "a comment happened to trigger a workflow" or on a push to
the state branch re-triggering CI. Every Loopmill-internal handoff is an explicit dispatch. GitHub-native events
(`issues`, `pull_request`, `issue_comment`) are ingested only by an `ingest` workflow that converts them into
envelopes and hands them to `step`.

This is why the two GitHub rules in Context §4 are load-bearing: `GITHUB_TOKEN`-created events do not start
workflow runs **except** `workflow_dispatch` and `repository_dispatch`, which is exactly what lets an agent job
report its own completion without a personal access token; and `repository_dispatch` runs only the default
branch's copy of a workflow, which is why the control workflow must live there and why feature-branch work uses
`workflow_dispatch` with an explicit ref.

**Decision (not in sheet):** the MVP ships four workflows on the default branch —
`.github/workflows/loopmill-step.yml` (one job = one `step`), `loopmill-run-node.yml` (agent job),
`loopmill-ingest.yml` (GitHub-native events → envelopes), and `loopmill-sweep.yml` (scheduled; leases and
`resume --due`). A loop whose `trigger` is `schedule` is fired by a `schedule:`-triggered workflow on the
default branch that emits `run-requested`. Note that GitHub delays scheduled workflows under load and disables
them after a period of repository inactivity — **unverified in this session's briefs**, and a `doctor` check
should assert the schedule is still armed.

**Alternative rejected — chaining on `push` to the state branch.** A push made with `GITHUB_TOKEN` does not
start a workflow run; making it work requires a PAT in the job that pushes, which is the credential D6 removes.

**Alternative rejected — Anthropic Routines' `/fire` endpoint as the bus.** It is a real HTTP trigger with a
per-routine bearer token, and it answers 429 with `Retry-After`, so it is usable. It is rejected as *the bus*
because it is single-vendor: Codex Cloud has no HTTP API at all (SPIKE-2 4c, VERIFIED absence), so a bus only
one runtime can reach is not a cross-vendor bus. It stays available as a future trigger for a Routines-backed
`observed` backend (D1).

**Alternative rejected — a Loopmill-hosted webhook relay or message queue.** Forbidden by D8.

### D5. Run state lives on the orphan branch `loopmill/state`, one commit per applied event

**Layout** (decision sheet §8):

```text
loops/<slug>/index.json                                  run list, dedupe index
runs/<runId>/run.json                                    immutable header: loopId, loopVersion, trigger,
                                                         createdAt, resolved loop-file digest
runs/<runId>/events/NNNNNN-<eventType>.json              immutable, zero-padded 6 digits
runs/<runId>/snapshot.json                               fold of events; rebuildable; snapshotOf: <event no>
runs/<runId>/attempts/<cycle>-<nodeId>-<attempt>.json    per-attempt usage and refs (optional, derivable)
```

One commit per applied event batch, message `step: <runId> #<eventNo> <eventType> <eventId>`, author = the
control plane.

**Atomicity.** The commit is the unit. A job that dies before the push leaves the remote unchanged; a job that
dies after the push but before the dispatch is recovered by the sweep (`lease-expired` → re-dispatch).
Atomicity is per push, not per step, so "no answer" means "unknown" and the caller redelivers; the `eventId`
index makes redelivery safe.

**Conflicts.** Fast-forward-only push (`--force-with-lease` against the SHA read at the start of the step);
rejection means re-read, re-apply, retry. Measured in SPIKE-3: with N simultaneous steps on one run, conflicts
are worst-case N(N-1)/2 (N=4 gave retries 0/1/2/3), and at N=6 one step exhausted the 5-retry budget and exited
without persisting anything. Contention is on the **branch**, not the run, so unrelated runs collide.

**Escalation option.** If measured contention matters, escalate to one branch per run
(`loopmill/run/<runId>`), archived into `loopmill/state` at terminal state. This is a documented option, not the
MVP default.

**Growth and gc.** Measured in SPIKE-3: ~500 B per event file, ~2 KB per snapshot, ~100 KB of packed repository
for a 7-step run including all git overhead — the rewritten snapshot dominates, not the events. Logs, diffs,
prompts and outputs therefore **never** live on the state branch; they go to Actions artifacts, the working
branch, or PR/issue comments, referenced from `artifactRefs`. `loopmill gc` squashes runs older than the
retention window into their snapshot and rewrites the branch; that is the only force-push Loopmill performs.
Steps fetch shallowly once history matters.

**Read model.** `loopmill sync` folds the state branch into a local SQLite database (`node:sqlite`, WAL) used by
`loopmill ui` (read-only) and analytics. SQLite is disposable and rebuildable, and there is **no SQLite in the
control-plane job**.

**Alternative rejected — Actions artifacts as the store.** No compare-and-swap, no cross-workflow transaction,
and artifact retention is capped and expires (retention specifics unverified in this session's briefs). State
that expires is not state.

**Alternative rejected — Issues or PR comments as the store.** Human-editable, rate-limited, no atomic
multi-file write, and by D6 comment bodies are untrusted input — a store must not be something an agent is
allowed to write prose into.

**Alternative rejected — an external database.** A hosted Postgres or equivalent is Loopmill-owned always-on
infrastructure (D8) and moves the user's run history off their own repository.

**Alternative rejected — a subdirectory of the default branch.** Every state write would contend with every code
push, would appear in PR diffs and `main`'s log, would trigger push-based CI, and would be blocked outright by
branch protection (SPIKE-3 README §6). An orphan branch contends only with other state writes.

**Alternative rejected — SQLite as the source of truth** (v0.4 §30). Two GitHub jobs share no filesystem; and
the review had already found that definition-in-rows makes loops unreviewable, unportable and untestable
(`dx-distribution-2`, `daemonless-ops-9`).

### D6. Two job classes, two credentials, and they never meet in one process

| | Control-plane job (`loopmill step`) | Agent job (`loopmill run-node`) |
| --- | --- | --- |
| GitHub permissions | `contents: read`, `actions: write` | `contents: write`; `pull-requests: write` / `issues: write` only for `effects: external` nodes |
| State branch | Pushes it, using a dedicated deploy key with write access, stored in the `loopmill-control` environment. A branch ruleset on `loopmill/state` blocks all other pushes. (Later: a GitHub App installation token.) | No deploy key; therefore cannot push `loopmill/state` at all |
| Vendor credential | **None** | The vendor subscription credential, from the `loopmill-agent` environment |
| Reports completion | n/a | By `repository_dispatch` / `workflow_dispatch` with `GITHUB_TOKEN` — the documented exception to the rule that `GITHUB_TOKEN` events do not start workflows |

**Human gates map to GitHub primitives**, so that waiting costs nothing and nothing is resident: before
execution → a GitHub Environment `loopmill-agent-external` with required reviewers (the job waits); PR
acceptance → a pull request review; an arbitrary hold → the label `loopmill:hold` or an explicit
`workflow_dispatch`. The approval subject is the artifact digest recorded in the `human-requested` event, and a
retry invalidates prior approvals.

**Untrusted input.** Everything an agent reads from issues, PRs, comments, web pages or reviewed content is
untrusted. Loopmill's injection scanner **marks but never sanitises**. Nodes with `effects: external` require a
human gate unless `approval.policy: auto` is set with a reason. Fork PRs never receive secrets (GitHub
default).

**Environment policy for agent subprocesses.** Deny: all vendor auth-override variables —
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`,
`CODEX_CONNECTORS_TOKEN`, plus `GH_TOKEN` unless the node is external. Preserve: `PATH`, `HOME`, `SHELL`,
`LANG`, `TZ`, proxies, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`. Inject: node-scoped values only. `doctor` and every
report show the effective auth mode per node execution and flag account-level metered overage ("extra usage" /
credits) as `meteredOverageEnabled`.

**Redaction.** Secrets never enter the state branch, envelopes, or logs; `sk-ant-`, `oat01` and `sk-` patterns
are redacted from every captured stream before persistence.

**Alternative rejected — one job that decides and executes** (v0.4's runner). It would hold the vendor
credential and the state-write credential in one environment, with an agent that reads untrusted content and
could therefore rewrite its own audit trail.

**Alternative rejected — a PAT for state pushes.** A PAT is user-scoped and typically cross-repository; a deploy
key plus a branch ruleset is scoped to one repository and one branch and makes the write path auditable.

**Alternative rejected — `claude-code-action` / `codex-action` as the agent job.** The sheet forecloses it
(§4): usage, structured output and exit codes must be captured by Loopmill itself, and neither action surfaces
them in the shape D3 and the usage record require.

### D7. MVP backends, and what is explicitly experimental

| Backend | Runtime | Status | Notes |
| --- | --- | --- | --- |
| `github-actions` | `claude-code` | **MVP, primary** | `loopmill run-node` invokes the CLI directly, never via a vendor action; `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`; **never `--bare`**. Capabilities: on-demand, returned + streamed log, usage full, quotaSignal classified, structuredOutput true, retryable, cancellable, isolation ephemeral, credential in job secret. Gated on SPIKE-1 |
| `observed` | `codex` (Codex Cloud) | **MVP, gated on SPIKE-2** | Loopmill only (a) emits the trigger — an `@codex` comment, or `codex cloud exec` where a vendor credential is present — and (b) observes a GitHub artifact until a deadline. Artifact matcher: a fenced `loopmill` JSON block in a comment, or a JSON file at a declared path in the diff/PR. Completion: matcher plus `codex cloud list --json` status where available; deadline → `TIMED_OUT`; matcher failure → `FAILED` with `artifact_invalid`. usage `none` → provenance `unavailable`; quotaSignal `none`; structuredOutput false; retryable (a new task each time); not cancellable; isolation and credential vendor-side |
| `local` | both | **MVP** | The same `loopmill run-node` on the maintainer's machine for manual runs and debugging. **No OS scheduler, no reconcile, no launchd/systemd/Task Scheduler code in the MVP.** Isolation worktree; credential on the user machine |
| `fake` | `fake` | **MVP** | Fixture-replaying backend shipped in the package; usage full and deterministic; makes the engine, retry edges, `maxIterations`, dedupe and the sweep testable in CI for zero tokens |
| `github-actions` | `codex` (seeded `auth.json` under `CODEX_HOME`) | **EXPERIMENTAL, behind a flag** | Gated on SPIKE-2b: refresh-token survival on ephemeral runners, plus the R11 terms reading |
| any | any, `authMode: api-key` | **Opt-in only** | Never the default, never silent; surfaced as metered in every report |

The `observed` backend is the one place where this ADR knowingly diverges from a supporting document: SPIKE-2's
own assessment is "VIABLE-WITH-CAVEATS — but not for the MVP", recommending a post-MVP experimental adapter.
The decision sheet (§4, §11) keeps `observed` in the MVP, gated on the R-runs. The sheet wins; the disagreement
is recorded so the gate is taken seriously — `NO-GO` on R4 or R7 moves it out.

**Alternative rejected — Codex Automations as the trigger.** GitHub-event-triggered Codex runs exist and are
plan-backed, including a "commit updates" trigger (SPIKE-2 2d, 10a, LIKELY), but they are configurable only in a
web UI, cannot be scripted, cannot be combined with a schedule, are unavailable in the CLI/desktop/IDE, and
report to the app's Triage inbox rather than to GitHub. Loopmill could neither create, version, nor observe
them, which is the opposite of a control plane.

**Alternative rejected — `openai/codex-action` with `OPENAI_API_KEY` as the default Codex path.** It works and
is documented, and it supports `--output-schema`, but it is metered API billing, which contradicts the
positioning. It remains reachable only under `authMode: api-key`.

**Alternative rejected — the private ChatGPT backend routes** (`POST /backend-api/wham/tasks` and the
`/wham/usage/...` endpoints). They are VERIFIED to exist and would supply the usage numbers `observed` lacks.
They are unversioned, undocumented and private; calling them is precisely the "programmatic access" the vendor
terms discourage. Loopmill calls the CLI, never these URLs.

### D8. "Daemonless" is redefined as "no Loopmill-owned always-on infrastructure"

v0.4's meaning was "no resident Loopmill process on the user's machine; scheduling is delegated to the OS"
(§5.2, §5.3, §26, §27). v0.5's meaning is:

> Loopmill requires no server, daemon, queue, scheduler or database **that Loopmill owns** and that must be
> running for a loop to make progress. Resident infrastructure the user already has — GitHub's scheduler,
> event delivery and job runners; the vendors' own clouds — is used rather than reimplemented.

Two consequences follow. First, Loopmill's own process model becomes *stricter*, not looser: every Loopmill
process is started by an event and exits — `step`, `run-node`, `sync`, `gc`, `validate`. There is no `runLoop`,
no resident runner, no long-lived UI server in the execution path. Second, the OS-scheduler work of v0.4 §26-§28
leaves the MVP entirely: no launchd, systemd or Task Scheduler code, and no `reconcile` catch-up authority,
because the schedule no longer lives on a machine that can be off.

**Decision (not in sheet):** wherever "daemonless" appears in user-facing text it must carry this definition in
the same paragraph. v0.4's readers will otherwise import the old meaning, which is now false in one direction
(GitHub's runners are resident) and true in a stronger one (nothing Loopmill owns is).

**Alternative rejected — keeping "daemonless = the OS scheduler".** It is the claim that fails the "PC must be
on" requirement, and it is no longer differentiating: Anthropic's Desktop scheduled tasks ship local scheduling
with worktree isolation and missed-run catch-up, free with the subscription (`claude-code-cli.md` #74, #75).

---

## Consequences

### Positive

- Unattended progress no longer depends on the user's machine being powered on. This is the requirement the
  whole ADR exists to satisfy.
- The audit trail is a git history: one commit per applied event, immutable event files, and a snapshot that is
  provably the fold of the log. SPIKE-3's local harness asserts exactly this (tests 1, 8, 19 — 20/20 passing,
  2026-09-06).
- Correctness does not depend on a lock service. Compare-and-swap on a branch ref gives all-or-nothing
  semantics with no infrastructure, and a lost race is always recoverable because the retry re-plans rather than
  replaying a stale plan.
- The control plane is testable offline: `fake` backend plus the `local-dir` StateStore exercise the engine, the
  retry edge, `maxIterations`, dedupe, stale events and the sweep in CI, for zero tokens and no subscription.
- The security boundary is enforced by GitHub primitives — environments, required reviewers, branch rulesets,
  per-job permissions — rather than by Loopmill code that would have to be trusted.
- Cross-vendor stays possible, because the bus is vendor-neutral: an Envelope in a `repository_dispatch` payload
  and an Envelope in a fenced comment block are the same record.
- Nothing to operate, pay for, or secure at idle.

### Negative

- **One step is one job.** Every event pays job-queue and runner-startup latency and consumes Actions minutes; a
  seven-step run is seven jobs. The per-step overhead has not been measured on real GitHub infrastructure
  (SPIKE-3, open).
- **Contention is on the branch, not the run.** Unrelated runs collide on the state branch head, and the
  measured conflict curve is quadratic in concurrent writers. The per-run concurrency group keeps N at 1 in
  normal operation, but the design must never depend on it.
- **Observed nodes report no usage at all** (SPIKE-2 8a, VERIFIED absence). Any Run containing a Codex Cloud
  node has usage coverage below 100%, so every token headline in that Run is a lower bound
  (`Measured Tokens: <sum>+`, with `Usage Coverage: n/m`). This is a direct cost to the observability
  differentiator, paid to keep the cross-vendor one.
- **Debugging crosses three surfaces**: the Actions run log, the state branch, and the vendor's own cloud UI.
  `loopmill status` and `loopmill logs` have to reconcile them.
- **GitHub becomes a hard dependency for the MVP unattended path.** The `StateStore`/`Dispatcher` interfaces
  bound the damage to two adapters, but they do not remove the dependency.
- **Actions minutes on private repositories are metered** (specifics unverified in this session's briefs), which
  puts a second, non-vendor cost on a product positioned around not paying per use.
- **v0.4's local-first promise is weakened**: repository contents, prompts and agent output now transit
  GitHub-hosted runners and, for `observed` nodes, the vendor's cloud. "The code never leaves your machine" is
  no longer claimable for the unattended path, and the docs must say so plainly.
- The MVP now needs GitHub-side setup (a deploy key, a branch ruleset, two environments, four workflows) before
  the first run. The 15-minute first-run path the review asked for (`product-scope-8`) is harder, not easier.

### Risks, and the spike that retires each

| # | Risk | If it lands | Retired by |
| --- | --- | --- | --- |
| R1 | `claude -p` with `CLAUDE_CODE_OAUTH_TOKEN` does not run headless on a hosted runner with usage JSON and structured output | `github-actions` loses its primary runtime → decision sheet STOP condition (a) | **SPIKE-1** |
| R2 | `--bare` becomes the `-p` default; in bare mode Claude Code ignores OAuth and `CLAUDE_CODE_OAUTH_TOKEN` (#22, verified as a documented intention) | Subscription auth dies silently in CI on a routine CLI upgrade | **SPIKE-1**, plus a pinned minimum runtime version and a `doctor` assertion that fails loudly |
| R3 | Codex: R4 (result reaches GitHub without a human click) or R7 (`ready` distinguishable from `error`, bounded in time) fails | `observed` is NO-GO; the MVP is Claude-only cross-role and "cross-vendor" is deferred → STOP condition (b) must be evaluated honestly | **SPIKE-2** (GO requires R1 ∧ R4 ∧ R5 ∧ R7 ∧ (R3 ∨ R8)) |
| R4 | Seeded `auth.json` refresh tokens do not survive ephemeral runners | `codex` on `github-actions` stays experimental indefinitely; Codex is reachable only as `observed` or `local` | **SPIKE-2b** |
| R5 | CAS on the state branch, or `GITHUB_TOKEN` dispatch chaining, does not behave on real GitHub as the local harness and the docs say | D2 and D5 change (batching several transitions per job, or a different store); the positioning does not | **SPIKE-3 GitHub run** |
| R6 | The `repository_dispatch` default-branch restriction blocks feature-branch development of the control workflow | Development uses `workflow_dispatch` with an explicit ref — already the spike's fallback path | **SPIKE-3 GitHub run** |
| R7 | Per-step runner overhead makes a 12-step loop cost hours of wall clock | "One step = one event = one job" becomes "one job applies a bounded batch of events"; the transition function and the store are unaffected | **SPIKE-3** (per-step overhead measurement) |
| R8 | One cloud task silently burns a whole 5-hour window, with work auto-reverted (SPIKE-2 9c, UNVERIFIED; `openai/codex` issue #6354) | A single loop can consume the user's day of subscription capacity | **SPIKE-2 R6**, plus the sheet's budget guards (`maxRunsPerWindow`, `minInterval`, `maxUnmeasuredExecutions`) |
| R9 | Vendor terms, once read verbatim, forbid the single-user unattended use Loopmill relies on | Decision sheet STOP condition (c) | **SPIKE-2 R11** and the open items in SPIKE-2 §5, executed by a human on an unrestricted network |
| R10 | State-branch contention or growth exceeds what a single branch tolerates | Escalate to one branch per run (`loopmill/run/<runId>`), archived at terminal state — already specified as a documented option | **SPIKE-3**, re-measured during the m2 seven-night soak |

---

## Compliance notes

These are the constraints on what the project may *say*, which are stricter than the constraints on what it may
*do*. All quotes carry their access date; nothing here is a legal opinion.

**What Loopmill may claim today.**

- That it runs the **unmodified official CLIs**, authenticated by the user's own login or token, on the user's
  own repository. Anthropic's policy page contains the carve-out this depends on, verbatim: *"Nor does it
  prevent an end user from signing in to the **unmodified Claude Code binary** with their own Claude
  subscription…"* (code.claude.com/docs/en/legal-and-compliance, accessed 2026-09-06; research brief
  `claude-code-cli.md` #67, verified verbatim).
- That Anthropic **documents** `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` as the mechanism for CI and
  scripts, that it requires a Pro/Max/Team/Enterprise plan, that it is inference-only, and that **subscription
  billing applies** to runs made with it (code.claude.com/docs/en/authentication, accessed 2026-09-06;
  `claude-code-cli.md` #45, verified). Loopmill may state that this is Anthropic's own documented CI mechanism.
- That it may say **in plain text** that it runs Claude Code, but may not use the Claude Code or Anthropic names
  or logos in a product, feature or company name or logo (`claude-code-cli.md` #69, verified).

**What Loopmill may not claim until the terms are read verbatim.**

- That either vendor **permits, endorses or supports** unattended, scheduled, subscription-backed agent loops in
  general. Anthropic's own wording cuts the other way in two places: *"Advertised usage limits for Pro and Max
  plans assume **ordinary, individual usage** of Claude Code and the Agent SDK"* (#64, verbatim) and
  *"Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior
  notice"* (#70, verbatim). The project's defence is its defaults stated as policy — one agent at a time, human
  cadence, `minInterval`, `maxRunsPerWindow`, no automatic merge — not a permission claim.
- **Anything about OpenAI's terms.** Every OpenAI primary source — `openai.com/policies/terms-of-use/`,
  `row-terms-of-use`, `help.openai.com/en/articles/11369540`, `developers.openai.com/codex/*` — was
  EGRESS-BLOCKED from this environment on 2026-09-06 (403 on CONNECT, proxy status `connect_rejected`). The
  strongest available signal is **LIKELY**, from a search-index summary rather than a fetched page: OpenAI
  documents *"Maintain Codex account auth in CI/CD (advanced)"*, with the caveat that "the right way to
  authenticate automation is with an API key, and this guide should only be used if you specifically need to run
  the workflow as your Codex account" (SPIKE-2 item 11c). Loopmill's README must quote that caveat as OpenAI's
  own words **and mark it as unverified until a human reads the page**, per SPIKE-2 §5 and SPIKE-2 R11.
- That Loopmill's token or cost figures are billing figures. Anthropic labels `total_cost_usd` a client-side
  estimate and states: *"Do not bill end users or trigger financial decisions from these fields"*
  (`claude-code-cli.md` #34, verified). Hence the sheet's rule: no USD in any headline view;
  `listPriceEquivalentUsd` is stored for internal normalisation only, hidden by default.

**Operating rules that follow.**

- Loopmill never collects, stores, caches, relays or transmits a vendor credential. Anthropic's policy is
  explicit that developers *"may not collect, store, or intermediate Claude.ai credentials or session tokens —
  sign-in to a Claude account must complete through Anthropic's own flow"* (#66, verbatim). The
  `CLAUDE_CODE_OAUTH_TOKEN` is minted by the user with `claude setup-token` and placed by the user into their
  own GitHub Environment secret; Loopmill reads it only as an environment variable inside the user's own agent
  job, and never writes it anywhere.
- Loopmill never calls a vendor's private endpoints (`/backend-api/wham/...`), never modifies a vendor binary,
  never ports unofficial auth cookies into CI, and never passes `--bare`.
- The docs carry a policy page with these quotes verbatim, their URLs and their access dates, and a statement of
  which rows are unverified. If SPIKE-2 R11 comes back prohibitive for a vendor, the response is to ship that
  runtime with a documented warning or to ship single-vendor — not to add a metered mode mid-MVP.

---

## Appendix A — How this changes the v0.4 document

`docs/design/mvp-design.md` (v0.4) stays in the repository as a superseded document. The mapping:

| v0.4 section | Disposition | Where it now lives |
| --- | --- | --- |
| §5.1 Subscription-native | Kept, narrowed to what Loopmill controls | D1 (`authMode`), D6 (env policy), Compliance notes |
| §5.2 Local-first | **Demoted from a principle to one backend** | D1, D7 (`local`), D8 |
| §5.3 Daemonless / Zero-idle | **Redefined** | D8 |
| §5.4 Observable | Kept; usage coverage becomes explicit | D3 (`usage` capability), decision sheet §10 |
| §7 Subscription Only Mode | Replaced by a three-part env policy plus an auth-mode field | D6, D1 |
| §8 Agent Runtime | **Split into three axes** | D1, D3 |
| §9 Authentication Model | Kept in substance; token handling made explicit | D1, D6, Compliance notes |
| §10 Runtime Health / §37 Doctor | Kept; must probe the job's environment, not a shell | D6 (auth mode per node execution, `meteredOverageEnabled`) |
| §11 Visual Loop Builder | Out of the MVP | decision sheet §11 (post-MVP) |
| §12 Node types, §13 hierarchy, §14 states | Superseded by the loop file, the domain model and the state machine | decision sheet §2, §3, §5 (not this ADR) |
| §26 Daemonless Scheduling | **Deleted from the MVP** — no launchd, systemd or Task Scheduler code | D4 (schedule trigger on GitHub), D8 |
| §27 Zero-idle Architecture | Replaced by the non-resident step | D2, D8 |
| §28 Missed Schedule Reconciliation | Replaced by lease expiry and the sweep | D2, D4 (`loopmill-sweep.yml`) |
| §29 Runner / UI Separation | Replaced by control-plane job vs agent job, plus a read-only UI over the read model | D6, D5 |
| §30 Persistence (SQLite is the store) | **Reversed**: the store is the state branch; SQLite is a disposable read model | D5 |
| §31 Runner / UI Coordination (SQLite as IPC) | Removed; components communicate only by Envelope | D4, D5 |
| §32 Control Queue | Replaced by envelope event types and GitHub-native human gates | D4, D6 |
| §33 Git / GitHub (`git`/`gh` from nodes) | Kept, but confined to the agent job, and only for `effects: external` nodes with the matching permission | D6 |
| §34 Workspace (shared, one agent) | Replaced by a declared `isolation` capability per backend | D3, D7 |
| §35 Safety Limits | Superseded by the budget model | decision sheet §10 (not this ADR) |
| §36 CLI | `run`/`resume`/`reconcile` replaced by `step`, `run-node`, `validate`, `sync`, `gc`, `status`, `backends`; exit codes are now a contract | D2 |
| §38 Technology / §39 Deployment | Local machine is no longer the deployment target for unattended runs | D7, D8 |
| §40 Future Remote Mode | Withdrawn as framed — there is no Loopmill remote to sync to | D8 |
| §44 Acceptance Criteria | Superseded, with the review's additions carried | decision sheet §11 |
| §47 Product Differentiation | Superseded | decision sheet §1 |
