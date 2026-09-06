# Changelog — Loopmill MVP Design v0.5

**Date:** 2026-09-06. **Replaces:** `docs/design/mvp-design.md` v0.4 (52 sections).
**Why this document exists:** v0.5 is a rewrite, not an edit. This changelog records what changed section
by section, what was deleted and why, which decisions were taken outside the binding decision sheet, and
how each of the 102 findings from the v0.4 review (95 confirmed + 7 contested) is disposed of.

**Companion specs:** written in parallel; the design summarises and links, and where the two touched the
same field (the `approval` shape, the reference-grammar accessors, the Retry Edge's `from`, the human
node's `subject` and timeout, the reference loop's node ids and cycle count) the design was aligned to
`docs/spec/loop-file.md` and to the validated `examples/daily-content-improvement.loop.yaml`.

**Inputs:** the v0.5 decision sheet (binding), the maintainer's v0.5 positioning, the v0.4 review digest
and its eleven finding sets, the three-plan judge recommendation, SPIKE-2 documentary research, the
SPIKE-3 local harness result, and the verified CLI/vendor research briefs.

---

## 1. Headline changes

| # | Change | Why |
|---|---|---|
| 1 | **The document is now about contracts, not screens.** Sections are schemas, state transitions, exit codes and capability records; the only diagram left is the reference loop | The review's central verdict on v0.4 was that every load-bearing contract underneath the four principles was unwritten, which is where all 16 criticals sat |
| 2 | **Execution model: resident runner + OS scheduler → event-driven control plane.** `loopmill step` consumes one envelope, writes one commit, dispatches at most one node, exits. GitHub Actions is the MVP executor | Removes an entire failure class (schedule installation, session/keychain scope, cross-process locks, missed-run reconciliation, resident-process crash recovery) rather than specifying it. It is also the only shape in which "no Loopmill-owned always-on infrastructure" survives contact with an unattended loop |
| 3 | **State: local SQLite → an orphan git branch (`loopmill/state`) with compare-and-swap.** SQLite survives only as a disposable read model built by `loopmill sync` | The v0.4 database was simultaneously the source of truth, the IPC channel and the unbacked-up artefact. A git branch gives atomicity, audit, replication and conflict detection for free, and makes a Loop's history reviewable |
| 4 | **Positioning re-cut.** Four differentiators: bring-your-own subscriptions, cross-vendor/cross-backend loops, bounded loop semantics, loop-level observability. Daemonless local scheduling and the visual builder are explicitly *not* differentiators | Both vendors now ship first-party unattended scheduled agents, so "daemonless local cron" is no longer a product; and "multiple agents supported" was ruled out by the maintainer |
| 5 | **Runtime, Execution Backend and Authentication Mode are three separate axes**, each with a declared capability record that the validator and the reports read | v0.4's "Agent Runtime" conflated *which CLI* with *where it runs* and *how it authenticates*, which made the cross-vendor claim unspecifiable |
| 6 | **Usage becomes coverage-qualified.** Four disjoint buckets (plus `reasoningTokens`, reference only and never summed), per-runtime mapping, provenance including `unavailable`, and a coverage figure printed next to every token number | The v0.4 record encoded Anthropic semantics only; applied to Codex it inflated input by ~1.9x, and its worked example matched no vendor's arithmetic |
| 7 | **Every vendor claim now carries a verification tag** (`[V]`/`[L]`/`[U]`/`[S]`), and section 19 says what may and may not be published | Half the compliance premise rests on pages that could not be read from the research environment; v0.4 treated both vendors identically |
| 8 | **Acceptance criteria renumbered A1-A40 and made failure-path.** The visual builder no longer gates anything | v0.4's 30 criteria were a happy-path v1 that could all pass on a watched, hand-started run |

---

## 2. Section by section

**Legend:** *new* = no v0.4 counterpart; *rewritten* = same subject, different content; *removed* = the
v0.4 material is gone and why.

| v0.5 section | Status | What changed, and why |
|---|---|---|
| **1. Overview and problem** | rewritten (v0.4 §1-3) | Keeps the relay-work problem but states the sharper one: running *one* agent unattended is now a free first-party feature, so the product is the bounded cross-vendor loop, not the automation. Adds the verification legend and the companion-spec map |
| **2. Positioning and differentiators** | rewritten (v0.4 §46-48, §52) | Four differentiators with a falsifier each, plus an explicit "not a differentiator" table. Deletes the v0.4 four-term product formula that contained a term (daemonless local scheduling) that is no longer defensible and one (visual builder) that is post-MVP |
| **3. Principles** | rewritten (v0.4 §5) | Five principles replace four. "Local-first" is demoted from a principle to a deployment option; "Daemonless/Zero-idle" narrows to "no Loopmill-owned always-on infrastructure"; "Subscription-native" gains the qualifier *where the vendor allows it* and an explicit "what it does not promise" (account-level overage is invisible to any client) |
| **4. Domain model** | new | The concept/definition/identity table from the decision sheet, the aggregation hierarchy, and vocabulary rules (Loop not Workflow; Retry Edge not Loop Edge). v0.4 had a four-line hierarchy and two names for the same object |
| **5. Loop definition** | new (replaces v0.4 §11-12, §30) | The Loop is a versioned file with a published JSON Schema, not rows in a database. Summarises the shape and the validation rules (27 numbered rules with stable codes in the spec), and carries the **entire reference loop inline** so that every later section has a concrete referent. Detail lives in `docs/spec/loop-file.md` |
| **6. Runtimes, backends, auth, capabilities** | new (replaces v0.4 §8-10, §41) | The capability record, the four MVP backends with a capability table, the two runtimes with their verified non-interactive contracts, four authentication modes, and five hard rules for the `api-key` opt-in |
| **7. Control plane `loopmill step`** | new | The contract, the seven-step algorithm, three exit-code namespaces, idempotency keys, the write-dispatch-before-call rule, concurrency by compare-and-swap, and the two interfaces that keep it portable |
| **8. Event bus and Envelope** | new (replaces v0.4 §32) | The envelope's required fields, the 17 MVP event types, four transports with their constraints, a 32 KiB size rule, and six anti-loop rules including "no implicit triggers" and strict fenced-block parsing |
| **9. State persistence** | rewritten (v0.4 §30-31) | Branch layout, one commit per event batch, atomicity, conflict handling, growth control, `gc` as the only force-push, and SQLite reduced to a rebuildable read model |
| **10. State machine** | rewritten (v0.4 §14) | Run, Node Execution and Attempt states as three separate lists with terminal outcomes; adds `WAITING_OBSERVED`, `INTERRUPTED`, `MAX_ITERATIONS_EXCEEDED`, `BUDGET_EXCEEDED`, `EXPIRED`, `SKIPPED`, `NO_PROGRESS`, `LOST`; removes `PAUSED`. Detail in `docs/spec/state-machine.md` |
| **11. Node I/O and templating** | new | The single largest gap in v0.4. Persisted I/O record, dotted reference grammar, scalar-only substitution, argv binding rule, structured-output re-validation, condition semantics, and `sessionPolicy: fresh` |
| **12. Human nodes on GitHub primitives** | rewritten (v0.4 §17-18) | Three gate modes mapped onto GitHub Environments, PR reviews and labels; approval bound to a subject digest; retries invalidate approvals; the auto-approval exemption is a written, recorded, per-node concession rather than a default |
| **13. Security boundary and environment policy** | new (replaces v0.4 §7, §35) | Job/permission/credential split, the deny/preserve/inject environment policy, untrusted-input marking, and persistence-time redaction |
| **14. Usage normalization, coverage and budget** | rewritten (v0.4 §19-25, §35) | Canonical record, per-runtime mapping table, provenance rules, the coverage formula and its rendering rules, and a seven-field budget with pre-dispatch enforcement. Detail in `docs/spec/usage-normalization.md` |
| **15. Loop observability** | rewritten (v0.4 §15-16, §36-37) | Six defined metrics, ten terminal-first commands with `--json`, and a read-only UI with an explicit security posture. The browser is no longer the only read path |
| **16. Reference loop walkthrough** | new (replaces v0.4 §42-43) | Every node as Runtime × Backend × Auth with a named fallback if its spike fails, the thirteen envelopes exchanged, the human gate, and the four shapes the maintainer can see at 07:00 |
| **17. Failure UX** | new | Exit-code contract, run report to three sinks, notification delegated to GitHub's channels with the limitation stated, and an answer for the crash before the first state write |
| **18. Git, Issue and PR lifecycle** | new (replaces v0.4 §33-34) | Branch naming, one commit per cycle, dedupe and `SKIPPED`, what exhaustion leaves behind, bidirectional run↔PR traceability, and no automatic merge |
| **19. Compliance posture** | new | A quote table with a verification status per row, and five rules for the policy page - including that nothing may be claimed from a page that could not be read |
| **20. MVP scope** | rewritten (v0.4 §44) | Backends with their gates, four milestones totalling 13 weeks, and 40 renumbered acceptance criteria in six groups, of which one full group is failure-path |
| **21. Non-goals** | rewritten (v0.4 §45) | Every row now carries a reason, and "never" is separated from "post-MVP" and "blocked upstream" |
| **22. Spikes and STOP conditions** | new | Four spikes with what each decides, and three STOP conditions that must be evaluated in writing at the end of m0 |
| **23. Prior art** | rewritten | Restated as Loopmill's own engine decisions (what the survey confirmed, what it warned against), plus a table of the vendors' own automation products and the general workflow engines surveyed |
| **24. Open questions** | new | Seven, including runner overhead per event, the `GITHUB_TOKEN` chaining dependency, cross-run contention, whether a permanently unmeasured node is worth keeping, and the unbudgeted prompt engineering |
| **Appendix A** | new | Old term → new term, so v0.4 readers can navigate |
| **Appendix B** | new | All 52 v0.4 sections mapped to v0.5 sections |

### v0.4 material deleted outright

| v0.4 content | Why it is gone |
|---|---|
| §26-28 OS scheduling, zero-idle diagrams, `reconcile` | Scheduling is GitHub's; there is no Loopmill scheduler to install, and therefore no missed-schedule reconciliation to specify. Recorded as a non-goal |
| §29, §31 Runner/UI separation and SQLite as an IPC channel | There is no runner and no shared writer; the UI reads a disposable projection |
| §32 Control Queue | Replaced by one event stream; a second command channel would need its own idempotency and authorisation model |
| §11 Visual Loop Builder, §15-16 monitor/inspector mockups, §21-24 token screens, §37 doctor screenshot | Screens are not contracts. The information they promised is now a field list (§11, §15.1) or a command output (§15.2) |
| §38 Technology stack section | Reduced to the few decisions that are load-bearing (`node:sqlite` read model, loopback UI); the rest is implementation freedom |
| §40 Future Remote Mode | Contradicts §3.5; if it ever exists it is someone's own deployment, not a Loopmill service |
| §49-52 Name and messaging | Belongs in the README, not in a design of record |

---

## 3. Decisions taken outside the decision sheet

Marked in the design as **Decision (not in sheet)**; each is a place where the sheet was silent and this
document had to choose.

| Where | Decision | Rationale |
|---|---|---|
| §7.3 | `loopmill run` (local driver) maps terminal outcomes to exit codes in a separate namespace from `step`; `run-node` exits non-zero only when it could not *report* | The sheet fixes `step`'s codes and says outcomes are not `step` exit codes; a human-run local driver still needs the outcome in `$?`, and node failure must not look like a broken runner |
| §12 | The design defers to `docs/spec/loop-file.md` for the exemption shape (`approval.policy: auto` + a mandatory `reason` + an optional `nodes` narrowing) and states the policy consequence only | The sheet allows `approval.policy: auto` "with a reason" but does not say where the reason lives; the loop-file spec owns the field, and the design must not invent a second spelling of it |
| §15.3 | The UI binds loopback only, mints a per-invocation token, emits no CORS headers, and is read-only in the MVP | The sheet scopes the UI as read-only but not its network posture; adopted from the v0.4 review's security finding |
| §17.3 | No Loopmill notification channel at all in the MVP; notification is delegated to GitHub's own channels, with the limitation stated | Any first-party channel is either always-on infrastructure (§3.5) or a per-OS integration Loopmill just removed |
| §17.4 | The trigger workflow mints `runId` and writes the envelope to its job summary before invoking `step`; `doctor --orphans` reconciles control-workflow runs against runs on the state branch | Closes the "crash before the first state write" case without a second state store |
| §18 | Working branch `loopmill/<loop>/<runId>`; one commit per cycle with a defined message; `dedupeKey = sha256(loopId + ':' + declared dedupe input)` defaulting to the entry node's resolved inputs | The sheet names the state branch and the `SKIPPED` outcome but not the working-branch name, the commit cadence or how the key is computed |
| §20.3 | The acceptance criteria are renumbered A1-A40 and grouped A-F, absorbing the sheet's list of carried-over additions | The sheet lists the additions but not a numbering; stable numbers are needed for traceability |

Two places where this document deliberately reports a **tension** rather than resolving it:

* The decision sheet keeps `observed` (Codex Cloud) inside the MVP, gated on SPIKE-2's R-runs; SPIKE-2's
  own recommendation is that it is post-MVP and at best a *degraded-GO*, because usage is `unavailable`
  and there is no per-task quota predicate. §6.2, §20.1 and §24.4 carry that tension explicitly rather
  than hiding it behind the gate.
* The judge recommendation put m3 at four weeks (14 total); the decision sheet says three (13 total).
  §20.2 follows the sheet and notes that the visual builder is outside the number either way.

---

## 4. Disposition of the v0.4 review findings

All 102 findings (95 confirmed, 7 contested) are listed. `§` in the *v0.4 issue* column refers to **v0.4**
sections as the reviewers wrote them; `§` in the last column refers to **v0.5** sections in the rewritten
document.

Counts: **16 critical, 46 high, 40 medium.** Dispositions: 85 resolved, 5 resolved by removal (the v0.4
mechanism no longer exists), 7 partially resolved with the remainder named, 2 deferred with a named home,
2 resolved with an explicitly stated limitation, 1 accepted as a measured cost. **Nothing critical or high
is silently dropped**, and no finding is closed by assertion: each disposition points at a section, a
schema or an acceptance criterion.

| # | Finding | Sev | Review status | v0.4 issue | Disposition | How v0.5 addresses it |
|---:|---|---|---|---|---|---|
| 1 | `daemonless-ops-1` | critical | confirmed | Nothing specifies how a schedule is installed; launchd/systemd/Task Scheduler env, session and keychain constraints... | **Resolved by removal** | No OS scheduler exists in v0.5. A schedule is `trigger.schedule {cron, tz}` in the loop file, executed by GitHub Actions (§3.5, §5.1); launchd/systemd/Task Scheduler are non-goals (§21). Residual: GitHub's own scheduling behaviour is SPIKE-3 work. |
| 2 | `daemonless-ops-2` | critical | confirmed | A runner killed mid-node leaves the Run in RUNNING forever; no lease, heartbeat or INTERRUPTED state | **Resolved** | Attempt leases, `LOST`, `lease-expired`, `INTERRUPTED` and a sweep at the top of every entrypoint (§7.4, §9.2, §10); `resume --due` re-dispatches (§15.2). Criterion A35. |
| 3 | `daemonless-ops-3` | critical | confirmed | No cross-process run lock: the OS scheduler, a manual Run and reconcile can execute the same workflow concurrently... | **Resolved** | There is no shared workspace and no competing process. Correctness is the compare-and-swap push plus a per-`runId` concurrency group (§7.5, §9.2); a duplicate trigger becomes `SKIPPED` by `dedupeKey` (§18). A10, A27. |
| 4 | `execution-semantics-1` | critical | confirmed | Node Input/Output are never defined and there is no templating or expression language, so the reference workflow ca... | **Resolved** | §11 defines the persisted I/O record, the dotted reference grammar and `${name}` scalar substitution; the reference loop is written out in full in §5.3. A5-A7. |
| 5 | `failure-ux-and-notifications-1` | critical | confirmed | `loopmill run` has no exit-code contract, yet that integer is the only thing all three OS schedulers keep | **Resolved** | §7.3 defines three exit-code namespaces (`step`, `run`, `run-node`), and §17.1 makes them contract. A12. |
| 6 | `failure-ux-and-notifications-2` | critical | confirmed | The runner keeps no log of its own, and a crash before the first DB write leaves no trace on any of the three platf... | **Resolved** | §17.2 writes a run report to the job summary, an artifact and a comment; §17.4 covers the crash before the first state write with `doctor --orphans`. A36. |
| 7 | `git-workspace-and-forge-lifecycle-1` | critical | confirmed | Nothing creates a branch, commits, or pushes, so §44's criterion 19 (`gh pr create`) provably fails in a scheduled run | **Resolved** | §18 defines branch naming `loopmill/<loop>/<runId>`, one commit per cycle, and PR creation after the gate. A20, A32. |
| 8 | `observability-data-2` | critical | confirmed | TokenUsage encodes Anthropic semantics only; applied to Codex it inflates input ~1.9x, and it cannot represent the... | **Resolved** | §14.1 replaces the Anthropic-shaped record with four disjoint buckets plus `model` and `provenance`; §14.2 maps each runtime normatively. A28. |
| 9 | `observability-data-3` | critical | confirmed | Codex turn.completed.usage is thread-cumulative; a Loop Edge retry on a resumed thread multiply-counts every cycle... | **Resolved** | §14.2: per-attempt usage is the cumulative diff, and `sessionPolicy: fresh` (§11) makes that diff the attempt. A28. |
| 10 | `prompt-contract-and-loop-efficacy-1` | critical | contested | The review artifact -- the one thing that must travel between vendors -- is never specified; it is a free-text Agen... | **Resolved** | The review artifact is a published schema - pass, plus per-finding id, path, line, severity and suggested change - re-validated by Loopmill and bound to `reviewedSha` (§5.3, §11, A25). |
| 11 | `runtime-integration-1` | critical | confirmed | Agent Node has no permission/sandbox setting, and the flags an unattended run needs have changed under the design | **Resolved** | `permissionProfile` is required on every agent node and passed explicitly (§5.1, §13.2); the effective command line is persisted (§11); flags are pinned per runtime version (§6.3). A16. |
| 12 | `runtime-integration-2` | critical | confirmed | WAITING_FOR_QUOTA has no machine-readable signal on either runtime; as specified it is not implementable | **Resolved** | §10: parking requires a fixture-backed classifier verdict AND a recorded `quotaResetsAt`; ambiguity is `FAILED`; documented transient look-alikes are excluded. A17. |
| 13 | `runtime-integration-3` | critical | confirmed | Subscription Only Mode strips the wrong set of variables, and never says which variables must be preserved | **Resolved** | §13.2 replaces the four-name scrub with mandatory deny / preserve / inject lists - the preserve list is named for the first time. A15. |
| 14 | `security-1` | critical | confirmed | Unattended execution authority is unspecified: no permission mode, sandbox mode, or tool allowlist anywhere in the... | **Resolved** | §13.1 splits the control-plane and agent jobs by permission and credential; §5.1 requires a permission profile; §12 requires a human gate on `effects: external`; §6.5 bounds `api-key`. |
| 15 | `subscription-economics-and-plan-fit-1` | critical | confirmed | The flagship loop costs 1.2-4.3 M tokens per run and the doc never asks whether that fits a subscription; on its ow... | **Resolved (mechanism), open (arithmetic)** | §14.4 adds `maxMeasuredTokens`, `maxRunsPerWindow` (1 per 5h), `minInterval`, `maxUnmeasuredExecutions`; A30 is the plan-fit test. Whether the loop fits a given plan is now measured rather than assumed (§24.6). |
| 16 | `subscription-economics-and-plan-fit-2` | critical | confirmed | §35 Safety Limits has no quota axis: no per-run budget, no per-window budget, no minimum interval, no max runs per... | **Resolved** | §14.4 is the quota axis v0.4 lacked; a breach is `BUDGET_EXCEEDED` before dispatch, never a mid-attempt kill. |
| 17 | `daemonless-ops-4` | high | confirmed | After Approve, nobody launches the runner: the Control Queue has no consumer while a run is WAITING_APPROVAL | **Resolved** | Approval is a GitHub Environment approval, ingested as `human-decided` (§12, §8.3); `resume --due` is the named drain (§15.2). A37. |
| 18 | `daemonless-ops-5` | high | confirmed | reconcile has no trigger and competes with each OS's own catch-up: the same missed run either fires twice or not at... | **Resolved by removal** | There is no `reconcile` and no second scheduler to race. Triggers that produced no run are found by `doctor --orphans` (§17.4). |
| 19 | `daemonless-ops-7` | high | confirmed | "The Runner checks the Control Queue at safe points" is the whole cancel spec; CANCEL is invisible for 40 minutes a... | **Resolved** | Cancellation is a declared backend capability (§6.1-6.2) - job cancel on `github-actions`; the usage record is protected by never killing mid-attempt on tokens (§14.4) and by storing `unavailable` when a turn is lost (§14.2). A18. |
| 20 | `daemonless-ops-8` | high | confirmed | WAITING_FOR_QUOTA is manual-resume-only, and reconcile has no defined behaviour for a run that is neither finished... | **Resolved** | `resume --due` drains quota-parked runs whose `quotaResetsAt` has passed, in the same pass as approvals and expired leases (§15.2). A37. |
| 21 | `dx-distribution-1` | high | confirmed | There is no install or first-run path: no package, no Node floor, no SQLite driver decision, no migration owner | **Partially resolved** | §20.2 puts the npm package, docs and policy page in m3 and §9.4 fixes the SQLite driver (`node:sqlite`, WAL); the Node floor, package layout and migration owner are named m3 deliverables, not specified in this document. |
| 22 | `dx-distribution-3` | high | confirmed | §36's five commands cannot satisfy §26, §17, §28 and §44: nothing installs a schedule, nothing approves, nothing sh... | **Resolved** | §15.2 defines ten terminal-first verbs with `--json`, and §7 defines `step`, `run` and `run-node`. No section now depends on a command that does not exist. |
| 23 | `execution-semantics-2` | high | confirmed | "Cycle" is not computable from the graph, and section 22's own example contradicts section 42's graph | **Resolved** | §4 defines Cycle as one Retry Edge body traversal with identity `(runId, cycleIndex)`, cycle 0 as setup/teardown, and the averaging rule; §5.3 and §16.1 agree. |
| 24 | `execution-semantics-3` | high | confirmed | Loop Edge iteration counting is unscoped and the behaviour at maxIterations is undefined; sections 12 and 42 disagr... | **Resolved** | §10: `MAX_ITERATIONS` is checked before dispatching the edge target, and exhaustion is `MAX_ITERATIONS_EXCEEDED`. A23 pins the count to exactly `maxIterations`. |
| 25 | `execution-semantics-4` | high | confirmed | Cancellation and Timeout are specified in a way that silently destroys the token record section 19 promises | **Resolved** | §14.4 forbids mid-attempt kills on tokens; a killed or timed-out attempt stores `unavailable` with `complete:false`, never 0 (§14.2). A18. |
| 26 | `execution-semantics-5` | high | confirmed | There are no Run-level states, no terminal-outcome model, and no END node type although two sections' diagrams use one | **Resolved** | §10 lists Run states and terminal outcomes; §5.1 adds the `end` node kind carrying an `outcome` label. |
| 27 | `execution-semantics-6` | high | confirmed | Node failure has no defined effect on the Run and there are no failure edges, which breaks the Test step of the ref... | **Resolved** | `onFailure: fail_run` / `continue` / `retry_edge:<id>` (§5.1); the reference loop's `test` node uses the retry edge (§5.3). |
| 28 | `execution-semantics-7` | high | confirmed | Structured output extraction and the Condition expression language are unspecified, including behaviour when output... | **Resolved** | §11: structured output is a JSON Schema re-validated by Loopmill for both runtimes; a condition over missing or non-conforming input is an ERROR. A7. |
| 29 | `execution-semantics-8` | high | confirmed | Retry Node / Retry From Here / Skip have no semantics, are absent from the Control Queue, and Command Nodes have no... | **Resolved** | Retry is exactly two things: an Attempt (infrastructure only) or a Retry Edge traversal (§4, §10). There is no ad-hoc retry/skip verb; command idempotency is handled by `effects`, `dedupeKey` (§18) and human gates (§12). |
| 30 | `failure-ux-and-notifications-3` | high | confirmed | Nothing ever tells the user anything: §45 removes the remote channels and puts no local one in their place, so ever... | **Resolved, with the limitation stated** | §17.3 delegates notification to GitHub's own channels and says plainly what happens when the operator has muted the repository; a first-party channel is open question §24.5. |
| 31 | `failure-ux-and-notifications-4` | high | confirmed | Every read path is the React Flow UI; there is no way to ask "what happened at 06:00?" from a terminal | **Resolved** | §15.2 is terminal-first, and §16.4 answers 'what happened at 06:00?' without a browser. A33. |
| 32 | `failure-ux-and-notifications-5` | high | confirmed | §44's 30 criteria are entirely happy-path; add failure-path criteria, starting with a kill -9 at 06:00 the user lea... | **Resolved** | §20.3 group F is entirely failure-path, plus A17-A19 and A35-A36. |
| 33 | `git-workspace-and-forge-lifecycle-2` | high | confirmed | A daily loop with no merge step re-observes the same defect every morning; nothing says what run N+1 does when run... | **Resolved** | §18 defines `dedupeKey`, the open-change index and the `SKIPPED` outcome (§10). A27. |
| 34 | `git-workspace-and-forge-lifecycle-3` | high | confirmed | §30 stores no repo, branch, SHA, Issue number or PR URL, so §16's Git Diff has no anchor and §24's metrics can neve... | **Resolved** | Events carry `artifactRefs[]` (commit, branch, pr, issue, comment, file) (§8.1), and §18 makes run<->PR traceability bidirectional. A32. |
| 35 | `git-workspace-and-forge-lifecycle-5` | high | confirmed | Non-interactive `gh` credential is unsettled: §7's scrub and the OS credential store pull in opposite directions, a... | **Resolved** | The agent job's `GITHUB_TOKEN` is the only git/gh credential, scoped per node by `effects` (§13.1-13.2). No OS credential store is involved. |
| 36 | `git-workspace-and-forge-lifecycle-6` | high | confirmed | Nobody commits, so `Git Diff` has no base and cycle 2's fix has no defined relationship to cycle 1's | **Resolved** | One commit per cycle with a defined message (§18), so cycle n's fix diffs cleanly against cycle n-1. |
| 37 | `observability-data-1` | high | confirmed | The §21 worked example does not add up under any vendor's semantics, and §22 inherits the error | **Resolved** | The v0.4 worked example is deleted. §14.2 gives the arithmetic per runtime and A28-A29 test it against recorded fixtures. |
| 38 | `observability-data-6` | high | confirmed | §30 is a list of table names: no keys, no indexes, no size caps for stdout/logs/diffs, no retention - the shared DB... | **Resolved** | §9.1 gives an explicit layout with keys; §9.3 keeps logs, diffs and outputs off the state branch and adds `gc` with a retention window; §9.4 makes SQLite a rebuildable read model. A38. |
| 39 | `product-scope-1` | high | confirmed | Daemonless local scheduling is no longer uncontested — Anthropic ships it first-party, so the four-term differentia... | **Resolved** | §2 removes daemonless local scheduling from the differentiators (first-party products now ship it) and re-cuts positioning around cross-vendor, cross-backend bounded loops; §3.5 narrows the infrastructure claim. |
| 40 | `product-scope-2` | high | confirmed | §44's 30 acceptance criteria are a v1 (~13–18 weeks), not an MVP; split into M1 (≈12 criteria, 4–6 weeks) and M2 | **Resolved** | §20.3 renumbers the criteria to A1-A40 across four milestones, and the builder gates nothing (§20.2). |
| 41 | `product-scope-3` | high | confirmed | No Node I/O contract: the §42 reference loop cannot be expressed with the §12 node set, so the dogfood target is un... | **Resolved** | §11 plus the complete reference loop in §5.3; every node's inputs resolve to a declared reference. |
| 42 | `product-scope-4` | high | confirmed | "Subscription-native" as stated in §5.1/§7 is unenforceable on both runtimes and legally asymmetric between them | **Resolved** | §3.1 states what Loopmill actually controls and what it cannot promise (account-level overage); §19 treats the two vendors separately. |
| 43 | `product-scope-6` | high | confirmed | Make a versioned file the Loop's source of truth and the Visual Builder a v1 surface; today a Loop exists only as r... | **Resolved** | The loop file is the source of truth with a published JSON Schema (§4, §5); SQLite is a disposable read model (§9.4). The builder is post-MVP (§20.2). |
| 44 | `product-scope-7` | high | confirmed | "Token Observability" is the wrong pillar name under flat subscriptions — rename pillar 5 to Loop Efficiency and le... | **Resolved** | The pillar is loop observability (§3.4, §15.1): outcome, retries, duration, measured tokens and coverage - tokens are one of six metrics, not the headline. |
| 45 | `product-scope-8` | high | confirmed | No 15-minute path exists: no template, no `init`, no dry run, and the first scheduled run is the most likely silent... | **Partially resolved** | `--dry-run` (A16), `validate`, `doctor` and the `fake` backend give a zero-token first path; a bundled template and an `init` verb are m3 documentation work and are not specified here. |
| 46 | `prompt-contract-and-loop-efficacy-2` | high | confirmed | A 3-iteration loop with an unconstrained reviewer oscillates: nothing stops style rejections, exhaustion is the exp... | **Resolved** | The verdict schema binds findings to a SHA (§5.3, A25), `NO_PROGRESS` stops budget-burning no-ops (§10, A24), and exhaustion is an expected outcome with its own bucket (§15.1). |
| 47 | `prompt-contract-and-loop-efficacy-5` | high | confirmed | §24 draws outcome conclusions from a schema with no outcomes: nothing records whether findings were addressed, whet... | **Resolved** | Outcomes are first-class (§10) and §18 makes the PR/Issue joinable to the metrics. A32. |
| 48 | `runtime-integration-10` | high | contested | "Subscription-native" as a headline: what is defensible, what is not, and one clause that cuts against Section 7 | **Resolved** | §2 and §3.1 state the defensible version of the claim; §19 sets the rules for the policy page, including what may not be claimed. |
| 49 | `runtime-integration-4` | high | confirmed | No version pinning, capability matrix, or contract tests - and Claude's announced `--bare` default would void the c... | **Resolved** | §6.3 pins a tested version range per runtime, forbids `--help` scraping for capabilities, requires fixture contract tests, and names `--bare` as a verified threat to `subscription-oauth`. |
| 50 | `runtime-integration-5` | high | confirmed | The AgentRuntime interface omits capabilities, session identity, a typed result, and cancel semantics - and cancel... | **Resolved** | §6.1's capability record plus the `Dispatcher`/`StateStore` interfaces (§7.6); cancel is a declared capability, not an assumption. |
| 51 | `runtime-integration-6` | high | confirmed | Agent Node "Timeout" is a setting with no CLI behind it, and the hang it exists to catch is a filed upstream bug | **Resolved** | Timeouts are enforced by the executor because `codex exec` has no timeout flag; `node-timed-out` is an event (§8.1) and the no-TTY hang is A14. |
| 52 | `runtime-integration-7` | high | confirmed | Loop Edge retry never says whether the agent session is resumed - and the two runtimes need opposite answers | **Resolved** | `sessionPolicy: fresh` is the only MVP value (§11); objections travel through node I/O; `sessionId`/`threadId` are recorded so resume can be added additively. |
| 53 | `runtime-integration-8` | high | confirmed | "Expected Structured Output" is one setting hiding two incompatible contracts, and its failure mode has no state | **Resolved** | `structuredOutput` is a JSON Schema plus a backend capability flag; a schema violation is `FAILED(structured_output_invalid)` (§5.2, §11). |
| 54 | `runtime-integration-9` | high | confirmed | Runtime Health checks the wrong things for a scheduled tool: no login expiry, no macOS keychain reachability, no re... | **Resolved** | `doctor` probes resolved binaries, versions, auth method, login expiry and a no-TTY spawn, with stable check ids (§15.2). A39. |
| 55 | `security-2` | high | confirmed | Reviewed content is untrusted input, and the reference Loop pipes it straight to `gh` with no human gate | **Resolved** | Untrusted content is marked with a caution banner (§13.3) and every `effects: external` node needs a human gate unless an `approval.auto` entry with a written reason covers it (§12, §5.3). A19. |
| 56 | `security-3` | high | confirmed | Command Node is an unstructured shell string with no allowlist, and it is the one step with network, credentials, a... | **Resolved** | A command node is `argv: string[]` executed with `shell:false`, one placeholder per element, never re-parsed (§5.1, §11). A6. |
| 57 | `security-4` | high | confirmed | The local UI server has no specified bind address, authentication, or origin check, yet it can start Runs and appro... | **Resolved** | §15.3: read-only UI, loopback bind with no widening flag, per-invocation token, no CORS. A34. |
| 58 | `security-5` | high | confirmed | "Allowed Workspace" is named but never defined or enforced, and the MVP runs unattended agents on the user's live c... | **Resolved** | Isolation is a declared backend capability (§6.2) and no run touches the operator's tree (§18). A20. |
| 59 | `security-6` | high | confirmed | Section 7 scrubs four API keys and inherits everything else, including `GITHUB_TOKEN` and `ANTHROPIC_BASE_URL` | **Resolved** | §13.2's deny list covers base-URL and cloud-provider overrides and `GH_TOKEN`/`GITHUB_TOKEN` unless the node is external. |
| 60 | `security-8` | high | confirmed | SQLite holds prompts, outputs, stdout/stderr and diffs in plaintext with no redaction, file mode, or retention rule | **Resolved** | Redaction happens at persistence time (§13.4); logs and diffs never reach the state branch (§9.3); `gc` enforces retention. A38. |
| 61 | `security-9` | high | confirmed | Scheduler registration is a privileged, unverified write, and the plist/unit is a persistence channel the agent its... | **Resolved by removal** | No scheduler registration exists, so the plist/unit persistence channel is gone. |
| 62 | `subscription-economics-and-plan-fit-4` | high | confirmed | The legitimacy premise is now half-settled and asymmetric: Anthropic verifiably sells unattended scheduled subscrip... | **Resolved** | §19 describes the vendors separately, quotes only text that was read, and labels every OpenAI row as primary-source-unreachable with its date. |
| 63 | `daemonless-ops-10` | medium | confirmed | Live monitoring is promised but has no mechanism: SQLite has no pub/sub, and no log-write or poll cadence is specified | **Resolved** | Live progress is the Actions job log and the event stream; the UI reads the folded read model (§9.4, §15.3). No pub/sub is promised. |
| 64 | `daemonless-ops-6` | medium | confirmed | SQLite is the IPC channel between two processes, but WAL, busy_timeout, driver choice and migration ownership are a... | **Resolved by removal** | SQLite is no longer an IPC channel between two processes; it is a rebuildable read model opened WAL with a busy timeout, absent from the control plane (§9.4). |
| 65 | `daemonless-ops-9` | medium | confirmed | Workflow definitions exist only as SQLite rows: not git-reviewable, not portable, and the OS scheduler entry is pin... | **Resolved** | The loop definition is a git-reviewable file identified by an immutable slug (§4, §5.1). |
| 66 | `dx-distribution-10` | medium | contested | No name-to-artifact mapping, no license metadata, and no telemetry statement — three things that must be settled be... | **Partially resolved** | The npm and PyPI names are free and the GitHub org is taken (verified in research); naming constraints from Anthropic's policy are in §19; the licence and telemetry statements are m3 documentation. |
| 67 | `dx-distribution-2` | medium | confirmed | Workflows exist only as SQLite rows: no file format, no schema, no validate/import/export, so loops cannot be autho... | **Resolved** | File format, published JSON Schema and `loopmill validate` (§5, §15.2). |
| 68 | `dx-distribution-4` | medium | confirmed | "node-pty when required" is undefined, and a daemonless runner is exactly the no-TTY case where `claude -p` is repo... | **Partially resolved** | A14 turns the no-TTY case into a test and records a per-runtime PTY requirement if one exists; `node-pty` is not adopted pre-emptively. |
| 69 | `dx-distribution-5` | medium | confirmed | No testing strategy anywhere, while every contract Loopmill depends on is an undocumented, version-fragile CLI string | **Resolved** | The `fake` backend, recorded fixtures and contract tests are MVP deliverables (§6.2; A17, A28, A31). |
| 70 | `dx-distribution-6` | medium | confirmed | Doctor is a screenshot, not a contract: no --json, no exit codes, and it probes the developer's shell rather than t... | **Resolved** | `doctor --json` with stable check ids and a non-zero exit on any failed check (§15.2, A39). |
| 71 | `dx-distribution-7` | medium | contested | §38 says "Monorepo" and names no packages, so the publish surface and the contribution contract for new runtimes ar... | **Deferred to m3** | Package layout and the contribution contract are m3 deliverables (§20.2); the runtime/backend/capability split (§6) defines the extension seam they must fit. |
| 72 | `dx-distribution-8` | medium | confirmed | Loopmill's own data and config locations are unstated, and the scheduled process will not inherit the environment t... | **Resolved** | State lives on `loopmill/state` (§9); the control-plane job's environment is the job's, not a developer shell's; the local read model has one resolved home. |
| 73 | `dx-distribution-9` | medium | contested | The React Flow builder is the largest unspecified deliverable and §44 makes it gate everything else; the UI server'... | **Resolved** | The builder is post-MVP; the m3 UI is read-only with an explicit security posture (§15.3, §20.2). |
| 74 | `execution-semantics-10` | medium | confirmed | A Run does not pin a Workflow Version, although section 18's design guarantees the definition can change mid-Run | **Resolved** | A Run pins `loopVersion` at start and replays it on resume (§4). A2. |
| 75 | `execution-semantics-9` | medium | confirmed | Session continuity between Agent Nodes is not modeled, so "control returns to Claude Code" has no mechanism -- and... | **Resolved** | `sessionPolicy: fresh` plus objections carried as declared inputs (§11) - which is also what keeps Codex's cumulative usage correct. |
| 76 | `failure-ux-and-notifications-6` | medium | confirmed | A hung runner produces no exit code at all, and §35's "Max Runtime" has no owner, no default and no scheduler backstop | **Resolved** | `maxRuntime` yields `EXPIRED` (§14.4), with GitHub's own job timeout as the outer backstop. |
| 77 | `failure-ux-and-notifications-7` | medium | confirmed | A scheduler entry is a frozen absolute path: nothing detects that it now starts an old binary, a removed Node, or a... | **Resolved by removal** | There is no frozen absolute-path scheduler entry; the workflow lives in the repository and runtime versions are pinned and probed (§6.3, §15.2). |
| 78 | `failure-ux-and-notifications-8` | medium | confirmed | No crash report and no diagnostic bundle, so every OSS bug report about a 06:00 run will be "it didn't run" with no... | **Partially resolved** | `run-report.md`/`.json` and `doctor --json` are the diagnostic bundle (§17.2, §15.2); a dedicated `bug-report` command is not in the MVP. |
| 79 | `git-workspace-and-forge-lifecycle-4` | medium | confirmed | Exhausting maxIterations leaves an orphan branch, an orphan Issue and no PR, and no section says what becomes of them | **Resolved** | Exhaustion leaves the branch, labels the Issue with the outcome (`loopmill:max-iterations` and its siblings) plus the unaddressed finding ids, and opens no PR (§18). |
| 80 | `git-workspace-and-forge-lifecycle-7` | medium | confirmed | Worktree-per-run is the right isolation primitive, but §34 defers it and nobody priced it: a fresh worktree has no... | **Resolved** | A21 requires the test node to pass in a freshly created workspace, so the bootstrap is a tested claim; isolation is per-backend (§6.2). |
| 81 | `git-workspace-and-forge-lifecycle-8` | medium | contested | One repo, one workflow, one GitHub is assumed but never stated: name the `repo` + `forge` binding now, or §45 must... | **Resolved** | `repos[]` with exactly one repository in the MVP (§5.1), GitHub as the only forge (§6.2), both stated as scope limits in §21. |
| 82 | `observability-data-10` | medium | confirmed | Vendor resets_at and per-runtime usage capability are obtainable today and should be persisted, even while quota %... | **Resolved** | `quotaResetsAt` is persisted from day one (§10); percentages stay out of the UI (§21). |
| 83 | `observability-data-4` | medium | confirmed | No `unavailable` state: quota-killed, failed and cancelled nodes will be stored as 0 tokens, which §20 forbids in s... | **Resolved** | `unavailable` provenance with `complete:false` and null buckets - never 0 (§14.1-14.2). A18. |
| 84 | `observability-data-5` | medium | confirmed | Cycle is never defined as a key, so §22's headline metric is not reproducible | **Resolved** | `(runId, cycleIndex)` is a persisted identity from the first event (§4). |
| 85 | `observability-data-7` | medium | confirmed | A single cross-runtime "Total" is not a comparable quantity; §24's own conclusions are unreachable without a cache... | **Resolved** | Disjoint buckets plus a cache split make a cross-runtime total a defined quantity (§14.1-14.2); the weighted view is labelled `estimated` and off by default. |
| 86 | `observability-data-8` | medium | confirmed | The Node Inspector stores only final artifacts; the event timeline and tool calls that explain a 500K-token node ar... | **Partially resolved** | Per-attempt records carry usage, artifact refs and the effective command line (§9.1, §11); a full tool-call timeline stays an Actions artifact rather than state (§9.3). |
| 87 | `observability-data-9` | medium | confirmed | Time, retry and success metrics are absent, yet §24 claims conclusions that only they can support | **Resolved** | Outcome, retries and duration are first-class metrics alongside tokens (§15.1). |
| 88 | `product-scope-10` | medium | confirmed | Naming: the doc calls the same object both "Loop" and "Workflow", and §49 is silent on the two namespace collisions | **Resolved** | §4's vocabulary rules and Appendix A: Loop (never Workflow), Retry Edge (never Loop Edge). |
| 89 | `product-scope-5` | medium | confirmed | Daemonless is a real UX constraint, not only a benefit: §18 and §32 contradict each other on who resumes an approve... | **Resolved** | One resume host (`resume --due`, §15.2) ends the v0.4 contradiction, and §17.3 states the notification limitation rather than hiding it. |
| 90 | `product-scope-9` | medium | contested | §45 conflates "never", "deferred" and "blocked upstream", and its quota-percentage entry rests on a premise that is... | **Resolved** | §21's non-goal table gives a reason per row and separates 'never' from 'post-MVP'; quota percentages are listed with the verified reason they stay out. |
| 91 | `prompt-contract-and-loop-efficacy-3` | medium | confirmed | The effective prompt is neither defined nor recorded: one free-text field, two different vendor injection points, a... | **Partially resolved** | The prompt file, the resolved inputs and the effective command line are persisted (§11); hashing repository instruction files an agent could rewrite mid-loop is not yet specified - carried as a residual risk. |
| 92 | `prompt-contract-and-loop-efficacy-4` | medium | confirmed | Nothing defines what the review node is given, so each cycle re-reviews the whole tree and a verdict is not bound t... | **Resolved** | The review node's inputs are declared and its verdict must carry `reviewedSha` matching the implementation head (§5.3 `verdict`, A25). |
| 93 | `prompt-contract-and-loop-efficacy-6` | medium | confirmed | Fresh sessions pay full context rediscovery every cycle, and the accounting-correct default is the token-expensive... | **Accepted and measured** | `fresh` sessions are the accounting-correct default; their cost is visible in §15.1 and bounded by §14.4 rather than hidden. |
| 94 | `prompt-contract-and-loop-efficacy-7` | medium | confirmed | No no-progress guard: a fix node that changes nothing still costs an iteration, and an identical tree can yield a d... | **Resolved** | `NO_PROGRESS` is a node outcome that does not consume the iteration budget (§10, A24), and a verdict is bound to the SHA it judged. |
| 95 | `prompt-contract-and-loop-efficacy-8` | medium | confirmed | §44 has no acceptance criterion for the thing the product exists to do: #17 and #18 pass with a review that says 'l... | **Resolved** | A25 is the acceptance criterion for the thing the product exists to do: a schema-conforming verdict bound to a SHA, and the next cycle recording which finding ids it addressed. |
| 96 | `security-10` | medium | confirmed | What the loop executes is resolved by name and configured by the repository it is editing | **Resolved** | Binaries are resolved to absolute paths with versions recorded (§15.2, A16), and the repository cannot redirect authentication because every auth-override variable is denied (§13.2). |
| 97 | `security-7` | medium | confirmed | Control Queue commands are unauthenticated rows, and an approval is not bound to what the human actually saw | **Resolved** | Approvals are GitHub identities bound to a subject digest, and any retry invalidates prior approvals (§12). |
| 98 | `subscription-economics-and-plan-fit-3` | medium | confirmed | The 06:00 default opens a 5-hour window that expires mid-workday, and §28's RUN_ON_NEXT_START default fires the who... | **Resolved** | The trigger carries `cron` + `tz` (§5.1); there is no catch-up storm because there is no catch-up; `minInterval` and `maxRunsPerWindow` bound the burst (§14.4). |
| 99 | `subscription-economics-and-plan-fit-5` | medium | confirmed | "Use the subscription you already pay for" hides that it is one shared seat allowance -- every Loopmill run is take... | **Resolved** | §19 publishes the shared-seat fact, and §14.4 defaults to one run per five-hour window. |
| 100 | `subscription-economics-and-plan-fit-6` | medium | confirmed | Max Loop Iterations is really a budget multiplier of up to 4x, and §12/§42 disagree on what "3" counts -- so no bud... | **Resolved** | `maxIterations` counts Retry Edge traversals, checked before dispatch (§10), and A23 pins the count exactly. |
| 101 | `subscription-economics-and-plan-fit-7` | medium | confirmed | Every number in §19-§24 is retrospective; the user needs a pre-flight estimate before they save a schedule, and Loo... | **Deferred, named** | No pre-flight estimate in the MVP. §14.4 gives hard pre-dispatch budgets and §15.1 gives retrospective per-loop history; the estimator is listed in §24. |
| 102 | `subscription-economics-and-plan-fit-8` | medium | confirmed | §44's 30 acceptance criteria contain no cost or quota criterion, so the MVP can pass while being unaffordable to run | **Resolved** | A30 is the cost/quota acceptance criterion the v0.4 list lacked. |

### 4.1 The seven partially resolved findings, and what is left

| Finding | What is still open | Where it will be closed |
|---|---|---|
| `dx-distribution-1` | Node floor, package layout, migration ownership | m3 (npm package), §20.2 |
| `product-scope-8` | Bundled template and an `init` verb for the 15-minute path | m3 docs, §20.2 |
| `dx-distribution-4` | Whether any runtime needs a PTY on the target backend | A14 makes it a test, not an assumption |
| `failure-ux-and-notifications-8` | A one-command diagnostic bundle | `run-report.json` + `doctor --json` cover most of it; a `bug-report` verb is post-MVP |
| `observability-data-8` | A tool-call-level timeline for a 500K-token node | Streamed logs stay Actions artefacts (§9.3); promoting them to state would break the growth rule |
| `prompt-contract-and-loop-efficacy-3` | Hashing repository instruction files that an agent can rewrite mid-loop | Named as residual risk; candidate for the loop-file spec |
| `dx-distribution-10` | Licence and telemetry statements | m3 docs; the name-availability facts are already recorded |

Deferred with a named home: `subscription-economics-and-plan-fit-7` (pre-flight cost estimate → §24) and
`dx-distribution-7` (package layout and contribution contract → m3).

---

## 5. What v0.5 does *not* claim

Recorded here so a future reviewer can tell honest limits from oversights.

1. **It does not claim the reference loop fits any particular plan.** §14.4 bounds the spend and A30
   measures it; the arithmetic is a spike result, not a design assertion.
2. **It does not claim OpenAI permits unattended subscription use.** Every OpenAI row in §19 is `[L]`
   with its primary source recorded as unreachable, and STOP (c) stays open until primary text is read.
3. **It does not claim the `observed` backend is measurable.** Codex Cloud exposes no per-task usage
   `[V]`; those nodes lower coverage permanently, and §24.4 asks whether they are worth keeping.
4. **It does not claim GitHub will chain `GITHUB_TOKEN`-generated dispatches reliably.** That is SPIKE-3's
   job, and §24.2 names the fallback if it fails.
5. **It does not claim anyone will be notified.** §17.3 delegates to GitHub and says what happens when the
   operator has muted the repository.
6. **It does not claim the plan is safe from vendor churn.** `--full-auto` was already removed from
   `codex exec` and `claude --bare` is announced as a future `-p` default that never reads OAuth `[V]`;
   §6.3 pins versions and ships contract tests, which detects breakage but cannot prevent it.

---

## 6. Where the detail went

This document is deliberately shorter than the sum of its subjects. Normative detail lives in the
companion specifications, which v0.5 references rather than duplicates:

| Spec | Sections that depend on it |
|---|---|
| `docs/spec/loop-file.md` + `.schema.json` | §4, §5, §11, §12, §20.3 group A |
| `docs/spec/state-machine.md` | §7, §10, §12, §17, §20.3 groups B and D |
| `docs/spec/envelope.md` + `.schema.json` | §7, §8, §16.2 |
| `docs/spec/usage-normalization.md` | §14, §15.1, §20.3 group E |
| `docs/adr/ADR-001-event-driven-control-plane.md` | §3.3, §7, §9, §24.1-24.3 |
| `examples/daily-content-improvement.loop.yaml` | §5.3, §16, §18 |

If a companion spec and this document disagree, the companion spec wins on detail and this document wins
on scope; if either disagrees with the v0.5 decision sheet, the sheet wins and the document is wrong.
