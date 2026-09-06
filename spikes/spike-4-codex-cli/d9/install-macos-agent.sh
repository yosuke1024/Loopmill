#!/bin/bash
# SPIKE-4 D9 -- generates (does NOT load) a macOS launchd USER AGENT that
# fires probe.sh on an interval. This is the harness for the "locked
# screen, but a real login session exists" half of D9 (see README.md in
# this directory): a user agent runs inside the user's GUI login session,
# so it measures whether THAT session's login keychain is reachable once
# the screen is locked -- not whether a login session exists at all (that
# is install-macos-daemon.sh, a different mechanism entirely).
#
# This script only ever WRITES the plist and prints the commands the
# operator must run by hand; it never calls launchctl itself.
#
# bash 3.2 compatible; set -uo pipefail, no set -e (see probe.sh for why).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_SH="$SCRIPT_DIR/probe.sh"

LABEL="com.loopmill.spike4-d9"
INTERVAL="${SPIKE4_D9_INTERVAL:-120}"
D9_OUT="${SPIKE4_D9_OUT:-$HOME/loopmill-spike4-d9}"
# SPIKE4_D9_PLIST_DIR lets verification runs write into a scratch directory
# instead of the operator's real ~/Library/LaunchAgents.
PLIST_DIR="${SPIKE4_D9_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="$PLIST_DIR/${LABEL}.plist"

mkdir -p "$PLIST_DIR" 2>/dev/null

# Resolve claude/codex/gh/node the same way probe.sh does (env override,
# then PATH, then a fixed candidate list) so the plist's PATH is built from
# whatever this install run actually found -- if that differs from what
# probe.sh finds when launchd runs it, THAT mismatch is itself a D9 finding
# probe.json's binaries.* block will show.
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

# Build a deduplicated PATH from the directories containing whichever of
# those four resolved (skipping "not-found"), plus the standard system
# dirs. Order: discovered dirs first (so the resolved binaries are found by
# a bare name too, in case something under the hood shells out to them by
# name), then the system dirs.
PLIST_PATH_VALUE=""
add_dir_once() {
  local d="$1"
  case ":$PLIST_PATH_VALUE:" in
    *":$d:"*) return 0 ;;
  esac
  if [ -z "$PLIST_PATH_VALUE" ]; then
    PLIST_PATH_VALUE="$d"
  else
    PLIST_PATH_VALUE="$PLIST_PATH_VALUE:$d"
  fi
}
for b in "$CLAUDE_BIN" "$CODEX_BIN" "$GH_BIN" "$NODE_BIN"; do
  if [ "$b" != "not-found" ]; then
    add_dir_once "$(dirname "$b")"
  fi
done
add_dir_once "/usr/bin"
add_dir_once "/bin"
add_dir_once "/usr/sbin"
add_dir_once "/sbin"

OUT_LOG="$D9_OUT/launchd-agent.out.log"
ERR_LOG="$D9_OUT/launchd-agent.err.log"
mkdir -p "$D9_OUT" 2>/dev/null

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PROBE_SH}</string>
        <string>launchd-agent</string>
    </array>
    <key>StartInterval</key>
    <integer>${INTERVAL}</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${OUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${ERR_LOG}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PLIST_PATH_VALUE}</string>
        <key>SPIKE4_D9_OUT</key>
        <string>${D9_OUT}</string>
    </dict>
</dict>
</plist>
PLIST

echo "Wrote: $PLIST_PATH"
echo
cat "$PLIST_PATH"
echo
echo "# ---------------------------------------------------------------------------"
echo "# Operator procedure (run these BY HAND -- this script does not load the"
echo "# agent itself). The label 'launchd-agent' covers BOTH the locked-screen"
echo "# case and the baseline: the run right after bootstrap likely still sees an"
echo "# unlocked screen (that fire is the baseline, not the measurement); lock the"
echo "# screen immediately after bootstrap and the SECOND fire (StartInterval"
echo "# seconds later) is the one that actually measures a locked-screen agent."
echo "# Compare probe.json's context.macos.screenLockState across the label's"
echo "# multiple output directories to tell the two fires apart."
echo "# ---------------------------------------------------------------------------"
echo
echo "launchctl bootstrap gui/\$(id -u) $PLIST_PATH"
echo "launchctl print gui/\$(id -u)/${LABEL} | head"
echo "# now lock the screen (Control-Command-Q) and leave the Mac alone for at"
echo "# least $((INTERVAL * 2)) seconds (two fires)"
echo "launchctl bootout gui/\$(id -u)/${LABEL}"
echo "ls $D9_OUT/"
