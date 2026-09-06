# SPIKE-4 D9 -- the scheduler context

## What this measures

Loopmill's design assumes a loop with `trigger.kind: schedule` is started by the operating
system's own scheduler, not by any resident Loopmill process (`docs/design/mvp-design.md`
section 7.5, "Scheduling is the operating system's"). That same section spells out what such a
process must be able to reach:

> A scheduled process must reach the runtime CLI's login state: the macOS login keychain for
> `claude`, `CODEX_HOME` for `codex`, and the operator's `gh` authentication. Whether a `launchd`
> user agent or a `systemd` user unit gets that on a locked screen or without a login session is
> a measured question (SPIKE-4), and `doctor --scheduler` probes exactly the environment the unit
> will run in before 06:00 ever comes.

D9 is that measured question. It is the harness for risk R2 in
`docs/adr/ADR-002-local-self-hosted-execution.md`: *"A scheduler-started process cannot reach the
CLI's login state (macOS keychain when the screen is locked or no user session; `CODEX_HOME` not
found under a `systemd` unit)."* D9 does not gate whether the `codex` runtime is `VERIFIED` or
stays `PLANNED / EXPERIMENTAL` (that is D1-D4 and D7, in the parent `spikes/spike-4-codex-cli/`
harness) -- it decides the per-platform operator notes in design section 7.5 and the check list
`doctor --scheduler` must run, on macOS and Linux independently.

## The four labels

| Label | What it exercises | How to run it |
|---|---|---|
| `interactive-baseline` | A normal terminal, logged-in session -- the control condition every other label is compared against. | `bash d9/probe.sh interactive-baseline` from a terminal, by hand. |
| `launchd-agent` | A macOS `launchd` **user agent**: runs inside the operator's own GUI login session, so it measures the *locked-screen* half of R2 (the session exists; is the screen lock itself the problem?). | `install-macos-agent.sh` generates the plist; see "macOS operator procedure" below. |
| `launchd-daemon` | A macOS `launchd` **system daemon**: runs entirely outside any GUI session (root's launchd), so it measures the *no session at all* half of R2. The login keychain is expected to be unreachable here even for the correct `UserName`. | `install-macos-daemon.sh` generates the plist; requires `sudo` and a full log-out. |
| `systemd-timer` | A Linux `systemd --user` timer, in two scenarios: staying logged in (close to `launchd-agent`), and logging out entirely with/without `loginctl enable-linger` (close to `launchd-daemon`, but the failure mode is usually "the timer never fires" rather than "it fires but can't authenticate"). | `install-linux-user-timer.sh` generates the unit files; see "Linux operator procedure" below. |

Every label writes to `${SPIKE4_D9_OUT:-$HOME/loopmill-spike4-d9}/<label>-<UTC timestamp>/`, so
repeated fires never collide or overwrite each other -- each fire of a timer/agent gets its own
directory, and `ls` on the base directory shows every fire in order.

## Operator procedure

None of the four scripts in this directory load, enable, or start anything themselves. Each
`install-*.sh` script only **writes** a plist or unit file and **prints** the privileged /
session-affecting commands for the operator to run by hand. This is deliberate: bootstrapping a
LaunchDaemon needs `sudo`, and measuring "no session at all" needs an actual log-out -- neither of
those should ever happen as a side effect of running a generator script.

### macOS

1. `bash d9/probe.sh interactive-baseline` once, from an ordinary terminal, to establish the
   control condition.
2. `bash d9/install-macos-agent.sh` -- writes `~/Library/LaunchAgents/com.loopmill.spike4-d9.plist`
   and prints the exact commands to run: `launchctl bootstrap`, then `launchctl print` to confirm
   it loaded, then **lock the screen** and leave the Mac alone for at least two `StartInterval`
   periods (default 240 s) so it fires twice, then `launchctl bootout`, then `ls` the output
   directory. The label is `launchd-agent` for both fires: the first fire (right after bootstrap)
   may still see an unlocked screen and is effectively a second baseline; the fire that happens
   *after* the screen is locked is the actual measurement. `probe.json`'s
   `context.macos.screenLockState` tells the two apart after the fact -- there is no need to time
   it precisely.
3. `bash d9/install-macos-daemon.sh` -- stages a plist and prints the `sudo cp` / `chown` / `chmod`
   / `launchctl bootstrap system` sequence for `/Library/LaunchDaemons/`, then the instruction to
   **log out of the Mac entirely** (Apple menu -> Log Out, not just lock) and wait, then log back
   in and read the results, then the `sudo launchctl bootout` + `rm` teardown. If that run reports
   `HOME` unset or wrong in `probe.json`, generate a second variant with `SPIKE4_D9_INJECT_HOME=1`
   and repeat: it separates "the daemon has no `HOME`" from "the login keychain is locked", which
   are different `doctor --scheduler` checks.
4. Override `SPIKE4_D9_INTERVAL` (seconds) before running an install script if 120 s fires are
   inconvenient -- both plists read it at generation time.

### Linux

1. `bash d9/probe.sh interactive-baseline` once, from an SSH session, for the control condition.
2. `bash d9/install-linux-user-timer.sh` -- writes
   `~/.config/systemd/user/loopmill-spike4-d9.{service,timer}` and prints:
   `systemctl --user daemon-reload`, `enable --now`, `list-timers` to confirm it is scheduled, then
   two scenarios:
   - **(A)** stay logged in (e.g. keep the SSH session open) for at least two `OnUnitActiveSec`
     periods and read the results -- this is the Linux analogue of `launchd-agent`.
   - **(B)** `loginctl enable-linger $USER`, then log out of *every* session (close every SSH
     connection), wait, and log back in -- this is the Linux analogue of `launchd-daemon`. Without
     linger, systemd stops a user's manager instance when their last session ends and the timer
     simply never fires while logged out; **that non-fire is itself the D9 finding for that
     scenario**, not a bug in the harness -- check for the *absence* of a new output directory
     covering the logged-out window, not an error inside one.
3. Teardown: `systemctl --user disable --now loopmill-spike4-d9.timer`.

## What to send back

The `probe.json` file from each fire (one per `<label>-<timestamp>/` directory under
`$SPIKE4_D9_OUT`), plus the raw `S1.stdout.txt` ... `S5.stderr.txt` files alongside it if anything
in `probe.json` looks surprising and the raw output would help. Everything `probe.sh` writes has
already been redacted (API-key- and token-shaped strings, JWTs, e-mail addresses, and `/Users/*/`
/ `/home/*/` usernames) before it ever touches disk, so nothing in these files is secret -- but the
operator should still skim them before sharing, the way one would skim any log before pasting it
somewhere.

## How to read the verdicts

Each of the five steps (S1-S5, see `probe.sh`'s header comment for exactly what each one runs)
gets one of: `ok`, `auth-failed` (the CLI ran but reported not being logged in), `not-found` (the
binary could not be resolved at all -- see `probe.json`'s `context.binaries` for which resolution
step, if any, worked), `error` (something else went wrong), `timeout` (the step's deadline fired
and the process was killed), or `dry-run` (`SPIKE4_D9_DRY_RUN=1` was set; nothing executed).
`probe.json`'s `combined` object folds S1+S2 into one `claude` verdict and S3+S4 into one `codex`
verdict (worst-of-the-two, with `auth-failed` counting as worse than `not-found`/`timeout`/`error`,
which in turn count as worse than `ok`), matching the one-line summary `probe.sh` prints to stdout:

```
spike4-d9 <label>: claude=<verdict> codex=<verdict> gh=<verdict> keychain-claude=<yes|no> keychain-codex=<yes|no> screen=<state> manager=<name>
```

`keychain-claude` / `keychain-codex` are `yes`/`no`/`timeout` only on macOS (whether
`security find-generic-password` found the `Claude Code-credentials` / `Codex Auth` login-keychain
items, exit code only -- never the credential itself; `timeout` means `security` blocked for 30 s,
which is what a locked keychain waiting for an unlock dialog looks like from a process that has no
way to answer it); `screen` (`locked`/`unlocked`/`unknown`) and
`manager` (`launchctl managername`, e.g. `Aqua` for a normal GUI session vs `Background`/`System`
for something else) are likewise macOS-only. On Linux, all four print `n/a` in the one-line summary
-- the Linux-equivalent detail (`XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` presence, `loginctl`
linger state, `systemctl --user is-system-running`) is in `probe.json`'s `context.linux` block
instead, since there is no Linux equivalent of "the keychain is locked" to collapse into one
yes/no field.

## Results

Fill in one row per fire. `claude auth` = step S1's verdict, `claude -p` = S2, `codex login` = S3,
`codex exec` = S4, `gh` = S5, `keychain` = `keychain-claude`/`keychain-codex` from the summary
line (macOS only). `notes` should call out anything `probe.json`'s `context` block adds that
isn't visible in the verdicts -- e.g. `screenLockState`, `launchctlManagerName`, or (on Linux)
whether the fire happened at all under scenario B.

| Context | claude auth | claude -p | codex login | codex exec | gh | keychain | notes |
|---|---|---|---|---|---|---|---|
| `interactive-baseline` (macOS 26.5, 2026-09-06 13:37 UTC) | ok | ok | ok | ok | ok | yes / yes | `manager=Aqua`, `screen=unlocked`, `tty=yes` |
| `launchd-agent`, screen locked (2026-09-06 13:41, 13:44, 13:46 UTC — three fires) | ok | ok | ok | ok | ok | yes / yes | `manager=Aqua`, `screen=locked`, `tty=no`, `SECURITYSESSIONID` unset; the plist's `PATH` was `/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` (launchd's own default has no Homebrew directory); claude 2.1.263, codex 0.153.4 |
| `launchd-agent`, screen unlocked | — | — | — | — | — | — | the screen was locked before the first fire, so this row was never produced; the interactive baseline stands in for it |
| `launchd-daemon` (no GUI session) | not run | not run | not run | not run | not run | not run | needs `sudo` and a full log-out; expected to fail on the keychain |
| `interactive-baseline` (Linux) | not run | | | | | n/a | no Linux host |
| `systemd-timer`, scenario A (stayed logged in) | not run | | | | | n/a | |
| `systemd-timer`, scenario B (logged out, no linger) | not run | | | | | n/a | did the timer fire at all? |
| `systemd-timer`, scenario B (logged out, with linger) | not run | | | | | n/a | |

## Cost

Every non-dry-run fire that reaches S2 and S4 spends a small amount of the operator's own
subscription quota: one trivial `claude -p` call and one trivial `codex exec` call, each a few
tokens (`"Reply with exactly: LOOPMILL-OK"`). At the default 120 s `StartInterval`/
`OnUnitActiveSec`, a few fires over a few minutes is negligible, but this is why an agent must
never run these install scripts' printed commands, or `probe.sh` itself outside `SPIKE4_D9_DRY_RUN=1`,
on the operator's behalf -- **the operator runs these, not an assistant.**
