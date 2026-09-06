# SPIKE-3 - event-driven, non-resident control plane step

A ~1000-line prototype of Loopmill's control plane, built to answer one question:

> Can `loopmill step` be a **non-resident** process - started once per event, doing
> exactly one state transition, and exiting - while keeping the run's state correct
> under duplicate, out-of-order and concurrent event delivery?

The answer this spike produces is **yes, provided state is event-sourced and every
write is a compare-and-swap**. What that costs and where it breaks is measured below.

This is a spike, not MVP code: the loop definition is hard-coded, the "AI backends"
are a deterministic simulation, and nothing here is wired into the real Loopmill
domain model yet.

---

## 1. What it is

One invocation of `step.mjs step` performs the seven-phase cycle from the MVP design:

```text
read state -> validate event -> apply transition -> decide next node
           -> dispatch backend -> persist state -> exit
```

Nothing stays resident between events. The only durable thing is the event log.

### The loop

```text
observe --> implement --> review --> pass? --> end
                 ^                     |
                 +----- retry edge ----+     maxIterations = 3 cycles
```

* Every node also has `maxAttempts = 2`: a node that reports `error` is re-dispatched
  as **attempt + 1** in the same cycle. A node that exhausts its attempts ends the run
  with `NODE_FAILED`.
* `review` reporting `fail` traverses the **retry edge** back to `implement` and
  increments the **cycle**. Cycle 4 would exceed `maxIterations`, so the run ends with
  `MAX_ITERATIONS_EXCEEDED`.
* **Prototype-only counting.** Here `maxIterations = 3` means *three body executions*
  (cycles 1..3). v0.5 counts traversals of the edge instead, so `maxIterations: 3`
  executes the body four times, in cycles 1..4 (`docs/spec/loop-file.md` §12.2,
  `docs/spec/state-machine.md` §6.3). The harness was written before that was settled
  and is not being retro-fitted; read it as a store-and-delivery experiment, not as the
  loop semantics.

### The simulated backend

There is no AI in this spike. "Dispatching a backend" writes a `node-dispatched`
event, and the simulator immediately fabricates that node's `node-completed`
envelope from a deterministic table (`SCHEDULES` in `step.mjs`):

| schedule | behaviour | terminal outcome |
| --- | --- | --- |
| `retry-then-pass` (default) | `implement` errors once (attempt 2 recovers), `review` rejects cycle 1, passes cycle 2 | `COMPLETED` |
| `always-fail` | `review` never passes | `MAX_ITERATIONS_EXCEEDED` |
| `node-always-error` | `observe` errors on every attempt | `NODE_FAILED` |
| `happy` | everything passes first time | `COMPLETED` |

The fabricated completion is **not applied inside the same step**. It is returned as
`nextEvent`, to be delivered as a new event - in process by `drive`, or as a fresh
GitHub Actions job by the workflow. That keeps the invariant *one step == one applied
inbound event == one commit*, which is what makes the audit trail readable.

### The Envelope

```jsonc
{
  "schemaVersion": 1,
  "eventId":   "evt_...",              // idempotency key
  "loopId":    "spike3-review-loop",
  "runId":     "run-1",
  "cycle":     1,                      // improvement-loop iteration
  "nodeId":    "implement",
  "attempt":   2,                      // node execution attempt within the cycle
  "eventType": "node-completed",       // run-started | node-completed | usage-reported
  "result":    { "status": "pass" },   // pass | fail | error
  "artifactRefs": ["sim://..."],
  "usage":     { "inputTokens": 1200, "outputTokens": 300, "totalTokens": 1500 },
  "occurredAt": "2026-09-06T00:00:00.000Z",
  "producer":   "sim/implement",
  "causationId": "evt_...",            // the event that caused this one
  "params":      { "schedule": "retry-then-pass" },
  "reason":      "retry-edge"
}
```

Idempotency is keyed by `eventId`; validity is keyed by `(runId, nodeId, cycle, attempt)`
against the in-flight node recorded in the snapshot.

### State layout

```text
runs/<run-id>/run.json                        immutable run header
runs/<run-id>/snapshot.json                   current-state CACHE - derivable, never authoritative
runs/<run-id>/events/000001-run-started.json  immutable
runs/<run-id>/events/000002-node-dispatched.json
runs/<run-id>/events/000003-node-completed.json
runs/<run-id>/events/000004-ignored-node-completed.json   a rejected delivery, kept for audit
...
```

Each event file is a *record* wrapping the envelope:

```jsonc
{ "seq": 4, "kind": "applied" | "emitted" | "ignored", "reason": "STALE_ATTEMPT",
  "recordedAt": "...", "envelope": { ... } }
```

`snapshot.json` is exactly `canonicalJson(foldEvents(records))` - a pure, key-sorted
fold with no wall-clock input, so it can be reproduced byte for byte. `rebuild-snapshot`
proves that on demand and the test suite asserts it.

### Two stores

* **local directory** - a plain directory. No concurrency control; used for fast
  semantics tests and local experimentation.
* **git branch** - clones/fetches a remote, checks out the state branch (creating it
  as an **orphan** branch if it does not exist), writes the event files and snapshot,
  makes **one commit per step**, and pushes with compare-and-swap:

  ```sh
  git push --force-with-lease=refs/heads/<branch>:<sha-we-read> origin HEAD:refs/heads/<branch>
  ```

  `<sha-we-read>` is the remote sha observed at the start of the step. If another
  writer moved the branch, the push is rejected; the step then **re-reads state and
  re-plans the event from scratch** (never replays a stale plan) and pushes again,
  up to `--max-push-retries` (default 5).

---

## 2. How to run it locally

```sh
cd spikes/spike-3-control-plane

# Drive a whole run through the local directory store
node step.mjs drive --store local --dir /tmp/lm-state --run-id run-1 --schedule retry-then-pass

# Drive a whole run through a git branch store, using a bare repo as the "remote"
git init --bare -q /tmp/lm-remote.git
node step.mjs drive --store git \
  --remote /tmp/lm-remote.git --branch loopmill/state-spike --workdir /tmp/lm-wd \
  --run-id run-1
git -C /tmp/lm-remote.git log --oneline loopmill/state-spike   # one commit per applied event

# Apply exactly ONE event (this is what a GitHub Actions job does)
node step.mjs started-event --run-id run-2 > /tmp/ev.json
node step.mjs step --store local --dir /tmp/lm-state --event-file /tmp/ev.json

# Prove snapshot.json is nothing but a fold of the event log
node step.mjs rebuild-snapshot --store local --dir /tmp/lm-state --run-id run-1

# Inspect
node step.mjs show --store local --dir /tmp/lm-state --run-id run-1

# Tests (node:test, no dependencies; uses a local BARE repo as the git remote)
node --test test/*.test.mjs        # or: npm test
```

Fault injection used by the tests: `--crash-point after-stage|after-commit`
(exit 98 / 97) and `--barrier-file <path>` (block before the first push until the
file appears), plus `LOOPMILL_NOW` to freeze the clock.

---

## 3. Exit codes

**These codes are prototype-only.** They exist so the test suite and a shell can branch without parsing
JSON, and they are deliberately wider than the shipping contract. The normative tables are
`docs/spec/state-machine.md` §12.1 — `loopmill step` exits `0` handled, `1` unexpected, `2` invalid,
`3` state conflict, `4` dispatch failed — and §12.2 for `loopmill run`'s outcome codes. Nothing in the
design may be derived from the table below.

`step` maps outcomes onto the exit code so a shell can branch without parsing JSON.
The full result is still printed as JSON on stdout; a one-line summary goes to stderr.

| code | name | meaning | caller should |
| ---: | --- | --- | --- |
| 0 | `OK_CONTINUE` | event applied, run still `RUNNING` | dispatch `nextEvent` if non-null |
| 10 | `OK_RUN_COMPLETED` | terminal, outcome `COMPLETED` | stop the chain |
| 11 | `OK_MAX_ITERATIONS_EXCEEDED` | terminal, retry-edge budget exhausted | stop the chain |
| 12 | `OK_RUN_FAILED` | terminal, outcome `NODE_FAILED` | stop the chain |
| 20 | `NOOP_DUPLICATE` | `eventId` already seen; **nothing written, no commit** | stop, success |
| 21 | `NOOP_STALE` | stale / out-of-order; recorded as an `ignored` record, never applied | stop, success |
| 22 | `NOOP_TERMINAL` | run already terminal; recorded as `ignored` | stop, success |
| 30 | `ERR_INVALID_EVENT` | envelope failed validation; nothing written | fail loudly, do not redeliver |
| 40 | `ERR_CONFLICT` | CAS lost `--max-push-retries` times; **nothing persisted** | redeliver the same event |
| 50 | `ERR_INTERNAL` | unexpected error | fail loudly |

Rule of thumb for CI: `< 30` means the control plane behaved correctly; `>= 30`
means the job should be red. 40 is a *safe* failure - the event is untouched and
redelivering the identical envelope converges, which is exactly what at-least-once
delivery gives you.

Codes 97 and 98 are only produced by the test-only fault injection.

---

## 4. How the GitHub chain is triggered

`.github/workflows/spike-3-step.yml` - one job per event.

```text
workflow_dispatch(event = started)
   -> job: read loopmill/state-spike, apply, commit+push, emit nextEvent
   -> gh api .../workflows/spike-3-step.yml/dispatches  (ref = same branch)
   -> job: ... repeat until terminal, or until the 12-step cap
```

* **`workflow_dispatch` with an explicit `ref`** is the mechanism, because it is the
  only one that runs *this branch's* version of the workflow.
* **`repository_dispatch` only ever runs the workflow file on the repository's
  default branch** and offers no ref selection. It is declared (type
  `loopmill-step`, envelope in `client_payload.event`) so the same entry point works
  once this lands on the default branch, but a feature-branch chain cannot use it.
* `workflow_dispatch` has a weaker version of the same restriction: the workflow file
  must exist on the default branch for the event to be dispatchable at all; after
  that, `ref:` selects which version actually runs.
* **GITHUB_TOKEN**: GitHub documents that events triggered with the automatic
  `GITHUB_TOKEN` do *not* create new workflow runs, **except** `workflow_dispatch`
  and `repository_dispatch` (changed 2022-09-08). The chain depends on that
  exception; it is the reason a state-branch *push* cannot be the trigger.
  *Verification status:* `docs.github.com` and `github.blog` were both unreachable
  from the build sandbox (egress blocked), so this was confirmed only through search
  results quoting the GitHub Docs "GITHUB_TOKEN" page and the 2022-09-08 changelog.
  The real workflow run is what actually settles it.
* `permissions: contents: write` (push state) + `actions: write` (dispatch next step).
* `concurrency: group: loopmill-<runId>`, `cancel-in-progress: false` - one in-flight
  step per run, and a step that is mid-transition is never cancelled. The group is
  built from a plain `run_id` input rather than `fromJSON(inputs.event).runId`,
  because `concurrency` is evaluated before the job exists and the expression must
  not break when the input is absent (as it is for `repository_dispatch`).
* Safety net: `step_no` is carried through the chain and the workflow refuses to
  dispatch past `MAX_CHAIN_STEPS = 12`. The loop is already bounded by
  `maxIterations` and `maxAttempts`; the cap only guards against a control-plane bug.

---

## 5. Properties the tests prove

`node --test test/*.test.mjs` - 20 tests, 10 against the local store
(`test/semantics.test.mjs`) and 10 against a git branch store backed by a local
**bare** repository (`test/git-store.test.mjs`).

| # | property | how it is proven |
| --- | --- | --- |
| 1 | **Duplicate delivery is a strict no-op.** The same `eventId` twice writes no event file, produces no commit, and leaves `snapshot.json` byte-identical. | local + git; git asserts `pushAttempts == 0` and an unchanged remote sha |
| 2 | **Out-of-order / stale events are never applied.** A completion for attempt 1 arriving after attempt 2 was dispatched is recorded as an `ignored` record with reason `STALE_ATTEMPT`; the in-flight attempt is untouched and nothing is dispatched. | local + git |
| 3 | A completion for a node that is not in flight is ignored (`NOT_CURRENT_NODE`). | local |
| 4 | **A stale event stays idempotent**: redelivering it is then a plain duplicate. | local |
| 5 | **Concurrent steps serialize.** Two processes read the same base sha and push simultaneously: exactly one succeeds with 0 conflicts, the other is rejected, re-reads, re-plans and succeeds on its second push. Both events end up applied, sequence numbers are contiguous with no gaps or collisions. | git, forced with a barrier file |
| 6 | **A lost CAS never half-persists.** With the retry budget set to 1, the loser exits 40, leaves *no* trace on the branch, and the identical envelope applies cleanly when redelivered. | git |
| 7 | **CAS actually compares.** A foreign writer pushes between a step's read and its push; the step's push is rejected exactly once, it rebases on the foreign commit (which survives) and applies its event on top. | git |
| 8 | **An interrupted job leaves the remote untouched.** Killed after the local commit but before the push: remote sha unchanged, the doomed commit exists only in the abandoned work dir, and rerunning the same event in the same work dir produces exactly one commit and a snapshot byte-identical to an uninterrupted run. | git |
| 9 | Same for a kill after writing files but before committing: the leftover work tree does not poison the rerun, and the event is applied exactly once. | git |
| 10 | **The retry edge works and is bounded.** `always-fail` stops at cycle 3 with 2 retry-edge traversals and `MAX_ITERATIONS_EXCEEDED` (exit 11), dispatching nothing further. | local |
| 11 | **Node attempts are bounded** - `NODE_FAILED` (exit 12) after `maxAttempts`. | local |
| 12 | **`snapshot.json == fold(events)`**, byte for byte, both via `rebuild-snapshot` and in process; deleting the cache and refolding reproduces it. | local + git |
| 13 | **Audit trail**: one commit per applied event, each commit subject carrying `eventId=<id>`, in the same order as the applied events. | git |
| 14 | The state branch is an orphan carrying **only** `runs/...` - no source tree. | git |
| 15 | Events after a terminal run are ignored (exit 22); invalid envelopes (bad `schemaVersion`, unknown node/loop/run, bad result status, an emitted type sent inbound) exit 30 without touching state. | local |
| 16 | Two runs share one state branch without interfering. | git |
| 17 | `usage-reported` is applicable in any order and does not advance the loop - this is the order-independent event used to build the concurrency test. | local + git |

Measured facts — local (this sandbox, local bare repo, Node 22.22.2 / git 2.43.0) and
from the 22 GitHub-hosted runs of 2026-09-06 — are recorded in `docs/spikes/README.md` §5.

---

## 6. "A git branch as the state store" - tradeoffs

### Atomicity
A step's whole effect - new event files, the rewritten snapshot, and on the first
event the run header - lands in **one commit**. There is no window in which a reader
sees half a transition. Because the commit is created locally and only then pushed,
a crash before the push is invisible to everyone else. That gives clean
all-or-nothing semantics without any lock service, which is the single strongest
argument for this design.

The catch: atomicity is per *push*, not per *step*. A step that pushes and then dies
before reporting has still committed; the caller must treat "no answer" as "unknown"
and redeliver. The `eventId` index makes that safe.

### Conflicts
`--force-with-lease=<branch>:<sha-read-at-start>` turns `git push` into a
compare-and-swap on the branch ref. Losing is cheap and always recoverable, because
the step re-reads and re-*plans* rather than replaying a stale plan - the retry sees
the winner's state and can legitimately decide the event is now stale.

Measured: under N simultaneous steps on the same run, conflicts are the worst case
`N(N-1)/2` (N=4 gave retries 0/1/2/3) - i.e. **retries grow linearly with the number
of concurrent writers**, and with the default budget of 5 an N=6 storm made one step
exit 40. Two consequences:

* Per-run serialization (the Actions `concurrency` group) is not a nicety, it is
  what keeps N at 1 in normal operation.
* The control plane must never *depend* on it. Exit 40 persists nothing, so
  at-least-once redelivery is the required contract.

Contention is also on the **branch**, not the run, so unrelated runs collide with
each other. At many concurrent runs the right move is one state branch per run
(`loopmill/run/<runId>`, archived into `loopmill/state` at terminal state — the
escalation option `docs/design/mvp-design.md` §9.2 and ADR-001 D5 already document),
which removes cross-run contention entirely at the cost of a lot of refs.

### Growth
Events are genuinely small. Measured on one 7-step run (14 event records):

| item | size |
| --- | --- |
| one event record | 719 B average |
| all 14 event files | 10.1 KB |
| `snapshot.json` | 2.2 KB |
| `run.json` | 303 B |
| working tree for the run | 12.5 KB |
| packed bare repo, 7 commits | 39 KB |
| packed bare repo, 10 runs / 70 commits | 124 KB (~1.35 KB of repo per additional commit) |

So the marginal cost is roughly **1.3 KB of repository per step**, and git object
overhead - a tree and a commit per step plus a whole rewritten snapshot blob -
dominates the ~700 B of actual event payload.

One real defect this exposes: `snapshot.json` embeds the full `seenEventIds`,
`appliedEventIds` and `emittedEventIds` lists, so it is **O(events)** and it is
rewritten on every step - **O(n^2)** bytes for a run of n events. The constant is
small (a 14-event run spends ~630 B of its 2.2 KB snapshot on ids) but it is the
wrong shape. Before the MVP the dedup index should either move to its own
append-only file, or be bounded (keep the last K ids and fall back to
`(runId, nodeId, cycle, attempt)` for anything older).

Artifacts, logs, diffs and prompts must **not** live here. They belong in Actions
artifacts, object storage, or the working branch, referenced from `artifactRefs`.
A state branch that stays "small JSON only" is viable; one that accumulates logs is
not.

### Pruning
Nothing is pruned today, and unbounded event history on a branch that every step
clones is the long-term failure mode. Realistic options:

* **Squash to a checkpoint**: replace `runs/<id>/events/*` for a finished run with a
  single `checkpoint.json` (the final snapshot plus a hash of the removed events),
  in one commit that records what was collapsed.
* **Archive**: move finished runs to `archive/<yyyy-mm>/<run-id>.json.gz`, or off the
  branch entirely into a release asset, keeping only the snapshot.
* **Rewrite the branch periodically** (a fresh orphan commit with the current tree).
  Cheap and simple, but it destroys the audit trail, so only for archived runs.
* Steps should fetch shallowly (`--depth=1`) once history matters; the spike fetches
  the full branch because it is tiny.

### Orphan branch vs a subdirectory of a normal branch
An **orphan branch is clearly better** for this:

* No interaction with the code history: state commits never appear in `main`'s log,
  never trigger `push`-based CI, never show up in PR diffs, and cannot conflict with
  a merge.
* CAS is per-branch, so state writes contend only with other state writes - a
  subdirectory of `main` would make every state write contend with every code push
  and would be blocked outright by branch protection.
* Cheap to fetch in isolation (`git fetch origin loopmill/state-spike`) and cheap to
  garbage-collect or rewrite when pruning.
* The tests assert the branch tree contains nothing but `runs/`.

The costs are real but small: a step needs a second checkout/work dir, the branch is
easy to delete by accident, and reviewers do not see state changes in PRs. The one
case for a subdirectory of a normal branch would be wanting state changes to be
reviewable in a PR - which is precisely the opposite of what a high-frequency control
plane wants.

---

## 7. Files

```text
step.mjs                    the control plane step, both stores, and the CLI
test/helpers.mjs            bare-repo fixtures, CLI drivers, barriers
test/semantics.test.mjs     state-machine semantics (local store)
test/git-store.test.mjs     durability and concurrency (git branch store)
package.json                `npm test` only; no dependencies
```
