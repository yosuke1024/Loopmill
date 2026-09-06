# SPIKE-1: Claude Code on a GitHub-hosted runner, subscription OAuth only

> **Reading under design v0.6 (ADR-002).** The MVP executes on a machine the operator manages, not on
> GitHub-hosted runners. This spike's result stands as the measured contract of the Claude Code CLI
> itself — `is_error`/`terminal_reason`, `modelUsage`, thinking tokens, SIGINT/SIGTERM, the
> `rate_limit_event` — which is independent of the runner; the hosted-runner half is the record for the
> reserved `github-actions` integration. Results: `docs/spikes/README.md` §3.

## Purpose

Loopmill's design assumes it can drive the official Claude Code CLI (`claude
-p`) as a subscription-native agent runtime: no API key, no billing account,
just the maintainer's own Claude Pro/Max login. This spike proves (or
disproves) that assumption on the environment Loopmill actually has to work
in first: a throwaway, non-interactive, no-TTY GitHub Actions runner.

Concretely, it answers:

- Does `claude auth status` report a subscription (OAuth) login, with no
  `ANTHROPIC_API_KEY` anywhere in the job?
- Does `-p --output-format json` give machine-readable results, usage, and
  cost that Loopmill can log per agent Node Execution?
- Does `--json-schema` give a validated structured output a Loopmill `condition`
  node can consume?
- What exactly does the exit-code / result-subtype contract look like when a
  run is cut short (`--max-turns`) or given a bad argument?
- Does cancelling a run with `SIGINT` preserve token usage, and does
  `SIGTERM` really lose it, the way the CLI's own docs claim?
- Does the documented no-TTY hang bug
  ([anthropics/claude-code#9026](https://github.com/anthropics/claude-code/issues/9026))
  reproduce here?
- Does an (invalid) `ANTHROPIC_API_KEY` really take precedence over the OAuth
  token in `-p` mode, the way the docs say it does?
- Is a plan/usage-limit hit distinguishable from any other failure?

This is a spike, not a feature: it produces a report (`out/RESULTS.md` plus
raw JSON per check), not a shipped capability.

## Prerequisites

1. A Claude **Pro, Max, Team, or Enterprise** subscription (the OAuth token
   `claude setup-token` mints is a subscription-only credential; it does not
   work on the Free plan).
2. Locally, on a machine where you are already logged into Claude Code with
   that subscription (`claude` running interactively, `/login` completed):

   ```bash
   claude setup-token
   ```

   This prints a long-lived (about one year) OAuth token **once**. Claude
   Code does not store it anywhere itself — copy it immediately.

3. Add it as a **repository secret** named `CLAUDE_CODE_OAUTH_TOKEN`:
   GitHub repo -> Settings -> Secrets and variables -> Actions -> New
   repository secret.

   **Never commit this token.** It is not tied to a specific machine —
   whoever holds it can run inference against your subscription — so treat
   it like any other bearer credential: repository secret only, rotate it if
   it ever leaks (there is no `claude setup-token --revoke`; revoke by
   logging out / rotating your Claude account session), and do not paste it
   into issues, PR descriptions, or workflow logs. This workflow and
   `run.sh` never print it; GitHub Actions also masks the literal secret
   value in logs as a second layer of defense.

4. Nothing else. The workflow installs Node 22 and the CLI itself.

## How to trigger

This workflow only runs on `workflow_dispatch` — it never runs on push or PR,
since it spends real tokens against your subscription.

**From the GitHub UI:** Actions tab -> "SPIKE-1 - Claude Code on subscription
OAuth only" -> Run workflow. Pick a branch, optionally set `model` (e.g.
`sonnet`), `scrub_test` (default `true`), and `only`, and run.

`only` takes a comma-separated list of check ids (e.g. `C6` or `C1,C6`); every
check not in the list is reported as `SKIPPED` instead of being run. It exists
to re-measure one check (typically C6, since it costs 8s+ per signal variant)
without re-spending the whole run. `C10` (the environment record) always runs
regardless of `only`, since it costs nothing.

**From the CLI** (requires `gh` and push/write access to the repo):

```bash
gh workflow run spike-1-claude-subscription.yml --ref <branch>

# with inputs:
gh workflow run spike-1-claude-subscription.yml --ref <branch> \
  -f model=sonnet -f scrub_test=true

# re-measure just C6:
gh workflow run spike-1-claude-subscription.yml --ref <branch> -f only=C6
```

Locally, the same selection is available via the `ONLY` environment variable
(e.g. `ONLY=C6 bash run.sh`) — see "Local validation" below.

Then watch it and pull the artifact once it finishes:

```bash
gh run watch
gh run download <run-id> -n spike-1-results -D ./spike-1-out
cat ./spike-1-out/RESULTS.md
```

## What each check proves

| Check | What it runs | Design question it answers |
|---|---|---|
| **C1** | `claude auth status --json` | **Subscription-only auth in CI.** Zero-token, non-interactive proof that the runner is logged in via OAuth (`authMethod`), not an API key, with no interactive `/login` step required. |
| **C2** | `claude -p "..." --output-format json --max-turns 1 --permission-mode plan --permission-prompts none` piped from `/dev/null` | **Usage/cost JSON.** Confirms the plain non-interactive path works with no TTY at all, and that the result object carries `usage` (input/output/cache tokens), `modelUsage`, `total_cost_usd`, `duration_ms`, `num_turns`, `session_id` — everything Loopmill's usage record needs per agent Node Execution (`docs/spec/usage-normalization.md` §2.1). |
| **C3** | Same, plus `--json-schema` | **Structured output.** Confirms `structured_output` is present, schema-conformant, and usable as-is by a `condition` node — without Loopmill having to parse free text. |
| **C4** | Same prompt, `--output-format stream-json --verbose` | Confirms the streaming event shape (`system/init`, `assistant`, `result`, …) that Loopmill's `execute(): AsyncIterable<AgentEvent>` would consume, and that the stream still ends in the same `result` object as C2. |
| **C5a** | A tool-using prompt under `--max-turns 1`, `--permission-mode acceptEdits --permission-prompts none`, in a scratch directory | **Exit-code contract, part 1.** Whether a turn cap on a task that needs tools ends as `success` (finished within the cap) or `error_max_turns` (cut off) — and what the process exit code is either way. |
| **C5b** | A deliberately invalid `--model` | **Exit-code contract, part 2.** Confirms invalid arguments fail loudly (non-zero exit, readable stderr) rather than silently falling back to something else — important for a runtime that has to tell FAILED apart from SUCCEEDED. |
| **C6** (`sigint`/`sigterm`/`timeoutint`) | A long, pure text-generation prompt ("Write out the integers from 1 to 1500, one per line, with no other text before, between or after them. Do not use any tool; produce the numbers yourself"), run with `--tools "" --permission-mode default --permission-prompts none --max-turns 1` and killed after 8s with `SIGINT`, then `SIGTERM`, then via `timeout -s INT 8`. This is deliberately **not** plan mode: in plan mode the model can decline a non-planning request in about two seconds, so the 8s signal would reach an already-exited process and measure nothing (observed 2026-09-06). | **Cancel signal that preserves usage.** The CLI's own docs claim `SIGINT` ends the turn cleanly with a recorded result (and usage), while `SIGTERM` yields exit 143 with *no* result at all. Loopmill's `cancel(runId)` must know which signal to send if a cancelled node is still supposed to report token usage. Each variant records `signal_delivered` (whether `kill` actually found a live process at the 8s mark) alongside `terminal_reason`; `SIGINT`/`SIGTERM` are only graded PASS/FAIL when `signal_delivered=yes` — otherwise the row is `INFO`, since the signal never reached a live process. |
| **C7** | C2's exact command, run detached (`setsid`) with stdin from `/dev/null`, under a 120s watchdog | **No-TTY hang behaviour.** Directly probes the failure mode reported in [anthropics/claude-code#9026](https://github.com/anthropics/claude-code/issues/9026): a `claude -p` invocation with no controlling terminal hanging instead of exiting. Exit code 124 means the watchdog had to kill it. |
| **C8** (`bad`/`good`, only if `scrub_test`) | C2's command with an invalid `ANTHROPIC_API_KEY` exported alongside the OAuth token, then again without it | **Env precedence.** The docs state `ANTHROPIC_API_KEY` always wins over the OAuth token in `-p` mode with no fallback. This proves it empirically: the "bad" run is *expected* to fail (an invalid key was used instead of the valid subscription login), and the "good" run confirms the OAuth-only path still works right after. This is the exact mechanism Loopmill's environment policy depends on when it scrubs `ANTHROPIC_API_KEY` from a child process's environment (`docs/design/mvp-design.md` §13.2, deny list). |
| **C9** | A trivial prompt, output grepped for `"hit your"`, then for the limit phrases `usage limit`, `rate limit`, `limit reached`, `limit resets`, `too many requests` | **Quota detectability.** There is no dedicated result subtype for a plan-limit hit — it is a generic failure with the limit message embedded in `result`/stderr. The grep deliberately does **not** match a bare `"limit"`: the result object itself contains field names like `depth_limit` and `concurrency_limit` (subagent stats), so a bare match would always fire. This check is informational: it only fires if you happen to be at your limit when you run the spike, but it records the raw text verbatim so a real hit can be matched against Loopmill's `WAITING_FOR_QUOTA` string patterns later. |
| **C10** | `node --version`, `claude --version`, `uname -a`, TTY check, `CLAUDE_CONFIG_DIR`/`HOME`/`PATH` | Baseline environment record so results are reproducible and comparable across runs/runners. |

## Pass/fail criteria

`out/RESULTS.md` gives each check one of five statuses:

- **PASS** — behavior matched what this spike expected or what the CLI's own
  docs claim. For most checks this means "it works": exit 0, `subtype:
  "success"`, the expected content. For a few checks (C5b, C8-bad, C6-sigterm)
  PASS means the *documented failure* was reproduced correctly — e.g. C8-bad
  is a PASS when the invalid API key run actually fails, because that is what
  proves precedence. PASS on **C2, C3, C4 and C8-good** additionally requires
  `is_error: false` in the parsed result, not just `subtype: "success"`: the
  CLI can report `subtype: "success"` together with `is_error: true` and exit
  1 when it is not logged in, or when an invalid API key wins precedence over
  the OAuth token (observed 2026-09-06). **C8-bad** is graded the mirror way:
  it PASSes on a non-zero exit, a non-`"success"` subtype, or `is_error:
  true` — any one of the three is accepted as proof the invalid key was
  rejected.
- **FAIL** — behavior diverged from what was expected/documented. This is
  the signal worth reading `out/<check>.summary.json` / `.err` for. In
  particular, a FAIL on **C1** or **C2** means the core premise of this
  spike does not currently hold and Loopmill's subscription-only design
  needs to be revisited before anything else here matters. A FAIL on **C7**
  means the known hang bug reproduced on GitHub-hosted runners specifically
  — a real blocker for CI-based Loopmill usage. A FAIL on **C8-bad** would
  mean the OAuth token was silently used *instead of* the invalid API key,
  contradicting the documented precedence Loopmill's env-scrubbing logic
  relies on.
- **INFO** — observational, no single correct outcome (C5a, C6-timeoutint,
  C9, C10). Read the details, don't grade them.
- **SKIPPED** — intentionally not run (C8 when `scrub_test: false`).
- **DRY-RUN** — `SPIKE_DRY_RUN=1` was set; the command was printed, not
  executed (used to validate the script's structure without spending
  tokens; see "Local validation" below).

**Overall spike verdict:** treat this spike as a pass for Loopmill's design
if C1, C2, C3, and C4 are PASS (the core "subscription-only, JSON usage,
structured output, streaming" story holds) and C7 is PASS (no hang). C5, C6,
C8, and C9 are expected to surface real, useful detail either way — a FAIL
there is a finding to design around, not necessarily a reason to abandon the
approach.

## Filling in the results

After a run, download the `spike-1-results` artifact and copy
`out/RESULTS.md` here, or fill in this template by hand from the artifact's
JSON files:

```markdown
### SPIKE-1 run — <date>, runner: ubuntu-latest, claude version: <x.y.z>

| Check | Status | Notes |
|---|---|---|
| C1 auth | | |
| C2 plain JSON | | |
| C3 structured output | | |
| C4 stream-json | | |
| C5a exit code (tool use, max-turns 1) | | |
| C5b exit code (invalid model) | | |
| C6 SIGINT | | |
| C6 SIGTERM | | |
| C6 timeout -s INT | | |
| C7 no-TTY hang probe | | |
| C8-bad (API key precedence) | | |
| C8-good (OAuth-only confirmed) | | |
| C9 quota probe | | |
| C10 environment | | |

**Overall:** PASS / FAIL — <one-line summary>
**Follow-ups for the design:** <links to design doc sections that need updating>
```

## Local validation (no tokens spent)

The workflow's structure can be sanity-checked without a subscription or any
network access:

```bash
bash -n spikes/spike-1-claude-subscription/run.sh   # syntax check

SPIKE_DRY_RUN=1 bash spikes/spike-1-claude-subscription/run.sh
cat spikes/spike-1-claude-subscription/out/RESULTS.md
```

In dry-run mode every check prints the exact command it would run (with
`--model`/`--json-schema`/etc. fully resolved) and still produces a
`RESULTS.md`, so the report format and check ordering can be reviewed by
anyone — including someone without Claude Code installed at all — before
spending a single token on the real thing. `SCRUB_TEST=false` and
`MODEL=<alias>` can also be set locally to mirror the workflow's inputs.

**`bash spikes/spike-1-claude-subscription/run.sh` without
`SPIKE_DRY_RUN=1` sends real prompts to your Claude account** if `claude` on
your `PATH` is already authenticated — it is not a no-op just because you
are running it locally. Only run it for real when you mean to spend tokens
against a subscription you intend to test.

## Notes on the harness itself

- `run.sh` never uses `set -e`: every check is isolated so that a crash or
  unexpected output in one (say, C6's signal handling) cannot prevent C7-C10
  from running and being reported.
- Every file written under `out/` is passed through a redaction filter that
  strips anything shaped like a Claude API key (`sk-ant-...`) or OAuth token
  (`oat01...`) before it touches disk — on top of GitHub Actions' own secret
  masking in the job log.
- `out/` is git-ignored in this directory (see `.gitignore`) — it is
  regenerated by every run and published as a build artifact, not committed.
- `run.sh` expands its optional argv arrays (e.g. `MODEL_ARGS`) with the
  `${arr[@]+"${arr[@]}"}` idiom rather than a plain `"${arr[@]}"`, so the dry
  run also works under bash 3.2 with `set -u`, where expanding an empty array
  the plain way is an unset-variable error.
