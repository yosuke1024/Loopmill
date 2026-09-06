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

**Update, 2026-09-06.** The maintainer adopted `docs/adr/ADR-002-local-self-hosted-execution.md`:
Loopmill executes on a user-managed host, and GitHub is the repository and the source of events, not
the control plane. Under that decision, STOP (a) is reworded to **no supported AI CLI can execute
unattended on a user-managed host under subscription authentication**; STOP (b) is **retired** — it was
a statement about hosted runners; STOP (c) is unchanged. The three conditions above are kept exactly as
written: they are the ones the spikes below were actually run against, and the sections that follow read
their results both ways — as measured, and as ADR-002 now reads them.

## 2. Spike overview

| ID | Question | Status | Gate it retires | Owner |
|---|---|---|---|---|
| SPIKE-1 | Does `claude -p` run headless on a GitHub-hosted runner authenticated only with `CLAUDE_CODE_OAUTH_TOKEN`, with usable usage JSON and structured output? | **Measured — PASS** (hosted run 34024962852, 2026-09-06, claude-code 2.1.263: C1-C4 and C7 PASS); C6 SIGTERM measured on a C6-only re-run (34026065026): exit 143, no result. **v0.6 reading:** PASS — the CLI contract, runner-independent (ADR-002 Appendix B) | STOP (a) **not triggered**; `github-actions` keeps Claude Code as its primary runtime (decision sheet §4, §11) | Maintainer (needs a `claude setup-token` from their own subscription, stored as a repository secret) |
| SPIKE-2 | Can Loopmill drive a Codex node on OpenAI's cloud under a ChatGPT subscription, get a machine-readable result onto GitHub, and re-trigger it, without an API key? | **Measured — NO-GO** (user runs R0, R1, R4, R8 on 2026-09-06: R1 PASS, R4 FAIL, R8 FAIL with `GITHUB_TOKEN`); the `observed` backend is dropped by maintainer decision. **v0.6 reading:** NO-GO stands; `observed` is removed, and Codex returns as a provider through `codex exec` on the host (SPIKE-4) | Decided the `observed` backend (decision sheet §4, §11): out. STOP (b) now hinges on SPIKE-2b | Maintainer (real ChatGPT Plus account, manual web-UI steps) |
| SPIKE-2b | Does a seeded Codex ChatGPT `auth.json` survive refresh-token rotation on an ephemeral GitHub-hosted runner? | Documentary groundwork done (status table item 4d); not yet run. **v0.6 reading:** superseded — no credential is moved to a runner Loopmill does not own; still not run | Decides whether `codex` on `github-actions` can leave EXPERIMENTAL status (decision sheet §11) | Maintainer (needs a real ChatGPT login to seed `auth.json` once) |
| SPIKE-3 | Can `loopmill step` be a non-resident, event-sourced process that stays correct under duplicate, concurrent, and interrupted delivery, chained purely by GitHub Actions? | Measured — 21/21 local tests, 44 hosted workflow runs in two batches (chains and duplicates; then a forced CAS storm, envelope sizes, the concurrency group's pending-run behaviour, an interrupted job and an `always-fail` chain). **v0.6 reading:** PASS — the transition, journal and concurrency properties carry to the SQLite store; the git-branch store and Actions chaining are the reserved backend's mechanism | Confirms/adjusts decision sheet §6 (control-plane algorithm, exit codes) and §8 (state persistence); does not change positioning. One mechanism change: no per-run concurrency group for `step` (design §7.5) | Automated — a simulated backend, no vendor credentials required |
| SPIKE-4 | Does `codex exec` run non-interactively on the operator's own host under a ChatGPT login, with structured output, a terminal-state and exit-code contract, usage from `turn.completed`, and does a scheduler-started process (`launchd`, a `systemd` user timer) authenticate `claude`/`codex`? | **Planned — harness not yet built** | The `codex` runtime's status (`VERIFIED` or `PLANNED / EXPERIMENTAL`), `doctor --scheduler`'s check list (ADR-002 D10, Appendix B) | Maintainer (needs `codex`/`claude` logged in on the host, macOS and Linux) |

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

**This is the one prerequisite the harness cannot supply itself.** The first hosted
run (2026-09-06, 09:14 UTC) went out with the token stored under the wrong secret
name and measured nothing but the unauthenticated failure shape; the secret was
renamed and the run repeated twenty minutes later.

### How to run

```bash
gh workflow run spike-1-claude-subscription.yml --ref <branch> \
  -f model=sonnet -f scrub_test=true

# re-measure one check only (every other check is reported as SKIPPED)
gh workflow run spike-1-claude-subscription.yml --ref <branch> -f only=C6

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

Hosted runs on 2026-09-06, GitHub-hosted `ubuntu-24.04`, Node v22.23.2, claude-code **2.1.263**,
account default model (`claude-sonnet-5` in `system/init`). Three runs in all: an unauthenticated
one, the full authenticated one, and a C6-only re-measurement after the harness had been fixed twice
(the plan-mode prompt was declined in 2 s; with tools available the model finished in 2.5 s).

**Run 1 (34024103818, 09:14 UTC) — unauthenticated by mistake.** The token had been stored under the
wrong secret name, so `CLAUDE_CODE_OAUTH_TOKEN` was empty. C1 reported `loggedIn: false`,
`authMethod: "none"`; every `-p` check ended `subtype: "success"`, `is_error: true`,
`result: "Not logged in · Please run /login"`, exit 1, zeroed usage, `modelUsage: {}`. Not a design
result, but three harness lessons came out of it and were fixed before run 2: `subtype` is not a
success signal; C6 must check that the signal reached a live process; a bare `limit` grep matches
`subagent_stats` field names.

**Run 2 (34024962852, 09:33 UTC) — authenticated.**

| Check | Status | Notes |
|---|---|---|
| C1 auth | PASS | exit 0, `loggedIn: true`, `authMethod: "oauth_token"`, `apiProvider: "firstParty"`; `system/init` reports `apiKeySource: "none"` |
| C2 plain JSON | PASS | exit 0, `subtype: "success"`, `is_error: false`, `terminal_reason: "completed"`, result `LOOPMILL-OK`; `usage` 2 / 11,012 / 18,534 / 12 (fresh / cache write / cache read / output); `modelUsage` has **two** entries — the main model and a ~900-token helper call on `claude-haiku-4-5-20251001` — so its sum (30,476) exceeds `result.usage` (29,560); `total_cost_usd` present |
| C3 structured output | PASS | exit 0; `structured_output` `{verdict: "pass", reason: …}` conforms to the schema; delivered through a tool call (`stop_reason: "tool_use"`, `num_turns: 2`); `thinking_tokens: 182` broken out in `usage.output_tokens_details` |
| C4 stream-json | PASS | 9 lines: `system/init`, **`rate_limit_event`**, 4× `system/thinking_tokens`, 2× `assistant` sharing one `message.id` with placeholder `output_tokens: 2`, `result/success`; the final `result` has the same shape as C2 |
| C5a exit code (tool use, max-turns 1) | INFO | exit **1**, `subtype: "error_max_turns"`, `is_error: true`, `terminal_reason: "max_turns"`, `errors: ["Reached maximum number of turns (1)"]`; `usage` and `modelUsage` reported in full |
| C5b exit code (invalid model) | PASS | exit 1, stderr `[claude-code:unrecognized_model] {"model": …, "query_source": "sdk"}`, no silent substitution |
| C6 SIGINT | PASS | reproduced identically on runs 2 and 34026065026; the signal reached a live process 7.7 s into streaming: exit **0**, `subtype: "error_during_execution"`, `is_error: true`, `terminal_reason: "aborted_streaming"`, `result: null`; `usage` all zero, `modelUsage` holds only the completed helper call (912 in / 16 out) — the interrupted response's tokens are absent from every field |
| C6 SIGTERM | PASS | run 2's signal reached an already exited process (the model declined the plan-mode prompt in 2.4 s, `terminal_reason: "completed"`); re-measured on run 34026065026 with a tool-free long prompt (`--tools ""`): the signal reached a live process 8.4 s in — exit **143**, nothing on stdout, no `result`, no usage. The documented behaviour holds, and `claude-killed.json`'s hand-written shape is confirmed |
| C6 timeout -s INT | INFO | `timeout` exit 124; the child's result is the SIGINT shape above (`aborted_streaming`) |
| C7 no-TTY hang probe | PASS | `setsid` + stdin from `/dev/null`: exit 0 in 5.7 s, no hang — anthropics/claude-code#9026 does not reproduce on 2.1.263 |
| C8-bad (API key precedence) | PASS | with an invalid `ANTHROPIC_API_KEY` exported beside the OAuth token: exit 1, `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`, `api_error_status: 401`, `result: "Failed to authenticate. API Error: 401 API key is invalid."` after 188 s of retries — the key wins and the OAuth token is never consulted |
| C8-good (OAuth-only confirmed) | PASS | exit 0, `is_error: false`, straight after C8-bad |
| C9 quota probe | INFO | no limit hit; run 1's "maybe" was the bare-`limit` grep matching `subagent_stats.refused.depth_limit` — harness tightened |
| C10 environment | INFO | Node v22.23.2, claude 2.1.263, Linux 6.17 (azure) x86_64, `tty_stdin: "no"`, `CLAUDE_CONFIG_DIR` unset, `HOME=/home/runner` |

**Overall: PASS** — C1, C2, C3, C4 and C7 PASS on a throwaway GitHub-hosted runner with nothing but
`CLAUDE_CODE_OAUTH_TOKEN`. STOP condition (a) is **not triggered**; `github-actions` keeps
`claude-code` as its primary runtime (decision sheet §4, §11). Raw artifacts: `spike-1-results` on each
run (30-day retention). The recorded result objects behind C2, C5a and C6-SIGINT are committed as
`docs/spec/usage-fixtures/claude-recorded-*.json`; no token, account or quota figure is committed.

### Findings that change the design

- **`subtype` is not a success signal.** `subtype: "success"` coexists with `is_error: true` and exit 1
  on an authentication failure. `is_error` and the result's `terminal_reason` (`completed`, `max_turns`,
  `api_error`, `aborted_streaming` observed) are the discriminators — `docs/spec/state-machine.md` §7.2,
  `docs/spec/usage-normalization.md` §2.1.
- **`modelUsage` is always present and is the basis in practice.** A one-turn run already has two
  entries (the main model plus a helper call on a smaller model); an unauthenticated run has `{}`.
  `result.usage` alone undercounts every healthy run — design §14.2, `usage-normalization.md` §2.1.
- **Thinking tokens are broken out** (`thinkingTokens` per model, `output_tokens_details.thinking_tokens`),
  so `reasoningTokens` is no longer `null` for claude-code — `usage-normalization.md` §2.1.
- **SIGINT keeps the result but not the interrupted response's tokens.** Exit 0, `aborted_streaming`,
  usage of the completed calls only. Recorded as `reported` with `complete: false` and unmeasured for
  coverage — the first MVP case of a partial `reported` record (`usage-normalization.md` §2.1 and §4.1;
  the `CANCELLED` row of `state-machine.md` §7.2).
- **A structured quota signal exists headlessly.** `stream-json` emits a `rate_limit_event` with
  per-window (`five_hour`, `seven_day`) utilization and `resetsAt`, `isUsingOverage`, and a `status`
  (`allowed_warning` observed past the CLI's 0.75 threshold). It is now a reported source for
  `quotaResetsAt` (`state-machine.md` §7.3-7.4); the refusal shape is still unobserved.
- **`error_max_turns` exits 1 with full usage** — a cut-off attempt is `FAILED(max_turns)` with a
  measured record, never `unavailable` (`claude-recorded-max-turns.json`).
- **API-key precedence holds** (C8): the environment deny-list in design §13.2 is load-bearing — an
  inherited `ANTHROPIC_API_KEY` silently replaces the subscription login and, when invalid, burns three
  minutes of retries before failing.
- **No no-TTY hang** on 2.1.263, so `invocation: on-demand` stands and acceptance criterion A14 needs no
  PTY clause for claude-code at this version.

**v0.6 reading.** Every finding above is a property of the Claude Code CLI itself — the
`is_error`/`terminal_reason` discriminator, `modelUsage` as the usage basis, the SIGINT/SIGTERM contract,
the `rate_limit_event` quota signal, and the absence of a no-TTY hang — not of the GitHub-hosted runner it
was measured on, and so it carries unchanged onto a user-managed host (`docs/adr/ADR-002-local-self-hosted-execution.md`
Appendix B). SPIKE-4 exists to confirm the same contract locally, not to re-derive it.

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
| 1d | Codex Cloud is Plus/Pro/Business/Enterprise only | VERIFIED (Plus) | Cloud tasks ran on a Plus account on 2026-09-06 (R0/R1). Loopmill must still detect plan type (`account/rateLimits/read` → `planType`) before offering anything. |
| 1e | Separate daily/run cap on cloud tasks | UNVERIFIED / NEEDS-USER-RUN | No cap constant found anywhere; must be measured (R6). |
| 2a | Two automation shapes exist: standalone (reports to the app's Triage inbox) and thread automations | LIKELY | A standalone automation does **not** land on GitHub unless its prompt explicitly uses the GitHub connector. |
| 2b | Typed scheduled-task schema is `Hourly`\|`Daily`\|`Weekdays`\|`Weekly`, with IANA timezone | VERIFIED (typed schema) | Hourly is the minimum first-party interval — fine for nightly loops, too coarse for a fast retry loop. |
| 2c | UI may also offer minute intervals and custom cron for thread automations | LIKELY | Not in any reachable typed schema; verify with run R2 before designing around it. |
| 2d | GitHub PR-activity event triggers exist (added 2026-08-25), Plus/Pro+ only, web/mobile-configured only, cannot combine with a schedule | LIKELY | The single most important row: a plan-backed GitHub-event trigger exists, but Loopmill cannot create, version, or observe it. |
| 3a | A cloud task's repo comes from a Codex Cloud "environment" bound via the GitHub App | VERIFIED | Loopmill needs one `env_…` id per repo, created out-of-band in the Codex web UI; `codex cloud exec --env` accepts an id or label. |
| 3b | The backend models linked pull requests | VERIFIED | ...but the CLI never surfaces those fields, and on 2026-09-06 no task ever linked one — a PR link must come from `gh`, not `codex cloud`. |
| 3c | Default sink is a task-local diff, not a GitHub object; PR creation needs a human click | **VERIFIED (R4, negative)** | Two prompt formulations (default; "Open a pull request… Do not require any human interaction") both ended `ready` with the diff inside the task, no branch, no PR, no push event. The agent's own summary: the `make_pr` tool is unavailable and the sandbox has no remote or GitHub authentication. The web UI offers a "Create PR" button — a click. Primary doc: "When the agent finishes, it shows its answer and a diff of any files it changed. You can open a PR or ask follow-up questions." |
| 3d | GitHub connector exposes issue read/comment/create_pull_request, not create_issue | LIKELY | A cloud task cannot open an Issue, only comment on one. |
| 3e | `@codex <instruction>` on a PR dispatches a cloud task and the reply lands on the PR as a bot comment | VERIFIED (R8, user-authored) | Mention at 10:50:36 → task `GitHub Mention: …` (`is_review: true` in `list --json`) → `chatgpt-codex-connector[bot]` summary comment at 10:52:00 (84 s), with a "View task" link. The **change was not pushed** ("A remote and authenticated GitHub session were not available in this checkout"). Only the agent's final message reaches GitHub, never the diff. |
| 4a | `codex cloud exec --env` creates a real task from a non-interactive process | VERIFIED (R1, live) | `codex cloud exec --env <id> "…" </dev/null`: exit 0, one URL on stdout, empty stderr, no prompt; task `pending` → `ready` in 2 min 46 s with the expected one-line diff. No daemon, no API key. |
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
| 7b | `codex cloud list --json` gives a machine-readable four-state enum (pending/ready/applied/error) | VERIFIED (live: `pending` → `ready` observed) | This is the completion signal to poll; mention-triggered tasks appear there too (`is_review: true`). The `error` state was not exercised. |
| 7c | `codex cloud status` is text-only, no `--json`, and exits 1 for anything but `ready` | VERIFIED | A trap: pending, error, and already-applied all collapse to exit 1 — must poll `list --json` instead. |
| 7d | No push notification, webhook, or completion callback | VERIFIED (absence) | Polling only; fine for a daemonless design, but costs a process spawn plus a round trip per poll. |
| 8a | Token usage is not exposed anywhere in the `codex cloud` CLI | VERIFIED (absence) | A direct hit on Loopmill's loop-observability differentiator — cloud nodes record `usage: unavailable` and lower the Run's usage coverage. |
| 8b | The private backend does have usage endpoints | VERIFIED (endpoints exist) | Whether a task id works as a `thread_id` there is unverified; do not build on undocumented private routes. |
| 8c | A usage panel exists in the ChatGPT UI | LIKELY / NEEDS-USER-RUN | Human-visible only, not machine-readable. |
| 9a | `codex cloud` surfaces no quota signal at all | VERIFIED (absence) | `WAITING_FOR_QUOTA` cannot be detected per-task on this backend. |
| 9b | Account-level reset time IS exposed via `account/rateLimits/read` | VERIFIED | The design answer: read the account, not the task — `usedPercent`/`resetsAt` works for cloud and local alike. |
| 9c | Reported behaviour at the plan wall mid-task is destructive (quota burned, work reverted, silent failures) | UNVERIFIED / NEEDS-USER-RUN | Must be probed directly (R6) before trusting the backend with real work. |
| 10a | Automations can trigger on PR commit updates | LIKELY | Shipped, plan-backed, but web-UI-only — not scriptable. |
| 10b | An Actions job posting `@codex …` with `GITHUB_TOKEN` re-triggers Codex | **REFUTED (R8)** | A comment authored by `github-actions[bot]` got, 7 s later, the connector's reply "To use Codex here, create a Codex account and connect to github" and started no task. The mention must be authored by a GitHub user linked to Codex. The only automatable shape left is a maintainer-owned PAT in the Actions job (R8b, not attempted). |
| 11a | Primary OpenAI terms/limits pages | READ | Reachable from the maintainer's machine on 2026-09-06 (`learn.chatgpt.com/docs/...`): the cloud-environment, internet-access, GitHub-integration and cloud overview pages were read. The Terms of Use, Usage Policies, CI/CD-auth and Scheduled-tasks pages were read verbatim later the same day (R11); quotes and access times are in design §19.1. |
| 11b | ChatGPT Terms of Use prohibit programmatic data extraction and "powering a third-party service" | **VERIFIED, corrected (R11)** | The Terms (effective 2026-01-01) prohibit "Automatically or programmatically extract data or Output", "Modify, copy, lease, sell or distribute any of our Services" and circumventing rate limits; no "third-party service" wording exists. The framing that Loopmill drives a user's own CLI for their own repo is explicit in design §19.1 and §22, with the interpretive residual named. |
| 11c | OpenAI documents (and discourages) "Maintain Codex account auth in CI/CD (advanced)" | VERIFIED (R11) | Verbatim: "The right way to authenticate automation is with an API key. Use this guide only if you specifically need to run the workflow as your Codex account." Quoted with its access time in design §19.1; Loopmill implements none of the recipe. |
| 11d | Unattended scheduled Codex on a ChatGPT plan (Automations) is a first-party, shipped product | VERIFIED (R11; the page now calls it "Scheduled tasks") | "Scheduled tasks run unattended with your default sandbox settings." — with the same keep-the-computer-on constraint Loopmill states; design §19.1. |

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

### User runs, 2026-09-06 (R0, R1, R4, R8)

Account: ChatGPT **Plus**. CLI: `codex-cli 0.144.6` (older than the 0.153.4 the documentary
research used; the `cloud exec/list/status/diff/apply` surface matched). Environment
`loopmill-codex-spike` bound to `yosuke1024/Loopmill`, agent internet access **off**, no
secrets, no environment variables. `OPENAI_API_KEY`/`CODEX_API_KEY` unset.

| Run | Result | Evidence |
|---|---|---|
| R0 | PASS | environment id present, `list --json` valid JSON, plan type Plus |
| R1 | PASS | exit 0, one task URL, empty stderr, stdin from `/dev/null`; `pending` → `ready` in 2 min 46 s; diff = one new file |
| R4 | **FAIL** | two formulations, both `ready` with a task-local diff; repository branches, PRs and events unchanged; the agent reports no `make_pr` tool and no remote/GitHub auth; the UI's "Create PR" button is the only exit |
| R7 | partial | the success side is bounded and machine-readable (`list --json`); the `error` side was not exercised |
| R8 | **FAIL** (strict) | a `GITHUB_TOKEN`-authored `@codex` comment is refused by the connector ("create a Codex account and connect to github"); a maintainer-authored mention does start a task and gets a reply comment in 84 s — but the change stays unpushed |
| R2, R3, R5, R6, R9, R10 | not run | superseded by the decision below |
| R11 | **done** (later on 2026-09-06) | the Terms of Use, Usage Policies, CI/CD-auth and Scheduled-tasks pages read verbatim in a browser on the maintainer's machine; quotes, URLs and access times in design §19.1, evaluation in design §22 |

**Two variants were considered and not run.** (1) A GitHub token in the Codex environment:
as a *secret* it cannot work — the primary page states secrets are "only available to setup
scripts. For security reasons, secrets are removed before the agent phase starts"; as a plain
*environment variable* with agent internet access switched on it probably would, but it puts
a repository-write credential inside the vendor's sandbox with the prompt-injection and
exfiltration exposure OpenAI's own internet-access page warns about, and it makes acceptance
criterion A19 unprovable for that backend. (2) A maintainer-owned fine-grained PAT in the
Actions job so the mention is authored by a Codex-linked user (R8b): a job secret in the
place design §13 already allows, but it only ever yields a *comment*, never a pushed change.

### Verdict and the decision

**Verdict: NO-GO** by the GO rule (R1 ∧ **R4** ∧ R5 ∧ R7 ∧ (R3 ∨ R8)): the diff never leaves
OpenAI's UI without a human click, and the one trigger that starts a task requires a
Codex-linked human identity, not a runner token. What *does* work unattended — dispatch
from a non-interactive process, a bounded completion signal, and the agent's final message
posted back to the PR — would support a review-only node (verdict JSON in a comment), which
is exactly how the reference loop used `observed`. The maintainer nevertheless decided on
2026-09-06 to **drop the `observed` backend from the design** rather than carry an
`[EXPERIMENTAL]` surface with no per-task usage, no quota predicate, no pushable result and a
trigger that must impersonate a human. Design §20.1, §22 and ADR-001 record the decision.

The earlier documentary verdict ("viable with caveats, not MVP") stands as history: `codex
cloud exec` does work unattended and needs no API key; what the live runs added is that the
result cannot reach GitHub as a change, and that `GITHUB_TOKEN` cannot own the trigger.

Fallbacks, ranked (unchanged, now the plan of record):

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

**Harness defects found on the hosted runner (both fixed the same day):**

- The "prove snapshot" step emitted `##[error]Invalid format 'unknown'`: the
  rebuild's stderr was redirected into the same file as its JSON, so `jq` printed
  the value and then failed, and a second, `=`-less line reached `GITHUB_OUTPUT`.
  stderr now goes to its own file.
- A schedule name passed as `exhaust` was not a recognised simulated schedule and
  silently fell back to the default. An unknown schedule in a `run-started`
  envelope is now rejected as invalid (`UNKNOWN_SCHEDULE`, exit 30) and covered
  by a local test (21/21).

**Totals, first batch:** 22 workflow runs, all successful; 3 runs touched the
state branch; about 21 commits.

### Hosted measurements, second batch (2026-09-06, 22 runs)

Same repository and workflow, branch version with two spike-only inputs added
for fault injection: `fault` (`after-stage` | `after-commit`, forwarded as
`LOOPMILL_CRASH_POINT`) and `hold_ms` (a sleep between reading the state branch
and pushing, forwarded as `LOOPMILL_HOLD_MS`). A "parked" run `gha-park-1` was
started with `step_no=12` so the chain cap stopped it with `observe` in flight;
the measurements below deliver events to that run. Passing a different `run_id`
input for events of the same run bypasses the per-run concurrency group on
purpose.

**Forced CAS storm.** Six `usage-reported` events for `gha-park-1`, distinct
concurrency groups, `hold_ms=4000`, dispatched within 0.2 s of each other:

| Job (run id) | Push attempts | CAS rejections | Step body |
|---|---:|---:|---:|
| 34025083443 | 1 | 0 | 5,490 ms |
| 34025083439 | 2 | 1 | 5,811 ms |
| 34025083432 | 3 | 2 | 7,208 ms |
| 34025083420 | 3 | 2 | 8,408 ms |
| 34025083509 | 4 | 3 | 10,189 ms |
| 34025083440 | 4 | 3 | 10,219 ms |

Eleven `--force-with-lease` rejections in total, worst case 3 retries (default
budget 5); the six commits landed 09:35:40-09:35:49 UTC, about two seconds apart;
all six events applied, none lost, `snapshot == fold(events)` over 8 records.
Each retry re-fetches, re-plans and re-pushes, so retries cost roughly one step
body each.

**Envelope size through `workflow_dispatch`.** A 32,768-byte envelope (the design's
size rule) was accepted and applied (33,045-byte record on the branch); a
65,400-byte envelope was accepted and applied too (65,678-byte record); a
66,000-byte envelope was refused by the API with HTTP 422 `inputs are too large`
and no run was created — the 65,535-character ceiling documented for the inputs
payload holds, and the rule's 32 KiB leaves the escaping headroom it was designed
to leave.

**One pending run per concurrency group.** Three `usage-reported` events
dispatched into the *same* group (`run_id=gha-park-1`) 1.4 s apart, `hold_ms=3000`:

| Dispatch | Run | Outcome |
|---|---|---|
| 09:39:13.4 | 34025257340 | success, `evt_pend_1` applied |
| 09:39:14.8 | 34025258112 | **cancelled by GitHub at 09:39:18, never started** |
| 09:39:16.1 | 34025258867 | success (started 09:39:32, after the first finished), `evt_pend_3` applied |

`evt_pend_2` was never applied — with `cancel-in-progress: false` GitHub keeps one
pending run per group and cancels the older pending run when another arrives. The
group is a serialisation aid, not a queue; an event that lands while another is
already pending is lost unless the producer redelivers. This is the mechanism
change recorded in design §7.5.

**Interrupted job (kill after the local commit, before the push).** The `observe`
completion for `gha-park-1` was delivered with `fault=after-commit`: the job
failed with the fault-injection exit (97) after committing locally; the run's
last commit on the branch was unchanged (`eccaf6c`, `lastSeq` 12) and no
`ignored`/half-written state appeared. Redelivering the byte-identical envelope
without the fault applied it with exactly one new commit (`fa36648`), `lastSeq`
14, `snapshot == fold(events)` over 14 records — at-least-once redelivery
converges.

**`always-fail` chain (retry-edge exhaustion on GitHub).** Run `gha-34025296142`:
8 steps, 8 commits, 09:40:04 → 09:41:44 UTC (100 s end to end, hops of 12-14 s,
step bodies 1,201-1,925 ms), path observe → implement →
review fail → retry edge → implement → review fail → retry edge → implement →
review fail → `MAX_ITERATIONS_EXCEEDED` (prototype exit 11, cycle 3, two
retry-edge traversals — the prototype's own counting rule). The chain stopped
itself; nothing was dispatched past the terminal step.

**Totals, second batch:** 22 workflow runs — 20 successful, 1 deliberately failed
(fault injection), 1 cancelled by the concurrency group; 20 commits on the state
branch; local suite 21/21.

**Not measured on GitHub:** `repository_dispatch` (it only ever runs the
default-branch workflow, so exercising it needs the chain itself on `main`),
state-branch growth over weeks of real use, and deploy-key/ruleset privilege
separation between the control-plane and agent jobs.

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
- **The concurrency group drops events.** One pending run per group; the next
  arrival cancels it. `step` must not rely on the group for delivery: the design
  now runs `step` without a per-run group and leans on CAS plus at-least-once
  redelivery (design §7.5, ADR-001).
- **CAS converges under a real storm.** Six concurrent writers over HTTPS to
  GitHub needed at most 3 retries and lost nothing; retries scale with the number
  of simultaneous writers, as the local `N(N-1)/2` measurement predicted.
- **The interrupted-job property holds on GitHub.** A job killed after its local
  commit leaves the remote untouched and the same envelope, redelivered, converges
  with one commit — the redelivery contract the design assumes (§7.4, A11).
- **The 65,535-character `workflow_dispatch` ceiling is real** and the 32 KiB
  envelope rule sits comfortably under it (65,400 bytes passed, 66,000 were
  refused before any run was created).

**v0.6 reading.** The properties this spike proves — a pure `transition`, an append-only hash-chained
journal, and correctness under duplicate, concurrent and interrupted delivery — carry over to the SQLite
journal and its per-Run lock (`docs/design/mvp-design.md` §9); only the medium changes, from an orphan git
branch to a local database, and the concurrency primitive changes from compare-and-swap on a git ref to a
SQLite transaction. The git-branch store, `GITHUB_TOKEN` chaining and the concurrency-group behaviour
measured here are kept as the reference for the reserved `github-actions` integration, not as the MVP's
own mechanism (`docs/adr/ADR-002-local-self-hosted-execution.md` Appendix A and D3-D4).

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

## 6. SPIKE-4 — Codex CLI subscription backend and the scheduler context

Location: `spikes/spike-4-codex-cli/` — built 2026-09-06: `run.sh` (checks D0-D8, dry-run capable,
modelled on the SPIKE-1 harness), `normalize.mjs` with offline tests (the codex usage normaliser D8
uses, which also writes the recorded-fixture candidates), `schema.json`, and `d9/` (the scheduler-context
probe plus generators for a `launchd` user agent, a `launchd` daemon and a `systemd --user` timer, none of
which loads anything by itself). D10 is the SPIKE-1 harness run locally; SPIKE-1's `run.sh` gained a
`timeout` shim for macOS, which ships no such binary.

### What it proves

Whether `codex exec`, authenticated with nothing but the operator's own ChatGPT login on the host, can
serve as Loopmill's `codex` runtime under `docs/adr/ADR-002-local-self-hosted-execution.md`: non-interactive
execution, structured output, a terminal-state and exit-code contract, and thread-cumulative usage
normalised into the common Usage record — plus whether a process started by the operating system's own
scheduler, with no interactive session, can reach that same login state for both `claude` and `codex`.
This is the harness for ADR-002's risks R1 (`codex exec` does not run non-interactively with
machine-readable results, usage and a terminal signal), R2 (a scheduler-started process cannot reach the
CLI's login state) and R3 (`claude -p` behaves differently on the operator's own host than on the hosted
runner SPIKE-1 measured it on).

### Prerequisites

1. `codex` logged in via a ChatGPT subscription on the host (`codex login`); `OPENAI_API_KEY` and
   `CODEX_API_KEY` unset, so a run cannot silently fall back to metered billing.
2. `claude` logged in on the same host (interactive login, or `CLAUDE_CODE_OAUTH_TOKEN`).
3. Both a macOS host and a Linux host — the scheduler-context checks (D9) are per-platform and neither
   substitutes for the other.

### Checks D1-D10 mapped to design questions

| Check | What it runs | Design question it answers |
|---|---|---|
| D0 | `codex --version`, `codex login status`, the credential-store and forced-login keys of `config.toml`, whether `auth.json` exists, the macOS keyring probe (exit code only) | The environment record, the way SPIKE-1's C1 and C10 were: it flags loudly when the login status is not 0 or an API key is present, since either invalidates the run. |
| D1 | `codex exec --json "<prompt>"` with stdin from `/dev/null`, no TTY, ChatGPT login only | Whether `subscription-login` runs non-interactively at all — the precondition for `codex` as an MVP runtime (`docs/design/mvp-design.md` §6.4, ADR-002 D5). |
| D2 | Same, plus `--output-schema <file>` | Whether structured output is schema-conformant and survives Loopmill's own re-validation (design §11). |
| D3 | A success, a forced failure, and an invalid argument | The terminal-state and exit-code contract: `turn.completed` vs `turn.failed`, and whether exit codes 0/1/2 are legible and distinct (design §6.3, §10). |
| D4 | Two sequential turns on one thread | Whether `turn.completed.usage` is thread-cumulative as documented, and whether the diff-since-last-turn rule (design §14.2) recovers the correct per-attempt figure. |
| D5 | SIGINT, SIGTERM, and a timeout against a long-running turn | Which signal `cancel(runId)` must send, and whether a usable result or usage record survives cancellation (design §14.4). |
| D6 | Grep output for a plan-limit message; inspect for any structured field alongside it | The quota signal's shape for `codex` — prose `usage limit` only, or something machine-readable — feeding `WAITING_FOR_QUOTA` (design §10). Informational, no pass/fail, same status as SPIKE-1's C9. |
| D7 | A prompt that edits a file, run inside a git worktree | Whether `filesChanged` and the worktree diff are what design §7.2 and §18 assume for the `local` backend. |
| D8 | Map D1-D7's raw output through the per-runtime mapping | Whether the result normalises into the canonical Usage record (design §14.1) with the same shape discipline as `docs/spec/usage-fixtures/claude-recorded-*.json`. |
| D9 | `claude -p` and `codex exec` invoked by a `launchd` user agent with the screen locked and with no user session, and by a `systemd --user` timer | Whether a scheduler-started process reaches the macOS login keychain, `CODEX_HOME`, and the operator's `gh` credential store (design §7.5, ADR-002 R2). |
| D10 | The SPIKE-1 harness, `ONLY=C1,C2,C3,C4,C6,C7`, run locally on macOS | Whether the hosted-runner contract SPIKE-1 measured also holds on the operator's own host (ADR-002 R3). |

### Pass/fail criteria

D1-D4 and D7 all PASS → the `codex` runtime is `VERIFIED` (design §20.1); a FAIL on any of them keeps
Codex at `PLANNED / EXPERIMENTAL` behind the same provider abstraction and does not stop the MVP (ADR-002
D10). D9 does not gate the runtime at all — on each of macOS and Linux independently, it decides the
per-platform notes in design §7.5 and the check list `doctor --scheduler` must run. D5, D6, D8 and D10 are
expected to surface useful detail regardless of outcome, the same way C5, C6, C9 and C10 did in SPIKE-1.

### Results

Run on 2026-09-06 on the maintainer's macOS host (Darwin 25.5.0, arm64), Node v25.5.0, codex-cli
**0.153.4**, claude-code **2.1.263** — both updated from 0.144.6 / 2.1.245 immediately before the run,
so the measurements match the research baselines — account-default models, `OPENAI_API_KEY` /
`CODEX_API_KEY` unset, the `codex` login in the macOS keyring (`cli_auth_credentials_store = "keyring"`,
`forced_login_method = "chatgpt"`, no `auth.json`). Two passes: the full D0-D8 pass, then D4, D7 and D8
re-run after their grading was corrected (see the rows); every number is from the pass named in its row.
Before either pass the harness had been verified offline: `bash -n`, `SPIKE_DRY_RUN=1`, the normaliser's
tests against the hand-written fixtures, and an end-to-end run against a stand-in `codex` script.

| Check | Status | Notes |
|---|---|---|
| D0 environment | INFO | `codex login status` exit 0 ("Logged in using ChatGPT"); keyring item `Codex Auth` present; no API key in the environment |
| D1 plain `exec --json` | PASS | exit 0, 9 s; stream `thread.started` → `turn.started` → `item.completed` (`agent_message`, `LOOPMILL-OK`) → `turn.completed` with `usage` {input 16,807, cached 12,928, cache_write 0, output 10, reasoning 0}; stderr `Reading additional input from stdin...` because stdin was `/dev/null` |
| D2 `--output-schema` | PASS | exit 0; the final `agent_message` is `{"verdict":"pass","reason":…}`, validates against the schema and equals the `-o` file byte for byte |
| D3 exit codes | PASS | a: 0. b (`-m loopmill-no-such-model`): exit 1 after an `item.completed` of `type: error` (a metadata warning), then `error` and `turn.failed` carrying the backend's HTTP 400 `invalid_request_error` ("The 'loopmill-no-such-model' model is not supported when using Codex with a ChatGPT account.") — a structured event, not prose. c (unknown flag): exit 2, clap usage on stderr, nothing on stdout. Pairwise distinct |
| D4 two turns, one thread | **PASS — the documentary claim is refuted** | `codex exec resume <thread_id>` accepted `--json` (and, per `--help`, `-o`, `--output-schema`, `-m`) but not `-C`, `-s` or `--color`; the same `thread_id` on both streams. Turn 1: {input 17,578, cached 12,928, output 303}; turn 2 (`TURN-TWO`): {input 19,714, cached 17,408, output **7**}. A thread-cumulative counter would have reported at least 310 output tokens; the resumed process counted only itself. The first pass, graded under the cumulative expectation, reported FAIL on the same shape (turn 1 {16,820 / 12,928 / 303}, turn 2 {17,136 / 16,640 / 7}); the grade now records which semantics was measured, and the re-run reproduced per-invocation counting |
| D5 SIGINT | INFO | delivered 8 s in to a live process: exit **1**, elapsed 9 s, stream stopped after `turn.started`, no `turn.completed`, nothing on stderr beyond the stdin notice |
| D5 SIGTERM | INFO | same, but exit **0** — a killed `codex exec` exits successfully with no terminal event |
| D5 TIMEOUT (SIGTERM, then SIGKILL) | INFO | ended on the SIGTERM: exit 0, no `turn.completed` |
| D6 quota probe | INFO | no limit phrase anywhere; the event types seen across the whole run are exactly `thread.started`, `turn.started`, `item.completed`, `turn.completed` (`usage`), `turn.failed` (`error`) and `error` (`message`); no key names a limit, a window or a reset |
| D7 worktree edit | PASS | exit 0, 13 s; `git status --porcelain` in the worktree is exactly `?? SPIKE4.md` and the scratch main checkout is clean; the file was written by a shell command (`agent_message` ×2, `command_execution` ×2, no `file_change` item, no approval event); content `spike-4 wrote this.` — the model added a full stop, which the first pass graded FAIL on an exact match; the re-run grades the worktree contract and records `content_exact=no` |
| D8 normalisation | PASS | nine records: D1, D2, D4a, D4b and D7 `derived` and complete (16,817 / 16,900 / 17,881 / 19,721 / 34,445); D3b and the three D5 cases `unavailable`; invariants I2 and I8 hold and I5 was re-scoped (below). The recorded fixtures are committed as `docs/spec/usage-fixtures/codex-recorded-*.json` |
| D9 scheduler context, macOS `launchd` user agent, screen locked | **PASS** | Run by the maintainer 2026-09-06 13:41-13:46 UTC: the agent (`gui/501`, `launchctl managername` = `Aqua`, `StartInterval` 120 s) fired three times with `screenLockState: locked`; every fire: keychain items `Claude Code-credentials` and `Codex Auth` found, S1 `claude auth status` `loggedIn: true`, S2 `claude -p` `LOOPMILL-OK` with `terminal_reason: completed`, S3 `codex login status` logged in, S4 `codex exec --json` `turn.completed`, S5 `gh auth status` logged in. Interactive baseline identical except `screen: unlocked`, `tty: yes`. The unit carried its own `PATH` (launchd's default is `/usr/bin:/bin:/usr/sbin:/sbin`, no Homebrew) and no `SECURITYSESSIONID` |
| D9, macOS `LaunchDaemon` with no login session; Linux `systemd --user` | **not run** | the daemon case needs `sudo` and a full log-out (procedure in `d9/README.md`); no Linux host is available |
| D10 SPIKE-1 locally | PASS | claude 2.1.263 on macOS, account default `claude-opus-5[1m]`: C1 (`loggedIn: true`, `authMethod: "claude.ai"`), C2, C3, C4 (7 lines, including a `rate_limit_event` and the operator's own hook events), C6-sigint (exit 0, `error_during_execution`, `aborted_streaming`, a result with `modelUsage: {}`), C6-sigterm (exit 143, no result), C6-timeoutint (124 through the shim, `aborted_streaming`), C7 (no hang, 5.1 s, no `setsid` on macOS). The hosted-runner contract holds on the host |

**Verdict.** D1-D4 and D7 PASS: the `codex` runtime is **verified** on the operator's host under
`subscription-login` (design §20.1). D9's primary case — a `launchd` user agent on a locked screen —
passed on macOS; the no-session daemon case and Linux remain unmeasured and are documented as such in
design §7.5.

### Findings that change the design

- **Codex usage is per process, not per thread.** `codex exec resume` starts its counter at zero, so
  the per-attempt figure is the attempt's own last `turn.completed.usage` and nothing is subtracted
  across processes. v0.5's thread-delta rule would have under-counted a resumed attempt (4,480 for the
  19,721-token attempt recorded here) and clamped its fresh bucket to zero. `usage-normalization.md`
  §2.2(b) and invariant I5 are rewritten; the hand-written `codex-two-turns-cumulative.json` is replaced
  by the recording `codex-recorded-two-turns.json`, which keeps the wrong numbers under `mustNotEqual`.
- **A SIGTERM-ed `codex exec` exits 0** — with no `turn.completed` in the stream. The exit code is
  therefore never a completion signal for codex; the terminal event is (`state-machine.md` §7.2 row 5
  already required it and now says why). SIGINT exits 1, also without a terminal event, so unlike
  claude-code there is no cancel signal that preserves usage: a cancelled codex attempt is `unavailable`
  and unmeasured for coverage.
- **stdin must be `/dev/null` or closed.** A non-TTY stdin is read as additional input (the
  `Reading additional input from stdin...` notice); an open pipe that is never closed would hold the
  CLI. Recorded in design §7.2.
- **The failure signal is structured.** An unknown model yields `error` and `turn.failed` events with
  the backend's `invalid_request_error` JSON inside `message`, exit 1. `codex exec resume`'s narrower
  flag set and the absence of any quota-shaped key in the exec JSONL (D6) are recorded in design §6.3
  and §14.2.
- **A `launchd` user agent on a locked screen reaches every login.** On macOS all three logins are
  keychain items (`claude`, `codex` with the keyring store, `gh`), and a user agent in the GUI session
  read them with the screen locked, three fires out of three. What the unit must carry is `PATH` (or
  absolute argv) and nothing else; there is no TTY and no security session. The unmeasured cases — a
  daemon with nobody logged in, and Linux — are the ones where the keychain or the user manager is
  expected to be absent, so design §7.5 documents them as preparation steps rather than assuming
  either way. `doctor --scheduler`'s check list is the probe's steps S1-S5 verbatim.

Harness lessons found before any real run, all recorded in `spikes/spike-4-codex-cli/README.md`: a
background job started by a non-interactive bash inherits an ignored SIGINT (measured on macOS bash
3.2: `sleep` survives `kill -INT` after a plain `&`, dies with 130 under `set -m`), so both launchers
switch job control on for the launch — SPIKE-1's C6 was unaffected only because a Node CLI installs
its own handler; `codex exec resume` accepts fewer flags than `codex exec` (no `-C`, `-s`, `--color`
in 0.144.6), so D4b runs from the scratch repository's own directory; macOS `date` has no `%N`.

---

## 7. Gate status and next steps

| Gate | Question | Status (2026-09-06) | Evidence |
|---|---|---|---|
| G1 | SPIKE-1: `claude-code` headless on a hosted runner with subscription OAuth only | **green** | run 34024962852, C1-C4 and C7 PASS (§3) |
| G2 | SPIKE-2: Codex Cloud as an `observed` backend, GO = R1 ∧ R4 ∧ R5 ∧ R7 ∧ (R3 ∨ R8) | **red — NO-GO**; `observed` dropped by maintainer decision (2026-09-06) | R4 FAIL, R8 FAIL with `GITHUB_TOKEN` (§4). Under v0.6 this no longer gates the MVP at all: `observed` is removed from the design outright, not merely left ungated (ADR-002 D4) |
| G3 | SPIKE-2b: seeded `auth.json` survives ephemeral runners | **superseded** — not run | ADR-002: no credential is ever moved to a runner Loopmill does not own, so the question no longer arises |
| G4 | SPIKE-3: non-resident, event-sourced `step` on real GitHub | **green — reinterpreted** | 21/21 local, 44 hosted runs (§5); the transition/journal/concurrency properties carry over to the SQLite store (ADR-002 Appendix B); the git-branch store and `GITHUB_TOKEN` chaining measured here are the reserved `github-actions` backend's mechanism, not the MVP's own |
| G5 | STOP (c): vendor terms read verbatim from primary sources | **green** — R11 done 2026-09-06 | OpenAI's Terms of Use, Usage Policies, the Codex CI/CD-auth page and the Scheduled-tasks page are quoted verbatim with access times in design §19.1; STOP (c) is evaluated in design §22: not triggered on the text, interpretive residual recorded |
| G6 | SPIKE-4: `codex exec` on the host, and the scheduler context | **green** — D1-D4 and D7 PASS 2026-09-06 (codex 0.153.4), D10 PASS (claude 2.1.263 on macOS), D9 PASS for a `launchd` user agent on a locked screen (3/3 fires); the no-session daemon case and Linux stay unmeasured | §6 |

**STOP conditions (v0.6, ADR-002 D10):** **(a)** no supported AI CLI can execute unattended on a
user-managed host under subscription authentication — **not triggered**, confirmed on the maintainer's
own host on 2026-09-06 (SPIKE-4 D10 reproduced SPIKE-1's C1-C4, C6 and C7 there, and D1-D7 ran
`codex exec` there too); **(b)** — "no cross-vendor path exists under subscriptions,
and the only working shape is GitHub Actions plus API keys" — **retired**: it was a statement about
hosted runners, and does not survive execution moving to a user-managed host; **(c)** vendor terms, read
verbatim, forbid the single-user unattended use Loopmill relies on — **not triggered on the text read**
(R11, 2026-09-06; design §19.1 and §22 carry the quotes and the interpretive residual).

1. **SPIKE-4 is closed for the MVP's own platform** (§6): D0-D8, D10 and the locked-screen `launchd`
   case of D9 all ran on 2026-09-06. Still unmeasured, and documented as preparation steps in design
   §7.5 rather than assumed: a `LaunchDaemon` with no login session (`d9/install-macos-daemon.sh`,
   needs `sudo` and a log-out) and `systemd --user` on Linux (no host). Run them when the situation
   arises; neither gates m0.
2. **R11 terms reading — done 2026-09-06.** OpenAI's Terms of Use, Usage Policies, the Codex CI/CD-auth
   page and the Scheduled-tasks page were read in a browser on the maintainer's machine (the policy pages
   answer HTTP 403 to non-browser clients); the quotes, URLs and access times are in design §19.1, and
   the full-text captures are kept outside the repository by the maintainer.
3. **Clean up the SPIKE-2 leftovers**, now that `observed` is removed rather than merely ungated: PR
   `#1`, branch `spike2/r8-mention`, and the Codex Cloud environment `loopmill-codex-spike`.
4. **SPIKE-3's follow-ups are now post-MVP items for the reserved `github-actions` backend**, not
   blockers for the SQLite-backed MVP store: `repository_dispatch` chaining and deploy-key/ruleset
   privilege separation between the control-plane and agent jobs. The `snapshot.json` O(n²) growth
   defect is the one SPIKE-3 finding that does carry over: the SQLite store keeps its idempotency index in
   the `events` table, never as id lists inside the snapshot (design §9.1).
5. **The m0 contract freeze is recorded** (`docs/design/m0-contract-freeze.md`, 2026-09-06), SPIKE-4 and
   R11 having closed; the five decisions listed there await the maintainer before m1 starts.
