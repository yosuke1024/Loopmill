#!/bin/bash
# SPIKE-4 D9 -- generates a macOS launchd SYSTEM DAEMON plist for the "no
# login session at all" case: a LaunchDaemon runs outside any GUI session
# (root's launchd, not a user's), so its login keychain is EXPECTED to be
# locked/unavailable even for the correct user, and CODEX_HOME/PATH may not
# be what an interactive shell would see either. Whatever probe.json's
# keychain-* fields and step verdicts show for this label IS the D9 answer
# for "no session at all" -- that is exactly what this daemon measures.
#
# This script never runs sudo itself. It stages the plist under /tmp (or
# SPIKE4_D9_PLIST_DIR, for verification runs that should not touch the real
# /Library/LaunchDaemons) and prints every privileged command the operator
# must run by hand to install, exercise and remove it.
#
# bash 3.2 compatible; set -uo pipefail, no set -e (see probe.sh for why).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_SH="$SCRIPT_DIR/probe.sh"

LABEL="com.loopmill.spike4-d9-daemon"
INTERVAL="${SPIKE4_D9_INTERVAL:-120}"
D9_OUT="${SPIKE4_D9_OUT:-$HOME/loopmill-spike4-d9}"
CURRENT_USER="$(id -un 2>/dev/null || echo "$USER")"

# SPIKE4_D9_PLIST_DIR lets verification runs stage the plist into a scratch
# directory instead of /tmp. The REAL destination is always
# /Library/LaunchDaemons -- a system daemon plist there must be owned by
# root:wheel and mode 644, which is why this script only prints the `sudo`
# commands rather than performing them.
STAGE_DIR="${SPIKE4_D9_PLIST_DIR:-/tmp}"
STAGE_PATH="$STAGE_DIR/${LABEL}.plist"
FINAL_PATH="/Library/LaunchDaemons/${LABEL}.plist"

mkdir -p "$STAGE_DIR" 2>/dev/null

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

OUT_LOG="$D9_OUT/launchd-daemon.out.log"
ERR_LOG="$D9_OUT/launchd-daemon.err.log"
mkdir -p "$D9_OUT" 2>/dev/null

# launchd does not necessarily hand a daemon the user's HOME, and both CLIs
# locate their state through it (~/.claude, ~/.codex). The first run measures
# the bare default; SPIKE4_D9_INJECT_HOME=1 generates a second variant with
# HOME set explicitly, which separates "no HOME" from "no keychain" in the
# results -- the two failures need different doctor checks.
HOME_ENTRY=""
if [ "${SPIKE4_D9_INJECT_HOME:-0}" = "1" ]; then
  HOME_ENTRY="
        <key>HOME</key>
        <string>${HOME}</string>"
fi

cat >"$STAGE_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>UserName</key>
    <string>${CURRENT_USER}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PROBE_SH}</string>
        <string>launchd-daemon</string>
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
        <string>${D9_OUT}</string>${HOME_ENTRY}
    </dict>
</dict>
</plist>
PLIST

echo "Wrote (staged): $STAGE_PATH"
echo
cat "$STAGE_PATH"
echo
echo "# ---------------------------------------------------------------------------"
echo "# A LaunchDaemon runs as root's launchd, entirely outside any GUI login"
echo "# session -- UserName just changes which uid the probe process runs as,"
echo "# it does NOT put that user's login keychain, GUI session, or Codex/gh"
echo "# credential store within reach the way a user agent (install-macos-agent.sh)"
echo "# does. The login keychain is expected to be LOCKED here; probe.json's"
echo "# keychain-claude / keychain-codex fields and the S1/S3 step verdicts for"
echo "# the 'launchd-daemon' label are exactly what this measures."
echo "#"
echo "# This script never ran sudo. Run these BY HAND, in order:"
echo "# ---------------------------------------------------------------------------"
echo
echo "sudo cp $STAGE_PATH $FINAL_PATH"
echo "sudo chown root:wheel $FINAL_PATH"
echo "sudo chmod 644 $FINAL_PATH"
echo "sudo launchctl bootstrap system $FINAL_PATH"
echo "# now log out of the Mac entirely (Apple menu -> Log Out) and wait at"
echo "# least $((INTERVAL * 2)) seconds, then log back in"
echo "sudo launchctl bootout system/${LABEL}"
echo "sudo rm $FINAL_PATH"
echo "ls $D9_OUT/"
