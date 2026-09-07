#!/bin/bash
# SPIKE-4 D9 -- generates (does NOT enable) a systemd --user service+timer
# pair that fires probe.sh on an interval, for the Linux half of D9.
#
# Two scenarios matter here, and they exercise different things:
#   (A) stay logged in (e.g. over SSH) for the run -- this is close to the
#       macOS user-agent case: a real user session (and its user manager)
#       exists the whole time.
#   (B) enable lingering (`loginctl enable-linger`), then log out of every
#       session entirely and wait -- WITHOUT linger, systemd stops a user's
#       manager instance when their last session ends, and the timer simply
#       does not fire at all while logged out. That non-fire (an absence of
#       any new output directory under SPIKE4_D9_OUT covering the logged-out
#       window) IS the D9 finding for that scenario, not a bug in this
#       harness. On Linux, `codex` keeps `auth.json` under `$CODEX_HOME`
#       (default `~/.codex`) rather than a keyring, so once linger keeps the
#       user manager alive, the Linux question is mainly whether $HOME /
#       CODEX_HOME and PATH are what this unit expects -- see the Environment=
#       lines below and probe.json's context.home / context.codexHome /
#       context.pathReceived fields.
#
# This script never runs systemctl itself. It writes the unit files and
# prints the operator commands.
#
# bash 3.2 compatible; set -uo pipefail, no set -e (see probe.sh for why).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_SH="$SCRIPT_DIR/probe.sh"

SERVICE_NAME="loopmill-spike4-d9.service"
TIMER_NAME="loopmill-spike4-d9.timer"
INTERVAL="${SPIKE4_D9_INTERVAL:-120}"
# systemd timers use OnUnitActiveSec's own time-span syntax rather than raw
# seconds; keep this readable and independent of INTERVAL's numeric unit.
INTERVAL_MIN=$(( (INTERVAL + 59) / 60 ))
[ "$INTERVAL_MIN" -lt 1 ] && INTERVAL_MIN=1

D9_OUT="${SPIKE4_D9_OUT:-$HOME/loopmill-spike4-d9}"
# SPIKE4_D9_UNIT_DIR lets verification runs write into a scratch directory
# instead of the operator's real ~/.config/systemd/user.
UNIT_DIR="${SPIKE4_D9_UNIT_DIR:-$HOME/.config/systemd/user}"
SERVICE_PATH="$UNIT_DIR/$SERVICE_NAME"
TIMER_PATH="$UNIT_DIR/$TIMER_NAME"

mkdir -p "$UNIT_DIR" 2>/dev/null
mkdir -p "$D9_OUT" 2>/dev/null

resolve_for_install() {
  local name="$1" envvar="$2" envval
  envval="${!envvar:-}"
  if [ -n "$envval" ] && [ -x "$envval" ]; then
    printf '%s' "$envval"
    return 0
  fi
  local found
  found="$(command -v "$name" 2>/dev/null)"
  if [ -n "$found" ] && [ -x "$found" ]; then
    printf '%s' "$found"
    return 0
  fi
  local dirs d
  dirs=("$HOME/.local/bin" "/opt/homebrew/bin" "/usr/local/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin")
  for d in "${dirs[@]}"; do
    if [ -x "$d/$name" ]; then
      printf '%s' "$d/$name"
      return 0
    fi
  done
  printf 'not-found'
}

CLAUDE_BIN="$(resolve_for_install claude SPIKE4_CLAUDE_BIN)"
CODEX_BIN="$(resolve_for_install codex SPIKE4_CODEX_BIN)"
GH_BIN="$(resolve_for_install gh SPIKE4_GH_BIN)"
NODE_BIN="$(resolve_for_install node SPIKE4_NODE_BIN)"

UNIT_PATH_VALUE=""
add_dir_once() {
  local d="$1"
  case ":$UNIT_PATH_VALUE:" in
    *":$d:"*) return 0 ;;
  esac
  if [ -z "$UNIT_PATH_VALUE" ]; then
    UNIT_PATH_VALUE="$d"
  else
    UNIT_PATH_VALUE="$UNIT_PATH_VALUE:$d"
  fi
}
for b in "$CLAUDE_BIN" "$CODEX_BIN" "$GH_BIN" "$NODE_BIN"; do
  if [ "$b" != "not-found" ]; then
    add_dir_once "$(dirname "$b")"
  fi
done
add_dir_once "/usr/local/bin"
add_dir_once "/usr/bin"
add_dir_once "/bin"

cat >"$SERVICE_PATH" <<UNIT
[Unit]
Description=Loopmill SPIKE-4 D9 probe (systemd --user timer)

[Service]
Type=oneshot
ExecStart=/bin/bash ${PROBE_SH} systemd-timer
Environment=PATH=${UNIT_PATH_VALUE}
Environment=SPIKE4_D9_OUT=${D9_OUT}
UNIT

cat >"$TIMER_PATH" <<UNIT
[Unit]
Description=Loopmill SPIKE-4 D9 probe timer

[Timer]
OnBootSec=1min
OnUnitActiveSec=${INTERVAL_MIN}min
Persistent=true
Unit=${SERVICE_NAME}

[Install]
WantedBy=timers.target
UNIT

echo "Wrote: $SERVICE_PATH"
echo
cat "$SERVICE_PATH"
echo
echo "Wrote: $TIMER_PATH"
echo
cat "$TIMER_PATH"
echo
echo "# ---------------------------------------------------------------------------"
echo "# Operator procedure (run these BY HAND -- this script does not enable the"
echo "# timer itself):"
echo "# ---------------------------------------------------------------------------"
echo
echo "systemctl --user daemon-reload"
echo "systemctl --user enable --now $TIMER_NAME"
echo "systemctl --user list-timers"
echo
echo "# Scenario A: stay logged in (e.g. over SSH) for at least $((INTERVAL_MIN * 2)) minutes"
echo "#   (two fires), then read \$SPIKE4_D9_OUT/systemd-timer-*/probe.json."
echo "#"
echo "# Scenario B: log out entirely and see whether the timer still fires --"
echo "# without linger it will NOT (systemd stops a user's manager instance when"
echo "# their last session ends, so the timer simply never fires while logged"
echo "# out -- that non-fire IS the D9 finding for this scenario):"
echo "loginctl enable-linger \$USER"
echo "# now log out of every session (close every SSH connection / console) and"
echo "# wait at least $((INTERVAL_MIN * 2)) minutes, then log back in"
echo
echo "# Teardown:"
echo "systemctl --user disable --now $TIMER_NAME"
