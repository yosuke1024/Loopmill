#!/usr/bin/env bash
# SPIKE-1: Claude Code CLI on a GitHub-hosted runner, authenticated ONLY with a
# Claude subscription OAuth token (claude setup-token), no API key.
#
# Every check below is isolated: a failure or crash in one check must never
# stop the others from running. We deliberately do NOT use `set -e` for this
# reason -- each check function traps its own command's exit status and keeps
# going. `set -u` catches unset-variable bugs in this script itself; every
# variable that depends on external output is defaulted before use.
#
# Outputs: everything is written under out/ next to this script:
#   out/RESULTS.md         human-readable summary table (also the run report)
#   out/<check>.json        redacted raw stdout of the check's claude invocation
#   out/<check>.err         redacted raw stderr
#   out/<check>.code         the claude process's exit code
#   out/<check>.summary.json  a compact, parsed summary of the result (when applicable)
#
# Dry run: SPIKE_DRY_RUN=1 bash run.sh prints every command this script would
# run (with a fully-formed argv) instead of executing it, and still produces a
# RESULTS.md so the report structure can be reviewed without spending tokens
# or requiring a logged-in claude binary.
set -uo pipefail

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
RESULTS_MD="$OUT_DIR/RESULTS.md"

mkdir -p "$OUT_DIR"

DRY_RUN="${SPIKE_DRY_RUN:-0}"
SCRUB_TEST="${SCRUB_TEST:-true}"
MODEL="${MODEL:-}"

MODEL_ARGS=()
if [ -n "$MODEL" ]; then
  MODEL_ARGS=(--model "$MODEL")
fi

# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

# Redact anything that looks like a Claude API key or OAuth token from any
# output we persist. Applied to every file this script writes under out/.
redact() {
  sed -E \
    -e 's/sk-ant-[A-Za-z0-9_-]{6,}/sk-ant-***REDACTED***/g' \
    -e 's/oat01-?[A-Za-z0-9_-]{6,}/oat01-***REDACTED***/g' \
    -e 's/(Bearer )[A-Za-z0-9._-]{20,}/\1***REDACTED***/g'
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

# run_and_finalize <id> <argv...>
# Runs argv with stdin from /dev/null, captures stdout/stderr/exit code,
# redacts, and writes out/<id>.json, out/<id>.err, out/<id>.code.
# Returns the command's exit code.
run_and_finalize() {
  local id="$1"; shift
  local raw_out="$OUT_DIR/${id}.out.raw"
  local raw_err="$OUT_DIR/${id}.err.raw"
  local codefile="$OUT_DIR/${id}.code"

  "$@" >"$raw_out" 2>"$raw_err" < /dev/null
  local code=$?

  echo "$code" > "$codefile"
  redact < "$raw_out" > "$OUT_DIR/${id}.json"
  redact < "$raw_err" > "$OUT_DIR/${id}.err"
  rm -f "$raw_out" "$raw_err"
  return "$code"
}

# jget <json-file> <dotted.path>
# Minimal JSON field accessor (Node is guaranteed present: it's a prerequisite
# for installing @anthropic-ai/claude-code in the first place). Prints an
# empty string on any parse/lookup failure, never errors out.
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

# gen_summary <raw-json-file> <summary-json-file>
# Parses a claude --output-format json result object into a small, stable
# summary (or records a parse failure) and redacts it before writing.
gen_summary() {
  local json_file="$1" summary_file="$2"
  local tmp="$summary_file.tmp"
  node -e '
    const fs = require("fs");
    let out;
    try {
      const raw = fs.readFileSync(process.argv[1], "utf8").trim();
      const d = JSON.parse(raw);
      out = {
        parse_ok: true,
        type: d.type,
        subtype: d.subtype,
        is_error: d.is_error,
        result: typeof d.result === "string" ? d.result.slice(0, 300) : d.result,
        num_turns: d.num_turns,
        duration_ms: d.duration_ms,
        duration_api_ms: d.duration_api_ms,
        total_cost_usd: d.total_cost_usd,
        session_id: d.session_id,
        usage: d.usage,
        modelUsage: d.modelUsage,
        structured_output: d.structured_output,
        permission_denials: d.permission_denials,
        errors: d.errors,
        stop_reason: d.stop_reason
      };
    } catch (e) {
      out = { parse_ok: false, parse_error: String((e && e.message) || e) };
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
  ' "$json_file" "$tmp" 2>/dev/null
  if [ -f "$tmp" ]; then
    redact < "$tmp" > "$summary_file"
    rm -f "$tmp"
  else
    echo '{"parse_ok":false,"parse_error":"gen_summary produced no output"}' > "$summary_file"
  fi
}

# stream_summary <ndjson-file> <summary-json-file>
# Parses a claude --output-format stream-json transcript: the sequence of
# message types, the assistant-message count, and the terminal result's
# usage/cost, if present.
stream_summary() {
  local ndjson_file="$1" summary_file="$2"
  local tmp="$summary_file.tmp"
  node -e '
    const fs = require("fs");
    let out;
    try {
      const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(l => l.trim().length > 0);
      const types = [];
      let assistantCount = 0;
      let finalResult = null;
      let parseErrors = 0;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          types.push(obj.type + (obj.subtype ? (":" + obj.subtype) : ""));
          if (obj.type === "assistant") assistantCount++;
          if (obj.type === "result") finalResult = obj;
        } catch (e) {
          parseErrors++;
          types.push("PARSE_ERROR");
        }
      }
      out = {
        parse_ok: true,
        line_count: lines.length,
        parse_errors: parseErrors,
        type_sequence: types,
        assistant_message_count: assistantCount,
        final_result: finalResult ? {
          subtype: finalResult.subtype,
          is_error: finalResult.is_error,
          num_turns: finalResult.num_turns,
          total_cost_usd: finalResult.total_cost_usd,
          usage: finalResult.usage,
          modelUsage: finalResult.modelUsage,
          session_id: finalResult.session_id
        } : null
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

# ---------------------------------------------------------------------------
# C1: auth status
# ---------------------------------------------------------------------------
check_C1() {
  local id="C1" desc="claude auth status --json (subscription OAuth probe)"
  local cmd=(claude auth status --json)

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}")"
    return 0
  fi

  run_and_finalize "$id" "${cmd[@]}"
  local code=$?

  local logged_in auth_method api_provider
  logged_in=$(jget "$OUT_DIR/${id}.json" "loggedIn")
  auth_method=$(jget "$OUT_DIR/${id}.json" "authMethod")
  api_provider=$(jget "$OUT_DIR/${id}.json" "apiProvider")

  local status="FAIL"
  if [ "$code" = "0" ] && [ "$logged_in" = "true" ]; then
    status="PASS"
  fi

  append_row "$id" "$desc" "$status" \
    "exit=$code loggedIn=$logged_in authMethod=$auth_method apiProvider=$api_provider (see C1.json)"
}

# ---------------------------------------------------------------------------
# C2: plain prompt, --output-format json
# ---------------------------------------------------------------------------
check_C2() {
  local id="C2" desc="claude -p plain prompt, --output-format json, no TTY"
  local cmd=(claude -p "Reply with exactly: LOOPMILL-OK" \
    --output-format json --max-turns 1 \
    --permission-mode plan --permission-prompts none)
  cmd+=("${MODEL_ARGS[@]}")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  run_and_finalize "$id" "${cmd[@]}"
  local code=$?
  gen_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"

  local subtype result
  subtype=$(jget "$OUT_DIR/${id}.summary.json" "subtype")
  result=$(jget "$OUT_DIR/${id}.summary.json" "result")

  local status="FAIL"
  if [ "$code" = "0" ] && [ "$subtype" = "success" ] && [[ "$result" == *"LOOPMILL-OK"* ]]; then
    status="PASS"
  fi

  append_row "$id" "$desc" "$status" \
    "exit=$code subtype=$subtype result=\"$result\" (see C2.summary.json)"
}

# ---------------------------------------------------------------------------
# C3: structured output via --json-schema
# ---------------------------------------------------------------------------
check_C3() {
  local id="C3" desc="claude -p --json-schema structured output"
  local schema='{"type":"object","properties":{"verdict":{"type":"string","enum":["pass","fail"]},"reason":{"type":"string"}},"required":["verdict","reason"]}'
  local prompt="Evaluate this claim: '1 + 1 = 2'. It is true. Respond with a structured verdict of pass and a one-sentence reason."
  local cmd=(claude -p "$prompt" \
    --output-format json --max-turns 1 \
    --permission-mode plan --permission-prompts none \
    --json-schema "$schema")
  cmd+=("${MODEL_ARGS[@]}")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  run_and_finalize "$id" "${cmd[@]}"
  local code=$?
  gen_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"

  local subtype verdict reason validates
  subtype=$(jget "$OUT_DIR/${id}.summary.json" "subtype")
  verdict=$(jget "$OUT_DIR/${id}.summary.json" "structured_output.verdict")
  reason=$(jget "$OUT_DIR/${id}.summary.json" "structured_output.reason")

  validates="no"
  if [ "$verdict" = "pass" ] || [ "$verdict" = "fail" ]; then
    if [ -n "$reason" ]; then
      validates="yes"
    fi
  fi

  local status="FAIL"
  if [ "$code" = "0" ] && [ "$subtype" = "success" ] && [ "$validates" = "yes" ]; then
    status="PASS"
  fi

  append_row "$id" "$desc" "$status" \
    "exit=$code subtype=$subtype verdict=$verdict validates=$validates (see C3.summary.json)"
}

# ---------------------------------------------------------------------------
# C4: stream-json
# ---------------------------------------------------------------------------
check_C4() {
  local id="C4" desc="claude -p --output-format stream-json --verbose"
  local cmd=(claude -p "Reply with exactly: LOOPMILL-OK" \
    --output-format stream-json --verbose --max-turns 1 \
    --permission-mode plan --permission-prompts none)
  cmd+=("${MODEL_ARGS[@]}")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  run_and_finalize "$id" "${cmd[@]}"
  local code=$?
  stream_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"

  local line_count assistant_count final_subtype
  line_count=$(jget "$OUT_DIR/${id}.summary.json" "line_count")
  assistant_count=$(jget "$OUT_DIR/${id}.summary.json" "assistant_message_count")
  final_subtype=$(jget "$OUT_DIR/${id}.summary.json" "final_result.subtype")

  local status="FAIL"
  if [ "$code" = "0" ] && [ "$final_subtype" = "success" ] && [ -n "$assistant_count" ] && [ "$assistant_count" -ge 1 ] 2>/dev/null; then
    status="PASS"
  fi

  append_row "$id" "$desc" "$status" \
    "exit=$code lines=$line_count assistant_msgs=$assistant_count final_subtype=$final_subtype (see C4.summary.json)"
}

# ---------------------------------------------------------------------------
# C5: exit-code contract
# ---------------------------------------------------------------------------

# C5a: a tool-requiring prompt under --max-turns 1
check_C5a() {
  local id="C5a" desc="tool-using prompt, --max-turns 1, acceptEdits/none (exit-code contract)"
  local prompt="List the files in this directory using a shell command and then say done."
  local cmd=(claude -p "$prompt" \
    --output-format json --max-turns 1 \
    --permission-mode acceptEdits --permission-prompts none)
  cmd+=("${MODEL_ARGS[@]}")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "(in a temp dir) $(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  local tmpd
  tmpd=$(mktemp -d)
  (cd "$tmpd" && run_and_finalize "$id" "${cmd[@]}")
  local code=$?
  rm -rf "$tmpd"

  gen_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"
  local subtype
  subtype=$(jget "$OUT_DIR/${id}.summary.json" "subtype")

  local status="INFO"
  local note="unexpected subtype"
  if [ "$subtype" = "success" ] || [ "$subtype" = "error_max_turns" ]; then
    note="expected subtype"
  fi

  append_row "$id" "$desc" "$status" \
    "exit=$code subtype=$subtype ($note) (see C5a.summary.json)"
}

# C5b: deliberately-invalid --model
check_C5b() {
  local id="C5b" desc="deliberately invalid --model (exit-code contract)"
  local cmd=(claude -p "Say hi" \
    --output-format json --max-turns 1 \
    --model "loopmill-spike-invalid-model-name" \
    --permission-mode plan --permission-prompts none)

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  run_and_finalize "$id" "${cmd[@]}"
  local code=$?

  local status="FAIL"
  if [ "$code" != "0" ]; then
    status="PASS"
  fi

  local stderr_snippet
  stderr_snippet=$(head -c 300 "$OUT_DIR/${id}.err" 2>/dev/null | tr '\n' ' ')

  append_row "$id" "$desc" "$status" \
    "exit=$code stderr=\"$stderr_snippet\" (see C5b.err)"
}

# ---------------------------------------------------------------------------
# C6: signal handling (cancel semantics)
# ---------------------------------------------------------------------------

# check_C6_bg <variant> <signal-name> -- launches claude in the background,
# waits 8s, sends the signal, and records timing + whether a final result
# with usage was captured.
check_C6_bg() {
  local variant="$1" signal="$2"
  local id="C6-${variant}"
  local desc="signal handling: background + ${signal} after 8s"
  local prompt="Count slowly from 1 to 200, one number per line, thinking carefully between numbers."
  local cmd=(claude -p "$prompt" \
    --output-format json --max-turns 20 \
    --permission-mode plan --permission-prompts none)
  cmd+=("${MODEL_ARGS[@]}")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null & sleep 8; kill -s $signal \$!"
    return 0
  fi

  local raw_out="$OUT_DIR/${id}.out.raw"
  local raw_err="$OUT_DIR/${id}.err.raw"
  : > "$raw_out"; : > "$raw_err"

  local start end elapsed
  start=$(date +%s.%N)
  "${cmd[@]}" >"$raw_out" 2>"$raw_err" < /dev/null &
  local pid=$!
  sleep 8
  kill -s "$signal" "$pid" 2>/dev/null
  wait "$pid"
  local code=$?
  end=$(date +%s.%N)
  elapsed=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.2f", b - a }' 2>/dev/null || echo "?")

  echo "$code" > "$OUT_DIR/${id}.code"
  redact < "$raw_out" > "$OUT_DIR/${id}.json"
  redact < "$raw_err" > "$OUT_DIR/${id}.err"
  rm -f "$raw_out" "$raw_err"

  gen_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"
  local parse_ok has_usage
  parse_ok=$(jget "$OUT_DIR/${id}.summary.json" "parse_ok")
  has_usage="no"
  if [ "$parse_ok" = "true" ]; then
    local usage_present
    usage_present=$(jget "$OUT_DIR/${id}.summary.json" "usage")
    [ -n "$usage_present" ] && has_usage="yes"
  fi

  # Documented expectation (research brief, fact #18):
  #   SIGINT  -> turn ends cleanly, a final result WITH usage is recorded.
  #   SIGTERM -> exit 143, turn left unfinished, NO result recorded.
  local status="INFO"
  case "$signal" in
    INT)
      if [ "$has_usage" = "yes" ]; then status="PASS"; else status="FAIL"; fi
      ;;
    TERM)
      if [ "$code" = "143" ] && [ "$has_usage" = "no" ]; then status="PASS"; else status="FAIL"; fi
      ;;
  esac

  append_row "$id" "$desc" "$status" \
    "exit=$code elapsed=${elapsed}s result_parsed=$parse_ok has_usage=$has_usage (see C6-${variant}.summary.json)"
}

# check_C6_timeout_int: `timeout -s INT 8 claude ...` as specified
check_C6_timeout_int() {
  local id="C6-timeoutint"
  local desc="signal handling: timeout -s INT 8 (coreutils wrapper)"
  local prompt="Count slowly from 1 to 200, one number per line, thinking carefully between numbers."
  local cmd=(timeout -s INT 8 claude -p "$prompt" \
    --output-format json --max-turns 20 \
    --permission-mode plan --permission-prompts none)
  cmd+=("${MODEL_ARGS[@]}")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  local start end elapsed
  start=$(date +%s.%N)
  run_and_finalize "$id" "${cmd[@]}"
  local code=$?
  end=$(date +%s.%N)
  elapsed=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.2f", b - a }' 2>/dev/null || echo "?")

  gen_summary "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.summary.json"
  local parse_ok has_usage
  parse_ok=$(jget "$OUT_DIR/${id}.summary.json" "parse_ok")
  has_usage="no"
  if [ "$parse_ok" = "true" ]; then
    local usage_present
    usage_present=$(jget "$OUT_DIR/${id}.summary.json" "usage")
    [ -n "$usage_present" ] && has_usage="yes"
  fi

  # `timeout` (without --preserve-status) reports 124 for a timeout it had to
  # act on, regardless of the underlying process's own exit code -- this is
  # informational, not a pass/fail on claude's own contract (see C6-sigint
  # above for the code-based check). Note: 124 means SIGINT was sent, not
  # that the process hung -- see C7 for the actual hang probe.
  append_row "$id" "$desc" "INFO" \
    "timeout_exit=$code elapsed=${elapsed}s result_parsed=$parse_ok has_usage=$has_usage (see C6-timeoutint.summary.json; note: coreutils timeout returns 124 on its own timeout regardless of the child's response to the signal, unless --preserve-status is used)"
}

# ---------------------------------------------------------------------------
# C7: no-TTY hang probe (anthropics/claude-code#9026)
# ---------------------------------------------------------------------------
check_C7() {
  local id="C7" desc="no-TTY hang probe: setsid + stdin from /dev/null, 120s watchdog"
  local prompt="Reply with exactly: LOOPMILL-OK"
  local have_setsid="yes"
  command -v setsid >/dev/null 2>&1 || have_setsid="no"

  local inner_cmd=(claude -p "$prompt" \
    --output-format json --max-turns 1 \
    --permission-mode plan --permission-prompts none)
  inner_cmd+=("${MODEL_ARGS[@]}")

  local cmd
  if [ "$have_setsid" = "yes" ]; then
    cmd=(timeout 120 setsid "${inner_cmd[@]}")
  else
    cmd=(timeout 120 "${inner_cmd[@]}")
  fi

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null (setsid available: $have_setsid)"
    return 0
  fi

  local start end elapsed
  start=$(date +%s.%N)
  run_and_finalize "$id" "${cmd[@]}"
  local code=$?
  end=$(date +%s.%N)
  elapsed=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.2f", b - a }' 2>/dev/null || echo "?")

  local status="PASS" hang="no"
  if [ "$code" = "124" ]; then
    status="FAIL"
    hang="yes (watchdog fired -- matches anthropics/claude-code#9026)"
  fi

  append_row "$id" "$desc" "$status" \
    "exit=$code elapsed=${elapsed}s hang=$hang setsid_available=$have_setsid (see C7.json/.err)"
}

# ---------------------------------------------------------------------------
# C8: scrub precedence (ANTHROPIC_API_KEY vs CLAUDE_CODE_OAUTH_TOKEN)
# ---------------------------------------------------------------------------
check_C8() {
  local id_bad="C8-bad" id_good="C8-good"
  local desc_bad="ANTHROPIC_API_KEY (invalid) exported alongside OAuth token"
  local desc_good="confirm OAuth-only run still passes without the API key"

  if [ "$SCRUB_TEST" != "true" ] && [ "$SCRUB_TEST" != "1" ]; then
    append_row "$id_bad" "$desc_bad" "SKIPPED" "scrub_test workflow input was disabled"
    append_row "$id_good" "$desc_good" "SKIPPED" "scrub_test workflow input was disabled"
    return 0
  fi

  local prompt="Reply with exactly: LOOPMILL-OK"
  local cmd=(claude -p "$prompt" \
    --output-format json --max-turns 1 \
    --permission-mode plan --permission-prompts none)
  cmd+=("${MODEL_ARGS[@]}")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id_bad" "$desc_bad" "ANTHROPIC_API_KEY=sk-ant-invalid-spike-*** $(show_argv "${cmd[@]}") < /dev/null"
    dry_row "$id_good" "$desc_good" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  # (bad) invalid API key exported alongside the OAuth token: precedence
  # (research fact #43/#44) says ANTHROPIC_API_KEY always wins in -p mode, so
  # this run is EXPECTED to fail with an authentication error.
  ANTHROPIC_API_KEY="sk-ant-invalid-spike-0000000000000000000000000000" \
    run_and_finalize "$id_bad" "${cmd[@]}"
  local code_bad=$?
  gen_summary "$OUT_DIR/${id_bad}.json" "$OUT_DIR/${id_bad}.summary.json"
  local subtype_bad
  subtype_bad=$(jget "$OUT_DIR/${id_bad}.summary.json" "subtype")
  local stderr_bad
  stderr_bad=$(head -c 300 "$OUT_DIR/${id_bad}.err" 2>/dev/null | tr '\n' ' ')

  local status_bad="FAIL"
  if [ "$code_bad" != "0" ] || [ "$subtype_bad" != "success" ]; then
    status_bad="PASS"
  fi
  append_row "$id_bad" "$desc_bad" "$status_bad" \
    "exit=$code_bad subtype=$subtype_bad stderr=\"$stderr_bad\" (expected: failure, proving API-key precedence; see C8-bad.summary.json)"

  # (good) re-run C2's exact shape without the bad key to confirm the
  # OAuth-only path is unaffected by the previous (isolated) export.
  run_and_finalize "$id_good" "${cmd[@]}"
  local code_good=$?
  gen_summary "$OUT_DIR/${id_good}.json" "$OUT_DIR/${id_good}.summary.json"
  local subtype_good
  subtype_good=$(jget "$OUT_DIR/${id_good}.summary.json" "subtype")

  local status_good="FAIL"
  if [ "$code_good" = "0" ] && [ "$subtype_good" = "success" ]; then
    status_good="PASS"
  fi
  append_row "$id_good" "$desc_good" "$status_good" \
    "exit=$code_good subtype=$subtype_good (see C8-good.summary.json)"
}

# ---------------------------------------------------------------------------
# C9: quota probe (informational)
# ---------------------------------------------------------------------------
check_C9() {
  local id="C9" desc="quota probe: grep for a plan-limit message (informational)"
  local cmd=(claude -p "Say OK" --output-format json --max-turns 1)
  cmd+=("${MODEL_ARGS[@]}")

  if [ "$DRY_RUN" = "1" ]; then
    dry_row "$id" "$desc" "$(show_argv "${cmd[@]}") < /dev/null"
    return 0
  fi

  run_and_finalize "$id" "${cmd[@]}"
  local code=$?

  local hit="no"
  if grep -qi "hit your" "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.err" 2>/dev/null; then
    hit="yes"
  elif grep -qi "limit" "$OUT_DIR/${id}.json" "$OUT_DIR/${id}.err" 2>/dev/null; then
    hit="maybe (matched generic 'limit', see files)"
  fi

  append_row "$id" "$desc" "INFO" \
    "exit=$code quota_message_seen=$hit (see C9.json/.err; a hit is informational, not a failure of this spike)"
}

# ---------------------------------------------------------------------------
# C10: environment record
# ---------------------------------------------------------------------------
check_C10() {
  local id="C10" desc="environment record (node/claude versions, uname, TTY, config)"

  local tty="no"
  if [ -t 0 ]; then tty="yes"; fi

  local node_version claude_version uname_a
  node_version=$(node --version 2>&1 || echo "unavailable")
  claude_version=$(claude --version 2>&1 || echo "unavailable")
  uname_a=$(uname -a 2>&1 || echo "unavailable")

  node -e '
    const out = {
      node_version: process.argv[1],
      claude_version: process.argv[2],
      uname: process.argv[3],
      tty_stdin: process.argv[4],
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || "<unset>",
      HOME: process.env.HOME || "<unset>",
      PATH: process.env.PATH || "<unset>"
    };
    console.log(JSON.stringify(out, null, 2));
  ' "$node_version" "$claude_version" "$uname_a" "$tty" > "$OUT_DIR/${id}.out.raw" 2>"$OUT_DIR/${id}.err.raw"
  echo 0 > "$OUT_DIR/${id}.code"
  redact < "$OUT_DIR/${id}.out.raw" > "$OUT_DIR/${id}.json"
  redact < "$OUT_DIR/${id}.err.raw" > "$OUT_DIR/${id}.err"
  rm -f "$OUT_DIR/${id}.out.raw" "$OUT_DIR/${id}.err.raw"

  append_row "$id" "$desc" "INFO" \
    "node=$node_version claude=$claude_version tty=$tty (see C10.json)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

init_results() {
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
  {
    echo "# SPIKE-1 Results"
    echo
    echo "Claude Code on a GitHub-hosted runner authenticated ONLY with a Claude"
    echo "subscription OAuth token (\`claude setup-token\`), no API key."
    echo
    echo "- Generated: $now"
    echo "- Dry run: $([ "$DRY_RUN" = "1" ] && echo "yes" || echo "no")"
    echo "- scrub_test input: $SCRUB_TEST"
    echo "- model override: $([ -n "$MODEL" ] && echo "$MODEL" || echo "(account default)")"
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
    echo "- \`PASS\`: behavior matched what this spike expected / documented."
    echo "- \`FAIL\`: behavior diverged from what this spike expected / documented -- read the details column and the linked files."
    echo "- \`INFO\`: observational only; there is no single correct outcome (e.g. C5, C9, C10)."
    echo "- \`SKIPPED\`: the check was intentionally not run (e.g. C8 with \`scrub_test: false\`)."
    echo "- \`DRY-RUN\`: SPIKE_DRY_RUN=1 -- the command was printed, not executed."
    echo
    echo "See README.md in this directory for what each check (C1-C10) proves for Loopmill's design."
  } >> "$RESULTS_MD"
}

main() {
  init_results

  check_C1
  check_C2
  check_C3
  check_C4
  check_C5a
  check_C5b
  check_C6_bg sigint INT
  check_C6_bg sigterm TERM
  check_C6_timeout_int
  check_C7
  check_C8
  check_C9
  check_C10

  finalize_results

  echo "Done. See $RESULTS_MD"
}

main "$@"
