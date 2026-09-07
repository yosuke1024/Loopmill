#!/bin/bash
# SPIKE-4 D9: does a process started by the operating system's own scheduler
# -- with the screen locked, or with no login session at all -- reach the
# login state each vendor CLI needs?
#
# See docs/spikes/README.md section 6 (D9) and
# docs/adr/ADR-002-local-self-hosted-execution.md (risk R2, "a
# scheduler-started process cannot reach the CLI's login state").
#
# This script is meant to be run BY THE SCHEDULER (launchd, systemd --user)
# with no interactive session behind it: no TTY, a minimal inherited PATH,
# and possibly a locked screen or no login session at all. It is also meant
# to be run by hand once first (the "interactive-baseline" label) so the two
# contexts can be compared. See README.md in this directory for the operator
# procedure.
#
# Because the whole point is to measure what a scheduler's environment
# provides, this script does not trust that environment for its OWN
# mechanics: every external tool it needs just to run (mkdir, date, uname,
# ...) is resolved to an absolute path under /bin, /usr/bin, /usr/sbin or
# /sbin -- see SYSBIN() -- rather than found via PATH. The four CLIs under
# test (claude, codex, gh, node) get a separate, explicit resolution chain
# (env override, then PATH, then a fixed candidate list -- see resolve_bin())
# because whether THAT resolution succeeds under the scheduler's environment
# is itself part of what D9 measures.
#
# bash 3.2 compatible (macOS ships 3.2.57 as /bin/bash, and this script is
# invoked as `/bin/bash probe.sh <label>` by the launchd/systemd units this
# directory generates): no associative arrays, no `local -n`, no ${var,,},
# no mapfile/readarray. Every array used below is populated before it is
# ever expanded with "${arr[@]}" -- bash 3.2 raises "unbound variable" under
# `set -u` when a genuinely empty array is expanded, unlike bash 4.4+.
#
# set -uo pipefail, deliberately NOT set -e (house style, see
# spikes/spike-1-claude-subscription/run.sh): every step is isolated, and a
# failure or non-zero exit in one step, or in a small helper pipeline, must
# never stop the rest of the probe from running.
set -uo pipefail

# ---------------------------------------------------------------------------
# Never leave a running process behind: if this script itself is interrupted
# while a step's child process is in flight, try to terminate that child
# before exiting.
# ---------------------------------------------------------------------------

CURRENT_CHILD_PID=""
cleanup_children() {
  if [ -n "$CURRENT_CHILD_PID" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
    kill -TERM "$CURRENT_CHILD_PID" 2>/dev/null
    sleep 1
    if kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
      kill -KILL "$CURRENT_CHILD_PID" 2>/dev/null
    fi
  fi
}
trap cleanup_children EXIT INT TERM

# ---------------------------------------------------------------------------
# SYSBIN: resolve this script's OWN utilities to absolute paths, restricted
# to /bin, /usr/bin, /usr/sbin, /sbin -- never trusting the ambient PATH,
# which under a scheduler-started process may be nearly empty.
# ---------------------------------------------------------------------------

SYSBIN() {
  local name="$1" d
  for d in /bin /usr/bin /usr/sbin /sbin; do
    if [ -x "$d/$name" ]; then
      printf '%s' "$d/$name"
      return 0
    fi
  done
  # Last resort: the bare name, letting the shell's own search find it. This
  # is better than aborting the whole probe over one missing helper; a probe
  # run where even this fails will show up as garbled/empty context fields
  # rather than a crash.
  printf '%s' "$name"
}

MKDIR_BIN="$(SYSBIN mkdir)"
DATE_BIN="$(SYSBIN date)"
UNAME_BIN="$(SYSBIN uname)"
ID_BIN="$(SYSBIN id)"
WHO_BIN="$(SYSBIN who)"
SED_BIN="$(SYSBIN sed)"
GREP_BIN="$(SYSBIN grep)"
TR_BIN="$(SYSBIN tr)"
ENV_BIN="$(SYSBIN env)"
SLEEP_BIN="$(SYSBIN sleep)"
RM_BIN="$(SYSBIN rm)"
SECURITY_BIN="$(SYSBIN security)"
IOREG_BIN="$(SYSBIN ioreg)"
LAUNCHCTL_BIN="$(SYSBIN launchctl)"
SYSTEMCTL_BIN="$(SYSBIN systemctl)"
LOGINCTL_BIN="$(SYSBIN loginctl)"

# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

# redact: strip anything that looks like a credential from stdin before it
# is persisted. Applied to every raw command output this script writes.
redact() {
  "$SED_BIN" -E \
    -e 's/sk-ant-[A-Za-z0-9_-]{6,}/sk-ant-***REDACTED***/g' \
    -e 's/oat01-?[A-Za-z0-9_-]{6,}/oat01-***REDACTED***/g' \
    -e 's/sk-[A-Za-z0-9_-]{10,}/sk-***REDACTED***/g' \
    -e 's/(Bearer )[A-Za-z0-9._-]{10,}/\1***REDACTED***/g' \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/***REDACTED-JWT***/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***REDACTED-EMAIL***/g' \
    -e 's#/Users/[^/[:space:]]+/#/Users/***/#g' \
    -e 's#/home/[^/[:space:]]+/#/home/***/#g'
}

# json_escape <string> -- escape a single-line string for embedding as a
# JSON string value. Only used by the bash printf fallback (see
# write_probe_json_bash_fallback below); the node path lets JSON.stringify
# do this instead. Pure bash parameter expansion, no external tools.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

# clean_field <value> [maxlen] -- redact, collapse to one line, and cap
# length for safe embedding as a JSON string field (context values and step
# summaries only; the raw per-step stdout/stderr files are NOT put through
# this, only through redact()).
clean_field() {
  local v="$1" maxlen="${2:-2000}"
  v="$(printf '%s' "$v" | redact | "$TR_BIN" '\n\r\t' '   ')"
  printf '%s' "${v:0:$maxlen}"
}

# looks_auth_failure -- reads stdin, greps (case-insensitive) for phrases
# that indicate an authentication failure rather than some other error.
# Used only as a fallback when a step's own tool did not give an
# unambiguous machine-readable signal.
looks_auth_failure() {
  "$GREP_BIN" -qiE 'not logged in|not authenticated|please (log|sign) in|please run .*(login|auth)|invalid api key|unauthorized|401|no credentials found|authentication (failed|required|error)' 2>/dev/null
}

looks_auth_failure_str() {
  printf '%s' "$1" | looks_auth_failure
}

# env_presence <VAR-NAME> -- "set" or "unset", without ever touching the
# variable's value. Used for the credential-shaped environment variables
# this probe must record presence of but never print.
env_presence() {
  local name="$1"
  if [ -n "${!name:-}" ]; then printf 'set'; else printf 'unset'; fi
}

# show_argv <argv...> -- best-effort shell-quoted rendering, for dry-run
# summaries only (mirrors spike-1's show_argv).
show_argv() {
  local out="" a
  for a in "$@"; do
    out="$out $(printf '%q' "$a")"
  done
  printf '%s' "${out# }"
}

# ---------------------------------------------------------------------------
# resolve_bin <name> <env-var-name> -- resolve one vendor CLI to an absolute
# path: env override, then PATH (`command -v`), then a fixed candidate
# list. Sets globals RESOLVED_BIN (absolute path, or the literal string
# "not-found") and RESOLVED_SRC (how it was found).
#
# Unlike SYSBIN() above, this chain deliberately trusts PATH and a handful
# of common install locations: whether THIS resolution succeeds under the
# scheduler's own environment is exactly what D9 measures, so it must not be
# shortcut the way SYSBIN() is.
# ---------------------------------------------------------------------------

resolve_bin() {
  local name="$1" envvar="$2" envval
  envval="${!envvar:-}"
  RESOLVED_BIN="not-found"
  RESOLVED_SRC="not-found"

  if [ -n "$envval" ] && [ -x "$envval" ]; then
    RESOLVED_BIN="$envval"
    RESOLVED_SRC="env:$envvar"
    return 0
  fi

  local found
  found="$(command -v "$name" 2>/dev/null)"
  if [ -n "$found" ] && [ -x "$found" ]; then
    RESOLVED_BIN="$found"
    RESOLVED_SRC="PATH"
    return 0
  fi

  local dirs
  dirs=("$HOME/.local/bin" "/opt/homebrew/bin" "/usr/local/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin")
  local nvmdir
  for nvmdir in "$HOME"/.nvm/versions/node/*/bin; do
    [ -d "$nvmdir" ] && dirs+=("$nvmdir")
  done

  local d
  for d in "${dirs[@]}"; do
    if [ -x "$d/$name" ]; then
      RESOLVED_BIN="$d/$name"
      RESOLVED_SRC="candidate:$d"
      return 0
    fi
  done

  return 1
}

# ---------------------------------------------------------------------------
# run_with_deadline <deadline-secs> <final-stdout-file> <final-stderr-file>
#                    <argv...>
# Runs argv with stdin from /dev/null under a wall-clock deadline. No
# `timeout` binary is relied upon (not guaranteed present, and macOS ships
# none by default): a background process, polled every second, is sent
# SIGTERM at the deadline and SIGKILL five seconds later if still alive.
# Captures to raw temp files, then writes the REDACTED final files and
# removes the raw ones (mirrors spike-1's run_and_finalize). Sets globals
# DEADLINE_EXIT_CODE, DEADLINE_ELAPSED, DEADLINE_TIMED_OUT ("yes"/"no")
# (bash 3.2 has no `local -n`, so globals are how this reports back).
# ---------------------------------------------------------------------------

run_with_deadline() {
  local deadline="$1" final_out="$2" final_err="$3"
  shift 3
  local raw_out="${final_out}.raw" raw_err="${final_err}.raw"
  local start end

  start="$("$DATE_BIN" +%s)"
  "$@" >"$raw_out" 2>"$raw_err" </dev/null &
  local pid=$!
  CURRENT_CHILD_PID="$pid"

  local timed_out="no" waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$deadline" ]; then
      timed_out="yes"
      kill -TERM "$pid" 2>/dev/null
      local grace=0
      while kill -0 "$pid" 2>/dev/null && [ "$grace" -lt 5 ]; do
        "$SLEEP_BIN" 1
        grace=$((grace + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null
      fi
      break
    fi
    "$SLEEP_BIN" 1
    waited=$((waited + 1))
  done

  wait "$pid" 2>/dev/null
  DEADLINE_EXIT_CODE=$?
  CURRENT_CHILD_PID=""
  end="$("$DATE_BIN" +%s)"
  DEADLINE_ELAPSED=$((end - start))
  DEADLINE_TIMED_OUT="$timed_out"

  redact <"$raw_out" >"$final_out"
  redact <"$raw_err" >"$final_err"
  "$RM_BIN" -f "$raw_out" "$raw_err"
}

# ---------------------------------------------------------------------------
# jget <file> <top-level-key> -- best-effort extraction of a top-level JSON
# field. Uses node when available (robust); falls back to a regex scrape
# for a flat top-level "key": value pair (string/bool/number/null)
# otherwise. Every field this probe needs from claude/codex JSON output is
# top-level, so this deliberately does not handle nested paths.
# ---------------------------------------------------------------------------

jget() {
  local file="$1" key="$2"
  if [ "$NODE_BIN" != "not-found" ] && [ -s "$file" ]; then
    "$NODE_BIN" -e '
      try {
        var fs = require("fs");
        var d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        var v = d[process.argv[2]];
        if (v === undefined || v === null) { process.stdout.write(""); }
        else if (typeof v === "object") { process.stdout.write(JSON.stringify(v)); }
        else { process.stdout.write(String(v)); }
      } catch (e) { process.stdout.write(""); }
    ' "$file" "$key" 2>/dev/null
    return 0
  fi
  [ -s "$file" ] || { printf ''; return 0; }
  local hit
  hit="$("$SED_BIN" -nE -e "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/p" "$file" 2>/dev/null | head -n1)"
  if [ -n "$hit" ]; then
    printf '%s' "$hit"
    return 0
  fi
  "$SED_BIN" -nE -e "s/.*\"${key}\"[[:space:]]*:[[:space:]]*([A-Za-z0-9_.+-]+).*/\\1/p" "$file" 2>/dev/null | head -n1
}

# parse_codex_exec <file> -- prints a small flat JSON object describing
# whether a turn.completed line was seen, whether a turn.failed line was
# seen, the last agent_message text, and any turn.failed message. Lenient
# about event shape (top-level "type", or nested "msg.type") since the
# exact codex exec --json event schema was not verified against a live run
# before this probe was written.
parse_codex_exec() {
  local file="$1"
  if [ "$NODE_BIN" != "not-found" ]; then
    "$NODE_BIN" -e '
      var fs = require("fs");
      var turnCompleted = false, turnFailed = false, lastAgentMessage = "", failMessage = "";
      try {
        var lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
        for (var i = 0; i < lines.length; i++) {
          var t = lines[i].trim();
          if (!t) continue;
          var obj;
          try { obj = JSON.parse(t); } catch (e) { continue; }
          var type = obj.type || (obj.msg && obj.msg.type) || "";
          if (type === "turn.completed" || type === "turn_completed") turnCompleted = true;
          if (type === "turn.failed" || type === "turn_failed") {
            turnFailed = true;
            failMessage = String(obj.message || obj.error || (obj.msg && (obj.msg.message || obj.msg.error)) || "");
          }
          if (type === "agent_message") {
            lastAgentMessage = String(obj.message || obj.text || (obj.msg && (obj.msg.message || obj.msg.text)) || "");
          }
        }
      } catch (e) {}
      console.log(JSON.stringify({turnCompleted: turnCompleted, turnFailed: turnFailed, lastAgentMessage: lastAgentMessage, failMessage: failMessage}));
    ' "$file" 2>/dev/null
    return 0
  fi
  local tc="false" tf="false" msg=""
  "$GREP_BIN" -q '"type"[[:space:]]*:[[:space:]]*"turn\.completed"' "$file" 2>/dev/null && tc="true"
  "$GREP_BIN" -q '"type"[[:space:]]*:[[:space:]]*"turn\.failed"' "$file" 2>/dev/null && tf="true"
  msg="$("$GREP_BIN" -o '"message"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" 2>/dev/null | tail -n1 | "$SED_BIN" -E 's/.*:"(.*)"/\1/')"
  printf '{"turnCompleted":%s,"turnFailed":%s,"lastAgentMessage":"unavailable-without-node","failMessage":"%s"}' \
    "$tc" "$tf" "$(json_escape "$msg")"
}

# ---------------------------------------------------------------------------
# verdict combination for the one-line summary
# ---------------------------------------------------------------------------

verdict_rank() {
  case "$1" in
    auth-failed) printf '0' ;;
    not-found) printf '1' ;;
    timeout) printf '2' ;;
    error) printf '3' ;;
    dry-run) printf '4' ;;
    ok) printf '5' ;;
    *) printf '6' ;;
  esac
}

combine_verdict() {
  local a="$1" b="$2" ra rb
  ra="$(verdict_rank "$a")"
  rb="$(verdict_rank "$b")"
  if [ "$ra" -le "$rb" ]; then printf '%s' "$a"; else printf '%s' "$b"; fi
}

# ---------------------------------------------------------------------------
# Steps S1-S5. Each is isolated: a failure inside one step function never
# stops the next from running (main() calls them unconditionally in
# sequence, and nothing in a step function can abort the script under
# `set -uo pipefail` without `set -e`).
# ---------------------------------------------------------------------------

CLAUDE_TRIVIAL_PROMPT="Reply with exactly: LOOPMILL-OK"
CODEX_TRIVIAL_PROMPT="Reply with exactly: LOOPMILL-OK"

# S1: claude auth status --json
step_S1() {
  local id="S1" name="claude auth status --json"
  local outname="${id}.stdout.txt" errname="${id}.stderr.txt"
  local outfile="$RUN_DIR/$outname" errfile="$RUN_DIR/$errname"
  SPIKE4_S1_NAME="$name"
  SPIKE4_S1_STDOUT="$outname"
  SPIKE4_S1_STDERR="$errname"

  if [ "$DRY_RUN" = "1" ]; then
    SPIKE4_S1_VERDICT="dry-run"; SPIKE4_S1_EXIT=""; SPIKE4_S1_DURATION="0"
    SPIKE4_S1_SUMMARY="dry-run: would run: $(show_argv "$CLAUDE_BIN" auth status --json)"
    printf '%s\n' "$SPIKE4_S1_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  if [ "$CLAUDE_BIN" = "not-found" ]; then
    SPIKE4_S1_VERDICT="not-found"; SPIKE4_S1_EXIT=""; SPIKE4_S1_DURATION="0"
    SPIKE4_S1_SUMMARY="claude binary not found; step not executed"
    printf '%s\n' "$SPIKE4_S1_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  run_with_deadline 30 "$outfile" "$errfile" "$CLAUDE_BIN" auth status --json
  SPIKE4_S1_EXIT="$DEADLINE_EXIT_CODE"
  SPIKE4_S1_DURATION="$DEADLINE_ELAPSED"

  if [ "$DEADLINE_TIMED_OUT" = "yes" ]; then
    SPIKE4_S1_VERDICT="timeout"
    SPIKE4_S1_SUMMARY="exit=$SPIKE4_S1_EXIT timed out after 30s"
    return 0
  fi

  if [ "$SPIKE4_S1_EXIT" != "0" ]; then
    if looks_auth_failure <"$outfile" || looks_auth_failure <"$errfile"; then
      SPIKE4_S1_VERDICT="auth-failed"
    else
      SPIKE4_S1_VERDICT="error"
    fi
    SPIKE4_S1_SUMMARY="exit=$SPIKE4_S1_EXIT (see $outname / $errname)"
    return 0
  fi

  local logged_in auth_method
  logged_in="$(jget "$outfile" "loggedIn")"
  auth_method="$(jget "$outfile" "authMethod")"
  if [ "$logged_in" = "false" ]; then
    SPIKE4_S1_VERDICT="auth-failed"
  elif [ "$logged_in" = "true" ]; then
    SPIKE4_S1_VERDICT="ok"
  else
    SPIKE4_S1_VERDICT="error"
  fi
  SPIKE4_S1_SUMMARY="exit=$SPIKE4_S1_EXIT loggedIn=$logged_in authMethod=$auth_method"
}

# S2: claude -p trivial prompt, --output-format json, no TTY
step_S2() {
  local id="S2" name="claude -p trivial prompt --output-format json (no TTY)"
  local outname="${id}.stdout.txt" errname="${id}.stderr.txt"
  local outfile="$RUN_DIR/$outname" errfile="$RUN_DIR/$errname"
  SPIKE4_S2_NAME="$name"
  SPIKE4_S2_STDOUT="$outname"
  SPIKE4_S2_STDERR="$errname"

  if [ "$DRY_RUN" = "1" ]; then
    SPIKE4_S2_VERDICT="dry-run"; SPIKE4_S2_EXIT=""; SPIKE4_S2_DURATION="0"
    SPIKE4_S2_SUMMARY="dry-run: would run: $(show_argv "$CLAUDE_BIN" -p "$CLAUDE_TRIVIAL_PROMPT" --output-format json --max-turns 1 --permission-mode plan --permission-prompts none)"
    printf '%s\n' "$SPIKE4_S2_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  if [ "$CLAUDE_BIN" = "not-found" ]; then
    SPIKE4_S2_VERDICT="not-found"; SPIKE4_S2_EXIT=""; SPIKE4_S2_DURATION="0"
    SPIKE4_S2_SUMMARY="claude binary not found; step not executed"
    printf '%s\n' "$SPIKE4_S2_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  run_with_deadline 120 "$outfile" "$errfile" \
    "$CLAUDE_BIN" -p "$CLAUDE_TRIVIAL_PROMPT" --output-format json --max-turns 1 \
    --permission-mode plan --permission-prompts none
  SPIKE4_S2_EXIT="$DEADLINE_EXIT_CODE"
  SPIKE4_S2_DURATION="$DEADLINE_ELAPSED"

  if [ "$DEADLINE_TIMED_OUT" = "yes" ]; then
    SPIKE4_S2_VERDICT="timeout"
    SPIKE4_S2_SUMMARY="exit=$SPIKE4_S2_EXIT timed out after 120s"
    return 0
  fi

  local is_error result terminal_reason
  is_error="$(jget "$outfile" "is_error")"
  result="$(jget "$outfile" "result")"
  terminal_reason="$(jget "$outfile" "terminal_reason")"

  if [ "$SPIKE4_S2_EXIT" != "0" ]; then
    if looks_auth_failure <"$outfile" || looks_auth_failure <"$errfile"; then
      SPIKE4_S2_VERDICT="auth-failed"
    else
      SPIKE4_S2_VERDICT="error"
    fi
  elif [ "$is_error" = "true" ]; then
    if looks_auth_failure_str "$result" || looks_auth_failure <"$outfile" || looks_auth_failure <"$errfile"; then
      SPIKE4_S2_VERDICT="auth-failed"
    else
      SPIKE4_S2_VERDICT="error"
    fi
  else
    case "$result" in
      *LOOPMILL-OK*) SPIKE4_S2_VERDICT="ok" ;;
      *) SPIKE4_S2_VERDICT="error" ;;
    esac
  fi

  SPIKE4_S2_SUMMARY="exit=$SPIKE4_S2_EXIT is_error=$is_error terminal_reason=$terminal_reason result=\"$(clean_field "$result" 150)\""
}

# S3: codex login status
step_S3() {
  local id="S3" name="codex login status"
  local outname="${id}.stdout.txt" errname="${id}.stderr.txt"
  local outfile="$RUN_DIR/$outname" errfile="$RUN_DIR/$errname"
  SPIKE4_S3_NAME="$name"
  SPIKE4_S3_STDOUT="$outname"
  SPIKE4_S3_STDERR="$errname"

  if [ "$DRY_RUN" = "1" ]; then
    SPIKE4_S3_VERDICT="dry-run"; SPIKE4_S3_EXIT=""; SPIKE4_S3_DURATION="0"
    SPIKE4_S3_SUMMARY="dry-run: would run: $(show_argv "$CODEX_BIN" login status)"
    printf '%s\n' "$SPIKE4_S3_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  if [ "$CODEX_BIN" = "not-found" ]; then
    SPIKE4_S3_VERDICT="not-found"; SPIKE4_S3_EXIT=""; SPIKE4_S3_DURATION="0"
    SPIKE4_S3_SUMMARY="codex binary not found; step not executed"
    printf '%s\n' "$SPIKE4_S3_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  run_with_deadline 30 "$outfile" "$errfile" "$CODEX_BIN" login status
  SPIKE4_S3_EXIT="$DEADLINE_EXIT_CODE"
  SPIKE4_S3_DURATION="$DEADLINE_ELAPSED"

  if [ "$DEADLINE_TIMED_OUT" = "yes" ]; then
    SPIKE4_S3_VERDICT="timeout"
    SPIKE4_S3_SUMMARY="exit=$SPIKE4_S3_EXIT timed out after 30s"
    return 0
  fi

  local not_in="no" is_in="no"
  "$GREP_BIN" -qi "not logged in" "$outfile" "$errfile" 2>/dev/null && not_in="yes"
  "$GREP_BIN" -qi "logged in" "$outfile" "$errfile" 2>/dev/null && is_in="yes"

  if [ "$not_in" = "yes" ]; then
    SPIKE4_S3_VERDICT="auth-failed"
  elif [ "$SPIKE4_S3_EXIT" = "0" ] && [ "$is_in" = "yes" ]; then
    SPIKE4_S3_VERDICT="ok"
  else
    SPIKE4_S3_VERDICT="error"
  fi

  local snippet
  snippet="$(clean_field "$("$SED_BIN" -n '1,3p' "$outfile" 2>/dev/null)" 200)"
  SPIKE4_S3_SUMMARY="exit=$SPIKE4_S3_EXIT loggedInPhraseSeen=$is_in notLoggedInPhraseSeen=$not_in snippet=\"$snippet\""
}

# S4: codex exec --json, trivial prompt, read-only sandbox, scratch cwd
step_S4() {
  local id="S4" name="codex exec --json (trivial prompt, scratch dir, read-only)"
  local outname="${id}.stdout.txt" errname="${id}.stderr.txt"
  local outfile="$RUN_DIR/$outname" errfile="$RUN_DIR/$errname"
  local scratch="$RUN_DIR/codex-scratch"
  SPIKE4_S4_NAME="$name"
  SPIKE4_S4_STDOUT="$outname"
  SPIKE4_S4_STDERR="$errname"

  if [ "$DRY_RUN" = "1" ]; then
    SPIKE4_S4_VERDICT="dry-run"; SPIKE4_S4_EXIT=""; SPIKE4_S4_DURATION="0"
    SPIKE4_S4_SUMMARY="dry-run: would run: $(show_argv "$ENV_BIN" -u OPENAI_API_KEY -u CODEX_API_KEY "$CODEX_BIN" exec --skip-git-repo-check -C "$scratch" -s read-only --json --color never "$CODEX_TRIVIAL_PROMPT")"
    printf '%s\n' "$SPIKE4_S4_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  if [ "$CODEX_BIN" = "not-found" ]; then
    SPIKE4_S4_VERDICT="not-found"; SPIKE4_S4_EXIT=""; SPIKE4_S4_DURATION="0"
    SPIKE4_S4_SUMMARY="codex binary not found; step not executed"
    printf '%s\n' "$SPIKE4_S4_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  run_with_deadline 120 "$outfile" "$errfile" \
    "$ENV_BIN" -u OPENAI_API_KEY -u CODEX_API_KEY \
    "$CODEX_BIN" exec --skip-git-repo-check -C "$scratch" -s read-only --json --color never "$CODEX_TRIVIAL_PROMPT"
  SPIKE4_S4_EXIT="$DEADLINE_EXIT_CODE"
  SPIKE4_S4_DURATION="$DEADLINE_ELAPSED"

  if [ "$DEADLINE_TIMED_OUT" = "yes" ]; then
    SPIKE4_S4_VERDICT="timeout"
    SPIKE4_S4_SUMMARY="exit=$SPIKE4_S4_EXIT timed out after 120s"
    return 0
  fi

  local parsed parsed_file turn_completed turn_failed agent_msg fail_msg
  parsed="$(parse_codex_exec "$outfile")"
  parsed_file="$RUN_DIR/.${id}.parsed.json"
  printf '%s' "$parsed" >"$parsed_file"
  turn_completed="$(jget "$parsed_file" "turnCompleted")"
  turn_failed="$(jget "$parsed_file" "turnFailed")"
  agent_msg="$(jget "$parsed_file" "lastAgentMessage")"
  fail_msg="$(jget "$parsed_file" "failMessage")"
  "$RM_BIN" -f "$parsed_file"

  if [ "$SPIKE4_S4_EXIT" != "0" ]; then
    if [ "$turn_failed" = "true" ] && { looks_auth_failure_str "$fail_msg" || looks_auth_failure <"$outfile" || looks_auth_failure <"$errfile"; }; then
      SPIKE4_S4_VERDICT="auth-failed"
    else
      SPIKE4_S4_VERDICT="error"
    fi
  elif [ "$turn_completed" = "true" ]; then
    SPIKE4_S4_VERDICT="ok"
  elif [ "$turn_failed" = "true" ]; then
    if looks_auth_failure_str "$fail_msg" || looks_auth_failure <"$outfile" || looks_auth_failure <"$errfile"; then
      SPIKE4_S4_VERDICT="auth-failed"
    else
      SPIKE4_S4_VERDICT="error"
    fi
  else
    SPIKE4_S4_VERDICT="error"
  fi

  SPIKE4_S4_SUMMARY="exit=$SPIKE4_S4_EXIT turnCompleted=$turn_completed turnFailed=$turn_failed agentMessage=\"$(clean_field "$agent_msg" 150)\""
}

# S5: gh auth status
step_S5() {
  local id="S5" name="gh auth status"
  local outname="${id}.stdout.txt" errname="${id}.stderr.txt"
  local outfile="$RUN_DIR/$outname" errfile="$RUN_DIR/$errname"
  SPIKE4_S5_NAME="$name"
  SPIKE4_S5_STDOUT="$outname"
  SPIKE4_S5_STDERR="$errname"

  if [ "$DRY_RUN" = "1" ]; then
    SPIKE4_S5_VERDICT="dry-run"; SPIKE4_S5_EXIT=""; SPIKE4_S5_DURATION="0"
    SPIKE4_S5_SUMMARY="dry-run: would run: $(show_argv "$GH_BIN" auth status)"
    printf '%s\n' "$SPIKE4_S5_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  if [ "$GH_BIN" = "not-found" ]; then
    SPIKE4_S5_VERDICT="not-found"; SPIKE4_S5_EXIT=""; SPIKE4_S5_DURATION="0"
    SPIKE4_S5_SUMMARY="gh binary not found; step not executed"
    printf '%s\n' "$SPIKE4_S5_SUMMARY" >"$outfile"; : >"$errfile"
    return 0
  fi

  run_with_deadline 30 "$outfile" "$errfile" "$GH_BIN" auth status
  SPIKE4_S5_EXIT="$DEADLINE_EXIT_CODE"
  SPIKE4_S5_DURATION="$DEADLINE_ELAPSED"

  if [ "$DEADLINE_TIMED_OUT" = "yes" ]; then
    SPIKE4_S5_VERDICT="timeout"
    SPIKE4_S5_SUMMARY="exit=$SPIKE4_S5_EXIT timed out after 30s"
    return 0
  fi

  local not_in="no" is_in="no"
  "$GREP_BIN" -qi "not logged" "$outfile" "$errfile" 2>/dev/null && not_in="yes"
  "$GREP_BIN" -qi "logged in" "$outfile" "$errfile" 2>/dev/null && is_in="yes"

  if [ "$not_in" = "yes" ]; then
    SPIKE4_S5_VERDICT="auth-failed"
  elif [ "$SPIKE4_S5_EXIT" = "0" ] && [ "$is_in" = "yes" ]; then
    SPIKE4_S5_VERDICT="ok"
  else
    SPIKE4_S5_VERDICT="error"
  fi

  SPIKE4_S5_SUMMARY="exit=$SPIKE4_S5_EXIT loggedInPhraseSeen=$is_in notLoggedInPhraseSeen=$not_in"
}

# ---------------------------------------------------------------------------
# write_step_json_bash <id> <name> <verdict> <exit> <duration> <summary>
#                       <stdoutfile> <stderrfile> <trailing-comma-or-empty>
# One step object, hand-escaped. Shared by the bash JSON fallback below.
# ---------------------------------------------------------------------------

write_step_json_bash() {
  local id="$1" name="$2" verdict="$3" exitc="$4" dur="$5" summary="$6" stdoutf="$7" stderrf="$8" trailing="$9"
  local exit_json dur_json
  if [ -z "$exitc" ]; then exit_json="null"; else exit_json="$exitc"; fi
  if [ -z "$dur" ]; then dur_json="null"; else dur_json="$dur"; fi
  printf '    "%s": {\n' "$id"
  printf '      "id": "%s",\n' "$id"
  printf '      "name": "%s",\n' "$(json_escape "$name")"
  printf '      "verdict": "%s",\n' "$(json_escape "$verdict")"
  printf '      "exitCode": %s,\n' "$exit_json"
  printf '      "durationSec": %s,\n' "$dur_json"
  printf '      "summary": "%s",\n' "$(json_escape "$summary")"
  printf '      "stdoutFile": "%s",\n' "$(json_escape "$stdoutf")"
  printf '      "stderrFile": "%s"\n' "$(json_escape "$stderrf")"
  printf '    }%s\n' "$trailing"
}

# write_probe_json_bash_fallback <out-file> -- builds the same nested shape
# as the node path, by hand, with every string value passed through
# json_escape(). Used when node is not-found, or if the node path fails.
write_probe_json_bash_fallback() {
  local out="$1"
  local mac_block linux_block

  if [ "$SPIKE4_CTX_OS" = "Darwin" ]; then
    mac_block="$(
      printf '{\n'
      printf '      "launchctlManagerName": "%s",\n' "$(json_escape "$SPIKE4_CTX_MAC_MANAGERNAME")"
      printf '      "launchctlManagerPid": "%s",\n' "$(json_escape "$SPIKE4_CTX_MAC_MANAGERPID")"
      printf '      "launchctlManagerUid": "%s",\n' "$(json_escape "$SPIKE4_CTX_MAC_MANAGERUID")"
      printf '      "screenLockState": "%s",\n' "$(json_escape "$SPIKE4_CTX_MAC_SCREENLOCK")"
      printf '      "keychainListPaths": "%s",\n' "$(json_escape "$SPIKE4_CTX_MAC_KEYCHAINS")"
      printf '      "keychainClaudeCredentialFound": "%s",\n' "$(json_escape "$SPIKE4_CTX_MAC_KEYCHAIN_CLAUDE")"
      printf '      "keychainCodexAuthFound": "%s"\n' "$(json_escape "$SPIKE4_CTX_MAC_KEYCHAIN_CODEX")"
      printf '    }'
    )"
  else
    mac_block="null"
  fi

  if [ "$SPIKE4_CTX_OS" = "Linux" ]; then
    linux_block="$(
      printf '{\n'
      printf '      "xdgRuntimeDirSet": "%s",\n' "$(json_escape "$SPIKE4_CTX_LINUX_XDG_RUNTIME_DIR_SET")"
      printf '      "dbusSessionBusAddressSet": "%s",\n' "$(json_escape "$SPIKE4_CTX_LINUX_DBUS_SET")"
      printf '      "loginctlLinger": "%s",\n' "$(json_escape "$SPIKE4_CTX_LINUX_LINGER")"
      printf '      "systemctlUserIsSystemRunning": "%s"\n' "$(json_escape "$SPIKE4_CTX_LINUX_SYSTEMCTL_STATUS")"
      printf '    }'
    )"
  else
    linux_block="null"
  fi

  {
    printf '{\n'
    printf '  "schemaVersion": "loopmill-spike4-d9/1",\n'
    printf '  "label": "%s",\n' "$(json_escape "$SPIKE4_CTX_LABEL")"
    printf '  "dryRun": %s,\n' "$([ "$SPIKE4_CTX_DRYRUN" = "1" ] && echo true || echo false)"
    printf '  "generatedAtUtc": "%s",\n' "$(json_escape "$SPIKE4_CTX_GENERATED_AT")"
    printf '  "startedAtUtc": "%s",\n' "$(json_escape "$SPIKE4_CTX_STARTED_AT")"
    printf '  "finishedAtUtc": "%s",\n' "$(json_escape "$SPIKE4_CTX_FINISHED_AT")"
    printf '  "outputDir": "%s",\n' "$(json_escape "$SPIKE4_CTX_OUTPUT_DIR")"
    printf '  "context": {\n'
    printf '    "uname": "%s",\n' "$(json_escape "$SPIKE4_CTX_UNAME")"
    printf '    "uid": "%s",\n' "$(json_escape "$SPIKE4_CTX_UID")"
    printf '    "user": "%s",\n' "$(json_escape "$SPIKE4_CTX_USER")"
    printf '    "home": "%s",\n' "$(json_escape "$SPIKE4_CTX_HOME")"
    printf '    "pathReceived": "%s",\n' "$(json_escape "$SPIKE4_CTX_PATH")"
    printf '    "codexHome": "%s",\n' "$(json_escape "$SPIKE4_CTX_CODEX_HOME")"
    printf '    "claudeConfigDir": "%s",\n' "$(json_escape "$SPIKE4_CTX_CLAUDE_CONFIG_DIR")"
    printf '    "envPresence": {\n'
    printf '      "OPENAI_API_KEY": "%s",\n' "$(json_escape "$SPIKE4_CTX_ENV_OPENAI_API_KEY")"
    printf '      "CODEX_API_KEY": "%s",\n' "$(json_escape "$SPIKE4_CTX_ENV_CODEX_API_KEY")"
    printf '      "ANTHROPIC_API_KEY": "%s",\n' "$(json_escape "$SPIKE4_CTX_ENV_ANTHROPIC_API_KEY")"
    printf '      "CLAUDE_CODE_OAUTH_TOKEN": "%s",\n' "$(json_escape "$SPIKE4_CTX_ENV_CLAUDE_CODE_OAUTH_TOKEN")"
    printf '      "GH_TOKEN": "%s"\n' "$(json_escape "$SPIKE4_CTX_ENV_GH_TOKEN")"
    printf '    },\n'
    printf '    "tty": "%s",\n' "$(json_escape "$SPIKE4_CTX_TTY")"
    printf '    "securitySessionIdSet": "%s",\n' "$(json_escape "$SPIKE4_CTX_SECURITYSESSIONID_SET")"
    printf '    "who": "%s",\n' "$(json_escape "$SPIKE4_CTX_WHO")"
    printf '    "os": "%s",\n' "$(json_escape "$SPIKE4_CTX_OS")"
    printf '    "macos": %s,\n' "$mac_block"
    printf '    "linux": %s,\n' "$linux_block"
    printf '    "binaries": {\n'
    printf '      "claude": {"path": "%s", "source": "%s"},\n' "$(json_escape "$SPIKE4_CTX_BIN_CLAUDE_PATH")" "$(json_escape "$SPIKE4_CTX_BIN_CLAUDE_SRC")"
    printf '      "codex": {"path": "%s", "source": "%s"},\n' "$(json_escape "$SPIKE4_CTX_BIN_CODEX_PATH")" "$(json_escape "$SPIKE4_CTX_BIN_CODEX_SRC")"
    printf '      "gh": {"path": "%s", "source": "%s"},\n' "$(json_escape "$SPIKE4_CTX_BIN_GH_PATH")" "$(json_escape "$SPIKE4_CTX_BIN_GH_SRC")"
    printf '      "node": {"path": "%s", "source": "%s"}\n' "$(json_escape "$SPIKE4_CTX_BIN_NODE_PATH")" "$(json_escape "$SPIKE4_CTX_BIN_NODE_SRC")"
    printf '    }\n'
    printf '  },\n'
    printf '  "steps": {\n'
    write_step_json_bash "S1" "$SPIKE4_S1_NAME" "$SPIKE4_S1_VERDICT" "$SPIKE4_S1_EXIT" "$SPIKE4_S1_DURATION" "$SPIKE4_S1_SUMMARY" "$SPIKE4_S1_STDOUT" "$SPIKE4_S1_STDERR" ","
    write_step_json_bash "S2" "$SPIKE4_S2_NAME" "$SPIKE4_S2_VERDICT" "$SPIKE4_S2_EXIT" "$SPIKE4_S2_DURATION" "$SPIKE4_S2_SUMMARY" "$SPIKE4_S2_STDOUT" "$SPIKE4_S2_STDERR" ","
    write_step_json_bash "S3" "$SPIKE4_S3_NAME" "$SPIKE4_S3_VERDICT" "$SPIKE4_S3_EXIT" "$SPIKE4_S3_DURATION" "$SPIKE4_S3_SUMMARY" "$SPIKE4_S3_STDOUT" "$SPIKE4_S3_STDERR" ","
    write_step_json_bash "S4" "$SPIKE4_S4_NAME" "$SPIKE4_S4_VERDICT" "$SPIKE4_S4_EXIT" "$SPIKE4_S4_DURATION" "$SPIKE4_S4_SUMMARY" "$SPIKE4_S4_STDOUT" "$SPIKE4_S4_STDERR" ","
    write_step_json_bash "S5" "$SPIKE4_S5_NAME" "$SPIKE4_S5_VERDICT" "$SPIKE4_S5_EXIT" "$SPIKE4_S5_DURATION" "$SPIKE4_S5_SUMMARY" "$SPIKE4_S5_STDOUT" "$SPIKE4_S5_STDERR" ""
    printf '  },\n'
    printf '  "combined": {\n'
    printf '    "claude": "%s",\n' "$(json_escape "$SPIKE4_C_CLAUDE")"
    printf '    "codex": "%s",\n' "$(json_escape "$SPIKE4_C_CODEX")"
    printf '    "gh": "%s",\n' "$(json_escape "$SPIKE4_C_GH")"
    printf '    "keychainClaude": "%s",\n' "$(json_escape "$SPIKE4_C_KEYCHAIN_CLAUDE")"
    printf '    "keychainCodex": "%s",\n' "$(json_escape "$SPIKE4_C_KEYCHAIN_CODEX")"
    printf '    "screen": "%s",\n' "$(json_escape "$SPIKE4_C_SCREEN")"
    printf '    "manager": "%s"\n' "$(json_escape "$SPIKE4_C_MANAGER")"
    printf '  },\n'
    printf '  "summaryLine": "%s"\n' "$(json_escape "$SPIKE4_C_SUMMARY_LINE")"
    printf '}\n'
  } >"$out"
}

# write_probe_json -- prefers node (JSON.stringify does the escaping, more
# robust than the bash fallback for edge-case characters); falls back to
# write_probe_json_bash_fallback if node is not-found or the node path
# fails to produce a non-empty file. Same keys either way.
write_probe_json() {
  local out="$RUN_DIR/probe.json"

  if [ "$NODE_BIN" != "not-found" ]; then
    local node_script="$RUN_DIR/.build-probe-json.js"
    cat >"$node_script" <<'NODEJS'
'use strict';
var fs = require('fs');
var env = process.env;

function s(name) { var v = env[name]; return v === undefined ? '' : v; }
function n(name) { var v = env[name]; if (v === undefined || v === '') return null; var num = Number(v); return isNaN(num) ? null : num; }
function b(name) { return s(name) === '1'; }

var os = s('SPIKE4_CTX_OS');

var context = {
  uname: s('SPIKE4_CTX_UNAME'),
  uid: s('SPIKE4_CTX_UID'),
  user: s('SPIKE4_CTX_USER'),
  home: s('SPIKE4_CTX_HOME'),
  pathReceived: s('SPIKE4_CTX_PATH'),
  codexHome: s('SPIKE4_CTX_CODEX_HOME'),
  claudeConfigDir: s('SPIKE4_CTX_CLAUDE_CONFIG_DIR'),
  envPresence: {
    OPENAI_API_KEY: s('SPIKE4_CTX_ENV_OPENAI_API_KEY'),
    CODEX_API_KEY: s('SPIKE4_CTX_ENV_CODEX_API_KEY'),
    ANTHROPIC_API_KEY: s('SPIKE4_CTX_ENV_ANTHROPIC_API_KEY'),
    CLAUDE_CODE_OAUTH_TOKEN: s('SPIKE4_CTX_ENV_CLAUDE_CODE_OAUTH_TOKEN'),
    GH_TOKEN: s('SPIKE4_CTX_ENV_GH_TOKEN')
  },
  tty: s('SPIKE4_CTX_TTY'),
  securitySessionIdSet: s('SPIKE4_CTX_SECURITYSESSIONID_SET'),
  who: s('SPIKE4_CTX_WHO'),
  os: os,
  macos: os === 'Darwin' ? {
    launchctlManagerName: s('SPIKE4_CTX_MAC_MANAGERNAME'),
    launchctlManagerPid: s('SPIKE4_CTX_MAC_MANAGERPID'),
    launchctlManagerUid: s('SPIKE4_CTX_MAC_MANAGERUID'),
    screenLockState: s('SPIKE4_CTX_MAC_SCREENLOCK'),
    keychainListPaths: s('SPIKE4_CTX_MAC_KEYCHAINS'),
    keychainClaudeCredentialFound: s('SPIKE4_CTX_MAC_KEYCHAIN_CLAUDE'),
    keychainCodexAuthFound: s('SPIKE4_CTX_MAC_KEYCHAIN_CODEX')
  } : null,
  linux: os === 'Linux' ? {
    xdgRuntimeDirSet: s('SPIKE4_CTX_LINUX_XDG_RUNTIME_DIR_SET'),
    dbusSessionBusAddressSet: s('SPIKE4_CTX_LINUX_DBUS_SET'),
    loginctlLinger: s('SPIKE4_CTX_LINUX_LINGER'),
    systemctlUserIsSystemRunning: s('SPIKE4_CTX_LINUX_SYSTEMCTL_STATUS')
  } : null,
  binaries: {
    claude: { path: s('SPIKE4_CTX_BIN_CLAUDE_PATH'), source: s('SPIKE4_CTX_BIN_CLAUDE_SRC') },
    codex: { path: s('SPIKE4_CTX_BIN_CODEX_PATH'), source: s('SPIKE4_CTX_BIN_CODEX_SRC') },
    gh: { path: s('SPIKE4_CTX_BIN_GH_PATH'), source: s('SPIKE4_CTX_BIN_GH_SRC') },
    node: { path: s('SPIKE4_CTX_BIN_NODE_PATH'), source: s('SPIKE4_CTX_BIN_NODE_SRC') }
  }
};

function step(prefix, id) {
  return {
    id: id,
    name: s(prefix + '_NAME'),
    verdict: s(prefix + '_VERDICT'),
    exitCode: n(prefix + '_EXIT'),
    durationSec: n(prefix + '_DURATION'),
    summary: s(prefix + '_SUMMARY'),
    stdoutFile: s(prefix + '_STDOUT'),
    stderrFile: s(prefix + '_STDERR')
  };
}

var steps = {
  S1: step('SPIKE4_S1', 'S1'),
  S2: step('SPIKE4_S2', 'S2'),
  S3: step('SPIKE4_S3', 'S3'),
  S4: step('SPIKE4_S4', 'S4'),
  S5: step('SPIKE4_S5', 'S5')
};

var combined = {
  claude: s('SPIKE4_C_CLAUDE'),
  codex: s('SPIKE4_C_CODEX'),
  gh: s('SPIKE4_C_GH'),
  keychainClaude: s('SPIKE4_C_KEYCHAIN_CLAUDE'),
  keychainCodex: s('SPIKE4_C_KEYCHAIN_CODEX'),
  screen: s('SPIKE4_C_SCREEN'),
  manager: s('SPIKE4_C_MANAGER')
};

var out = {
  schemaVersion: 'loopmill-spike4-d9/1',
  label: s('SPIKE4_CTX_LABEL'),
  dryRun: b('SPIKE4_CTX_DRYRUN'),
  generatedAtUtc: s('SPIKE4_CTX_GENERATED_AT'),
  startedAtUtc: s('SPIKE4_CTX_STARTED_AT'),
  finishedAtUtc: s('SPIKE4_CTX_FINISHED_AT'),
  outputDir: s('SPIKE4_CTX_OUTPUT_DIR'),
  context: context,
  steps: steps,
  combined: combined,
  summaryLine: s('SPIKE4_C_SUMMARY_LINE')
};

fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
NODEJS

    export SPIKE4_CTX_LABEL SPIKE4_CTX_DRYRUN SPIKE4_CTX_GENERATED_AT SPIKE4_CTX_STARTED_AT \
      SPIKE4_CTX_FINISHED_AT SPIKE4_CTX_OUTPUT_DIR SPIKE4_CTX_UNAME SPIKE4_CTX_UID SPIKE4_CTX_USER \
      SPIKE4_CTX_HOME SPIKE4_CTX_PATH SPIKE4_CTX_CODEX_HOME SPIKE4_CTX_CLAUDE_CONFIG_DIR \
      SPIKE4_CTX_ENV_OPENAI_API_KEY SPIKE4_CTX_ENV_CODEX_API_KEY SPIKE4_CTX_ENV_ANTHROPIC_API_KEY \
      SPIKE4_CTX_ENV_CLAUDE_CODE_OAUTH_TOKEN SPIKE4_CTX_ENV_GH_TOKEN SPIKE4_CTX_TTY \
      SPIKE4_CTX_SECURITYSESSIONID_SET SPIKE4_CTX_WHO SPIKE4_CTX_OS \
      SPIKE4_CTX_MAC_MANAGERNAME SPIKE4_CTX_MAC_MANAGERPID SPIKE4_CTX_MAC_MANAGERUID \
      SPIKE4_CTX_MAC_SCREENLOCK SPIKE4_CTX_MAC_KEYCHAINS SPIKE4_CTX_MAC_KEYCHAIN_CLAUDE \
      SPIKE4_CTX_MAC_KEYCHAIN_CODEX SPIKE4_CTX_LINUX_XDG_RUNTIME_DIR_SET SPIKE4_CTX_LINUX_DBUS_SET \
      SPIKE4_CTX_LINUX_LINGER SPIKE4_CTX_LINUX_SYSTEMCTL_STATUS \
      SPIKE4_CTX_BIN_CLAUDE_PATH SPIKE4_CTX_BIN_CLAUDE_SRC SPIKE4_CTX_BIN_CODEX_PATH SPIKE4_CTX_BIN_CODEX_SRC \
      SPIKE4_CTX_BIN_GH_PATH SPIKE4_CTX_BIN_GH_SRC SPIKE4_CTX_BIN_NODE_PATH SPIKE4_CTX_BIN_NODE_SRC \
      SPIKE4_S1_NAME SPIKE4_S1_VERDICT SPIKE4_S1_EXIT SPIKE4_S1_DURATION SPIKE4_S1_SUMMARY SPIKE4_S1_STDOUT SPIKE4_S1_STDERR \
      SPIKE4_S2_NAME SPIKE4_S2_VERDICT SPIKE4_S2_EXIT SPIKE4_S2_DURATION SPIKE4_S2_SUMMARY SPIKE4_S2_STDOUT SPIKE4_S2_STDERR \
      SPIKE4_S3_NAME SPIKE4_S3_VERDICT SPIKE4_S3_EXIT SPIKE4_S3_DURATION SPIKE4_S3_SUMMARY SPIKE4_S3_STDOUT SPIKE4_S3_STDERR \
      SPIKE4_S4_NAME SPIKE4_S4_VERDICT SPIKE4_S4_EXIT SPIKE4_S4_DURATION SPIKE4_S4_SUMMARY SPIKE4_S4_STDOUT SPIKE4_S4_STDERR \
      SPIKE4_S5_NAME SPIKE4_S5_VERDICT SPIKE4_S5_EXIT SPIKE4_S5_DURATION SPIKE4_S5_SUMMARY SPIKE4_S5_STDOUT SPIKE4_S5_STDERR \
      SPIKE4_C_CLAUDE SPIKE4_C_CODEX SPIKE4_C_GH SPIKE4_C_KEYCHAIN_CLAUDE SPIKE4_C_KEYCHAIN_CODEX \
      SPIKE4_C_SCREEN SPIKE4_C_MANAGER SPIKE4_C_SUMMARY_LINE

    if "$NODE_BIN" "$node_script" "$out" 2>"$RUN_DIR/.build-probe-json.err" && [ -s "$out" ]; then
      "$RM_BIN" -f "$node_script" "$RUN_DIR/.build-probe-json.err"
      return 0
    fi
    "$RM_BIN" -f "$node_script"
  fi

  write_probe_json_bash_fallback "$out"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  # --- label & dry-run flag ---
  LABEL="${1:-}"
  if [ -z "$LABEL" ]; then LABEL="${SPIKE4_D9_LABEL:-unlabelled}"; fi
  DRY_RUN="${SPIKE4_D9_DRY_RUN:-0}"

  # --- output directory ---
  local base_out
  base_out="${SPIKE4_D9_OUT:-}"
  if [ -z "$base_out" ]; then
    if [ -n "${HOME:-}" ]; then base_out="$HOME/loopmill-spike4-d9"; else base_out="/var/tmp/loopmill-spike4-d9"; fi
  fi

  local ts
  ts="$("$DATE_BIN" -u +"%Y%m%dT%H%M%SZ")"
  RUN_DIR="$base_out/${LABEL}-${ts}"

  "$MKDIR_BIN" -p "$RUN_DIR" 2>/dev/null
  if [ ! -d "$RUN_DIR" ]; then
    printf 'spike4-d9 FATAL: could not create output directory: %s\n' "$RUN_DIR" >&2
    exit 1
  fi
  "$MKDIR_BIN" -p "$RUN_DIR/codex-scratch" 2>/dev/null

  SPIKE4_CTX_STARTED_AT="$("$DATE_BIN" -u +"%Y-%m-%dT%H:%M:%SZ")"

  # --- resolve the four vendor CLIs ---
  resolve_bin claude SPIKE4_CLAUDE_BIN; CLAUDE_BIN="$RESOLVED_BIN"; CLAUDE_SRC="$RESOLVED_SRC"
  resolve_bin codex SPIKE4_CODEX_BIN; CODEX_BIN="$RESOLVED_BIN"; CODEX_SRC="$RESOLVED_SRC"
  resolve_bin gh SPIKE4_GH_BIN; GH_BIN="$RESOLVED_BIN"; GH_SRC="$RESOLVED_SRC"
  resolve_bin node SPIKE4_NODE_BIN; NODE_BIN="$RESOLVED_BIN"; NODE_SRC="$RESOLVED_SRC"

  SPIKE4_CTX_BIN_CLAUDE_PATH="$(clean_field "$CLAUDE_BIN" 500)"
  SPIKE4_CTX_BIN_CLAUDE_SRC="$(clean_field "$CLAUDE_SRC" 200)"
  SPIKE4_CTX_BIN_CODEX_PATH="$(clean_field "$CODEX_BIN" 500)"
  SPIKE4_CTX_BIN_CODEX_SRC="$(clean_field "$CODEX_SRC" 200)"
  SPIKE4_CTX_BIN_GH_PATH="$(clean_field "$GH_BIN" 500)"
  SPIKE4_CTX_BIN_GH_SRC="$(clean_field "$GH_SRC" 200)"
  SPIKE4_CTX_BIN_NODE_PATH="$(clean_field "$NODE_BIN" 500)"
  SPIKE4_CTX_BIN_NODE_SRC="$(clean_field "$NODE_SRC" 200)"

  # --- context: general ---
  SPIKE4_CTX_LABEL="$LABEL"
  SPIKE4_CTX_DRYRUN="$DRY_RUN"
  SPIKE4_CTX_OUTPUT_DIR="$(clean_field "$RUN_DIR" 500)"
  SPIKE4_CTX_UNAME="$(clean_field "$("$UNAME_BIN" -a 2>&1)" 500)"
  SPIKE4_CTX_UID="$("$ID_BIN" -u 2>/dev/null)"; [ -z "$SPIKE4_CTX_UID" ] && SPIKE4_CTX_UID="unknown"
  local user_val
  user_val="$("$ID_BIN" -un 2>/dev/null)"; [ -z "$user_val" ] && user_val="${USER:-unknown}"
  SPIKE4_CTX_USER="$(clean_field "$user_val" 200)"
  SPIKE4_CTX_HOME="$(clean_field "${HOME:-<unset>}" 500)"
  SPIKE4_CTX_PATH="$(clean_field "${PATH:-<unset>}" 4000)"
  SPIKE4_CTX_CODEX_HOME="$(clean_field "${CODEX_HOME:-<unset>}" 500)"
  SPIKE4_CTX_CLAUDE_CONFIG_DIR="$(clean_field "${CLAUDE_CONFIG_DIR:-<unset>}" 500)"
  SPIKE4_CTX_ENV_OPENAI_API_KEY="$(env_presence OPENAI_API_KEY)"
  SPIKE4_CTX_ENV_CODEX_API_KEY="$(env_presence CODEX_API_KEY)"
  SPIKE4_CTX_ENV_ANTHROPIC_API_KEY="$(env_presence ANTHROPIC_API_KEY)"
  SPIKE4_CTX_ENV_CLAUDE_CODE_OAUTH_TOKEN="$(env_presence CLAUDE_CODE_OAUTH_TOKEN)"
  SPIKE4_CTX_ENV_GH_TOKEN="$(env_presence GH_TOKEN)"
  if [ -t 0 ]; then SPIKE4_CTX_TTY="yes"; else SPIKE4_CTX_TTY="no"; fi
  SPIKE4_CTX_SECURITYSESSIONID_SET="$(env_presence SECURITYSESSIONID)"
  SPIKE4_CTX_WHO="$(clean_field "$("$WHO_BIN" 2>&1)" 1000)"
  SPIKE4_CTX_OS="$("$UNAME_BIN" -s 2>/dev/null)"

  # --- context: platform-specific (always executed, regardless of DRY_RUN:
  # this is free and safe -- no secret is ever printed, only presence/state) ---
  SPIKE4_CTX_MAC_MANAGERNAME="n/a"
  SPIKE4_CTX_MAC_MANAGERPID="n/a"
  SPIKE4_CTX_MAC_MANAGERUID="n/a"
  SPIKE4_CTX_MAC_SCREENLOCK="n/a"
  SPIKE4_CTX_MAC_KEYCHAINS="n/a"
  SPIKE4_CTX_MAC_KEYCHAIN_CLAUDE="n/a"
  SPIKE4_CTX_MAC_KEYCHAIN_CODEX="n/a"
  SPIKE4_CTX_LINUX_XDG_RUNTIME_DIR_SET="n/a"
  SPIKE4_CTX_LINUX_DBUS_SET="n/a"
  SPIKE4_CTX_LINUX_LINGER="n/a"
  SPIKE4_CTX_LINUX_SYSTEMCTL_STATUS="n/a"

  if [ "$SPIKE4_CTX_OS" = "Darwin" ]; then
    SPIKE4_CTX_MAC_MANAGERNAME="$(clean_field "$("$LAUNCHCTL_BIN" managername 2>&1)" 200)"
    SPIKE4_CTX_MAC_MANAGERPID="$(clean_field "$("$LAUNCHCTL_BIN" managerpid 2>&1)" 200)"
    SPIKE4_CTX_MAC_MANAGERUID="$(clean_field "$("$LAUNCHCTL_BIN" manageruid 2>&1)" 200)"

    local ioreg_out
    ioreg_out="$("$IOREG_BIN" -n Root -d1 -a 2>/dev/null)"
    if [ -n "$ioreg_out" ]; then
      # Heuristic (no first-party API for this in a plain shell script):
      # CGSSessionScreenIsLocked is present with <true/> only while the
      # screen is locked; when unlocked the key is typically absent
      # entirely. If ioreg itself failed to produce output, state is
      # "unknown" rather than guessed.
      if printf '%s' "$ioreg_out" | "$GREP_BIN" -A1 "CGSSessionScreenIsLocked" 2>/dev/null | "$GREP_BIN" -q "<true/>" 2>/dev/null; then
        SPIKE4_CTX_MAC_SCREENLOCK="locked"
      else
        SPIKE4_CTX_MAC_SCREENLOCK="unlocked"
      fi
    else
      SPIKE4_CTX_MAC_SCREENLOCK="unknown"
    fi

    SPIKE4_CTX_MAC_KEYCHAINS="$(clean_field "$("$SECURITY_BIN" list-keychains 2>&1 | "$TR_BIN" '\n' ';')" 1000)"

    # A locked login keychain makes `security` wait for an unlock dialog that
    # a scheduler-started process can never answer, so both probes run under
    # the same deadline as every step; "timeout" is recorded as its own state
    # because it is exactly the failure D9 exists to detect. Output goes to a
    # scratch file that is deleted at once: the item's attributes (never the
    # secret -- no -w) are not needed, only the exit code.
    local kc_out="$RUN_DIR/keychain-probe.out" kc_err="$RUN_DIR/keychain-probe.err"
    run_with_deadline 30 "$kc_out" "$kc_err" "$SECURITY_BIN" find-generic-password -s "Claude Code-credentials"
    if [ "$DEADLINE_TIMED_OUT" = "yes" ]; then SPIKE4_CTX_MAC_KEYCHAIN_CLAUDE="timeout"
    elif [ "$DEADLINE_EXIT_CODE" -eq 0 ]; then SPIKE4_CTX_MAC_KEYCHAIN_CLAUDE="yes"
    else SPIKE4_CTX_MAC_KEYCHAIN_CLAUDE="no"; fi
    "$RM_BIN" -f "$kc_out" "$kc_err"

    run_with_deadline 30 "$kc_out" "$kc_err" "$SECURITY_BIN" find-generic-password -s "Codex Auth"
    if [ "$DEADLINE_TIMED_OUT" = "yes" ]; then SPIKE4_CTX_MAC_KEYCHAIN_CODEX="timeout"
    elif [ "$DEADLINE_EXIT_CODE" -eq 0 ]; then SPIKE4_CTX_MAC_KEYCHAIN_CODEX="yes"
    else SPIKE4_CTX_MAC_KEYCHAIN_CODEX="no"; fi
    "$RM_BIN" -f "$kc_out" "$kc_err"

  elif [ "$SPIKE4_CTX_OS" = "Linux" ]; then
    SPIKE4_CTX_LINUX_XDG_RUNTIME_DIR_SET="$(env_presence XDG_RUNTIME_DIR)"
    SPIKE4_CTX_LINUX_DBUS_SET="$(env_presence DBUS_SESSION_BUS_ADDRESS)"

    local linux_user
    linux_user="${USER:-$SPIKE4_CTX_USER}"

    if [ -x "$LOGINCTL_BIN" ] || command -v loginctl >/dev/null 2>&1; then
      SPIKE4_CTX_LINUX_LINGER="$(clean_field "$("$LOGINCTL_BIN" show-user "$linux_user" -p Linger 2>&1)" 200)"
    else
      SPIKE4_CTX_LINUX_LINGER="loginctl not found"
    fi

    if [ -x "$SYSTEMCTL_BIN" ] || command -v systemctl >/dev/null 2>&1; then
      SPIKE4_CTX_LINUX_SYSTEMCTL_STATUS="$(clean_field "$("$SYSTEMCTL_BIN" --user is-system-running 2>&1)" 200)"
    else
      SPIKE4_CTX_LINUX_SYSTEMCTL_STATUS="systemctl not found"
    fi
  fi

  # --- steps S1-S5 (dry-run or not-found are handled inside each step; a
  # crash inside one step function never stops the next since we don't
  # `set -e`) ---
  step_S1
  step_S2
  step_S3
  step_S4
  step_S5

  # --- combine per-CLI verdicts for the one-line summary ---
  SPIKE4_C_CLAUDE="$(combine_verdict "$SPIKE4_S1_VERDICT" "$SPIKE4_S2_VERDICT")"
  SPIKE4_C_CODEX="$(combine_verdict "$SPIKE4_S3_VERDICT" "$SPIKE4_S4_VERDICT")"
  SPIKE4_C_GH="$SPIKE4_S5_VERDICT"

  if [ "$SPIKE4_CTX_OS" = "Darwin" ]; then
    SPIKE4_C_KEYCHAIN_CLAUDE="$SPIKE4_CTX_MAC_KEYCHAIN_CLAUDE"
    SPIKE4_C_KEYCHAIN_CODEX="$SPIKE4_CTX_MAC_KEYCHAIN_CODEX"
    SPIKE4_C_SCREEN="$SPIKE4_CTX_MAC_SCREENLOCK"
    SPIKE4_C_MANAGER="$SPIKE4_CTX_MAC_MANAGERNAME"
  else
    # keychain-* and screen are macOS concepts; on any other platform (or
    # unrecognised uname -s) there is nothing to report but "n/a" -- see
    # README.md for how each label's own platform-appropriate context
    # (Linux block above) carries the equivalent detail instead.
    SPIKE4_C_KEYCHAIN_CLAUDE="n/a"
    SPIKE4_C_KEYCHAIN_CODEX="n/a"
    SPIKE4_C_SCREEN="n/a"
    SPIKE4_C_MANAGER="n/a"
  fi

  SPIKE4_C_SUMMARY_LINE="$(printf 'spike4-d9 %s: claude=%s codex=%s gh=%s keychain-claude=%s keychain-codex=%s screen=%s manager=%s' \
    "$LABEL" "$SPIKE4_C_CLAUDE" "$SPIKE4_C_CODEX" "$SPIKE4_C_GH" \
    "$SPIKE4_C_KEYCHAIN_CLAUDE" "$SPIKE4_C_KEYCHAIN_CODEX" "$SPIKE4_C_SCREEN" "$SPIKE4_C_MANAGER")"

  SPIKE4_CTX_FINISHED_AT="$("$DATE_BIN" -u +"%Y-%m-%dT%H:%M:%SZ")"
  SPIKE4_CTX_GENERATED_AT="$SPIKE4_CTX_FINISHED_AT"

  write_probe_json

  printf '%s\n' "$SPIKE4_C_SUMMARY_LINE"
}

main "$@"
