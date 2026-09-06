# Spikes

Status as of 2026-09-06. This page indexes Loopmill's pre-MVP spikes: what each one
is trying to prove, what it has proven so far, and what is still outstanding before
the m0 "spikes and contract freeze" milestone can close.

## 1. Purpose and STOP conditions

Loopmill's design (`docs/design/mvp-design.md`, pinned by the v0.5 decision sheet)
rests on assumptions that no amount of reading vendor docs can settle: that a
subscription-authenticated agent CLI runs unattended on a throwaway CI runner, that
more than one vendor can be driven this way, and that a control plane with no
resident process can stay correct under concurrent and duplicate delivery. The
spikes exist to test those assumptions against a real runner and real CLIs before
committing to them in code.

The decision sheet defines three conditions under which a spike must overturn the
design rather than just annotate it:

- **(a)** No subscription-backed runtime can run unattended on any hosted backend.
- **(b)** No cross-vendor path exists under subscriptions, and the only working
  shape is "GitHub Actions + API keys" — which `claude-code-action`/`codex-action`
  already provide, leaving Loopmill nothing new to build.
- **(c)** Vendor terms, once read verbatim, forbid the single-user unattended use
  Loopmill relies on.

If a spike result honestly meets one of these, the fix is to revisit the decision
sheet's positioning (section 1) and scope (section 11), not to route around the
finding.

## 2. Spike overview

| ID | Question | Status | Gate it retires | Owner |
|---|---|---|---|---|
| SPIKE-1 | Does `claude -p` run headless on a GitHub-hosted runner authenticated only with `CLAUDE_CODE_OAUTH_TOKEN`, with usable usage JSON and structured output? | Ready — harness built, not yet run | STOP (a); decides whether `github-actions` keeps Claude Code as its primary runtime (decision sheet §4, §11) | Maintainer (needs a `claude setup-token` from their own subscription, stored as a repository secret) |
| SPIKE-2 | Can Loopmill drive a Codex node on OpenAI's cloud under a ChatGPT subscription, get a machine-readable result onto GitHub, and re-trigger it, without an API key? | Documentary research done; R0-R11 user run plan not yet executed | Decides the `observed` backend (decision sheet §4, §11); feeds STOP (b) | Maintainer (needs a real ChatGPT Plus/Pro account and manual web-UI steps) |
| SPIKE-2b | Does a seeded Codex ChatGPT `auth.json` survive refresh-token rotation on an ephemeral GitHub-hosted runner? | Documentary groundwork done (status table item 4d); not yet run | Decides whether `codex` on `github-actions` can leave EXPERIMENTAL status (decision sheet §11) | Maintainer (needs a real ChatGPT login to seed `auth.json` once) |
| SPIKE-3 | Can `loopmill step` be a non-resident, event-sourced process that stays correct under duplicate, concurrent, and interrupted delivery, chained purely by GitHub Actions? | Measured — 20/20 local tests, 22 hosted workflow runs | Confirms/adjusts decision sheet §6 (control-plane algorithm, exit codes) and §8 (state persistence); does not change positioning | Automated — a simulated backend, no vendor credentials required |

Status legend: **ready** = harness exists, nothing has been executed against a real
account yet; **documentary done** = everything answerable by reading source/binary
without a live subscription has been answered; **measured** = the harness has
actually been run (locally, on a hosted runner, or both) and produced numbers.

---

## 3. SPIKE-1 — Claude Code on subscription OAuth only

Location: `spikes/spike-1-claude-subscription/` (`README.md`, `run.sh`); workflow
`.github/workflows/spike-1-claude-subscription.yml`.

### What it proves

Whether the official Claude Code CLI, authenticated with nothing but a subscription
OAuth token minted by `claude setup-token`, can act as Loopmill's agent node
executor on a throwaway, non-interactive, no-TTY GitHub Actions runner — with
machine-readable usage, cost, and structured output, and a legible exit-code
contract. This is the harness for the `github-actions` execution backend's
`claude-code` runtime as specified in decision sheet §4.

### Prerequisites

1. A Claude **Pro, Max, Team, or Enterprise** subscription — the OAuth token is
   subscription-only and does not work on the Free plan.
2. Locally, with Claude Code already logged in interactively: run `claude
   setup-token` and copy the printed token immediately (it is shown once and never
   stored by the CLI).
3. Add it as the repository secret `CLAUDE_CODE_OAUTH_TOKEN` (GitHub repo →
   Settings → Secrets and variables → Actions). Never commit it; it is a bearer
   credential with no revoke command short of rotating the Claude account session.
4. Nothing else — the workflow installs Node 22 and the CLI itself.

**This is the one prerequisite the harness cannot supply itself: the workflow
exists and is ready, but it has not been run because the secret has not yet been
provisioned.**

### How to run

```bash
gh workflow run spike-1-claude-subscription.yml --ref <branch> \
  -f model=sonnet -f scrub_test=true

gh run watch
gh run download <run-id> -n spike-1-results -D ./spike-1-out
cat ./spike-1-out/RESULTS.md
```

The workflow only runs on `workflow_dispatch` (it spends real tokens against the
maintainer's subscription, so it never runs on push or PR). The harness's structure
can be sanity-checked with no tokens spent via `SPIKE_DRY_RUN=1 bash
spikes/spike-1-claude-subscription/run.sh`, which prints every command it would
run and still produces a `RESULTS.md`.

### Checks C1-C10 mapped to design questions

| Check | What it runs | Design question it answers |
|---|---|---|
| C1 | `claude auth status --json` | Subscription-only auth in CI, no API key anywhere — the precondition for `authMode: subscription-oauth` (§2, §11). |
| C2 | `claude -p ... --output-format json`, no TTY | The `usage`/cost/turn/session fields Loopmill's Usage record needs per Attempt (§10, claude-code mapping). |
| C3 | Same, plus `--json-schema` | Whether structured output is schema-conformant and usable directly by a `condition` node, per the loop file's `structuredOutput` validation rule (§3). |
| C4 | Same, `--output-format stream-json --verbose` | The streaming event shape a backend's `result: streamed` capability (§4) would expose, and that it still ends in the same result object as C2. |
| C5a | Tool-using prompt, `--max-turns 1` | Exit-code contract part 1: whether a turn cap ends as success or a distinguishable cutoff — feeds Node Execution / Attempt states (§5). |
| C5b | Deliberately invalid `--model` | Exit-code contract part 2: invalid arguments must fail loudly, never silently substitute — same state-machine boundary. |
| C6 (sigint/sigterm/timeoutint) | Kill a long-running turn after 8s with each signal | Which signal `cancel(runId)` (§4, `cancellable: true`) must send to keep usage on a cancelled node. |
| C7 | `setsid` + `/dev/null` stdin, 120s watchdog | Whether the no-TTY hang bug (anthropics/claude-code#9026) reproduces on hosted runners — a direct test of `invocation: on-demand` viability. |
| C8 (bad/good) | Invalid `ANTHROPIC_API_KEY` alongside the OAuth token, then without it | The env-precedence fact Loopmill's environment deny-list (§9) depends on: that an API key would silently override the subscription login if not scrubbed. |
| C9 | Grep output for a plan-limit message | Whether a quota hit is distinguishable from any other failure — feeds the `WAITING_FOR_QUOTA` rule (§5) and its string-pattern matching. |
| C10 | `node`/`claude` versions, `uname`, TTY, config env | Baseline environment record for reproducibility; supports `doctor`'s effective-auth-mode reporting (§9). |

### Pass/fail criteria

Each check gets one of five statuses: **PASS** (matched what was expected or
documented — including a few checks where the *documented failure* is the correct
outcome, e.g. C8-bad, C6-sigterm), **FAIL** (diverged — worth reading the raw
`.summary.json`/`.err`), **INFO** (observational, no single correct outcome: C5a,
C6-timeoutint, C9, C10), **SKIPPED** (C8 when `scrub_test: false`), or **DRY-RUN**.

**Overall verdict rule:** the spike counts as a pass for Loopmill's design if C1,
C2, C3, and C4 are PASS (subscription-only auth, JSON usage, structured output,
streaming all hold) and C7 is PASS (no hang). A FAIL on C1 or C2 means the core
premise needs revisiting before anything else here matters; a FAIL on C7 is a real
blocker for CI-based Loopmill usage. C5, C6, C8, and C9 are expected to surface
useful detail regardless of outcome — a FAIL there is a design input, not
necessarily a reason to abandon the approach.

### Results

**Not yet run.**

| Check | Status | Notes |
|---|---|---|
| C1 auth | not yet run | |
| C2 plain JSON | not yet run | |
| C3 structured output | not yet run | |
| C4 stream-json | not yet run | |
| C5a exit code (tool use, max-turns 1) | not yet run | |
| C5b exit code (invalid model) | not yet run | |
| C6 SIGINT | not yet run | |
| C6 SIGTERM | not yet run | |
| C6 timeout -s INT | not yet run | |
| C7 no-TTY hang probe | not yet run | |
| C8-bad (API key precedence) | not yet run | |
| C8-good (OAuth-only confirmed) | not yet run | |
| C9 quota probe | not yet run | |
| C10 environment | not yet run | |

**Overall:** not yet run — blocked on the maintainer provisioning
`CLAUDE_CODE_OAUTH_TOKEN` as a repository secret.

---

## 4. SPIKE-2 — Codex Cloud as an observed execution backend

Research artifact prepared 2026-09-06 against Codex CLI v0.153.4 source and binary
(`openai/codex` at commit `9587c9ef366bd678ea5e9310f59ec33fdc44df7e`) and the
`openai/codex-action` README. OpenAI's own documentation pages
(`developers.openai.com`, `help.openai.com`, `chatgpt.com`) were unreachable from
the research environment (egress blocked, re-confirmed on the day), so every claim
sourced only from those pages is marked LIKELY, not VERIFIED, and needs a human
re-read before Loopmill makes any public claim from it.

### Status table (condensed, items 1-11)

Legend: **VERIFIED** = read from the CLI binary or source tree · **LIKELY** =
consistent across a blocked page's search-index summary plus an independent
source · **UNVERIFIED** = single weak source · **NEEDS-USER-RUN** = only
decidable with a live ChatGPT subscription.

| # | Item | Status | Implication |
|---|---|---|---|
| 1a | Cloud tasks run under ChatGPT-plan auth only; API key env vars are structurally rejected | VERIFIED | Enforced by OpenAI itself — matches Loopmill's `subscription-login` auth mode and its environment deny list with no extra work. |
| 1b | Base URL locked to `chatgpt.com`/`chat.openai.com`/`chatgpt-staging.com` | VERIFIED | No self-hosting; "observed" always means OpenAI's own cloud. |
| 1c | Cloud tasks share the same 5h/weekly plan windows as local Codex and ChatGPT Work | LIKELY | A cloud loop and a local loop compete for one budget — concurrency defaults matter more, not less. |
| 1d | Codex Cloud is Plus/Pro/Business/Enterprise only | LIKELY | Loopmill must detect plan type (`account/rateLimits/read` → `planType`) before offering the backend. |
| 1e | Separate daily/run cap on cloud tasks | UNVERIFIED / NEEDS-USER-RUN | No cap constant found anywhere; must be measured (R6). |
| 2a | Two automation shapes exist: standalone (reports to the app's Triage inbox) and thread automations | LIKELY | A standalone automation does **not** land on GitHub unless its prompt explicitly uses the GitHub connector. |
| 2b | Typed scheduled-task schema is `Hourly`\|`Daily`\|`Weekdays`\|`Weekly`, with IANA timezone | VERIFIED (typed schema) | Hourly is the minimum first-party interval — fine for nightly loops, too coarse for a fast retry loop. |
| 2c | UI may also offer minute intervals and custom cron for thread automations | LIKELY | Not in any reachable typed schema; verify with run R2 before designing around it. |
| 2d | GitHub PR-activity event triggers exist (added 2026-08-25), Plus/Pro+ only, web/mobile-configured only, cannot combine with a schedule | LIKELY | The single most important row: a plan-backed GitHub-event trigger exists, but Loopmill cannot create, version, or observe it. |
| 3a | A cloud task's repo comes from a Codex Cloud "environment" bound via the GitHub App | VERIFIED | Loopmill needs one `env_…` id per repo, created out-of-band in the Codex web UI; `codex cloud exec --env` accepts an id or label. |
| 3b | The backend models linked pull requests | VERIFIED | ...but the CLI never surfaces those fields — a PR link must come from `gh`, not `codex cloud`. |
| 3c | Default sink may be a task-local diff, not a GitHub object; PR creation may need an explicit prompt | LIKELY / NEEDS-USER-RUN | The decisive open question for the whole backend — settled by run R4. |
| 3d | GitHub connector exposes issue read/comment/create_pull_request, not create_issue | LIKELY | A cloud task cannot open an Issue, only comment on one. |
| 3e | `@codex`/`@codex review` PR or issue comments dispatch a cloud task; `@codex review` posts a real review | LIKELY | A working external trigger reachable from an Actions job with only `GITHUB_TOKEN`. |
| 4a | `codex cloud exec --env` creates a real task from a non-interactive process | VERIFIED | The single biggest positive finding: cloud tasks can be dispatched with no daemon and no API key. |
| 4b | Underlying endpoint is private/undocumented (`POST .../wham/tasks`) | VERIFIED | Loopmill must call the CLI, never this endpoint directly. |
| 4c | No public REST API, webhook, MCP tool, or app-server method for cloud tasks | VERIFIED (absence) | `codex cloud exec`, a GitHub comment, or a web-UI automation are the only entry points — no HTTP "fire" equivalent. |
| 4d | CI/CD auth for a Codex account requires seeding `auth.json`, with OpenAI recommending a persistent self-hosted runner | LIKELY | Ephemeral GitHub-hosted runners are a poor fit for this — exactly what SPIKE-2b tests. |
| 5a | Best-of-N attempts (1-4) at creation | VERIFIED | A cheap built-in "try it N ways", at N× plan consumption. |
| 5b | No CLI way to re-run or follow up an existing cloud task | VERIFIED (absence) | Every retry on the cloud backend is a brand-new task id; the Retry Edge cannot reuse a task. |
| 5c | Follow-up messages exist only in the web/desktop app | LIKELY | Human-in-the-loop only, not automatable. |
| 5d | A manual "Run now" may exist for automations | LIKELY / NEEDS-USER-RUN | If it has no CLI/HTTP form it is a human escape hatch only. |
| 6a | No structured-output/JSON-schema option for cloud tasks | VERIFIED (absence) | The Structured Output field would be empty for every cloud node. |
| 6b | Workaround: have the prompt write a JSON file into the diff/PR | LIKELY / NEEDS-USER-RUN | The viable design shape — "the artifact is a file in the diff" — measured by R5. |
| 7a | Every task has a stable id and a browser URL; `codex cloud exec` prints exactly that URL | VERIFIED | Clean run-identifier story: the printed URL is the run handle. |
| 7b | `codex cloud list --json` gives a machine-readable four-state enum (pending/ready/applied/error) | VERIFIED | This is the completion signal to poll. |
| 7c | `codex cloud status` is text-only, no `--json`, and exits 1 for anything but `ready` | VERIFIED | A trap: pending, error, and already-applied all collapse to exit 1 — must poll `list --json` instead. |
| 7d | No push notification, webhook, or completion callback | VERIFIED (absence) | Polling only; fine for a daemonless design, but costs a process spawn plus a round trip per poll. |
| 8a | Token usage is not exposed anywhere in the `codex cloud` CLI | VERIFIED (absence) | A direct hit on Loopmill's loop-observability differentiator — cloud nodes record `usage: unavailable` and lower the Run's usage coverage. |
| 8b | The private backend does have usage endpoints | VERIFIED (endpoints exist) | Whether a task id works as a `thread_id` there is unverified; do not build on undocumented private routes. |
| 8c | A usage panel exists in the ChatGPT UI | LIKELY / NEEDS-USER-RUN | Human-visible only, not machine-readable. |
| 9a | `codex cloud` surfaces no quota signal at all | VERIFIED (absence) | `WAITING_FOR_QUOTA` cannot be detected per-task on this backend. |
| 9b | Account-level reset time IS exposed via `account/rateLimits/read` | VERIFIED | The design answer: read the account, not the task — `usedPercent`/`resetsAt` works for cloud and local alike. |
| 9c | Reported behaviour at the plan wall mid-task is destructive (quota burned, work reverted, silent failures) | UNVERIFIED / NEEDS-USER-RUN | Must be probed directly (R6) before trusting the backend with real work. |
| 10a | Automations can trigger on PR commit updates | LIKELY | Shipped, plan-backed, but web-UI-only — not scriptable. |
| 10b | Cleanest re-trigger: an Actions job on `pull_request: [synchronize]` posting `@codex review` | LIKELY | Subscription-backed execution, output on the PR, zero ChatGPT credential on the runner. |
| 11a | Primary OpenAI terms/limits pages | BLOCKED (re-attempted, still 403) | No public compliance claim can be made from this environment; must be re-verified with unrestricted network. |
| 11b | ChatGPT Terms of Use prohibit programmatic data extraction and "powering a third-party service" | LIKELY | The clause to stay clear of; the framing that Loopmill drives a user's own CLI for their own repo must be explicit in docs, not assumed. |
| 11c | OpenAI documents (and discourages) "Maintain Codex account auth in CI/CD (advanced)" | LIKELY (strongest available signal) | The closest thing to permission that exists; quote its caveat verbatim rather than claiming blanket approval. |
| 11d | Unattended scheduled Codex on a ChatGPT plan (Automations) is a first-party, shipped product | VERIFIED (product exists) | Unattended subscription-backed Codex is something OpenAI itself sells; the residual risk is about who does the scheduling. |

### The `codex cloud` CLI surface (v0.153.4)

Marked `[EXPERIMENTAL]` in `codex --help`. Five subcommands:

```
codex cloud                                   # TUI: browse tasks, New Task, Select Environment, Parallel Attempts, Diff
codex cloud exec   --env <ENV_ID> [QUERY]     # create a task; QUERY may be "-" or piped stdin
                   [--branch <BRANCH>] [--attempts <1..4>]
codex cloud list   [--env <ENV_ID>] [--limit <1..20>] [--cursor <CURSOR>] [--json]
codex cloud status <TASK_ID>                  # text only; NO --json
codex cloud diff/apply <TASK_ID> [--attempt <N>]
```

Contracts worth designing against: ChatGPT sign-in is required and API-key env
vars are explicitly disabled (`Not signed in...`, exit 1); `exec` prints exactly
one line (the task URL) and exits 0; `status` exits 0 only for `ready`, 1 for
`pending`/`error`/`applied` alike; `list --json` gives the structured four-state
enum plus a files/lines-changed summary; `apply` runs a preflight `git apply
--check` before applying; a full task URL is accepted anywhere a bare task id is.
Escape hatches: `CODEX_CLOUD_TASKS_BASE_URL`, `CODEX_STARTING_DIFF`,
`CODEX_CLOUD_TASKS_MODE=mock` (debug builds only).

**Verified absences:** no `--json` on `status`; no wait/follow/tail; no re-run or
follow-up of an existing task; no `--output-schema`; no token usage; no
rate-limit/quota field; no PR link in CLI output even though the backend models
one; no environment create/update/delete; no app-server or MCP method; no
webhook.

### User run plan R0-R11 and the GO rule

Needs a real ChatGPT Plus/Pro account, a throwaway GitHub repo with a Codex Cloud
environment configured, Codex CLI ≥ 0.153.4 logged in via ChatGPT, and
`OPENAI_API_KEY`/`CODEX_API_KEY` unset. Record UTC timestamp, command, exit code,
full stdout/stderr, task id/URL, and a `codex cloud list --json` snapshot for
every run.

| ID | Tests | Pass criterion |
|---|---|---|
| R0 | Plan gate + environment id (items 1d, 3a) | An `env_…` id exists and `list --json` returns valid JSON. |
| R1 | `codex cloud exec` works unattended (4a) | Exit 0, one task URL printed, task visible in the app, no interactive prompt, run from a non-interactive context. |
| R2 | Automation schedule granularity + manual fire (2b, 2c, 5d) | Record verbatim which of hourly/daily/custom-cron/sub-hourly the UI actually offers, and whether a manual fire exists. |
| R3 | GitHub event trigger (2d, 10a) | The automation fires on a second push to an open PR; the "cannot combine event + schedule" rule confirmed or refuted. |
| R4 | **What lands on GitHub by default** (3b, 3c) — the decisive test | PASS if at least one prompt formulation reliably produces a PR (or branch) visible on GitHub with no human action in the app. |
| R5 | Machine-readable artifact (6a, 6b) | PASS if ≥4/5 repeats yield valid, schema-conforming JSON retrievable without a human. |
| R6 | Quota, caps, and the wall (1c, 1e, 9a, 9c) | Record the exact refusal text and exit code, `usedPercent` before/after, whether a partial task is auto-reverted. |
| R7 | Completion/failure detection (7b, 7c) | PASS if a terminal `ready`/`error` is reached in bounded time for both a success and a forced failure, and `error` is distinguishable from `pending`. |
| R8 | Re-trigger from GitHub Actions (3e, 4d, 10b) | PASS if push → `@codex review` comment → Codex run → PR review completes with only `GITHUB_TOKEN` on the runner. |
| R9 | Usage visibility (8a, 8c) | Record whether any per-task number exists anywhere; expected: account aggregate only. |
| R10 | Follow-up/retry (5b, 5c) | Record whether a web-app follow-up reuses the same task id or mints a new one. |
| R11 | Terms (11) | On an unrestricted machine, archive verbatim quotes from the terms-of-use and CI/CD-auth pages for the README. |

**GO** requires **R1 ∧ R4 ∧ R5 ∧ R7 ∧ (R3 ∨ R8)**: a task can be created
unattended, the result reaches GitHub without a human click, a schema-conforming
JSON artifact is retrievable, `ready`/`error` are both reachable and
distinguishable in bounded time, and at least one trigger exists that Loopmill can
actually own.

**NO-GO** if R4 fails (the diff never leaves OpenAI's UI without a human), or R7
cannot distinguish failure from pending, or R6 shows one loop iteration can
silently burn a whole 5-hour window.

**Degraded-GO** (ship as experimental, opt-in, clearly labelled) if the GO set
passes but R6/R9 confirm there is no per-task usage and no quota predicate — i.e.
Loopmill can run cloud nodes but cannot account for them.

### SPIKE-2b — seeded `auth.json` survival on ephemeral runners

A separate, narrower question from the R0-R11 plan: whether a Codex ChatGPT
`auth.json`, seeded once as a CI secret, survives OpenAI's refresh-token rotation
across repeated runs on a GitHub-hosted (ephemeral, no persistent `CODEX_HOME`)
runner — or whether each run silently gets a stale token because the rotated
refresh token was never written back anywhere. Item 4d's documentary research
found that OpenAI's own CI/CD guidance recommends a **persistent self-hosted
runner** specifically to avoid this failure mode, which is the opposite of
GitHub-hosted runners' default posture. SPIKE-2b decides whether `codex` on
`github-actions` (decision sheet §11, currently EXPERIMENTAL behind a flag) can
ever graduate out of that status, or whether it must stay pinned to a
self-hosted-runner deployment shape, or to `api-key` auth mode only. Needs the
same real ChatGPT account as SPIKE-2; not yet run.

### Current verdict and fallbacks

**Verdict: viable with caveats, not MVP.** Ship the `observed` Codex Cloud backend
as a post-MVP, explicitly experimental adapter. `codex cloud exec` genuinely works
unattended and needs no API key, which is better than expected — but four things
block it from the MVP: the CLI surface is `[EXPERIMENTAL]` and missing basic
plumbing (no `--json` status, no wait, no re-run, no PR link); token
observability — the headline differentiator — goes fully dark for cloud nodes;
`WAITING_FOR_QUOTA` is undetectable per-task and the reported failure mode at the
wall is destructive; and the GitHub-event-triggered scheduler Loopmill would
actually want exists only as an unversioned, unobservable web-UI automation.

Fallbacks, ranked:

1. **Codex local (`codex exec`) under Loopmill's own scheduler** — the design's
   existing plan and still the best: full observability, subscription-native,
   daemonless, no experimental surface.
2. **`@codex` comment from a GitHub Actions job** — subscription-backed cloud
   execution triggered by a Loopmill-authored workflow, GitHub as the observation
   surface, no ChatGPT credential on the runner. Likely-viable; confirmed by R8.
3. **`openai/codex-action` with an API key** — verified to work and documented,
   supports `--output-schema` and a `final-message` job output, but is metered API
   billing, which contradicts the subscription-native positioning. Offer as a
   documented opt-in path, never as the default.
4. **Claude-only** — always available, but forfeits the cross-vendor loop that is
   Loopmill's structural differentiator.

---

## 5. SPIKE-3 — event-driven, non-resident control plane

Location: `spikes/spike-3-control-plane/` (`step.mjs`, test suite); workflow
`.github/workflows/spike-3-step.yml`. Repository: `yosuke1024/Loopmill`, state
branch `loopmill/state-spike`, measured on GitHub-hosted runners on 2026-09-06.

### What the prototype is

A roughly 1000-line prototype answering one question: can `loopmill step` be a
non-resident process — started once per event, doing exactly one state
transition, and exiting — while keeping the run's state correct under duplicate,
out-of-order, and concurrent event delivery? Each invocation runs the seven-phase
cycle: read state → validate event → apply transition → decide next node →
dispatch backend → persist state as one commit (compare-and-swap push) → exit.
The loop under test is hard-coded (`observe → implement → review → pass? → end`
with a retry edge, `maxIterations = 3`, `maxAttempts = 2` per node), and the "AI
backend" is a deterministic simulation table, not a real agent. Nothing here is
wired into Loopmill's real domain model yet.

**Prototype-only semantics.** Two things in this harness are deliberately not the
v0.5 contract, and neither should be read back into the design. Its **exit codes**
are a wider set chosen for test legibility (0/10/11/12/20/21/22/30/40/50, listed in
`spikes/spike-3-control-plane/README.md` §3); the normative table is the five codes
of `docs/spec/state-machine.md` §12.1 (`0/1/2/3/4`) with `loopmill run`'s outcome
codes in §12.2. And its **iteration counting** treats `maxIterations = 3` as three
body executions (it stops at cycle 3), while v0.5 counts *traversals of the edge*,
so a body with `maxIterations: 3` executes four times, in cycles 1..4
(`docs/spec/loop-file.md` §12.2, `docs/spec/state-machine.md` §6.3).

### Properties proven locally

`node --test test/*.test.mjs` — 20 tests, 20 pass, 0 fail, stable across three
consecutive runs (~9.5s each):

1. Duplicate delivery is a strict no-op: no event file, no commit, byte-identical snapshot.
2. Out-of-order/stale events are recorded as `ignored` (`STALE_ATTEMPT`), never applied.
3. A completion for a node not in flight is ignored (`NOT_CURRENT_NODE`).
4. A stale event, once recorded, is idempotent on redelivery.
5. Concurrent steps serialize: exactly one push wins per race, the loser re-reads and re-plans, both events end up applied in order.
6. A lost CAS race never half-persists — prototype exit 40 (the v0.5 code is `3`) leaves the branch untouched.
7. CAS actually compares: a foreign writer's commit between read and push survives; the step rebases onto it rather than overwriting it.
8. An interrupted job killed after commit but before push leaves the remote untouched and reruns cleanly.
9. Same for a kill after writing files but before committing.
10. The retry edge is exercised and bounded: `always-fail` reaches `MAX_ITERATIONS_EXCEEDED` (prototype exit 11) at cycle 3 — the prototype's own counting rule, not v0.5's (see the note above).
11. Node-level attempts are bounded: `NODE_FAILED` (prototype exit 12) after `maxAttempts`.
12. `snapshot.json == fold(events)` byte-for-byte, both via `rebuild-snapshot` and in process.
13. Audit trail: one commit per applied event, `eventId` in every commit subject, in applied order.
14. The state branch is an orphan carrying only `runs/...`, no source tree.
15. Events after a terminal run, and invalid envelopes, are rejected without touching state (prototype exit 22 / 30).
16. Two runs share one state branch without interfering.
17. `usage-reported` applies in any order without advancing the loop.

Measured under forced contention: conflicts are the worst case `N(N-1)/2` (N=4 →
retries 0/1/2/3; N=6 → one process exhausted the default 5-retry budget and
exited 40). Storage growth: ~1.35 KB of repository per step, dominated by git
object overhead over the ~700 B event payload; `snapshot.json` is O(events) and
rewritten every step, i.e. O(n²) bytes over a run's lifetime — flagged as a defect
to fix before MVP.

### Hosted-run results (GitHub-hosted runners, repo `yosuke1024/Loopmill`, workflow `spike-3-step.yml`)

**Registration.** A workflow that exists only on a feature branch is not
registered — `workflow_dispatch` returns 404. After the workflow file was placed
on the default branch, dispatching with `ref: <feature branch>` correctly ran that
branch's version. **Consequence: the control-plane workflow must live on the
default branch**, confirming empirically what the design already assumed.

**Chaining.** A step dispatched the next step via `gh api
.../workflows/spike-3-step.yml/dispatches` using the automatic `GITHUB_TOKEN`; the
next run was created by `github-actions[bot]` and executed. This confirms the
documented exception that `workflow_dispatch`/`repository_dispatch` triggered with
`GITHUB_TOKEN` do start new workflow runs.

**First chain (run `gha-34021185550`):**

| Metric | Value |
|---|---|
| Steps / events | 7 steps, 14 events |
| Wall clock | 08:12:04 - 08:13:23 UTC (79 s end to end) |
| Path | observe → implement attempt 1 error → implement attempt 2 pass → review fail → retry edge → cycle 2 implement pass → review pass → SUCCEEDED |
| Commits | one per applied completion |
| `snapshot == fold(events)` | true at every step |

**Per-step measurements (job `101453963751`):**

| Metric | Value |
|---|---|
| Step body (incl. clone + push over HTTPS) | 1,425 ms |
| Push attempts / CAS conflicts | 1 / 0 |
| Dispatch of next step | 1.5 s |
| Whole job wall clock | 13 s (created 08:11:58, completed 08:12:11) |
| Hop latency (dispatch → next run created) | under 1 s |
| Next job actually starting | ~5-8 s later |

Other sampled steps: 1,621 ms and 1,143 ms step bodies, push attempts 1, conflicts
0 in both.

**Duplicate delivery (job `101454496055`).** Re-dispatching an already-applied
event (`eventId evt_137c05eb3fc9e8c0449d2f55`) was classified DUPLICATE, prototype exit code
20 (the v0.5 code is `0`, disposition `duplicate`), push attempts 0, no new commit, no next-step dispatch, snapshot unchanged.

**Concurrent chains.** Two runs, `gha-34021365549` and `gha-34021366751`, started
2 s apart and interleaved commits on the same state branch (alternating between
08:15:59 and 08:17:44); both finished SUCCEEDED with 14 events each. Sampled steps
showed push attempts 1 / conflicts 0 because hops landed roughly 12 s apart, so no
live CAS conflict occurred on GitHub in this run — CAS under forced contention
remains proven only by the local tests (N=4 worst case 3 retries; N=6 exhausted
the 5-retry budget once).

**Queueing.** One job (run `34021381725`) was created at 08:16:16 but did not
start until 08:16:54 (38 s), attributable to the per-run concurrency group and
runner allocation. **Hop latency is therefore variable**, not the sub-second
figure a single isolated hop might suggest.

**Harness defects found on the hosted runner:**

- The "prove snapshot" step emits `##[error]Invalid format 'unknown'` when writing
  its output — cosmetic, `continue-on-error` already covers it.
- A schedule name passed as `exhaust` was not a recognised simulated schedule and
  silently fell back to the default, so the retry-edge-exhaustion path was
  exercised only in the local test suite, not on GitHub.

**Totals:** 22 workflow runs, all successful; 3 runs touched the state branch;
about 21 commits.

**Not measured on GitHub:** `repository_dispatch` (it only ever runs the
default-branch workflow, so exercising it needs the chain itself on `main`),
forced CAS conflicts (the interleaved-chains run above happened not to collide),
an interrupted job (kill mid-push), state-branch growth over weeks of real use,
and deploy-key/ruleset privilege separation between the control-plane and agent
jobs.

### Findings that change the design

- **The control-plane workflow must live on the default branch.** Empirically
  confirmed, not just documented — a feature-branch-only workflow file is
  unreachable by `workflow_dispatch` at all. This matches decision sheet §7's
  transport note but now rests on a measured result, not a claim from search
  results.
- **`GITHUB_TOKEN` chaining works.** The security boundary in §9 — the agent job
  reports completion via `repository_dispatch`/`workflow_dispatch` with
  `GITHUB_TOKEN` alone, with no deploy key — is now confirmed to actually trigger
  a new run, not merely documented as an exception.
- **Hop latency is variable, not constant.** Individual step bodies are ~1-1.6 s
  and a whole job can complete in 13 s, but queueing driven by the per-run
  concurrency group can add tens of seconds (38 s observed once). Any wall-clock
  budget or latency expectation in the design (§10 `maxRuntime`) needs to treat
  hop latency as a distribution, not a constant.
- **The `snapshot.json` O(n²) rewrite defect is real, not just theoretical.** It
  was found in local testing and nothing in the hosted runs contradicts it — it
  should be fixed (append-only dedup index, or a bounded id window per §8's
  growth section) before the MVP's state store is built on this shape.
- **The concurrency group's queueing is load-bearing, not cosmetic.** The 38 s
  queueing delay confirms `concurrency: cancel-in-progress: false` genuinely
  serializes a run's steps at the cost of latency — a real product-level tradeoff
  for any loop with a tight budget, not just an implementation detail.

### How to reproduce

Start a fresh chain (mints a new run because the default event's `runId` is the
sentinel `gha-auto`):

```bash
gh workflow run spike-3-step.yml --ref <default-branch>
```

Or pass an explicit envelope and chain position (this is exactly what the workflow
itself does to dispatch its own next step):

```bash
gh api -X POST -H "Accept: application/vnd.github+json" \
  "repos/<owner>/<repo>/actions/workflows/spike-3-step.yml/dispatches" \
  --input - <<'JSON'
{"ref":"<branch>","inputs":{"event":"<envelope-json-string>","run_id":"<runId>","step_no":"<n>"}}
JSON
```

To read the state branch directly:

```bash
git fetch origin loopmill/state-spike
git show loopmill/state-spike:runs/<runId>/snapshot.json
git log --oneline loopmill/state-spike        # one commit per applied event
```

Or via the prototype's own CLI, which additionally verifies the fold:

```bash
node spikes/spike-3-control-plane/step.mjs show \
  --store git --remote <repo-url> --branch loopmill/state-spike --run-id <runId>

node spikes/spike-3-control-plane/step.mjs rebuild-snapshot \
  --store git --remote <repo-url> --branch loopmill/state-spike --run-id <runId>
```

---

## 6. Next steps, in order

1. **Provision `CLAUDE_CODE_OAUTH_TOKEN`** (maintainer runs `claude setup-token`
   locally and adds it as a repository secret), then dispatch SPIKE-1 for real and
   fill in its results table above.
2. **Execute the SPIKE-2 R0-R11 user run plan** against a real ChatGPT Plus/Pro
   account and a throwaway repo, evaluate the GO/NO-GO/Degraded-GO rule honestly,
   and separately run SPIKE-2b (seeded `auth.json` survival) to settle whether
   `codex` on `github-actions` can leave EXPERIMENTAL status.
3. **Fix the SPIKE-3 harness defects** found on the hosted runs (the "prove
   snapshot" output-format error; the unrecognised `exhaust` schedule name) and
   exercise the still-unmeasured items — `repository_dispatch` chaining on the
   default branch, a forced CAS conflict against GitHub over HTTPS, an
   interrupted job killed mid-push, and deploy-key/ruleset privilege separation
   between the control-plane and agent jobs.
4. **Address the snapshot O(n²) growth defect** in the state-store design (§8)
   before it is built into the real `loopmill step` implementation, not after.
5. **Re-evaluate STOP conditions (a), (b), and (c)** against the SPIKE-1 and
   SPIKE-2 results once both have real runs, and update the decision sheet's
   section 13 and section 11 scope if any of them is honestly met.
6. Only once the above close, proceed to the m0 "spikes and contract freeze"
   milestone as scoped in decision sheet §11.
