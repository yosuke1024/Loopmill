# SPIKE-4: Codex CLI on the operator's own host, ChatGPT login only

## What it proves

Whether `codex exec`, authenticated with nothing but the operator's own ChatGPT login on the host
(`codex login`), can serve as Loopmill's `codex` runtime under
`docs/adr/ADR-002-local-self-hosted-execution.md`: non-interactive execution, structured output, a
terminal-state and exit-code contract, and thread-cumulative usage normalised into the common Usage
record (`docs/spec/usage-normalization.md`). This is the harness for ADR-002's risks R1 (`codex exec`
does not run non-interactively with machine-readable results, usage and a terminal signal), R2 (a
scheduler-started process cannot reach the CLI's login state -- D9) and R3 (`claude -p` behaves
differently on the operator's own host than on the hosted runner SPIKE-1 measured it on -- D10).

The plan, the check-to-design mapping and the pass rule are in `docs/spikes/README.md` section 6; the
results are recorded there once a real run has happened.

## Layout

```
run.sh               checks D0-D8 (codex exec on this host); dry-run capable
normalize.mjs        the codex usage normaliser used by D8 (pure function + CLI); also writes the
                     recorded-fixture candidates
schema.json          the --output-schema used by D2 (the same verdict/reason shape as SPIKE-1 C3)
test/                offline tests for normalize.mjs against the committed hand-written fixtures
d9/                  the scheduler-context probes (launchd agent, launchd daemon, systemd --user
                     timer) and their own README
out/                 everything a run writes (git-ignored)
```

## Prerequisites

1. `codex` logged in via a ChatGPT subscription on this host (`codex login`; `codex login status`
   must exit 0). `OPENAI_API_KEY` and `CODEX_API_KEY` unset in your own shell, so a run cannot
   silently fall back to metered billing -- the harness also explicitly unsets both on every
   invocation it makes, regardless of your shell.
2. Node.js >= 22 on `PATH` (JSON parsing, `normalize.mjs`, the offline tests), exactly as SPIKE-1.
3. `git` on `PATH`. The harness creates and owns a scratch git repository under `out/work/` and a
   worktree under `out/work-wt/` (D7). It never touches the Loopmill repository itself.
4. macOS or Linux. `run.sh` targets bash 3.2 (macOS's shipped `/bin/bash`) as well as bash 5: no
   associative arrays, no `mapfile`, no `${var,,}`, no `timeout` binary.
5. The operator's own `~/.codex/config.toml` applies to every invocation, as it would under Loopmill
   (MCP servers, `notify` hooks, credential-store settings). Pass overrides through
   `CODEX_EXTRA_ARGS` (for example `-c notify=[]`) rather than editing the script; the value is
   recorded in `RESULTS.md`. D4 deliberately does not use `--ephemeral`, so its two turns leave
   session files under `CODEX_HOME` like any interactive session would.

## How to run

```bash
bash spikes/spike-4-codex-cli/run.sh
```

**This sends real prompts to your ChatGPT-authenticated `codex` CLI.** A full run is about ten
`codex exec` invocations: eight trivial prompts, one deliberately long answer (D4a, roughly 600
output tokens), three long answers interrupted a few seconds in (D5), and one small file edit (D7).
Only run it for real when you mean to spend usage against the subscription you intend to test.

Local validation with no tokens spent:

```bash
bash -n spikes/spike-4-codex-cli/run.sh                       # syntax
SPIKE_DRY_RUN=1 bash spikes/spike-4-codex-cli/run.sh          # prints every argv, writes RESULTS.md
cat spikes/spike-4-codex-cli/out/RESULTS.md
(cd spikes/spike-4-codex-cli && node --test test/*.test.mjs)  # normalizer against the fixtures
```

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `SPIKE_DRY_RUN` | `0` | `1` prints every command instead of running it |
| `ONLY` | (all) | comma-separated check ids (`D1,D4,D8`, ...); every other check is reported `SKIPPED`. `D3`, `D4`, `D5` select all their sub-checks |
| `MODEL` | (account default) | passed as `-m <MODEL>` on every `codex exec` / `codex exec resume` call |
| `CODEX_EXTRA_ARGS` | (empty) | word-split and appended to every `codex exec` argv |
| `CHECK_TIMEOUT` | `300` | seconds before the harness's own deadline (SIGTERM, then SIGKILL after 10 s) fires on D1/D2/D3/D4/D7 |
| `SIGNAL_DELAY` | `8` | seconds the harness waits before sending a signal in D5, and D5-TIMEOUT's own deadline |

```bash
ONLY=D4,D8 bash spikes/spike-4-codex-cli/run.sh          # re-measure the cumulative-usage check
SIGNAL_DELAY=3 ONLY=D5 bash spikes/spike-4-codex-cli/run.sh
```

## Checks D0-D8

| Check | What it runs | Design question it answers |
|---|---|---|
| D0 | `codex --version`, `codex login status`, two keys of `config.toml` (`cli_auth_credentials_store`, `forced_login_method`), whether `auth.json` exists, the macOS keyring probe (exit code only) | The environment record. Flags loudly when `login_status_exit != 0` or an API key is present in the harness's own environment -- either invalidates the rest of the run |
| D1 | `codex exec --json "Reply with exactly: LOOPMILL-OK"`, stdin from `/dev/null`, `-s read-only`, inside the scratch repository | Whether `subscription-login` runs non-interactively at all (design section 6.4, ADR-002 D5). Non-fatal `error` events are counted, not graded |
| D2 | Same, plus `--output-schema schema.json` | Whether structured output is schema-conformant, survives re-validation, and equals the `-o` file (design section 11) |
| D3 (a/b/c) | a success; `-m loopmill-no-such-model`; `--loopmill-no-such-flag` | The terminal-state and exit-code contract: `turn.completed` vs `turn.failed`, pairwise-distinct exit codes, and whether the failure signal is a structured event or stderr prose (design sections 6.3, 10) |
| D4 (a/b) | Turn 1 with a deliberately large answer; turn 2 via `codex exec resume <thread_id>` with a tiny answer | Whether `turn.completed.usage` is thread-cumulative: turn 2's `output_tokens` must exceed turn 1's, which a per-turn figure for a five-token reply cannot do. Also records which `resume` flags this version accepts (design section 14.2) |
| D5 (SIGINT / SIGTERM / TIMEOUT) | A long counting answer, signalled `SIGNAL_DELAY` seconds in; the third variant is the harness's own cancel sequence (SIGTERM, then SIGKILL after 10 s) | Which signal `cancel(runId)` must send and what survives: exit code, whether `turn.completed` was written, whether the last JSONL line is truncated (design section 14.4, `usage-normalization.md` section 2.5). `FAIL` only when the signal reached an already-exited process |
| D6 | Grep every D1-D5 output for a plan-limit phrase; scan every JSONL event for quota-shaped keys; list the distinct event types seen | The quota signal's shape for `codex`: prose only, or something machine-readable (state-machine section 7.3). Informational |
| D7 | A file-creating prompt with `-s workspace-write` inside a git worktree cut from the scratch repository | Whether the worktree diff is what the `local` backend assumes: exactly one new file with the requested content, the main checkout untouched, and which item types (`file_change`, `command_execution`) the stream carried (design sections 7.2, 18) |
| D8 | `normalize.mjs` over D1, D2, D3b, D4a, D4b, D5-*, D7 | Whether the raw streams normalise into the canonical Usage record with invariants I2, I5 and I8 holding, and writes the recorded-fixture candidates under `out/fixtures/` (design section 14.1) |

## Pass rule

**D1-D4 and D7 all PASS -> the `codex` runtime is `VERIFIED`** (design section 20.1); a FAIL on any
of them keeps `codex` at `PLANNED / EXPERIMENTAL` behind the same provider abstraction and does not
stop the MVP (ADR-002 D10). D5, D6, D8, D9 and D10 are expected to surface useful detail regardless of
outcome, the same way C5, C6, C9 and C10 did in SPIKE-1.

Status legend: `PASS` (matched what was expected or documented), `FAIL` (diverged; read the details
column and the linked `out/<check>.*` files), `INFO` (observational: D0, D3a-c, D4a/b, the D5
sub-checks when the signal reached a live process, D6), `SKIPPED` (`ONLY` did not select it),
`DRY-RUN` (`SPIKE_DRY_RUN=1`).

## Outputs

Everything is written under `out/` next to the script (git-ignored):

```
out/RESULTS.md                 the summary table (also the run report)
out/<check>.json               redacted raw stdout (JSONL for exec)
out/<check>.err                redacted raw stderr
out/<check>.code               exit code
out/<check>.argv.txt           the exact argv that was run (redacted), recorded into the fixtures
out/<check>.duration           wall-clock seconds
out/<check>.deadline           yes|no: whether the harness's own deadline fired
out/<check>.alive-at-signal    D5: whether the process was alive when the signal was sent
out/<check>.last.txt           the -o/--output-last-message file, where the sub-command supports it
out/<check>.summary.json       stream_summary's parsed view of the JSONL (event types, usage, ...)
out/<check>.usage.json         normalize.mjs's canonical Usage record + diagnostics (D8)
out/fixtures/codex-recorded-*.json   recorded-fixture candidates (D8), in the shape of
                                      docs/spec/usage-fixtures/codex-*.json with a `recording` block
out/work/, out/work-wt/        the scratch repository and D7's worktree
```

Redaction is applied before anything is persisted: API-key and token shapes, JWTs, e-mail addresses,
`account_id` values, and the user segment of `/Users/...` and `/home/...` paths.

## Harness lessons (found while building it, before any real run)

- **Background jobs inherit an ignored SIGINT.** A non-interactive bash starts `cmd &` with SIGINT
  set to ignore, and the child keeps that disposition; a CLI that relies on the default action then
  looks immune to Ctrl-C. Measured on macOS bash 3.2: after a plain `&`, `sleep` survives `kill -INT`;
  under `set -m` it dies with 130. Both launchers here switch job control on for the launch only.
  Node-based CLIs install their own handler and hide this, which is why SPIKE-1's C6 was unaffected.
- **`codex exec resume` accepts fewer flags than `codex exec`** (`--json`, `--output-schema`, `-o`
  and `-m` are listed; `-C`, `-s` and `--color` are not, per `--help` on 0.144.6). D4b therefore runs
  from the scratch repository's own working directory and records the flag set that was accepted.
- **macOS `date` has no `%N`**, so durations are whole seconds.
- **`--skip-git-repo-check` is not used**: the harness gives `codex` a real repository, because that
  is what the `local` backend does.
- **The first real run changed two grades, not the measurements.** D4 had been written expecting a
  thread-cumulative count and graded the per-invocation result FAIL; D7 graded a trailing full stop
  FAIL on an exact-content match. Both now grade the design question and record the raw observation
  (`usage_semantics`, `content_exact`). The first pass's numbers are kept in `docs/spikes/README.md`
  section 6.
- **`codex exec` reads a non-TTY stdin.** With stdin on `/dev/null` it prints
  `Reading additional input from stdin...` and continues; an open pipe that is never closed would hold
  it. Loopmill's executor must hand the CLI `/dev/null`.
- **A SIGTERM-ed `codex exec` exits 0** with no `turn.completed`; SIGINT exits 1. Neither leaves a usage
  record, so the terminal event, never the exit code, is the completion signal.

## Results

Recorded in `docs/spikes/README.md` section 6 (2026-09-06, codex 0.153.4, claude 2.1.263). The
recorded fixtures live in `docs/spec/usage-fixtures/codex-recorded-*.json`.

## D9 -- the scheduler context

D9 cannot live in `run.sh`: it has to be started *by* the OS scheduler. `d9/README.md` describes the
four contexts (`interactive-baseline`, `launchd-agent` with the screen locked, `launchd-daemon` with
no login session, `systemd-timer` with and without linger), the generator scripts that write the
plist and unit files without loading them, and the results table to fill in. Every fire spends one
trivial `claude -p` and one trivial `codex exec` call; the operator runs them, not an agent.

## D10 -- the SPIKE-1 harness on this host

```bash
ONLY=C1,C2,C3,C4,C6,C7 bash spikes/spike-1-claude-subscription/run.sh
```

Read `spikes/spike-1-claude-subscription/out/RESULTS.md` against the hosted-run table in
`docs/spikes/README.md` section 3. Expected differences that are not findings: C1 reports
`authMethod: "claude.ai"` for an interactive login (the hosted runner had `oauth_token`), C7 reports
`setsid_available=no` on macOS, and the local `claude` version may differ from the 2.1.263 measured on
the runner -- record it.
