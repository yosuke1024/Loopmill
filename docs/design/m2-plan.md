# m2 plan — scheduled, unattended local execution

**Status:** starting 2026-09-08, against the contracts frozen in `m0-contract-freeze.md` and the code
m1 shipped. This file is the working map for m2 (`mvp-design.md` §20.2): what is being built, in which
order, by which conventions, and where each piece stands. It is updated as work lands; it is not a
contract.

m1's plan is `m1-plan.md`; its acceptance audit (§5.1) and the record of the first live run (§6) are
the starting position for everything below.

## 1. The cut-line

`mvp-design.md` §20.2 states m2's cut-line as "seven consecutive unattended nights of the reference
loop on the maintainer's machine". The reference loop under `examples/` cannot serve as written: it is
content-site oriented and its `mode: label` gate needs the GitHub ingestion m2 is only now building.

**Decision, m2, 2026-09-08 (maintainer).** The seven nights run **a Loopmill-owned nightly loop against
this repository, gated by `mode: pull-request-review`**, scoped to documentation so that the nights
cannot churn `src/` while m2 itself is being built there. Each night: survey the repository for one
documentation statement that has gone stale against the code, change exactly that, run the suite in the
Run's own worktree, have the reviewer judge the committed diff, push, open a pull request, and park on
the human gate with no process anywhere. In the morning the maintainer reviews that pull request on
GitHub in the ordinary way; the next `resume --due` ingests the approving review and merges.

Rejected alternatives, with the reason: a `mode: cli` nightly loop (simplest, and `mode: cli` already
works — but it exercises no GitHub ingestion at all, so roughly a third of m2 would ship untried by the
cut-line); a separate throwaway target repository (isolates this repository from nightly churn, but the
changes are not work anyone needs, so the morning review degenerates and real output-quality problems
go unnoticed).

**What that decision buys and what it costs.** It makes the approval flow most users will actually want
— wake up, a pull request is waiting, approve it where you already review code — the thing the cut-line
proves. It also makes two items that m1 recorded as merely open into hard prerequisites: nothing today
turns `gh pr create`'s output into a `pr` artifactRef, and without one a `pull-request-review` gate
cannot know which pull request to poll. §4's W2 is therefore on the critical path, not optional.

### 1.1 Node order, and why the external effects are pre-approved

A `pull-request-review` gate inverts m1's node order: the pull request must exist before anyone can
review it, so the shape is `push` → `open-pr` → **gate** → `merge`, not m1's gate-then-push.

`loop-file.md` §6.4 (LM-VAL-023) requires a `human` node on every path to an `effects: external` node.
Satisfied literally, the nightly loop would ask for two approvals per night — one to open the pull
request and one to merge it — and the first could only be `mode: cli`, which defeats unattended
operation. `approval.policy: auto` with `nodes: [push, open-pr]` and a written `reason` is the
mechanism the contract already provides for exactly this; §6.4's own rationale is written around this
case ("a Loop typically has one external effect that is obviously safe to automate ... and one that is
not"). The genuinely irreversible act, `merge`, keeps its gate.

## 2. Ground truth, audited 2026-09-08

Eight areas were audited against the code, the frozen contracts and m1's two real runs, each survey
then adversarially checked. Corrections made to the audit's own findings during review are noted where
they change the plan.

### 2.1 What m1 already built that m2 must not rebuild

- **The engine half of resume exists and is tested.** `transition()` handles `resumed` from
  `WAITING_FOR_QUOTA` (`src/engine/transition.ts:1932`) and from `INTERRUPTED` (`:1954`), including the
  `resume.kind: "due"` path (`:133`). What is missing is entirely driver and CLI.
- **The lock, its lease and its heartbeat.** `acquireLock` / `heartbeat` / `releaseLock`
  (`src/store/sqlite.ts:653-687`), with dedicated unit tests in `test/store/locks.test.ts`.
- **`SKIPPED(overlapping_run)`** — A10, proven end to end by `test/driver/concurrency.test.ts`.
- **The per-attempt worktree reset** every re-dispatch needs: `resetToCycleBase` (`git reset --hard` +
  `git clean -fd`) against a base read from the worktree's own `HEAD`
  (`src/backends/local/worktree.ts:70-92`), so a re-dispatch after a crash needs no remembered state.
- **`deriveDeliveryEventId`** (`src/envelope/ids.ts`, TV-2 vectors green) — the idempotency-key
  derivation the frozen envelope specifies for GitHub polling, already written and tested with no
  caller yet.
- **A `dedupe_key` column** on the `runs` table, populated at insert (`src/store/sqlite.ts:290`, `:376`).
- **`store.listRuns()`** returns every run's full snapshot with `loopId` / `since` / `limit` filters —
  enough for a first version of several queries §4 needs, without new SQL.

### 2.2 A defect in shipped code — the sweep orphans a Run

**Found by this audit and reproduced against the real store and driver, not inferred.**

`state-machine.md` §10.2 says the sweep "scans the store (the `events`/`snapshots` tables and the
`locks` row)" and emits `lease-expired` "when `lease != null` and `ctx.now >= lease.expiresAt`" — the
trigger is **`snapshot.lease`**. `SqliteStore.sweep()` (`src/store/sqlite.ts:705-739`) instead scans
only the `locks` table, reading the snapshot merely to fill in `nodeId`/`cycleIndex`/`attempt`, and
deletes every expired row unconditionally. The index is inverted with respect to the contract.

For an `effects: external` node this is harmless: R-32 parks the Run `INTERRUPTED` with
`snapshot.lease = null`, so no row is wanted. For an `effects: none` node — **the default, and what
every agent node in every loop here is** — R-31 auto-retries: `applyRunningLeaseExpired`
(`src/engine/transition.ts:1761-1765`) calls `dispatchEnvelope` and returns a fresh attempt with a new
lease and a `dispatch` action. `runSweep` records that action without performing it, by design
(`src/driver/sweep.ts`'s own doc comment), and `store.append`'s lease write is
`UPDATE locks ... WHERE loop_id = ? AND run_id = ?` (`src/store/sqlite.ts:572-579`) — zero rows, because
`sweep()` just deleted it.

Observed, driving the real `applyStep` / `continueRun` / `runSweep` / `SqliteStore` with a dispatch that
throws the way a `kill -9` behaves:

```
--- after the simulated kill -9 ---
status: RUNNING   current: review-content DISPATCHED attempt 1   locks row: LIVE
--- after runSweep() ---
outcome.applied: true   actions: [dispatch review-content attempt 2]
status: RUNNING   current: review-content DISPATCHED attempt 2
snapshot.lease: LIVE     locks row: GONE
--- a later entrypoint sweeps again, an hour on ---
rows swept: 0            status still: RUNNING
```

The Run is `RUNNING` for ever: its snapshot claims a live attempt, nobody will dispatch it, and no
future sweep can see it because the sweep's only index — the `locks` row — is gone. The next
`loopmill run` acquires the now-free lock and starts a second Run, so overlap protection is gone too.
This is precisely the silent Run `mvp-design.md` §17.4 says must never happen, and it is reached by an
ordinary crash or timeout on an ordinary agent node.

No existing test covers it: `test/driver/sweep.test.ts`'s own header records that it deliberately uses
an `effects: external` node and that the `effects: none` path "auto-retries ... never reaching the
status this file tests".

**This needs no contract amendment.** §10.2 already specifies the correct index; the implementation
does not follow it.

**Fixed 2026-09-08 (W0a).** `SqliteStore.sweep()` is now a read-only scan — it reports expired rows
and deletes nothing — and `driver/sweep.ts` decides each row's fate from the transition it just
applied: release the row when the resulting snapshot holds no lease (R-32 parked it, or the attempts
exhausted into a terminal state), keep it when a re-dispatch installed a fresh one. Nothing needed the
deletion in the first place: `acquireLock` takes over an expired row rather than requiring an absent
one, so expiry alone already frees the loop. The same scenario now runs: sweep, re-dispatch, the row
survives carrying the new lease, the next sweep still finds the Run, attempts exhaust, and it lands
`FAILED` — reported, never silent. Two tests in `test/store/locks.test.ts` asserted the deletion and
its "a second scan finds nothing left" idempotency; both encoded the implementation rather than
§10.2, and were rewritten to assert the read-only scan and the engine-level `duplicate` that now
makes a repeated report harmless.

Indexing the scan itself on the snapshot is still W0b, and is what §10.2's five unimplemented bullets
need: a parked Run has no process and no `locks` row at all, so no lock-indexed scan can ever reach
`human_timeout`, `observe_deadline`, `max_runtime`, `resumed{due}` or a stuck `PENDING`.

### 2.3 What is genuinely absent

| Area | Absent | Notes |
|---|---|---|
| resume | `loopmill resume` in both forms; the CLI has 12 commands and none is `resume` (`src/cli/main.ts:695-717`) | the engine half exists (§2.1) |
| sweep | five of `state-machine.md` §10.2's six bullets: `node-timed-out{human_timeout}`, `node-timed-out{observe_deadline}`, `run-finished(EXPIRED, max_runtime)`, `resumed{kind: due}`, `run-started` for a stuck `PENDING` | all need the same snapshot-indexed scan as W0's fix |
| GitHub | any read of GitHub state whatsoever. `gh` is invoked twice in `src/`, both in `doctor.ts` (`gh --version`, `gh auth status`); no HTTP client, no API dependency | a clean slate, and ADR-002 D7 bounds it: poll with the user's own `gh`, never a bus or a store |
| artifacts | `pr`, `issue` and `branch` artifactRefs are never produced; `subjectFor` never constructs `Subject.kind: "pr"` (`src/engine/transition.ts:747-774`) | **no amendment needed** — see §2.4 |
| gates | `mode: label` and `mode: pull-request-review` ingestion; the `cancel` decision has a tested engine handler and no entrypoint | `mode: cli` approve/reject is proven end to end by m1's live run |
| scheduler | `doctor --scheduler` returns `"not_implemented_in_m1"` (`src/driver/doctor.ts:150`); nothing reads a scheduler's own last-fire time; no convention ties a launchd label to a loop | see §2.5 for the unmeasured assumption underneath A36 |
| budget | `minInterval` and `maxRunsPerWindow` are per-Loop and across runs, so they need a store query at request time, not a snapshot check | `listRuns()` may be enough for a first version |
| A25 | the finding schema, any mechanism carrying findings to the retried node, and any record of which finding ids a cycle addressed | see §6, decision 2 |

### 2.4 Two audit findings that were corrected during review

- **`pr` / `issue` artifactRefs need no contract amendment.** The audit proposed one (a declared
  output-capture field on `command` nodes). The frozen contracts already settle it: `state-machine.md`
  §3.1 row 5 lists `backend:<id>` as a producer of `node-completed` carrying `artifactRefs[]`, and both
  worked traces show exactly this loop's shape —  `mvp-design.md:1150` (`node-completed create-issue |
  backend:local | artifactRefs: [{kind: issue, ref: "#482"}]`) and `:1157` (`create-pr | artifactRefs:
  [{kind: pr, ref: "#489"}]`). The `local` backend is already the sanctioned producer; only the
  implementation is missing.
- **`skipReason: overlapping_run` is not a contract violation.** The audit reported that the frozen
  `skipReason` enum (`state-machine.md:161`, `state-machine.json:48`) is closed over
  `{dedupe, min_interval, runs_per_window}` while the prose and the code use `overlapping_run`. The
  enum governs a *persisted* `run-finished(SKIPPED, ...)` outcome; a second concurrent `run` is refused
  before any Run exists and, per A10, "writes nothing else" — it reports on stderr and exits 15. The
  prose is loose, not contradictory. A wording fix, not an amendment.

### 2.5 One assumption under A36 that nobody has measured

A36 requires `doctor --scheduler` to report a scheduler fire that produced no `run-requested`
transaction, **with the scheduler's own last-fire time**. SPIKE-4's D9 — the measurement this whole area
rests on — never tried to read one: `d9/probe.sh` reads `launchctl managername` and the three login
verdicts only. Whether `launchctl print` exposes a parseable last-fire timestamp for a
`StartInterval`/`StartCalendarInterval` job is unverified. This is the same shape as the defect that
failed m1's first live run (`claude` needs `USER`, assumed rather than measured), so W3 begins with a
short measurement, not with code.

What SPIKE-4 D9 *did* establish, and what W3 depends on:

- A **launchd user agent** on a locked screen reaches every login — the `claude`, `codex` and `gh`
  keychain items were all found, 3 fires out of 3 (`docs/spikes/README.md`, D9). The unmeasured cases
  are a `LaunchDaemon` with no login session, and Linux; neither is the MVP's primary path.
- launchd's default `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` — **no Homebrew**. Since `resolveBinary`
  (m1, A16) resolves against the child's own scrubbed `PATH`, a schedule entry that does not carry a
  `PATH` finds neither `claude` nor `codex` nor `npm`. ADR-002 D6 already anticipates this: the unit
  carries "absolute argv, an install-time environment snapshot, the loop's `tz`".

## 3. Conventions

m1's conventions (`m1-plan.md` §3) carry over unchanged. Two additions:

- **GitHub is read by shelling out to the user's own `gh` with `--json`**, through one driver module,
  never an HTTP client and never a new dependency (ADR-002 D7: polled, with the user's own login). No
  network in any test: the module takes the same kind of injectable boundary the backends do, and every
  test drives recorded `gh --json` output.
- **A read of GitHub is an *ingestion*, not a control channel.** It produces envelopes with
  `deriveDeliveryEventId`, so a repeated poll is a `duplicate`, never a second applied event.

## 4. Waves and status

| Wave | Contents | Depends on | Status |
|---|---|---|---|
| W0a | The §2.2 defect: `store.sweep()` becomes a read-only scan, and `runSweep` releases the `locks` row only when the resulting snapshot holds no lease | — | **done 2026-09-08** (676 tests; the reproduction is now `test/driver/sweep.test.ts`'s third case, verified to fail against the old code) |
| W1 | `loopmill resume <runId> [--decision retry\|skip\|fail]` and `resume --due`; its exit codes; the exit-23 resolution; the unreachable `cancel` decision | W0a | **done 2026-09-08** (685 tests). `resume --due` drains the *quota*-parked half of A37; its approved-but-unresumed half needs the GitHub read and lands in W2 |
| W0b | The rest of `state-machine.md` §10.2: index the scan on the snapshot, and emit the bullets that have no producer (`human_timeout`, `max_runtime`, `resumed{due}`, stuck `PENDING`) | **W1** — reordered, see below | not started |
| W2 | The `gh` read module; `pr` / `branch` / `issue` artifactRefs from the `local` backend; a `Subject.kind: "pr"` producer; `pull-request-review` gate ingestion (`label` is m3, §6 decision 1) | W1 | not started |
| W3 | Measure `launchctl print` first (§2.5); then `doctor --scheduler` and the launchd user-agent unit with its environment snapshot; the loop↔unit identity convention | — (may run beside W2) | not started |
| W4 | Cross-run budget at request time (`minInterval`, `maxRunsPerWindow`); dedupe/`SKIPPED` (A27); the run report and coverage gaps (A29, A32) | W0a, W2 | not started |

**Reordering, 2026-09-08: W0b follows W1, not the other way round.** W0b was planned first on the
assumption that the remaining sweep bullets are more store queries of the kind W0a touched. They are
not: four of them resolve to transitions whose action is a *dispatch*, and `runSweep` deliberately
performs no action. Emitting `resumed{kind: due}` from `status`'s own sweep would un-park a
quota-waiting Run that nothing then dispatches, and — now that W0a keeps such a Run visible — its
attempts would drain into `FAILED`, turning "waiting for quota" into a failure. `state-machine.md`
§10.2 scopes that bullet itself, in its own parenthesis: "(this is `loopmill resume --due`)". The
bullets need an entrypoint that can honour the action they produce, which is exactly what W1 builds.
`observe_deadline` is dropped from W0b entirely: the `observed` backend was removed from the design in
v0.6, so that bullet has no producer to write.

The one thing W0a leaves genuinely undone is the index itself — the scan still enumerates `locks`
rows, which is why it can only ever reach the lease bullet. That moves to W0b with the rest.
| W5 | The A25 finding schema, the loop-file amendment for a cycle-scoped reference, and the retry-feedback hand-off | W2 | not started |
| W6 | The nightly loop file, then seven consecutive nights (the cut-line) | W1-W4 | not started |

### 4.1 What W1 settled

**Exit 23 has a producer, and `--decision` has no default.** m1 left this open because the answer
depended on what `resume` would do (`m1-plan.md` §6). The frozen table (`state-machine.md` §12.2) says
only "Process exited with the Run in `INTERRUPTED`" — the "(only via `status` after a crash)" gloss
exists solely in `mvp-design.md` §7.3's reproduction, and named a producer that did not exist.
`loopmill resume <runId>` on an `INTERRUPTED` Run with no `--decision` now reports what the Run is
waiting on and exits `23`, writing nothing and taking no lock. `--decision` has no default because
§10.3 defines `INTERRUPTED` as the state where the node "could **not** be safely re-dispatched without
a human deciding": a Run only reaches it on an `effects: external` node, which may already have run
before the lease that made it look lost expired, so a default of `retry` would risk exactly the double
side effect the state exists to prevent.

**`resume --due` never decides for a human.** Four places in `mvp-design.md` said an `INTERRUPTED` Run
is recovered by `resume --due` (§7.4, §7.5, the §8 state bullet, and criteria A11 and A35). That
contradicts two frozen statements: §10.2 lists `resumed{kind: due}` for `WAITING_FOR_QUOTA` Runs only,
and §10.3 requires a human decision. All five were corrected to name
`resume <runId> --decision retry|skip|fail`. These are corrections, not amendments: `mvp-design.md` is
not among the contracts `m0-contract-freeze.md` §2 freezes, and each correction moves it *towards* the
frozen text. §7.5's sweep paragraph was additionally rewritten for W0a — it still described the row as
released unconditionally.

**Its exit codes needed no new space.** `resume` uses `run`'s table unchanged, exactly as `gates.ts`
already says of `approve`/`reject` ("this is a resumed `run`, not a different command family"). The one
genuinely new rule is for the batch form: `resume --due` exits `0` on a normal drain whatever the
individual Runs did, because a drained Run's outcome is data for the report, not the batch's status —
the same rule §7.3 states for the node executor.

**Two things the brief for this wave got wrong**, both caught against the frozen schema rather than
assumed: `resumed` carries no `cycle`/`nodeId`/`attempt` (`envelope.schema.json` sets all three to the
`false` subschema for run-level events, and the engine reads `snapshot.current`/`snapshot.interrupted`
instead), and it *requires* `reason`, which mirrors `resume.kind` the way the normative example
`envelope-examples/resumed.json` does.

**`cancel` reached the CLI.** `decideGate` already accepted the decision and the engine already handled
it; only the command was missing, so `loopmill cancel <runId>` is now wired alongside `approve`/`reject`.

## 5. Acceptance criteria this milestone must meet

In full: A11 and A35 (interruption and recovery), A17 (quota parking, its backend half), A19 (the
red-team gate check under a real unattended run), A26 (human gates), A27 (dedupe), A30 (budget), A36
(`doctor --scheduler`), A37 (`resume --due`). Advanced but not completed here: A29 and A32 (the report
and traceability, whose UI half is m3), A39 (`doctor --json`, whose full check list is m3). A25 is m2's
as of the 2026-09-08 decision recorded in `mvp-design.md` §20.2.

A26 says "in all three modes"; per decision 1 in §6, m2 meets it for `cli` and `pull-request-review`,
and `label` moves to m3.

## 6. Decisions taken

**1. `mode: label` moves to m3 (maintainer, 2026-09-08).** The cut-line uses `pull-request-review`, so
`label` would have shipped exercised only by tests, and it cannot be built as specified in any case:
three frozen sources say an approval is *adding* `loopmill:approve` (`loop-file.md:579`,
`loop-file.schema.json:493`, and the reference loop's own comment) while `envelope.md:656` maps it to
*removing* a `loopmill:hold` label that appears nowhere else in the repository. The reason for
deferring is m1's own evidence: five defects survived 619 passing tests and were found only by a dry
run, a pre-flight and one live run, so a gate mode the cut-line never exercises carries exactly that
risk — and building it would additionally spend an amendment settling a contradiction with no real
consumer to settle it against. The cost accepted is that A26 is met in two modes of three at the end
of m2, and that the reference loop under `examples/` stays unrunnable as written until m3.

**2. A25's hand-off is a cycle-scoped reference, and pays for the amendment (maintainer, 2026-09-08).**
`review` does not dominate `implement`, so `nodes.review.structured` is not a legal input of the node
being retried (LM-VAL-014). The alternative considered was injecting the findings through the existing
(currently dead) `retryHint` append-point, which needs no amendment but is invisible to the loop
author, cannot be validated as a reference, and fails at run time rather than at `validate`. It was
rejected because A25 does not stop at "the retry can see why the reviewer refused": it requires the
next cycle to **record which finding ids it addressed**, which is a data flow the loop has to name.
An appended prompt hint can carry the text but has nowhere to hang the ids, so it would satisfy the
easier half of A25 and leave the half the criterion is actually about undone. W5 therefore amends
loop-file 0.6 with a cycle-scoped reference form and reworks LM-VAL-014's wording so the dominance
rule still says something true. Part of that cost is already owed either way: `state-machine.md` §6.6
specifies `run.retryHint = "no_progress"` for a NO_PROGRESS retry and it is not implemented as
written.

Not decisions, recorded so they are not mistaken for them: exit code 23 is resolved as part of W1's
`resume` design (`mvp-design.md` §7.3's own parenthetical says "only via `status` after a crash", and
`cmdStatus` returns 0 unconditionally today, so both halves are unwired and W1 picks one); the
`skipReason` wording (§2.4) is a doc fix; the `pr` artifactRef mechanism (§2.4) needs no amendment.
