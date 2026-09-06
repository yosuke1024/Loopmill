#!/usr/bin/env bash
# SPIKE-4: Codex CLI (`codex exec`) as Loopmill's `codex` runtime, run on the operator's own host,
# authenticated ONLY by the CLI's own ChatGPT login (`codex login`) -- no OPENAI_API_KEY, no
# CODEX_API_KEY. This is the harness for ADR-002's risks R1 (does codex exec run non-interactively
# with machine-readable results, usage and a terminal signal), R2 (a scheduler-started process
# reaching the login state -- see D9, elsewhere) and R3 (does claude -p behave the same on this host
# as SPIKE-1 measured on a hosted runner -- see D10, elsewhere).
#
# Modelled closely on spikes/spike-1-claude-subscription/run.sh: same conventions apply here.
#
# Every check below is isolated: a failure or crash in one check must never stop the others from
# running. We deliberately do NOT use `set -e` for this reason -- each check function traps its own
# command's exit status and keeps going. `set -u` catches unset-variable bugs in this script itself;
# every variable that depends on external output is defaulted before use, and every array that might
# be empty is expanded with the `${arr[@]+"${arr[@]}"}` idiom so an empty-array expansion is not an
# unbound-variable error under bash 3.2 (macOS's shipped bash) with `set -u`. No associative arrays,
# no `mapfile`/`readarray`, no `${var,,}` -- this script must run unmodified on macOS bash 3.2 and on
# Linux bash 5.
#
# Outputs: everything is written under out/ next to this script:
#   out/RESULTS.md              human-readable summary table (also the run report)
#   out/<check>.json             redacted raw stdout of the check's codex invocation (JSONL for exec)
#   out/<check>.err              redacted raw stderr
#   out/<check>.code             the codex process's exit code
#   out/<check>.duration         wall-clock seconds the invocation took (run_codex/run_codex_signal)
#   out/<check>.deadline         yes|no -- whether run_codex's own deadline (not a signal test) fired
#   out/<check>.last.txt         the -o/--output-last-message file, when the sub-command supports it
#   out/<check>.summary.json     stream_summary's parsed view of the JSONL (event types, usage, ...)
#   out/<check>.usage.json       normalize.mjs's canonical Usage record + diagnostics (D8)
#   out/fixtures/codex-recorded-*.json   candidate recorded fixtures (D8)
#   out/work/                    a scratch git repository this script owns; codex is always run with
#                                 -C pointed inside it. NEVER the Loopmill repository itself.
#   out/work-wt/                 a git worktree of out/work, used by D7 (workspace-write)
#
# Dry run: SPIKE_DRY_RUN=1 bash run.sh prints every command this script would run (with a fully-formed
# argv) instead of executing it, and still produces a RESULTS.md, so the report structure and every
# check's exact argv can be reviewed without spending a token or requiring a logged-in codex binary.
#
# ONLY: optional comma-separated list of check ids (D0,D1,...,D8) selects which checks run; every
# other check is reported SKIPPED. D3's three sub-checks are selected together via `ONLY=D3` (there is
# no way to select just D3b); same for D4 (D4a/D4b) and D5 (D5-SIGINT/D5-SIGTERM/D5-TIMEOUT).
#
# D9 (scheduler context: launchd / systemd --user reaching the codex/claude login state) lives under
# d9/ (see README.md `## D9`) -- it is not part of this script because it cannot be, by construction:
# it has to be triggered BY a scheduler, not by a process the operator ran directly. D10 (whether the
# SPIKE-1 hosted-runner contract also holds on this host) is simply the SPIKE-1 harness itself, run
# locally: `ONLY=C1,C2,C3,C4,C6,C7 bash spikes/spike-1-claude-subscription/run.sh` (see README.md).
set -uo pipefail

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
RESULTS_MD="$OUT_DIR/RESULTS.md"
WORK_DIR="$OUT_DIR/work"
FIXTURES_DIR="$OUT_DIR/fixtures"
SCHEMA_FILE="$SCRIPT_DIR/schema.json"
NORMALIZE_JS="$SCRIPT_DIR/normalize.mjs"

mkdir -p "$OUT_DIR" "$FIXTURES_DIR"

DRY_RUN="${SPIKE_DRY_RUN:-0}"
MODEL="${MODEL:-}"
ONLY="${ONLY:-}"
CODEX_EXTRA_ARGS="${CODEX_EXTRA_ARGS:-}"
CHECK_TIMEOUT="${CHECK_TIMEOUT:-300}"
SIGNAL_DELAY="${SIGNAL_DELAY:-8}"

# selected <id> -> 0 when the check should run
selected() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}

MODEL_ARGS=()
if [ -n "$MODEL" ]; then
  MODEL_ARGS=(-m "$MODEL")
fi

# CODEX_EXTRA_ARGS: optional, word-split, appended to every codex exec argv (e.g. `-c notify=[]`).
CODEX_EXTRA_ARGS_ARR=()
if [ -n "$CODEX_EXTRA_ARGS" ]; then
  read -ra CODEX_EXTRA_ARGS_ARR <<< "$CODEX_EXTRA_ARGS"
fi

# Every codex invocation runs with OPENAI_API_KEY and CODEX_API_KEY explicitly unset, so a run cannot
# silently fall back to metered API billing.
CODEX_BASE=(env -u OPENAI_API_KEY -u CODEX_API_KEY codex)

# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

# Redact anything that looks like a credential or PII from any output we persist. Applied to every
# file this script writes under out/.
redact() {
  sed -E \
    -e 's/sk-ant-[A-Za-z0-9_-]{6,}/sk-ant-***REDACTED***/g' \
    -e 's/oat01-?[A-Za-z0-9_-]{6,}/oat01-***REDACTED***/g' \
    -e 's/sk-[A-Za-z0-9_-]{6,}/sk-***REDACTED***/g' \
    -e 's/(Bearer )[A-Za-z0-9._-]{20,}/\1***REDACTED***/g' \
    -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/***JWT-REDACTED***/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***EMAIL-REDACTED***/g' \
    -e 's/"account_id"[[:space:]]*:[[:space:]]*"[^"]*"/"account_id":"***REDACTED***"/g' \
    -e 's/account_id=[A-Za-z0-9_-]+/account_id=***REDACTED***/g' \
    -e 's#/Users/[^/[:space:]"]+/#/Users/***/#g' \
    -e 's#/home/[^/[:space:]"]+/#/home/***/#g'
}

# append_row <id> <description> <status> <details>
# Appends one row to the RESULTS.md table. Status is one of:
#   PASS | FAIL | INFO | SKIPPED | DRY-RUN
append_row() {
  local id="$1" desc="$2" status="$3" details="$4"
  desc="${desc//|/\\|}"
  details="${details//|/\\|}"
  details="${details//$'\n'/ }"
  printf '| %s | %s | %s | %s |\n' "$id" "$desc" "$status" "$details" >> "$RESULTS_MD"
}

skip_row() { append_row "$1" "$2" "SKIPPED" "not selected by ONLY=$ONLY"; }

# dry_row <id> <description> <argv-as-single-display-string>
dry_row() {
  local id="$1" desc="$2" shown="$3"
  echo "[DRY-RUN] $id: $shown"
  append_row "$id" "$desc" "DRY-RUN" "would run: $shown"
}

# show_argv <argv...> -- best-effort shell-quoted rendering for dry-run display
show_argv() {
  local out="" a
  for a in "$@"; do
    out="$out $(printf '%q' "$a")"
  done
  printf '%s' "${out# }"
}

# intval <maybe-empty-or-non-numeric> -- coerces to a non-negative integer, defaulting to 0. Used
# before every `-ge`/`-gt` comparison so a missing/empty jget result never trips `set -u` or prints a
# stray "integer expression expected" to the terminal.
intval() {
  case "$1" in
    '' | *[!0-9]*) echo 0 ;;
    *) echo "$1" ;;
  esac
}

# jget <json-file> <dotted.path>
# Minimal JSON field accessor (Node is guaranteed present -- see docs/spikes/README.md prerequisites).
# Prints an empty string on any parse/lookup failure, never errors out.
jget() {
  local file="$1" path="$2"
  node -e '
    try {
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const parts = process.argv[2].split(".");
      let v = d;
      for (const p of parts) {
        if (v === null || v === undefined) { v = undefined; break; }
        v = v[p];
      }
      if (v === undefined || v === null) console.log("");
      else if (typeof v === "object") console.log(JSON.stringify(v));
      else console.log(String(v));
    } catch (e) {
      console.log("");
    }
  ' "$file" "$path" 2>/dev/null
}

# last_agent_message <summary.json> -- the last element of stream_summary's agent_messages array, or
# empty string if there is none.
last_agent_message() {
  node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const arr = d.agent_messages || [];
      process.stdout.write(arr.length ? arr[arr.length - 1] : "");
    } catch (e) { process.stdout.write(""); }
  ' "$1" 2>/dev/null
}

# stream_summary <jsonl-file> <summary-json-file>
# Parses a `codex exec --json` JSONL transcript into the compact summary described in the SPIKE-4
# task brief: parse_ok, line_count, parse_errors, event_types (in order, "item.completed:agent_message"
# style for item events), thread_id, turn_completed_count, last_usage (the usage object of the LAST
# turn.completed, or null), turn_failed (the error, or null), error_events, agent_messages (last 3,
# truncated to 300 chars each), item_types (counts per item type), last_line_truncated (true when the
# last non-empty line does not parse), model (from thread.started/turn.started if present, else null).
stream_summary() {
  local ndjson_file="$1" summary_file="$2"
  local tmp="$summary_file.tmp"
  node -e '
    const fs = require("fs");
    let out;
    try {
      const raw = fs.readFileSync(process.argv[1], "utf8");
      let lines = raw.split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
      const nonBlank = lines.filter(l => l.trim().length > 0);

      const events = [];
      const eventTypes = [];
      let parseErrors = 0;
      let lastLineTruncated = false;

      nonBlank.forEach((line, idx) => {
        try {
          const obj = JSON.parse(line);
          events.push(obj);
          let t = obj && obj.type ? String(obj.type) : "UNKNOWN";
          if ((obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") && obj.item && obj.item.type) {
            t = t + ":" + obj.item.type;
          }
          eventTypes.push(t);
        } catch (e) {
          parseErrors++;
          eventTypes.push("PARSE_ERROR");
          if (idx === nonBlank.length - 1) lastLineTruncated = true;
        }
      });

      let threadId = null;
      let turnCompletedCount = 0;
      let lastUsage = null;
      let turnFailed = null;
      let model = null;
      const errorEvents = [];
      const itemTypes = {};
      const agentMessages = [];

      for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "thread.started") {
          if (ev.thread_id) threadId = ev.thread_id;
          if (ev.model && !model) model = ev.model;
        }
        if (ev.type === "turn.started" && ev.model && !model) model = ev.model;
        if (ev.type === "turn.completed") {
          turnCompletedCount++;
          lastUsage = ev.usage || null;
        }
        if (ev.type === "turn.failed") {
          turnFailed = ev.error || ev.message || true;
        }
        if (ev.type === "error") {
          errorEvents.push(ev);
        }
        if ((ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed") && ev.item && ev.item.type) {
          itemTypes[ev.item.type] = (itemTypes[ev.item.type] || 0) + 1;
          if (ev.type === "item.completed" && ev.item.type === "agent_message" && typeof ev.item.text === "string") {
            agentMessages.push(ev.item.text.slice(0, 300));
          }
        }
      }

      out = {
        parse_ok: true,
        line_count: nonBlank.length,
        parse_errors: parseErrors,
        event_types: eventTypes,
        thread_id: threadId,
        turn_completed_count: turnCompletedCount,
        last_usage: lastUsage,
        turn_failed: turnFailed,
        error_events: errorEvents,
        agent_messages: agentMessages.slice(-3),
        item_types: itemTypes,
        last_line_truncated: lastLineTruncated,
        model: model
      };
    } catch (e) {
      out = { parse_ok: false, parse_error: String((e && e.message) || e) };
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
  ' "$ndjson_file" "$tmp" 2>/dev/null
  if [ -f "$tmp" ]; then
    redact < "$tmp" > "$summary_file"
    rm -f "$tmp"
  else
    echo '{"parse_ok":false,"parse_error":"stream_summary produced no output"}' > "$summary_file"
  fi
}

# ensure_work_repo -- creates the scratch git repository this whole script operates in, once. NEVER
# touches the Loopmill repository: this is a brand new repo under out/work, with its own local
# user.name/user.email (never the global git config), one initial commit.
ensure_work_repo() {
  if [ -d "$WORK_DIR/.git" ]; then
    return 0
  fi
  mkdir -p "$WORK_DIR"
  git -C "$WORK_DIR" init -q >/dev/null 2>&1
  git -C "$WORK_DIR" config user.name "Loopmill SPIKE-4" >/dev/null 2>&1
  git -C "$WORK_DIR" config user.email "spike4@loopmill.local" >/dev/null 2>&1
  {
    echo "# SPIKE-4 scratch repository"
    echo
    echo "This repository exists only for spikes/spike-4-codex-cli/run.sh. It is never pushed"
    echo "anywhere and is not part of the Loopmill repository's own history."
  } > "$WORK_DIR/README.md"
  git -C "$WORK_DIR" add README.md >/dev/null 2>&1
  git -C "$WORK_DIR" commit -q -m "Initial commit for SPIKE-4 scratch repository" >/dev/null 2>&1
}

# run_codex <id> <deadline_seconds> <argv...>
# Like run_and_finalize (SPIKE-1) but also records wall-clock duration to out/<id>.duration and
# enforces a hard deadline WITHOUT the `timeout` binary (macOS has none): starts argv in the
# background with stdin from /dev/null, polls `kill -0` every 0.5s, and if the deadline passes sends
# SIGTERM, waits up to 10s, then SIGKILL. Records deadline_hit=yes|no to out/<id>.deadline.
run_codex() {
  local id="$1" deadline_s="$2"; shift 2
  local raw_out="$OUT_DIR/${id}.out.raw"
  local raw_err="$OUT_DIR/${id}.err.raw"
  : > "$raw_out"; : > "$raw_err"
  show_argv "$@" | redact > "$OUT_DIR/${id}.argv.txt"

  local start end elapsed
  start=$(date +%s)
  # Job control is switched on for the launch only: a non-interactive bash starts background jobs
  # with SIGINT ignored and the child inherits that disposition, so a binary that relies on the
  # default action would look immune to SIGINT (measured on macOS bash 3.2: after a plain `&`,
  # `sleep` survives INT; under `set -m` it dies with 130). Node-based CLIs install their own
  # handler and hide this; a Rust CLI may not.
  set -m
  "$@" >"$raw_out" 2>"$raw_err" < /dev/null &
  local pid=$!
  set +m

  local deadline_ticks=$(( deadline_s * 2 ))
  local ticks=0
  local hit="no"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.5
    ticks=$((ticks + 1))
    if [ "$ticks" -ge "$deadline_ticks" ]; then
      hit="yes"
      kill -TERM "$pid" 2>/dev/null
      local term_s=0
      while kill -0 "$pid" 2>/dev/null && [ "$term_s" -lt 10 ]; do
        sleep 1
        term_s=$((term_s + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null
      fi
      break
    fi
  done

  wait "$pid" 2>/dev/null
  local code=$?
  end=$(date +%s)
  elapsed=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.2f", b - a }' 2>/dev/null || echo "?")

  echo "$code" > "$OUT_DIR/${id}.code"
  echo "$elapsed" > "$OUT_DIR/${id}.duration"
  echo "$hit" > "$OUT_DIR/${id}.deadline"
  redact < "$raw_out" > "$OUT_DIR/${id}.json"
  redact < "$raw_err" > "$OUT_DIR/${id}.err"
  rm -f "$raw_out" "$raw_err"
  return "$code"
}

# run_codex_signal <id> <signal-name> <delay-s> <argv...>
# Starts argv in the background, waits <delay-s> seconds, confirms the process is still alive
# (kill -0 immediately before signalling -- the alive_at_signal record C6 taught us matters), sends
# <signal-name>, then waits up to 60s for it to exit, escalating to SIGKILL if it still has not.
# Sets D5_ALIVE, D5_DELIVERED, D5_ELAPSED, D5_ESCALATED for the caller and returns the exit code.
run_codex_signal() {
  local id="$1" signal="$2" delay="$3"; shift 3
  local raw_out="$OUT_DIR/${id}.out.raw"
  local raw_err="$OUT_DIR/${id}.err.raw"
  : > "$raw_out"; : > "$raw_err"
  show_argv "$@" | redact > "$OUT_DIR/${id}.argv.txt"

  local start end elapsed
  start=$(date +%s)
  # Job control is switched on for the launch only: a non-interactive bash starts background jobs
  # with SIGINT ignored and the child inherits that disposition, so a binary that relies on the
  # default action would look immune to SIGINT (measured on macOS bash 3.2: after a plain `&`,
  # `sleep` survives INT; under `set -m` it dies with 130). Node-based CLIs install their own
  # handler and hide this; a Rust CLI may not.
  set -m
  "$@" >"$raw_out" 2>"$raw_err" < /dev/null &
  local pid=$!
  set +m

  sleep "$delay"

  local alive="no"
  if kill -0 "$pid" 2>/dev/null; then alive="yes"; fi

  local delivered="no"
  if [ "$alive" = "yes" ]; then
    kill -s "$signal" "$pid" 2>/dev/null && delivered="yes"
  fi

  local waited=0
  local escalated="no"
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 60 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    escalated="yes"
    kill -KILL "$pid" 2>/dev/null
  fi

  wait "$pid" 2>/dev/null
  local code=$?
  end=$(date +%s)
  elapsed=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.2f", b - a }' 2>/dev/null || echo "?")

  echo "$code" > "$OUT_DIR/${id}.code"
  echo "$elapsed" > "$OUT_DIR/${id}.duration"
  echo "$alive" > "$OUT_DIR/${id}.alive-at-signal"
  echo "$escalated" > "$OUT_DIR/${id}.escalated-to-sigkill"
  redact < "$raw_out" > "$OUT_DIR/${id}.json"
  redact < "$raw_err" > "$OUT_DIR/${id}.err"
  rm -f "$raw_out" "$raw_err"

  D5_ALIVE="$alive"
  D5_DELIVERED="$delivered"
  D5_ELAPSED="$elapsed"
  D5_ESCALATED="$escalated"
  return "$code"
}

# ---------------------------------------------------------------------------
# D0: environment and auth record
# ---------------------------------------------------------------------------
check_D0() {
  local id="D0" desc="environment and auth record (codex --version, login status, config, keyring)"
  local cmd_version=("${CODEX_BASE[@]}" --version)
  local cmd_login=("${CODEX_BASE[@]}" login status)

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd_version[@]}") && $(show_argv "${cmd_login[@]}") && [macOS only] security find-generic-password -s \"Codex Auth\""
    return 0
  fi

  local version_out version_code
  version_out=$("${cmd_version[@]}" 2>"$OUT_DIR/${id}.version.err.raw")
  version_code=$?
  redact <<< "$version_out" > "$OUT_DIR/D0.codex-version.txt"

  local login_out login_code
  login_out=$("${cmd_login[@]}" < /dev/null 2>"$OUT_DIR/${id}.login.err.raw")
  login_code=$?

  local login_stdout_first login_stderr_first
  login_stdout_first=$(printf '%s\n' "$login_out" | head -n1)
  login_stderr_first=$(head -n1 "$OUT_DIR/${id}.login.err.raw" 2>/dev/null)

  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local codex_home_display="${CODEX_HOME:-<unset>}"
  local auth_json_exists="no"
  [ -f "$codex_home/auth.json" ] && auth_json_exists="yes"

  local cred_store="<absent>" forced_login="<absent>"
  if [ -f "$codex_home/config.toml" ]; then
    local v
    v=$(grep -E '^[[:space:]]*cli_auth_credentials_store[[:space:]]*=' "$codex_home/config.toml" 2>/dev/null | head -n1 | sed -E 's/^[^=]*=[[:space:]]*//')
    [ -n "$v" ] && cred_store="$v"
    v=$(grep -E '^[[:space:]]*forced_login_method[[:space:]]*=' "$codex_home/config.toml" 2>/dev/null | head -n1 | sed -E 's/^[^=]*=[[:space:]]*//')
    [ -n "$v" ] && forced_login="$v"
  fi

  local openai_key_present="no" codex_key_present="no"
  [ -n "${OPENAI_API_KEY:-}" ] && openai_key_present="yes"
  [ -n "${CODEX_API_KEY:-}" ] && codex_key_present="yes"

  local tty="no"; [ -t 0 ] && tty="yes"
  local node_version uname_a
  node_version=$(node --version 2>&1 || echo "unavailable")
  uname_a=$(uname -a 2>&1 || echo "unavailable")

  local keyring_hit="n/a (not macOS)"
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    if security find-generic-password -s "Codex Auth" >/dev/null 2>&1; then
      keyring_hit="yes"
    else
      keyring_hit="no"
    fi
  fi

  node -e '
    const out = {
      codex_version: process.argv[1],
      codex_version_exit: process.argv[2],
      login_status_exit: process.argv[3],
      login_status_stdout_first_line: process.argv[4],
      login_status_stderr_first_line: process.argv[5],
      auth_json_exists: process.argv[6],
      codex_home: process.argv[7],
      cli_auth_credentials_store: process.argv[8],
      forced_login_method: process.argv[9],
      openai_api_key_present: process.argv[10],
      codex_api_key_present: process.argv[11],
      uname: process.argv[12],
      node_version: process.argv[13],
      tty_stdin: process.argv[14],
      path: process.env.PATH || "<unset>",
      macos_keyring_has_codex_auth: process.argv[15]
    };
    console.log(JSON.stringify(out, null, 2));
  ' "$version_out" "$version_code" "$login_code" "$login_stdout_first" "$login_stderr_first" \
    "$auth_json_exists" "$codex_home_display" "$cred_store" "$forced_login" \
    "$openai_key_present" "$codex_key_present" "$uname_a" "$node_version" "$tty" "$keyring_hit" \
    > "$OUT_DIR/${id}.out.raw" 2>"$OUT_DIR/${id}.err.raw"

  echo 0 > "$OUT_DIR/${id}.code"
  redact < "$OUT_DIR/${id}.out.raw" > "$OUT_DIR/${id}.json"
  redact < "$OUT_DIR/${id}.err.raw" > "$OUT_DIR/${id}.err"
  rm -f "$OUT_DIR/${id}.out.raw" "$OUT_DIR/${id}.err.raw" "$OUT_DIR/${id}.version.err.raw" "$OUT_DIR/${id}.login.err.raw"

  local flags=""
  if [ "$login_code" != "0" ]; then flags="${flags} [!!login_status_exit!=0]"; fi
  if [ "$openai_key_present" = "yes" ] || [ "$codex_key_present" = "yes" ]; then flags="${flags} [!!api_key_present=yes]"; fi

  append_row "$id" "$desc" "INFO" \
    "codex_version_exit=$version_code login_status_exit=$login_code auth_json_exists=$auth_json_exists cred_store=$cred_store forced_login=$forced_login openai_key=$openai_key_present codex_key=$codex_key_present keyring=$keyring_hit${flags} (see D0.json)"
}

# ---------------------------------------------------------------------------
# D1: trivial prompt, clean success
# ---------------------------------------------------------------------------
check_D1() {
  local id="D1" desc="codex exec --json: trivial prompt, clean success"
  local prompt="Reply with exactly: LOOPMILL-OK"
  local cmd=("${CODEX_BASE[@]}" exec --json --color never -s read-only -C "$WORK_DIR" -o "$OUT_DIR/${id}.last.txt")
  cmd+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
  cmd+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  cmd+=("$prompt")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  ensure_work_repo
  run_codex "$id" "$CHECK_TIMEOUT" "${cmd[@]}"
  local code=$?
  stream_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"

  local parse_ok turn_completed_count thread_id turn_failed error_events last_usage
  parse_ok=$(jget "$OUT_DIR/${id}.summary.json" "parse_ok")
  turn_completed_count=$(jget "$OUT_DIR/${id}.summary.json" "turn_completed_count")
  thread_id=$(jget "$OUT_DIR/${id}.summary.json" "thread_id")
  turn_failed=$(jget "$OUT_DIR/${id}.summary.json" "turn_failed")
  error_events=$(jget "$OUT_DIR/${id}.summary.json" "error_events")
  last_usage=$(jget "$OUT_DIR/${id}.summary.json" "last_usage")

  local last_msg contains_ok
  last_msg=$(last_agent_message "$OUT_DIR/${id}.summary.json")
  contains_ok="no"
  case "$last_msg" in *LOOPMILL-OK*) contains_ok="yes" ;; esac

  # Non-fatal `error` events (a retried stream hiccup, an MCP server from the operator's config.toml
  # that could not start) do not break the contract as long as the turn completed; they are recorded
  # in the details column, not graded.
  local error_count
  error_count=$(node -e 'try{const a=JSON.parse(process.argv[1]);console.log(Array.isArray(a)?a.length:0);}catch(e){console.log(0);}' "$error_events" 2>/dev/null)

  local status="FAIL"
  if [ "$code" = "0" ] && [ "$parse_ok" = "true" ] \
     && [ "$(intval "$turn_completed_count")" -ge 1 ] \
     && [ -z "$turn_failed" ] \
     && [ "$contains_ok" = "yes" ]; then
    status="PASS"
  fi

  local duration; duration=$(cat "$OUT_DIR/${id}.duration" 2>/dev/null || echo "?")
  local usage_present="no"
  [ -n "$last_usage" ] && [ "$last_usage" != "null" ] && usage_present="yes"

  append_row "$id" "$desc" "$status" \
    "exit=$code parse_ok=$parse_ok turns_completed=$turn_completed_count thread_id_present=$([ -n "$thread_id" ] && echo yes || echo no) usage_present=$usage_present error_events=$error_count duration=${duration}s (see D1.summary.json)"
}

# ---------------------------------------------------------------------------
# D2: structured output via --output-schema
# ---------------------------------------------------------------------------
check_D2() {
  local id="D2" desc="codex exec --json --output-schema: structured pass/fail verdict"
  local prompt="Evaluate this claim: '1 + 1 = 2'. It is true. Respond with a structured verdict of pass and a one-sentence reason."
  local cmd=("${CODEX_BASE[@]}" exec --json --color never -s read-only -C "$WORK_DIR" \
    --output-schema "$SCHEMA_FILE" -o "$OUT_DIR/${id}.last.txt")
  cmd+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
  cmd+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  cmd+=("$prompt")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  ensure_work_repo
  run_codex "$id" "$CHECK_TIMEOUT" "${cmd[@]}"
  local code=$?
  stream_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"

  local last_msg
  last_msg=$(last_agent_message "$OUT_DIR/${id}.summary.json")

  node -e '
    const fs = require("fs");
    const text = process.argv[1];
    const schemaPath = process.argv[2];
    const lastTxtPath = process.argv[3];
    let out = { valid: false, verdict: null, reason: null, last_txt_matches: false };
    try {
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      let obj = null;
      try { obj = JSON.parse(text); } catch (e) { obj = null; }
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const allowed = Object.keys(schema.properties || {});
        const extra = Object.keys(obj).filter(k => allowed.indexOf(k) === -1);
        const missing = (schema.required || []).filter(k => !(k in obj));
        const verdictOk = schema.properties && schema.properties.verdict && Array.isArray(schema.properties.verdict.enum)
          ? schema.properties.verdict.enum.indexOf(obj.verdict) !== -1 : true;
        const reasonOk = typeof obj.reason === "string";
        if (extra.length === 0 && missing.length === 0 && verdictOk && reasonOk) out.valid = true;
        out.verdict = obj.verdict === undefined ? null : obj.verdict;
        out.reason = obj.reason === undefined ? null : obj.reason;
      }
    } catch (e) {}
    try {
      const lastTxt = fs.readFileSync(lastTxtPath, "utf8").trim();
      out.last_txt_matches = (lastTxt === String(text).trim());
    } catch (e) {}
    console.log(JSON.stringify(out));
  ' "$last_msg" "$SCHEMA_FILE" "$OUT_DIR/${id}.last.txt" > "$OUT_DIR/${id}.validate.json" 2>"$OUT_DIR/${id}.validate.err"

  local validates verdict last_txt_matches turn_completed_count
  validates=$(jget "$OUT_DIR/${id}.validate.json" "valid")
  verdict=$(jget "$OUT_DIR/${id}.validate.json" "verdict")
  last_txt_matches=$(jget "$OUT_DIR/${id}.validate.json" "last_txt_matches")
  turn_completed_count=$(jget "$OUT_DIR/${id}.summary.json" "turn_completed_count")

  local status="FAIL"
  if [ "$code" = "0" ] && [ "$(intval "$turn_completed_count")" -ge 1 ] \
     && [ "$validates" = "true" ] && [ "$last_txt_matches" = "true" ]; then
    status="PASS"
  fi

  local validates_yn="no"; [ "$validates" = "true" ] && validates_yn="yes"
  local last_txt_matches_yn="no"; [ "$last_txt_matches" = "true" ] && last_txt_matches_yn="yes"

  append_row "$id" "$desc" "$status" \
    "exit=$code turns_completed=$turn_completed_count validates=$validates_yn verdict=$verdict last_txt_matches=$last_txt_matches_yn (see D2.summary.json, D2.last.txt)"
}

# ---------------------------------------------------------------------------
# D3: terminal-state and exit-code contract (a: success, b: forced failure, c: invalid argument)
# ---------------------------------------------------------------------------
check_D3() {
  local id_a="D3a" id_b="D3b" id_c="D3c"
  local desc_a="D3 sub-check a: success (trivial prompt), expect exit 0"
  local desc_b="D3 sub-check b: forced failure (-m loopmill-no-such-model), expect non-zero exit + machine-readable signal"
  local desc_c="D3 sub-check c: invalid argument (--loopmill-no-such-flag), expect exit 2, no JSON on stdout"
  local desc_overall="D3 overall: terminal-state and exit-code contract (a/b/c pairwise-distinct exits; b machine-readable)"
  local prompt="Reply with exactly: LOOPMILL-OK"

  local cmd_a=("${CODEX_BASE[@]}" exec --json --color never -s read-only -C "$WORK_DIR" -o "$OUT_DIR/${id_a}.last.txt")
  cmd_a+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
  cmd_a+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  cmd_a+=("$prompt")

  local cmd_b=("${CODEX_BASE[@]}" exec --json --color never -s read-only -C "$WORK_DIR" -m loopmill-no-such-model -o "$OUT_DIR/${id_b}.last.txt")
  cmd_b+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  cmd_b+=("$prompt")

  local cmd_c=("${CODEX_BASE[@]}" exec --json --color never -s read-only -C "$WORK_DIR" --loopmill-no-such-flag)
  cmd_c+=("$prompt")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id_a" "$desc_a" "$(show_argv "${cmd_a[@]}") < /dev/null"
    dry_row "$id_b" "$desc_b" "$(show_argv "${cmd_b[@]}") < /dev/null"
    dry_row "$id_c" "$desc_c" "$(show_argv "${cmd_c[@]}") < /dev/null"
    dry_row "D3" "$desc_overall" "(computed from D3a/D3b/D3c above)"
    return 0
  fi

  ensure_work_repo

  run_codex "$id_a" "$CHECK_TIMEOUT" "${cmd_a[@]}"
  local code_a=$?
  stream_summary "$OUT_DIR/${id_a}.json" "$OUT_DIR/${id_a}.summary.json"
  append_row "$id_a" "$desc_a" "INFO" "exit=$code_a (component of D3 below; see D3a.summary.json)"

  run_codex "$id_b" "$CHECK_TIMEOUT" "${cmd_b[@]}"
  local code_b=$?
  stream_summary "$OUT_DIR/${id_b}.json" "$OUT_DIR/${id_b}.summary.json"

  local turn_failed_b error_events_b stderr_snip_b
  turn_failed_b=$(jget "$OUT_DIR/${id_b}.summary.json" "turn_failed")
  error_events_b=$(jget "$OUT_DIR/${id_b}.summary.json" "error_events")
  stderr_snip_b=$(head -c 300 "$OUT_DIR/${id_b}.err" 2>/dev/null | tr '\n' ' ')

  local machine_signal_b="no"
  if [ -n "$turn_failed_b" ] || { [ -n "$error_events_b" ] && [ "$error_events_b" != "[]" ]; }; then
    machine_signal_b="yes"
  fi
  local failure_signal_b="none"
  if [ "$machine_signal_b" = "yes" ]; then
    failure_signal_b="structured-event"
  elif [ "$code_b" != "0" ] && [ -n "$stderr_snip_b" ]; then
    failure_signal_b="stderr-prose-only"
  fi
  local turn_completed_count_b usage_appeared_b
  turn_completed_count_b=$(jget "$OUT_DIR/${id_b}.summary.json" "turn_completed_count")
  usage_appeared_b="no"
  [ "$(intval "$turn_completed_count_b")" -ge 1 ] && usage_appeared_b="yes"

  append_row "$id_b" "$desc_b" "INFO" \
    "exit=$code_b machine_signal=$machine_signal_b failure_signal=$failure_signal_b turn_completed_seen=$usage_appeared_b stderr=\"$stderr_snip_b\" (see D3b.summary.json)"

  run_codex "$id_c" "$CHECK_TIMEOUT" "${cmd_c[@]}"
  local code_c=$?
  local stdout_has_json_c="no"
  if [ -s "$OUT_DIR/${id_c}.json" ]; then
    if node -e 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]);process.exit(0);}catch(e){process.exit(1);}' "$OUT_DIR/${id_c}.json" 2>/dev/null; then
      stdout_has_json_c="yes"
    fi
  fi
  local stderr_snip_c
  stderr_snip_c=$(head -c 300 "$OUT_DIR/${id_c}.err" 2>/dev/null | tr '\n' ' ')
  append_row "$id_c" "$desc_c" "INFO" \
    "exit=$code_c stdout_has_json=$stdout_has_json_c stderr=\"$stderr_snip_c\" (see D3c.err)"

  # Overall verdict.
  local codes_distinct="no"
  if [ "$code_a" != "$code_b" ] && [ "$code_a" != "$code_c" ] && [ "$code_b" != "$code_c" ]; then
    codes_distinct="yes"
  fi

  local status="FAIL"
  if [ "$code_a" = "0" ] && [ "$code_b" != "0" ] && [ "$code_c" != "0" ] && [ "$codes_distinct" = "yes" ] \
     && { [ "$machine_signal_b" = "yes" ] || [ "$failure_signal_b" = "stderr-prose-only" ]; }; then
    status="PASS"
  fi

  append_row "D3" "$desc_overall" "$status" \
    "a_exit=$code_a b_exit=$code_b c_exit=$code_c codes_distinct=$codes_distinct failure_signal=$failure_signal_b (see D3a/b/c.summary.json)"
}

# ---------------------------------------------------------------------------
# D4: two sequential turns on one thread (thread-cumulative usage, the delta rule)
# ---------------------------------------------------------------------------
check_D4() {
  local id_a="D4a" id_b="D4b"
  local desc_a="D4a: turn 1 on a fresh thread (deliberately large output)"
  local desc_b="D4b: turn 2 via codex exec resume on the same thread"
  local desc_overall="D4 overall: two sequential turns on one thread -- is turn.completed.usage per invocation or thread-cumulative"

  local prompt_a="Write the integers from 1 to 150 separated by single spaces, on one line, and nothing else."
  local prompt_b="Reply with exactly: TURN-TWO"

  local cmd_a=("${CODEX_BASE[@]}" exec --json --color never -s read-only -C "$WORK_DIR" -o "$OUT_DIR/${id_a}.last.txt")
  cmd_a+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
  cmd_a+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  cmd_a+=("$prompt_a")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id_a" "$desc_a" "$(show_argv "${cmd_a[@]}") < /dev/null"
    dry_row "$id_b" "$desc_b" "codex exec resume <thread-id-from-D4a-or---last> --json --color never [-s/-C/-o dropped on a clap exit-2 usage error] \"$prompt_b\" < /dev/null"
    dry_row "D4" "$desc_overall" "(computed from D4a/D4b above)"
    return 0
  fi

  ensure_work_repo
  run_codex "$id_a" "$CHECK_TIMEOUT" "${cmd_a[@]}"
  local code_a=$?
  stream_summary "$OUT_DIR/${id_a}.json" "$OUT_DIR/${id_a}.summary.json"

  local thread_id turn_completed_count_a
  thread_id=$(jget "$OUT_DIR/${id_a}.summary.json" "thread_id")
  turn_completed_count_a=$(jget "$OUT_DIR/${id_a}.summary.json" "turn_completed_count")

  append_row "$id_a" "$desc_a" "INFO" \
    "exit=$code_a thread_id_present=$([ -n "$thread_id" ] && echo yes || echo no) turns_completed=$turn_completed_count_a (see D4a.summary.json)"

  # Save D4a's raw cumulative usage object now, for D8's --start argument (D4b's usageAtAttemptStart).
  local last_usage_a
  last_usage_a=$(jget "$OUT_DIR/${id_a}.summary.json" "last_usage")
  node -e '
    try {
      const d = JSON.parse(process.argv[1]);
      console.log(JSON.stringify(d && typeof d === "object" ? d : {
        input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0
      }));
    } catch (e) {
      console.log(JSON.stringify({input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0}));
    }
  ' "$last_usage_a" > "$OUT_DIR/D4a.usage-start.json" 2>/dev/null

  # Turn 2: try `codex exec resume <thread_id> --json ...` with the full flag set; on a clap exit-2
  # usage error mentioning an unexpected argument, retry with only --json, then with no flags at all.
  # Each attempt after the first is run with the shell's own cwd forced to WORK_DIR (defense in depth,
  # in case -C itself turns out to be one of the unsupported flags).
  local resume_target=()
  if [ -n "$thread_id" ]; then resume_target=("$thread_id"); else resume_target=(--last); fi

  local attempt1=("${CODEX_BASE[@]}" exec resume "${resume_target[@]}" --json --color never -s read-only -C "$WORK_DIR" -o "$OUT_DIR/${id_b}.last.txt")
  attempt1+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
  attempt1+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  attempt1+=("$prompt_b")

  run_codex "${id_b}-try1" "$CHECK_TIMEOUT" "${attempt1[@]}"
  local code_try1=$?

  local accepted_flags="--json --color -s -C -o"
  local final_code="$code_try1"
  local final_id="${id_b}-try1"

  local looks_like_clap_error="no"
  if [ "$code_try1" = "2" ] && grep -qiE "unexpected argument|unrecognized|error: the following required arguments" "$OUT_DIR/${id_b}-try1.err" 2>/dev/null; then
    looks_like_clap_error="yes"
  fi

  if [ "$looks_like_clap_error" = "yes" ]; then
    local attempt2=("${CODEX_BASE[@]}" exec resume "${resume_target[@]}" --json)
    attempt2+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
    attempt2+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
    attempt2+=("$prompt_b")

    ( cd "$WORK_DIR" && run_codex "${id_b}-try2" "$CHECK_TIMEOUT" "${attempt2[@]}" )
    local code_try2=$?
    accepted_flags="--json"
    final_code="$code_try2"
    final_id="${id_b}-try2"

    if [ "$code_try2" = "2" ] && grep -qiE "unexpected argument|unrecognized" "$OUT_DIR/${id_b}-try2.err" 2>/dev/null; then
      local attempt3=("${CODEX_BASE[@]}" exec resume "${resume_target[@]}")
      attempt3+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
      attempt3+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
      attempt3+=("$prompt_b")
      ( cd "$WORK_DIR" && run_codex "${id_b}-try3" "$CHECK_TIMEOUT" "${attempt3[@]}" )
      local code_try3=$?
      accepted_flags="(none of --json/-s/-C/-o)"
      final_code="$code_try3"
      final_id="${id_b}-try3"
    fi
  fi

  # Normalize the final attempt's files to the D4b.* names D8 expects; the try1/try2/try3 files stay
  # on disk too, so which flags were accepted is itself auditable.
  cp "$OUT_DIR/${final_id}.json" "$OUT_DIR/${id_b}.json" 2>/dev/null || : > "$OUT_DIR/${id_b}.json"
  cp "$OUT_DIR/${final_id}.err" "$OUT_DIR/${id_b}.err" 2>/dev/null || : > "$OUT_DIR/${id_b}.err"
  echo "$final_code" > "$OUT_DIR/${id_b}.code"
  cp "$OUT_DIR/${final_id}.duration" "$OUT_DIR/${id_b}.duration" 2>/dev/null || echo "?" > "$OUT_DIR/${id_b}.duration"
  cp "$OUT_DIR/${final_id}.argv.txt" "$OUT_DIR/${id_b}.argv.txt" 2>/dev/null || :
  [ -f "$OUT_DIR/${final_id}.last.txt" ] && cp "$OUT_DIR/${final_id}.last.txt" "$OUT_DIR/${id_b}.last.txt"

  stream_summary "$OUT_DIR/${id_b}.json" "$OUT_DIR/${id_b}.summary.json"

  local turn_completed_count_b last_usage_b thread_id_b
  turn_completed_count_b=$(jget "$OUT_DIR/${id_b}.summary.json" "turn_completed_count")
  last_usage_b=$(jget "$OUT_DIR/${id_b}.summary.json" "last_usage")
  thread_id_b=$(jget "$OUT_DIR/${id_b}.summary.json" "thread_id")

  append_row "$id_b" "$desc_b" "INFO" \
    "exit=$final_code accepted_flags=\"$accepted_flags\" turns_completed=$turn_completed_count_b (see D4b.summary.json)"

  # D4 overall verdict. The design question is whether the per-attempt figure can be recovered,
  # whichever way the CLI counts. Turn 2's reply is a handful of tokens, so a thread-cumulative count
  # carries turn 1's large output forward (output_b > output_a) and a per-invocation count does not
  # (output_b far below output_a). Either answer is a PASS once it is determinable; FAIL means one of
  # the two usage objects is missing. First real run (0.153.4, 2026-09-06): per-invocation.
  local output_a output_b
  output_a=$(node -e 'try{const d=JSON.parse(process.argv[1]);console.log(d && typeof d.output_tokens==="number"?d.output_tokens:"");}catch(e){console.log("");}' "$last_usage_a" 2>/dev/null)
  output_b=$(node -e 'try{const d=JSON.parse(process.argv[1]);console.log(d && typeof d.output_tokens==="number"?d.output_tokens:"");}catch(e){console.log("");}' "$last_usage_b" 2>/dev/null)

  local thread_ids_equal="no"
  [ -n "$thread_id" ] && [ "$thread_id" = "$thread_id_b" ] && thread_ids_equal="yes"

  local usage_semantics="undetermined"
  local status="FAIL"
  if [ -n "$output_a" ] && [ -n "$output_b" ] \
     && [ "$(intval "$turn_completed_count_a")" -ge 1 ] && [ "$(intval "$turn_completed_count_b")" -ge 1 ]; then
    if [ "$output_b" -ge "$((output_a + 1))" ] 2>/dev/null; then
      usage_semantics="thread-cumulative"; status="PASS"
    else
      usage_semantics="per-invocation"; status="PASS"
    fi
  fi

  local delta_json
  delta_json=$(node -e '
    try {
      const a = JSON.parse(process.argv[1]);
      const b = JSON.parse(process.argv[2]);
      const fields = ["input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"];
      const out = {};
      for (const f of fields) out[f] = (typeof b[f] === "number" ? b[f] : 0) - (typeof a[f] === "number" ? a[f] : 0);
      console.log(JSON.stringify(out));
    } catch (e) { console.log("{}"); }
  ' "$last_usage_a" "$last_usage_b" 2>/dev/null)

  append_row "D4" "$desc_overall" "$status" \
    "usage_a=$last_usage_a usage_b=$last_usage_b b_minus_a=$delta_json usage_semantics=$usage_semantics thread_ids_equal=$thread_ids_equal accepted_resume_flags=\"$accepted_flags\" (see D4a.summary.json, D4b.summary.json)"
}

# ---------------------------------------------------------------------------
# D5: signal handling (cancel semantics) -- SIGINT, SIGTERM, and the harness deadline (TIMEOUT)
# ---------------------------------------------------------------------------
D5_PROMPT="Count from 1 to 400, one integer per line, and nothing else."

check_D5_variant() {
  local variant="$1" signal="$2"
  local id="D5-${variant}"
  local desc="D5 ${variant}: ${signal} sent ${SIGNAL_DELAY}s into a long counting turn"
  local cmd=("${CODEX_BASE[@]}" exec --json --color never -s read-only -C "$WORK_DIR" -o "$OUT_DIR/${id}.last.txt")
  cmd+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
  cmd+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  cmd+=("$D5_PROMPT")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null & sleep ${SIGNAL_DELAY}; kill -s $signal \$!"
    return 0
  fi

  ensure_work_repo
  run_codex_signal "$id" "$signal" "$SIGNAL_DELAY" "${cmd[@]}"
  local code=$?

  stream_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"
  local turn_completed_count last_line_truncated
  turn_completed_count=$(jget "$OUT_DIR/${id}.summary.json" "turn_completed_count")
  last_line_truncated=$(jget "$OUT_DIR/${id}.summary.json" "last_line_truncated")
  local last_event_type
  last_event_type=$(node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const t = d.event_types || [];
      console.log(t.length ? t[t.length - 1] : "");
    } catch (e) { console.log(""); }
  ' "$OUT_DIR/${id}.summary.json" 2>/dev/null)

  local has_turn_completed="no"
  [ "$(intval "$turn_completed_count")" -ge 1 ] && has_turn_completed="yes"

  local stderr_tail
  stderr_tail=$(tail -c 300 "$OUT_DIR/${id}.err" 2>/dev/null | tr '\n' ' ')

  local status="INFO" note=""
  if [ "$D5_ALIVE" = "no" ]; then
    status="FAIL"
    note=" [FAIL: signal reached an exited process; raise SIGNAL_DELAY or use a longer prompt]"
  fi

  append_row "$id" "$desc" "$status" \
    "alive_at_signal=$D5_ALIVE delivered=$D5_DELIVERED exit=$code elapsed=${D5_ELAPSED}s escalated_to_sigkill=$D5_ESCALATED has_turn_completed=$has_turn_completed last_line_truncated=$last_line_truncated last_event_type=\"$last_event_type\" stderr_tail=\"$stderr_tail\"${note} (see ${id}.summary.json)"
}

check_D5_timeout() {
  local id="D5-TIMEOUT"
  local desc="D5 TIMEOUT: harness deadline mechanism (SIGTERM, then SIGKILL after 10s) at ${SIGNAL_DELAY}s -- Loopmill's cancel() sequence"
  local cmd=("${CODEX_BASE[@]}" exec --json --color never -s read-only -C "$WORK_DIR" -o "$OUT_DIR/${id}.last.txt")
  cmd+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
  cmd+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  cmd+=("$D5_PROMPT")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null (deadline ${SIGNAL_DELAY}s, then SIGTERM, then SIGKILL after 10s)"
    return 0
  fi

  ensure_work_repo
  run_codex "$id" "$SIGNAL_DELAY" "${cmd[@]}"
  local code=$?
  stream_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"

  local deadline_hit elapsed
  deadline_hit=$(cat "$OUT_DIR/${id}.deadline" 2>/dev/null || echo "unknown")
  elapsed=$(cat "$OUT_DIR/${id}.duration" 2>/dev/null || echo "?")

  local ended_via="other"
  case "$code" in
    143) ended_via="SIGTERM" ;;
    137) ended_via="SIGKILL" ;;
  esac

  local turn_completed_count has_turn_completed
  turn_completed_count=$(jget "$OUT_DIR/${id}.summary.json" "turn_completed_count")
  has_turn_completed="no"
  [ "$(intval "$turn_completed_count")" -ge 1 ] && has_turn_completed="yes"

  local status="INFO" note=""
  if [ "$deadline_hit" != "yes" ]; then
    status="FAIL"
    note=" [FAIL: process exited before the deadline; raise SIGNAL_DELAY or use a longer prompt]"
  fi

  append_row "$id" "$desc" "$status" \
    "deadline_hit=$deadline_hit exit=$code ended_via=$ended_via elapsed=${elapsed}s has_turn_completed=$has_turn_completed${note} (see D5-TIMEOUT.summary.json)"
}

check_D5() {
  check_D5_variant SIGINT INT
  check_D5_variant SIGTERM TERM
  check_D5_timeout
}

# ---------------------------------------------------------------------------
# D6: quota-signal probe (informational)
# ---------------------------------------------------------------------------
check_D6() {
  local id="D6" desc="quota-signal probe: grep D1-D5 output for a plan-limit message; scan events for rate/usage/quota fields"

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "grep -i -E 'usage limit|rate limit|limit reached|resets|quota|too many requests|429' over out/D1..D5-*.json/.err; scan JSONL events for rate_limit/usage_limit/quota/reset keys"
    return 0
  fi

  local files=() f
  for f in "$OUT_DIR"/D1.json "$OUT_DIR"/D1.err "$OUT_DIR"/D2.json "$OUT_DIR"/D2.err \
           "$OUT_DIR"/D3a.json "$OUT_DIR"/D3a.err "$OUT_DIR"/D3b.json "$OUT_DIR"/D3b.err \
           "$OUT_DIR"/D3c.json "$OUT_DIR"/D3c.err \
           "$OUT_DIR"/D4a.json "$OUT_DIR"/D4a.err "$OUT_DIR"/D4b.json "$OUT_DIR"/D4b.err \
           "$OUT_DIR"/D5-SIGINT.json "$OUT_DIR"/D5-SIGINT.err "$OUT_DIR"/D5-SIGTERM.json "$OUT_DIR"/D5-SIGTERM.err \
           "$OUT_DIR"/D5-TIMEOUT.json "$OUT_DIR"/D5-TIMEOUT.err; do
    [ -f "$f" ] && files+=("$f")
  done

  local quota_message_seen="no"
  if [ "${#files[@]}" -gt 0 ] && grep -qil -E 'usage limit|rate limit|limit reached|resets|quota|too many requests|429' "${files[@]}" 2>/dev/null; then
    quota_message_seen="maybe (matched a limit phrase; see D6.matches.txt)"
    grep -il -E 'usage limit|rate limit|limit reached|resets|quota|too many requests|429' "${files[@]}" 2>/dev/null > "$OUT_DIR/D6.matches.txt" || true
  fi

  local json_files=()
  for f in "$OUT_DIR"/D1.json "$OUT_DIR"/D2.json "$OUT_DIR"/D3a.json "$OUT_DIR"/D3b.json "$OUT_DIR"/D3c.json \
           "$OUT_DIR"/D4a.json "$OUT_DIR"/D4b.json "$OUT_DIR"/D5-SIGINT.json "$OUT_DIR"/D5-SIGTERM.json "$OUT_DIR"/D5-TIMEOUT.json; do
    [ -f "$f" ] && json_files+=("$f")
  done

  node -e '
    const fs = require("fs");
    const files = process.argv.slice(1);
    const eventTypeSet = new Set();
    const turnCompletedKeys = new Set();
    const turnFailedKeys = new Set();
    const quotaKeyHits = new Set();
    const quotaKeyPattern = /rate_limit|usage_limit|quota|reset/i;
    for (const f of files) {
      let lines;
      try { lines = fs.readFileSync(f, "utf8").split("\n"); } catch (e) { continue; }
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (!obj || typeof obj !== "object") continue;
        if (obj.type) eventTypeSet.add(String(obj.type));
        if (obj.type === "turn.completed") {
          for (const k of Object.keys(obj)) turnCompletedKeys.add(k);
          if (obj.usage) for (const k of Object.keys(obj.usage)) if (quotaKeyPattern.test(k)) quotaKeyHits.add("usage." + k);
        }
        if (obj.type === "turn.failed") {
          for (const k of Object.keys(obj)) turnFailedKeys.add(k);
        }
        for (const k of Object.keys(obj)) if (quotaKeyPattern.test(k)) quotaKeyHits.add(k);
      }
    }
    const out = {
      distinct_event_types: Array.from(eventTypeSet).sort(),
      turn_completed_keys: Array.from(turnCompletedKeys).sort(),
      turn_failed_keys: Array.from(turnFailedKeys).sort(),
      structured_quota_fields: Array.from(quotaKeyHits).sort()
    };
    console.log(JSON.stringify(out, null, 2));
  ' ${json_files[@]+"${json_files[@]}"} > "$OUT_DIR/${id}.json" 2>"$OUT_DIR/${id}.err"

  local structured_field structured_display
  structured_field=$(jget "$OUT_DIR/${id}.json" "structured_quota_fields")
  structured_display="none"
  [ -n "$structured_field" ] && [ "$structured_field" != "[]" ] && structured_display="$structured_field"

  append_row "$id" "$desc" "INFO" \
    "quota_message_seen=$quota_message_seen structured_quota_field=$structured_display (see D6.json, D6.matches.txt)"
}

# ---------------------------------------------------------------------------
# D7: worktree edit, workspace-write
# ---------------------------------------------------------------------------
check_D7() {
  local id="D7" desc="codex exec --json -s workspace-write, in a git worktree: file edit contract"
  local worktree_dir="$OUT_DIR/work-wt"
  local prompt="Create a new file named SPIKE4.md in the current directory containing exactly one line of text: spike-4 wrote this. Do not modify or create any other file."

  local cmd=("${CODEX_BASE[@]}" exec --json --color never -s workspace-write -C "$worktree_dir" -o "$OUT_DIR/${id}.last.txt")
  cmd+=(${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"})
  cmd+=(${CODEX_EXTRA_ARGS_ARR[@]+"${CODEX_EXTRA_ARGS_ARR[@]}"})
  cmd+=("$prompt")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "(git -C out/work worktree remove --force out/work-wt; git -C out/work branch -D spike4-d7; git -C out/work worktree add out/work-wt -b spike4-d7) then $(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  ensure_work_repo

  # Clean up a leftover worktree/branch from a previous run before creating a fresh one. This, and
  # every git command in this check, operates ONLY on the scratch repo under out/ -- never on the
  # Loopmill repository.
  if [ -d "$worktree_dir" ]; then
    git -C "$WORK_DIR" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || rm -rf "$worktree_dir"
  fi
  git -C "$WORK_DIR" branch -D spike4-d7 >/dev/null 2>&1 || true
  git -C "$WORK_DIR" worktree prune >/dev/null 2>&1 || true

  git -C "$WORK_DIR" worktree add "$worktree_dir" -b spike4-d7 >"$OUT_DIR/${id}.worktree-add.out" 2>"$OUT_DIR/${id}.worktree-add.err"
  local worktree_add_code=$?

  if [ "$worktree_add_code" != "0" ]; then
    append_row "$id" "$desc" "FAIL" \
      "git worktree add failed with exit $worktree_add_code (see D7.worktree-add.err); codex was not invoked"
    return 0
  fi

  run_codex "$id" "$CHECK_TIMEOUT" "${cmd[@]}"
  local code=$?
  stream_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"

  local turn_completed_count item_types approval_seen
  turn_completed_count=$(jget "$OUT_DIR/${id}.summary.json" "turn_completed_count")
  item_types=$(jget "$OUT_DIR/${id}.summary.json" "item_types")
  approval_seen="no"
  grep -qi "approval" "$OUT_DIR/${id}.json" 2>/dev/null && approval_seen="yes"

  local porcelain_wt porcelain_main
  porcelain_wt=$(git -C "$worktree_dir" status --porcelain 2>/dev/null)
  porcelain_main=$(git -C "$WORK_DIR" status --porcelain 2>/dev/null)

  # The design question is the worktree contract, not the model's punctuation: content_ok accepts the
  # requested line with a trailing-punctuation or whitespace difference and records separately whether
  # the match was exact (the first real run wrote "spike-4 wrote this." with a full stop).
  local content="" content_ok="no" content_exact="no"
  if [ -f "$worktree_dir/SPIKE4.md" ]; then
    content=$(cat "$worktree_dir/SPIKE4.md")
    [ "$content" = "spike-4 wrote this" ] && content_exact="yes"
    local normalized
    normalized=$(printf '%s' "$content" | head -n1 | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:][:punct:]]+$//')
    [ "$normalized" = "spike-4 wrote this" ] && content_ok="yes"
  fi

  local wrote_via="unknown"
  case "$item_types" in
    *file_change*) wrote_via="file_change item" ;;
    *command_execution*) wrote_via="command_execution (a shell command wrote the file)" ;;
  esac

  local porcelain_line_count porcelain_shape_ok
  porcelain_line_count=$(printf '%s\n' "$porcelain_wt" | grep -c .)
  porcelain_shape_ok="no"
  if [ "$porcelain_line_count" = "1" ] && printf '%s\n' "$porcelain_wt" | grep -qE '^(\?\?|A) +SPIKE4\.md$'; then
    porcelain_shape_ok="yes"
  fi

  local main_clean="no"
  [ -z "$porcelain_main" ] && main_clean="yes"

  local diff_stat
  diff_stat=$(git -C "$worktree_dir" diff --stat 2>/dev/null | tr '\n' ' ')

  local status="FAIL"
  if [ "$code" = "0" ] && [ "$(intval "$turn_completed_count")" -ge 1 ] \
     && [ "$porcelain_shape_ok" = "yes" ] && [ "$content_ok" = "yes" ] && [ "$main_clean" = "yes" ]; then
    status="PASS"
  fi

  append_row "$id" "$desc" "$status" \
    "exit=$code turns_completed=$turn_completed_count item_types=$item_types wrote_via=\"$wrote_via\" approval_event_seen=$approval_seen porcelain_wt=\"$porcelain_wt\" porcelain_main_clean=$main_clean content_ok=$content_ok content_exact=$content_exact content=\"$content\" diff_stat=\"$diff_stat\" (see D7.summary.json, D7.worktree-add.err)"
}

# ---------------------------------------------------------------------------
# D8: normalization -- map D1-D7's raw output through normalize.mjs into canonical Usage records,
# and write the recorded fixture candidates.
# ---------------------------------------------------------------------------

# d8_normalize_one <id> <fixture-name-or-empty>
# Appends a one-line outcome to the global D8_RECORDS array (and D8_FAILURES on a hard failure). Must
# only be called from within check_D8, after D8_RECORDS/D8_FAILURES have been reset.
d8_normalize_one() {
  local nid="$1" fixture_name="$2"
  local jsonl="$OUT_DIR/${nid}.json"
  if [ ! -f "$jsonl" ]; then
    D8_RECORDS+=("$nid:skipped(no stdout file)")
    return 0
  fi

  local exit_code signal
  exit_code=$(cat "$OUT_DIR/${nid}.code" 2>/dev/null || echo 0)
  signal="none"
  case "$nid" in
    D5-SIGINT) signal="SIGINT" ;;
    D5-SIGTERM) signal="SIGTERM" ;;
    D5-TIMEOUT)
      case "$exit_code" in
        143) signal="SIGTERM" ;;
        137) signal="SIGKILL" ;;
        *) signal="none" ;;
      esac
      ;;
  esac

  # Every attempt is its own process, and D4 measured per-invocation counting on 0.153.4, so every
  # record -- D4b included -- is read from its own invocation's last turn.completed with a zero start.
  # The retired thread-delta arithmetic survives only as a must-not-equal inside the two-turns fixture.
  local extra_args=()

  local out_file="$OUT_DIR/${nid}.usage.json"
  local node_args=(--jsonl "$jsonl" --exit-code "$exit_code" --signal "$signal" --runtime-version "$D8_RUNTIME_VERSION" --out "$out_file")
  node_args+=(${extra_args[@]+"${extra_args[@]}"})
  if [ -n "$fixture_name" ]; then
    local invocation
    invocation=$(cat "$OUT_DIR/${nid}.argv.txt" 2>/dev/null)
    [ -z "$invocation" ] && invocation="codex exec (argv not recorded; see ${nid}.json)"
    node_args+=(--fixture "$fixture_name" --fixture-out "$FIXTURES_DIR/codex-recorded-${fixture_name}.json" --invocation "$invocation")
  fi

  if node "$NORMALIZE_JS" "${node_args[@]}" 2>"$OUT_DIR/${nid}.normalize.err"; then
    local prov complete total
    prov=$(jget "$out_file" "usage.provenance")
    complete=$(jget "$out_file" "usage.complete")
    total=$(jget "$out_file" "usage.totalTokens")
    D8_RECORDS+=("$nid:ok(provenance=$prov complete=$complete total=$total)")
  else
    D8_FAILURES+=("$nid")
    D8_RECORDS+=("$nid:FAILED(see ${nid}.normalize.err)")
  fi
}

check_D8() {
  local id="D8" desc="normalize D1/D2/D3b/D4a/D4b/D5-SIGINT/D5-SIGTERM/D5-TIMEOUT/D7 into canonical Usage records (normalize.mjs)"

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "node normalize.mjs --jsonl out/<id>.json --exit-code <code> --signal <SIGINT|SIGTERM|SIGKILL|none> --runtime-version <codex --version> --out out/<id>.usage.json [--fixture <name> --fixture-out out/fixtures/codex-recorded-<name>.json] for each of D1,D2,D3b,D4a,D4b,D5-SIGINT,D5-SIGTERM,D5-TIMEOUT,D7, plus a two-jsonl --fixture two-turns call over D4a+D4b"
    return 0
  fi

  local runtime_version
  runtime_version=$(cat "$OUT_DIR/D0.codex-version.txt" 2>/dev/null)
  if [ -z "$runtime_version" ]; then
    runtime_version=$("${CODEX_BASE[@]}" --version 2>/dev/null | head -n1)
  fi
  D8_RUNTIME_VERSION="$runtime_version"

  D8_RECORDS=()
  D8_FAILURES=()

  d8_normalize_one D1 success
  d8_normalize_one D2 structured
  d8_normalize_one D3b turn-failed
  d8_normalize_one D4a ""
  d8_normalize_one D4b ""
  d8_normalize_one D5-SIGINT sigint
  d8_normalize_one D5-SIGTERM sigterm
  d8_normalize_one D5-TIMEOUT ""
  d8_normalize_one D7 worktree

  # D4a+D4b two-turns fixture, built from the same two streams, only if both stdouts exist.
  if [ -f "$OUT_DIR/D4a.json" ] && [ -f "$OUT_DIR/D4b.json" ]; then
    local exit_a exit_b
    exit_a=$(cat "$OUT_DIR/D4a.code" 2>/dev/null || echo 0)
    exit_b=$(cat "$OUT_DIR/D4b.code" 2>/dev/null || echo 0)
    if node "$NORMALIZE_JS" \
        --jsonl "$OUT_DIR/D4a.json" --jsonl "$OUT_DIR/D4b.json" \
        --exit-code "$exit_a" --exit-code "$exit_b" \
        --runtime-version "$runtime_version" \
        --out "$OUT_DIR/D4-fixture.usage.json" \
        --fixture two-turns --fixture-out "$FIXTURES_DIR/codex-recorded-two-turns.json" \
        --invocation "$(cat "$OUT_DIR/D4a.argv.txt" 2>/dev/null || echo "codex exec (D4a)")" \
        --invocation "$(cat "$OUT_DIR/D4b.argv.txt" 2>/dev/null || echo "codex exec resume (D4b)")" \
        2>"$OUT_DIR/D4-two-turns.normalize.err"; then
      D8_RECORDS+=("D4a+D4b:ok(two-turns fixture written)")
    else
      D8_FAILURES+=("D4a+D4b")
      D8_RECORDS+=("D4a+D4b:FAILED(see D4-two-turns.normalize.err)")
    fi
  else
    D8_RECORDS+=("D4a+D4b:skipped(D4a.json or D4b.json missing)")
  fi

  # Invariant checks over every produced usage.json: I2 (buckets >= 0), I1/I8 (totals recompute).
  local invariants_ok="yes"
  local invariant_notes=()
  local uf
  for uf in "$OUT_DIR"/*.usage.json; do
    [ -f "$uf" ] || continue
    local check_result
    check_result=$(node -e '
      try {
        const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const u = d.usage;
        if (u.provenance === "unavailable") { console.log("ok"); process.exit(0); }
        const fields = ["freshInputTokens","cacheWriteTokens","cacheReadTokens","outputTokens"];
        for (const f of fields) {
          if (typeof u[f] !== "number" || u[f] < 0) { console.log("FAIL:" + f + " not >= 0"); process.exit(0); }
        }
        if (u.totalInputTokens !== u.freshInputTokens + u.cacheWriteTokens + u.cacheReadTokens) { console.log("FAIL:totalInputTokens"); process.exit(0); }
        if (u.totalTokens !== u.totalInputTokens + u.outputTokens) { console.log("FAIL:totalTokens"); process.exit(0); }
        console.log("ok");
      } catch (e) { console.log("FAIL:exception " + String((e && e.message) || e)); }
    ' "$uf" 2>/dev/null)
    if [ "$check_result" != "ok" ]; then
      invariants_ok="no"
      invariant_notes+=("$(basename "$uf"):$check_result")
    fi
  done

  # I5 for D4 (per-invocation counting): each record equals its own invocation's turn.completed figure
  # -- no cross-invocation subtraction happened -- and the two-attempt total is their plain sum.
  if [ -f "$OUT_DIR/D4a.usage.json" ] && [ -f "$OUT_DIR/D4b.usage.json" ]; then
    local i5_result
    i5_result=$(node -e '
      try {
        const fs = require("fs");
        const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
        if (a.usage.provenance !== "derived" || b.usage.provenance !== "derived") { console.log("skipped(not both derived)"); process.exit(0); }
        for (const [name, r] of [["D4a", a], ["D4b", b]]) {
          const c = r.diagnostics.lastCumulative;
          if (!c) { console.log("skipped(no usage on " + name + ")"); process.exit(0); }
          if (r.usage.totalInputTokens !== (c.input_tokens || 0) || r.usage.outputTokens !== (c.output_tokens || 0)) {
            console.log("FAIL:" + name + " record differs from its own invocation figure"); process.exit(0);
          }
        }
        console.log("ok");
      } catch (e) { console.log("FAIL:exception " + String((e && e.message) || e)); }
    ' "$OUT_DIR/D4a.usage.json" "$OUT_DIR/D4b.usage.json" 2>/dev/null)
    case "$i5_result" in
      ok | skipped*) ;;
      *) invariants_ok="no"; invariant_notes+=("I5:$i5_result") ;;
    esac
  fi

  local status="PASS"
  if [ "${#D8_FAILURES[@]}" -gt 0 ] || [ "$invariants_ok" != "yes" ]; then
    status="FAIL"
  fi

  local records_joined notes_joined
  records_joined=$(printf '%s; ' ${D8_RECORDS[@]+"${D8_RECORDS[@]}"})
  notes_joined=$(printf '%s; ' ${invariant_notes[@]+"${invariant_notes[@]}"})

  append_row "$id" "$desc" "$status" \
    "records: $records_joined invariants_ok=$invariants_ok ${notes_joined:+notes: $notes_joined}(see out/*.usage.json, out/fixtures/*.json)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

init_results() {
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
  {
    echo "# SPIKE-4 Results"
    echo
    echo "Codex CLI (\`codex exec\`) as Loopmill's \`codex\` runtime, run on the operator's own host,"
    echo "authenticated only by the CLI's own ChatGPT login (\`codex login\`). Checks D0-D8 below; D9"
    echo "(scheduler context) and D10 (the SPIKE-1 harness run locally) live elsewhere -- see README.md."
    echo
    echo "- Generated: $now"
    echo "- Dry run: $([ "$DRY_RUN" = "1" ] && echo "yes" || echo "no")"
    echo "- only: $([ -n "$ONLY" ] && echo "$ONLY" || echo "(all checks)")"
    echo "- model override: $([ -n "$MODEL" ] && echo "$MODEL" || echo "(account default)")"
    echo "- CODEX_EXTRA_ARGS: $([ -n "$CODEX_EXTRA_ARGS" ] && echo "$CODEX_EXTRA_ARGS" || echo "(none)")"
    echo "- CHECK_TIMEOUT: ${CHECK_TIMEOUT}s, SIGNAL_DELAY: ${SIGNAL_DELAY}s"
    echo "- codex --version: (see D0.json / D0.codex-version.txt)"
    echo
    echo "| Check | Description | Status | Details |"
    echo "|---|---|---|---|"
  } > "$RESULTS_MD"
}

finalize_results() {
  {
    echo
    echo "## Status legend"
    echo
    echo "- \`PASS\`: behavior matched what this spike expected or documented."
    echo "- \`FAIL\`: behavior diverged from what this spike expected -- read the details column and the"
    echo "  linked \`out/<check>.*\` files."
    echo "- \`INFO\`: observational only; there is no single correct outcome (D0, D3a, D3b, D3c,"
    echo "  D5-SIGINT/D5-SIGTERM/D5-TIMEOUT when the signal reached a live process, D6)."
    echo "- \`SKIPPED\`: the check was intentionally not run (\`ONLY\` did not select it)."
    echo "- \`DRY-RUN\`: \`SPIKE_DRY_RUN=1\` -- the command was printed, not executed."
    echo
    echo "Pass rule (\`docs/spikes/README.md\` section 6): **D1-D4 and D7 all PASS -> the \`codex\` runtime"
    echo "is VERIFIED** (design section 20.1); a FAIL on any of them keeps \`codex\` at"
    echo "\`PLANNED / EXPERIMENTAL\` behind the same provider abstraction and does not stop the MVP"
    echo "(ADR-002 D10). D5, D6, D8 and D10 are expected to surface useful detail regardless of outcome,"
    echo "the same way C5, C6, C9 and C10 did in SPIKE-1."
    echo
    echo "See README.md in this directory for what each check (D0-D8) proves for Loopmill's design."
  } >> "$RESULTS_MD"
}

main() {
  init_results

  if selected D0; then check_D0; else skip_row D0 "environment and auth record"; fi
  if selected D1; then check_D1; else skip_row D1 "codex exec --json: trivial prompt, clean success"; fi
  if selected D2; then check_D2; else skip_row D2 "codex exec --json --output-schema: structured pass/fail verdict"; fi
  if selected D3; then
    check_D3
  else
    skip_row D3a "D3 sub-check a: success"
    skip_row D3b "D3 sub-check b: forced failure"
    skip_row D3c "D3 sub-check c: invalid argument"
    skip_row D3 "D3 overall: terminal-state and exit-code contract"
  fi
  if selected D4; then
    check_D4
  else
    skip_row D4a "D4a: turn 1 on a fresh thread"
    skip_row D4b "D4b: turn 2 via codex exec resume"
    skip_row D4 "D4 overall: two sequential turns on one thread"
  fi
  if selected D5; then
    check_D5
  else
    skip_row D5-SIGINT "D5 SIGINT: signal sent mid-turn"
    skip_row D5-SIGTERM "D5 SIGTERM: signal sent mid-turn"
    skip_row D5-TIMEOUT "D5 TIMEOUT: harness deadline mechanism"
  fi
  if selected D6; then check_D6; else skip_row D6 "quota-signal probe"; fi
  if selected D7; then check_D7; else skip_row D7 "codex exec --json -s workspace-write, in a git worktree"; fi
  if selected D8; then check_D8; else skip_row D8 "normalize D1/D2/D3b/D4a/D4b/D5-*/D7 into canonical Usage records"; fi

  finalize_results

  echo "Done. See $RESULTS_MD"
}

main "$@"
