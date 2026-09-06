# Loopmill Envelope specification

Envelope schema version: **1.0.0**
Status: **normative for the MVP**. Binding companion files: [`envelope.schema.json`](./envelope.schema.json)
(JSON Schema draft 2020-12) and [`envelope-examples/`](./envelope-examples/).
Date: 2026-09-06.

Where this document and the schema disagree, the schema wins for anything it can express, and this
document wins for everything it cannot (producer policy, transports, ingestion, security).

---

## 1. Purpose

An **Envelope** is one machine-readable record of one thing that happened in one Loop Run: a Run was
requested, an Attempt was dispatched, a Node completed with usage, a human approved something, a Retry
Edge was traversed, a Run finished.

Loopmill has no always-on server. `loopmill run <loop>` is a process that starts, applies events one
journal transaction at a time until the Run is terminal or enters a wait, and exits; internally it
composes `loopmill step`, the single-transition primitive that applies exactly one event, persists the
result, dispatches at most one thing, and returns. Everything that survives between processes is the
event journal in the local `.loopmill/state.sqlite` store, or a snapshot folded from it
(`docs/design/mvp-design.md` §8-9). The **Envelope is the journal entry**: the record every applied or
emitted event becomes, one row per event, hash-chained. GitHub is not the bus — it is where the
repository lives, where decisions and native events are polled from, and where a human or a comment
hands something back to Loopmill. The Envelope is still the only thing that has to be agreed on by
parties that do not share memory: the driver and its `local`/`fake` dispatchers inside one process,
`loopmill step` reading an envelope from stdin or a file, a human posting a fenced block in a GitHub
comment, and an exported run re-ingested later.

Two rules follow, and the rest of this document is mostly their consequences:

1. **An envelope is past tense.** It states what happened, on whose authority, and with which
   identifiers. Present-tense coordination state ("a gate is waiting right now", "a lease is held until
   10:30", "the next node is `test`") is *derived* state and lives in the snapshot the driver folds
   from events. It is never carried as an envelope field, because a stale in-flight fact redelivered by
   an at-least-once transport would be indistinguishable from a fresh one.
2. **An envelope is small and complete.** Small enough for every transport it might have to cross — in
   process, over stdin/`--event-file`, through a GitHub comment, or through the reserved
   `repository_dispatch`/`workflow_dispatch` paths (32 KiB, section 7.6); complete enough that a reader
   with the loop file and the event log needs nothing else. Bytes that are neither (logs, diffs,
   prompts, model output, uploaded files) travel as `artifactRefs`.

## 2. The Envelope is the only protocol

Everything crossing a Loopmill *process* boundary is an envelope. There is no second channel, no
side-band state file, no "the loop file also carries a marker", no implicit signalling by mutating a
branch or a label. Handing an envelope between the driver and an in-process dispatcher does not cross a
process boundary, but the object handed over is still schema-shaped and validated exactly as if it had.

| Boundary | Direction | Carrier |
|---|---|---|
| trigger (schedule, CLI, polled GitHub event) -> driver | inbound | envelope (`run-requested`) |
| driver -> `local`/`fake` dispatcher | in-process | envelope inside a dispatch (section 7.1) |
| `local`/`fake` dispatcher -> driver | in-process | envelope (`node-*`), handed back as an object in the same process |
| human -> driver | inbound | envelope minted by polling with the operator's own `gh` login (`resume --due` or `loopmill ingest`), or written directly by `loopmill approve`/`reject` on the host (section 8) |
| driver -> human | outbound | rendered views of envelopes (the run report, `loopmill status`, PR/issue comments) |
| driver -> driver (next step) | inbound | envelope (`resumed`, `lease-expired`, sweep events) |

What this forbids, explicitly:

- No backend may write to the journal directly. It reports; the driver decides and records.
- No handoff may rely on a GitHub side effect being noticed. A push, a label or a comment is never a
  Loopmill-internal signal; every internal handoff is an explicit dispatch carrying an envelope.
  Native GitHub events reach Loopmill only by being **polled** (section 8), which turns them into
  envelopes; Loopmill never registers a webhook and never runs anything on GitHub's side in the MVP.
- No component may infer state from another component's logs.
- Nothing but an envelope may change a Run's state. If a fact cannot be expressed as an envelope, it is
  not part of the protocol yet, and adding it is a schema change under section 12.

## 3. Anatomy

```json
{
  "schemaVersion": "1.0.0",
  "eventId": "06G7BWHT4089ZN8MD96260DEPE",
  "eventType": "node-completed",
  "occurredAt": "2026-09-06T09:41:12.740Z",
  "producer": "backend:local",
  "loopId": "article-review",
  "loopVersion": "sha256:49e8067c2d493d48f6c0e17f2ce1c27f579c945d25d80547506c3d8e79f93488",
  "runId": "run_06G7BWH2P07RDEMGG3JAG9HSRS",
  "cycle": 1,
  "nodeId": "implement",
  "attempt": 1,
  "result": { "status": "succeeded", "exitCode": 0 },
  "usage": { "...": "section 4.6" }
}
```

### 3.1 Always required

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | semver string | Version of this specification the record conforms to. MUST be the first key on the wire (section 7.3). |
| `eventId` | ULID, 26 chars | Identity of this event; the exact-duplicate idempotency key. Crockford base32, time-sortable. |
| `eventType` | enum (17 values) | What happened. Section 5. |
| `occurredAt` | RFC 3339 date-time | Producer's clock at the moment the described thing happened, not the moment it was transported. Clocks are not trusted for ordering (section 6.4). |
| `producer` | `control-plane` \| `backend:<backendId>` \| `human` \| `trigger` | Who asserts the event. Asserted by the receiving boundary from an authenticated identity, never copied from an untrusted payload (section 11.3). |
| `loopId` | slug | The Loop this Run executes. Immutable, user-visible, matches `.loopmill/<slug>.loop.yaml`. |
| `loopVersion` | `sha256:<64 hex>` | Digest of the canonicalised loop file pinned by this Run. Every event of a Run carries the same value; a mismatch is a validation error, never a silent upgrade. |
| `runId` | `run_` + ULID | The Run. Allocated by the producer of `run-requested`, immutable afterwards. |

### 3.2 Node coordinates

`cycle` (integer >= 0), `nodeId` (slug) and `attempt` (integer >= 0) are **required together** for every
node-level event type (section 5) and **forbidden** on `run-requested`, `run-started`, `run-finished`
and `resumed`. `retry-edge-taken` carries `cycle` (the cycle it enters) and no node coordinates.
`ignored-stale` carries them only when the envelope it declined carried them.

- `cycle` — nodes outside any Retry Edge body execute in cycle 0; body traversals are cycles 1..N. A
  Loop with no Retry Edge only ever has cycle 0.
- `attempt` — dispatched attempts are numbered from 1, and a higher number means infrastructure-level
  retry only (a LOST completion, a transient backend error). A loop retry never increments `attempt`;
  it increments `cycle`. Conflating the two is the single most expensive mistake this field prevents,
  which is why `attempt` is required rather than defaulted: a completion without an attempt number
  cannot be told apart from the completion of a re-dispatch, and a control plane that guesses will
  accept a zombie result. `attempt: 0` is reserved for a **control-plane-local** Node Execution — a
  condition, an `end` node, a human gate or a synthetic record — which is never dispatched to a backend
  and owns no Attempt (`state-machine.md` D-13); it is never used for anything that was dispatched.

`(runId, cycleIndex, nodeId)` identifies a Node Execution; `(runId, cycleIndex, nodeId, attempt)`
identifies an Attempt and is the semantic idempotency key (section 6.2).

### 3.3 Optional everywhere

| Field | Type | Meaning |
|---|---|---|
| `causationId` | ULID | The event that directly caused this one. Section 6.3. |
| `correlationId` | runId | Root Run this event belongs to; equals `runId` unless a sub-run exists. |
| `artifactRefs` | array of ArtifactRef | Pointers to bytes that do not belong in the envelope. Section 4.3. |
| `signature` | string | **Reserved.** Section 11.6. Receivers of schema 1.x MUST ignore it. |

### 3.4 Conditional objects

Each of these is legal only on the event types listed, and required where section 5 says so. The schema
enforces both directions: a `trigger` on a node event and a `run-finished` without an `outcome` are
equally invalid.

| Field | Legal on | Section |
|---|---|---|
| `result` | `node-completed`, `node-failed`, `node-timed-out`, `node-observed` | 4.2 |
| `usage` | `node-completed`, `node-failed`, `node-timed-out`, `node-observed` | 4.6 |
| `error` | `node-failed`, `node-timed-out`, `dispatch-failed`, `lease-expired` | 4.7 |
| `dispatch` | `node-dispatched`, `dispatch-failed` | 4.4 |
| `trigger` | `run-requested` | 4.1 |
| `human` | `human-requested`, `human-decided` | 4.8 |
| `retryEdge` | `retry-edge-taken` | 4.5 |
| `matcher` | `node-observed` | 4.11 |
| `resume` | `resumed` | 4.12 |
| `outcome` | `run-finished` | 4.9 |
| `quotaResetsAt` | `quota-parked`, `node-failed` | 4.10 |
| `reason` | any control-plane bookkeeping event; required on `ignored-stale`, `resumed`, `lease-expired` | 4.10 |

---

## 4. Field semantics

### 4.1 `trigger`

`{ kind: manual | schedule | event, source?, actor?, ref?, dedupeKey?, scheduledFor? }`

What asked for the Run. `actor` is the authenticated identity as the boundary saw it (a GitHub login,
a local user name), never a self-declared string from a payload. `dedupeKey` is what `loopmill step`
compares against the Loop's open changes to decide `SKIPPED`. `scheduledFor` is the schedule slot, which
is how a reconciled missed schedule stays distinguishable from a late run of the current slot.

### 4.2 `result`

`{ status, exitCode?, structured?, summary? }`

- `status` — the Node Execution's terminal state, lowercased: `succeeded`, `failed`, `timed_out`,
  `cancelled`, `skipped`, `no_progress`.
  *Decision (not in sheet): the sheet fixes the state names but not their spelling inside `result`;
  the envelope uses the lowercase snake_case form and the state machine uppercases them.*
- `exitCode` — where the backend has one; `-1` means killed by a signal.
- `structured` — the node's `structuredOutput`, **already validated by the producer** against the JSON
  Schema declared in the loop file. Objects only. A loop-level verdict (`pass`/`fail`) is a field of
  `structured`, never of `status`: `status: succeeded` means "the node ran"; whether the review passed
  is loop semantics and belongs to the condition node that reads it.
  *Decision (not in sheet): `structured` is restricted to a JSON object, and to 8 KiB serialised;
  anything larger moves to a `file` artifact ref (section 7.6). The reserved `github-actions`
  integration uses `actions-artifact` for the same purpose (section 4.3).*
- `summary` — one short paragraph for humans, max 4000 characters. Never a log, never a diff.

### 4.3 `artifactRefs`

Array (max 32) of `{ kind, ref, digest?, url? }`. The design's kind list is
`commit | branch | pr | issue | comment | file`. The schema additionally carries `actions-artifact`,
**reserved** for the `github-actions` integration (ADR-002 D4) and unused by the `local` and `fake`
backends in the MVP.

`ref` is the identifier within its kind: a commit sha, a branch name, a PR or issue number, a comment
id, an Actions artifact name, or a repository-relative path. `digest` is `sha256:<hex>` of the
referenced bytes where the producer can compute it, and is **required for anything a human gate
approves** (section 4.8) so that approval binds to content and not to a mutable pointer. `url` is a
convenience for humans and is never used for machine resolution.

### 4.4 `dispatch`

`{ backendId, runtimeId?, transport, expectedProducer, dedupeKey?, deadline?, target? }`

Written by the control plane **before** it calls the backend, so that a crash between the record and the
call is recoverable: the sweep sees a dispatched attempt with an expired `deadline`, emits
`lease-expired`, and re-dispatches. `dedupeKey` travels into the trigger so the backend can recognise a
duplicate dispatch. `expectedProducer` is the anti-forgery anchor of section 11.3: it names the only
producer whose node-level events the control plane will accept for this attempt.
*Decision (not in sheet): `dispatch` as an object, and `expectedProducer` in particular. The sheet
requires the control plane to check "producer allowed for eventType"; recording the expected producer at
dispatch time is what makes that check per-attempt rather than per-type.*

### 4.5 `retryEdge`

`{ edgeId, fromNodeId, toNodeId, fromCycle, toCycle, maxIterations, traversals, budgetConsumed }`

The one backward edge kind. `traversals` is the edge's budget-consuming traversal count *after* this
one, and `budgetConsumed` is `false` exactly for the free traversal a `NO_PROGRESS` cycle produces
(`state-machine.md` §6.6): a reader of the log can therefore tell a charged retry from a free one
without re-deriving it. `toCycle` equals the envelope's `cycle` and equals `fromCycle + 1`;
`step` checks both invariants (JSON Schema cannot). Exhausting `maxIterations` never produces a
`retry-edge-taken`: the check happens *before* dispatching the target, and exhaustion ends the Run with
`MAX_ITERATIONS_EXCEEDED`, which is a terminal outcome and not a failure.

### 4.6 `usage`

The canonical per-Attempt record:

```json
{
  "runtime": "claude-code",
  "model": "claude-opus-5",
  "freshInputTokens": 1820,
  "cacheWriteTokens": 24110,
  "cacheReadTokens": 402331,
  "outputTokens": 5904,
  "reasoningTokens": null,
  "totalInputTokens": 428261,
  "totalTokens": 434165,
  "provenance": "reported",
  "provenanceNote": null,
  "source": { "runtimeVersion": "2.4.1", "eventKind": "result.usage" },
  "complete": true
}
```

Rules the schema enforces:

- The four buckets are **disjoint**: `totalInputTokens = fresh + cacheWrite + cacheRead`, and
  `totalTokens = totalInputTokens + outputTokens`. `reasoningTokens` is reference only and is never
  summed into anything.
- `provenance: unavailable` requires **all buckets null**, `complete: false` and a `provenanceNote`.
  An unmeasurable attempt is never stored as zero: zero is a measurement, null is the absence of one,
  and a report that cannot tell them apart is worse than no report.
- `provenance: reported | derived` requires integer buckets and a `source` naming the runtime record the
  numbers came from.
  *Decision (not in sheet): `source` is required for measured usage and `provenanceNote` for
  `estimated`/`unavailable`. The sheet lists both fields without saying when they are mandatory.*
- `provenance: estimated` exists for the `fake` backend and future heuristics. It is never summed with
  `reported`/`derived` in a headline figure.
- `listPriceEquivalentUsd` may be stored for internal normalisation only. No view shows USD by default;
  a subscription run has no per-run price.

Mapping per runtime:

| Runtime | Source record | Mapping | Provenance |
|---|---|---|---|
| `claude-code` | `result.usage` (or the sum of `modelUsage` when present, which covers subagents) | fresh = `input_tokens`, cacheWrite = `cache_creation_input_tokens`, cacheRead = `cache_read_input_tokens`, output = `output_tokens` | `reported` |
| `codex` | `turn.completed.usage`, which is **thread-cumulative** | per-attempt = last cumulative minus cumulative at attempt start (a fresh session starts at zero); cacheRead = `cached_input_tokens`, cacheWrite = `cache_write_input_tokens`, fresh = `max(0, input - cached - cacheWrite)`, output = `output_tokens`, reasoning = `reasoning_output_tokens` | `derived` |
| any runtime, no terminal usage record (turn failed, process killed) | none | all buckets null | `unavailable` |
| `observed` backends (**reserved**, unreachable in the MVP — SPIKE-2 NO-GO, ADR-002 D4) | none; execution would happen vendor-side | all buckets null | `unavailable` |

Usage aggregates only upward along Loop > Run > Cycle > Node Execution > Attempt, and a scope containing
an `unavailable` or `estimated` attempt is reported with its coverage attached rather than as a clean
total.

### 4.7 `error`

`{ code, message, classified }`

`code` is the producer's own snake_case token (`artifact_invalid`, `oauth_token_expired`,
`command_exit_nonzero`). `classified` is the coarse bucket the state machine reads:
`quota | auth | timeout | transient | invalid_input | artifact_invalid | backend_error | runtime_error |
cancelled | unknown`.
*Decision (not in sheet): the `classified` enum. The sheet names the QUOTA classification and the
`artifact_invalid` reason and requires that ambiguity is never a wait; this enum is the smallest set
that covers the sheet's transitions.* Ambiguity classifies as `unknown`, and `unknown` never becomes a
wait: only `quota` **with** `quotaResetsAt` can park a Run.

### 4.8 `human`

`{ mode?, subjectDigest, decision?, decidedBy?, deadline?, note? }`

`mode ∈ cli | pull-request-review | label`. `cli` is the operator running `loopmill approve <runId>` /
`loopmill reject <runId>` directly on the host; the other two are ingested by polling `gh` with the
operator's own login (section 8). v0.5's `environment-reviewers` — a job pinned to a GitHub Environment
with required reviewers — no longer exists: there is no job for GitHub to hold (ADR-002 D7).
`subjectDigest` is the sha256 of exactly what is being approved — normally the digest of the artifact
recorded in the `human-requested` event. A new Attempt produces a new subject digest and therefore
**invalidates every earlier approval**; approvals are never carried across attempts. `decidedBy` is the
authenticated decider as the boundary saw it — a GitHub login when polled, or the host's own user/`gh`
identity for `cli`. `decision ∈ approve | reject | cancel` — the three the state machine routes on
(`state-machine.md` §8.5, D-02/D-03). There is no `expired` decision: a gate that ran out of time is a
`node-timed-out` with `error.code: human_timeout`, produced by the sweep, not a decision by a human.

### 4.9 `outcome`

`{ state, endLabel?, failureReason?, cycles?, summary? }` with
`state ∈ SUCCEEDED | FAILED | CANCELLED | MAX_ITERATIONS_EXCEEDED | BUDGET_EXCEEDED | EXPIRED | SKIPPED`.
`SUCCEEDED` requires `endLabel` (reported as `SUCCEEDED(end:<label>)`) and forbids `failureReason`;
`FAILED` requires `failureReason`. `MAX_ITERATIONS_EXCEEDED` and `BUDGET_EXCEEDED` are outcomes, not
failures, and carry no `failureReason`.
Totals (tokens, durations, coverage) are **not** carried here: they are folded from the event log, and
an envelope that asserted them could disagree with the log it is part of.

### 4.10 `reason` and `quotaResetsAt`

`reason` is a snake_case token explaining a control-plane bookkeeping event. The vocabularies are the
closed enums of `docs/spec/state-machine.md` — this document does not invent a second set:

| Event | `reason` | Enum |
|---|---|---|
| `ignored-stale` | `stale_attempt`, `semantic_duplicate`, `unknown_node`, `run_terminal`, `future_cycle`, `producer_not_expected`, `unknown_event_type`, … | `StaleReason`, state-machine §5.3 |
| `resumed` | `due`, `manual`, `interrupted` — the same value as `resume.kind`, restated for readers | state-machine §3.1 |
| `lease-expired` | `attempt_deadline`, `control_plane_lease`, `observe_deadline` | state-machine §3.1 |
| `quota-parked` | free token naming the quota source, e.g. `runtime_reported_quota_exhausted` | — |

`quotaResetsAt` is when the vendor window is expected to reopen. It is required on `quota-parked`. On a
`node-failed` classified `quota` it is optional, and its absence is decisive: without it the failure is
a plain failure, never a wait.

### 4.11 `matcher`

`{ kind, ref, outcome }` with `kind ∈ comment-block | file-in-diff | cloud-status` and
`outcome ∈ found_valid | found_invalid`.

Only on `node-observed`, and required there. It is what the artifact matcher of an `observed` backend
actually did: which surface it read (`ref` is the comment id, the file path in the diff, or the cloud
task id) and whether what it found parsed and validated. `found_valid` carries `result`;
`found_invalid` carries `error` instead and is what drives the retry-or-fail branch in
`state-machine.md` §9.2. Without this field a reader could not tell "the vendor answered something
unusable" from "the vendor answered".

### 4.12 `resume`

`{ kind, decision?, actor? }` with `kind ∈ due | manual | interrupted` and
`decision ∈ retry | skip | fail`.

Only on `resumed`, and required there. `kind` says why the Run is being un-parked — a due quota
window, an operator's explicit command, or the recovery of an `INTERRUPTED` Run — and `decision` is
only meaningful for `kind: interrupted`, where a human has to choose between re-dispatching the node,
skipping it, and abandoning the Run (`state-machine.md` §10.3). Budgets never reset on a resume.

---

## 5. Event catalogue

Seventeen types, of which sixteen are reachable in the MVP. `node-observed` (row 8) is kept in the
catalogue as **reserved** for an artifact-matcher/`observed` backend and is unreachable in the MVP
(SPIKE-2 NO-GO, ADR-002 D4). "Producer" is the policy the control plane enforces; the schema constrains
the *shape* of `producer`, not which producer may send which type, because the same type legitimately
comes from different backends.
*Decision (not in sheet): producer policy is enforced by `loopmill step`, not by the schema.*

Node-level types (require `cycle`, `nodeId`, `attempt`) are marked •.

| # | eventType | Producer | Also required | Meaning |
|---|---|---|---|---|
| 1 | `run-requested` | `trigger`, `control-plane` (reconcile) | `trigger` | Someone asked for a Run. Creates the Run; `runId` is allocated here. A human's request made through GitHub (an Issue, a label) reaches the machine when it is polled and stamped `producer: trigger` (8.1). |
| 2 | `run-started` | `control-plane` | — | The Run exists, the loop file is validated and `loopVersion` is pinned. |
| 3 | `node-dispatched` • | `control-plane` | `dispatch` | An Attempt was handed to a backend. Written **before** the dispatch call. |
| 4 | `node-started` • | `backend:<id>` | — | The backend began executing (only backends that stream emit this). |
| 5 | `node-completed` • | `backend:<id>` | `result` | The Attempt finished. Agent nodes MUST also carry `usage`. |
| 6 | `node-failed` • | `backend:<id>`, `control-plane` | `error` | The Attempt failed. `error.classified` decides what happens next. |
| 7 | `node-timed-out` • | `backend:<id>`, `control-plane` | — | The node's own timeout or an observed deadline elapsed. |
| 8 | `node-observed` • | `backend:observed` | `matcher`, `artifactRefs` (>= 1); `result` when `matcher.outcome: found_valid` | **Reserved, unreachable in the MVP** (SPIKE-2 NO-GO). An artifact matcher looked at the surface an `observed` backend writes to, and found something valid or something unusable. |
| 9 | `human-requested` • | `control-plane` | `human{mode, subjectDigest}` | A human gate opened. A gate is control-plane-local, so its `attempt` is `0` (3.2). |
| 10 | `human-decided` • | `human` | `human{decision, subjectDigest}` | A human approved, rejected or cancelled. Same coordinates as the `human-requested` it answers, `attempt: 0`. |
| 11 | `quota-parked` • | `control-plane` | `quotaResetsAt`, `reason` | The Run entered `WAITING_FOR_QUOTA`. Derived from a `node-failed` classified `quota`; backends never emit it directly. |
| 12 | `retry-edge-taken` | `control-plane` | `cycle`, `retryEdge` | A Retry Edge was traversed and the cycle index advanced. `retryEdge.budgetConsumed: false` marks the free traversal of a `NO_PROGRESS` cycle. |
| 13 | `run-finished` | `control-plane` | `outcome` | The Run reached a terminal state. Exactly one per Run. |
| 14 | `ignored-stale` | `control-plane` | `reason`, `causationId` | A delivered event was rejected without being applied. Kept for audit. It repeats the declined envelope's node coordinates when it had them, and carries none when it did not (a second `run-requested`, a premature `resumed`). |
| 15 | `dispatch-failed` • | `control-plane` | `dispatch`, `error` | The backend call itself failed (`step` exits 4). |
| 16 | `resumed` | `control-plane`, `human` | `resume`, `reason` | A parked or interrupted Run resumed. Budgets do not reset. |
| 17 | `lease-expired` • | `control-plane` | `reason` | The sweep declared an in-flight Attempt LOST; a new Attempt may follow up to `maxAttempts`. |

One valid example per type lives in [`envelope-examples/`](./envelope-examples/), named after the type.
They are drawn from one illustrative Run of a Loop called `article-review` — an example made for this
document, not the reference loop of `examples/daily-content-improvement.loop.yaml` — and they do not
form a complete trace.

Notes that are easy to get wrong:

- `node-completed` means *the attempt ran to completion*, including a run whose verdict is "fail".
  A failing review is a successful node execution with `structured.verdict = "fail"`.
- `no_progress` is a `result.status`, not an event type: the agent ran and changed nothing. It does not
  consume the iteration budget.
- `ignored-stale` is the only event that describes another event. Its `causationId` names the rejected
  `eventId`, which is what makes "we saw it and refused it" auditable rather than invisible.
- `run-finished` is emitted for **every** terminal state, including `SKIPPED` and `BUDGET_EXCEEDED`.

---

## 6. Identity and idempotency

### 6.1 `eventId` — exact duplicates

A ULID: 48-bit millisecond timestamp + 80 bits of entropy, Crockford base32 (26 chars, `I`, `L`, `O`
and `U` excluded), lexicographically sortable in generation order. The control plane keeps
`appliedEventIds`; a second delivery of the same `eventId` writes nothing, produces no commit, and exits
0 reporting `duplicate`.

Producers MUST generate a fresh ULID per event, except polling, which **derives** it (section 8.3) so
that a redelivered or re-polled GitHub event maps to the same `eventId`.

### 6.2 Semantic key — different bytes, same fact

`(runId, cycle, nodeId, attempt, eventType)` is the semantic idempotency key. Two `node-completed`
events for the same Attempt with different `eventId`s are the same fact told twice (a re-run job, a
retried HTTP call); the second is recorded as `ignored-stale` with `reason: semantic_duplicate` and
applied to nothing.

The stronger rule the control plane applies to every node-level event: the coordinates must match the
**expected in-flight Attempt** recorded by the last `node-dispatched`, and `producer` must equal that
dispatch's `expectedProducer`. Anything else is `ignored-stale`, exit 0. There is no "close enough".

### 6.3 Causation chain

`causationId` names the event that directly caused this one; `correlationId` names the Run the whole
chain belongs to. A well-formed Run therefore reads as a tree rooted at `run-requested`:

```text
run-requested
  run-started
    node-dispatched (implement, c1, a1)
      node-started
      node-completed  --> usage, artifactRefs
    node-dispatched (pr-review, c1, a1)
      node-observed
    retry-edge-taken (c1 -> c2)
      ...
    run-finished
```

`causationId` is advisory for the state machine and load-bearing for humans and for debugging: it is the
only field that answers "why did this happen now?" without replaying the fold.

### 6.4 Ordering

Order comes from the event log's `seq` in the local store, never from `occurredAt`. Producer clocks
are unsynchronised, and a backend that returns after a lease expired can legitimately carry an earlier
timestamp than the `lease-expired` that overtook it. `occurredAt` is for humans, for durations, and for
the ULID timestamp prefix; the applied order is whatever transaction the driver committed.

---

## 7. Transports

Six paths carry the same bytes: three are used in the MVP (7.1-7.3), two are **reserved** for the
`github-actions` integration (7.4-7.5), and one rule (7.6) bounds every one of them.

### 7.1 In-process (default in the MVP)

Within one `loopmill run` process, the driver hands the dispatch envelope to the `local` or `fake`
dispatcher as an in-memory object — after the `node-dispatched` event has been committed — and gets the
completion envelope (`node-completed` / `node-failed` / `node-timed-out`) back the same way; the
completion is then applied and persisted as the next journal transaction
(`docs/design/mvp-design.md` §7.2, §8.2). Nothing is serialised to a wire for this path — the object
simply changes hands inside one process — but it is schema-shaped and validated exactly as if it had
crossed a process boundary; the schema does not know or care that no bytes moved. This is the path
every MVP Run takes twice per node: once out to the dispatcher, once back.

### 7.2 stdin / `--event-file`

`loopmill step` accepts exactly one envelope, as UTF-8 JSON on stdin or via `--event-file <path>`. One
invocation applies one event. NDJSON, arrays of envelopes and multi-document input are rejected:
batching would make the "one applied event, one transaction" audit property untrue. This is how the
test suite drives the engine, and how a run `loopmill export`ed earlier is re-ingested one event at a
time.

### 7.3 GitHub comment: the fenced `loopmill` block

A human hands a decision to Loopmill — or, under the reserved `github-actions` integration, a backend
reports one — by posting a comment that carries an envelope inside a fenced block. Loopmill never
receives this over a webhook: it is read by **polling**, with the operator's own `gh` login, from
`resume --due` or `loopmill ingest` (section 8). Nothing is ever pushed to Loopmill; a comment sits on
GitHub until something on the operator's host asks for it.

The grammar is exact:

````text
```loopmill
{ "schemaVersion": "1.0.0", "eventId": "...", "eventType": "human-decided", ... }
```
````

1. The opening fence is a line matching `^```loopmill[ \t]*$` — three backticks, the literal word
   `loopmill`, nothing else but trailing whitespace, and the line starts at column 0 (no indentation,
   no list nesting, no blockquote).
2. Everything up to the closing fence is the payload: exactly one JSON object.
3. The closing fence is a line matching `^```[ \t]*$`.
4. **Only the first block in the comment body is parsed.** Later blocks are ignored entirely (they are
   how a quoted reply carries the original without re-firing it).
5. The payload is parsed as **strict JSON** (RFC 8259, UTF-8, no BOM): no comments, no trailing commas,
   no single quotes, no `NaN`/`Infinity`, no unquoted keys. A parse failure is a rejected envelope, never
   a best-effort repair.
6. **`schemaVersion` MUST be the first key** of the object. JSON objects are unordered by definition, so
   this is a Loopmill wire rule checked textually before parsing: it makes a truncated or mangled block
   detectable, lets a reader route by version without a full parse, and makes a hand-written block
   visibly conformant.
7. Everything outside the block — prose, screenshots, other fences — is ignored. A comment with no
   `loopmill` fence produces no envelope, ever.

A comment body is limited to 65,536 characters, which the 32 KiB envelope rule already respects.

### 7.4 `repository_dispatch` — **reserved** (`github-actions` integration)

```http
POST /repos/{owner}/{repo}/dispatches
{
  "event_type": "loopmill-event",
  "client_payload": { "envelope": "<the envelope as one JSON string>" }
}
```

Not used by the MVP — there is no control-plane workflow on GitHub for it to reach. Kept as the
mechanism SPIKE-1 and SPIKE-3 measured, as the reserved `github-actions` integration's transport
(ADR-002 D4, D7). One top-level property in `client_payload`, always named `envelope`, always a
**string** containing the serialised envelope (not a nested object); a workflow of that integration
would read `${{ github.event.client_payload.envelope }}` and pipe it into `loopmill step`.

Facts that shaped this choice (verification status in section 7.5):

- `client_payload` allows at most **10 top-level properties** and the whole JSON payload must be
  **less than 64 KB**. Using exactly one property keeps every future field inside the envelope, where
  the schema governs it, instead of inventing a second, unversioned wire format.
- `repository_dispatch` runs **only workflows on the default branch**, and `GITHUB_REF` for the run is
  the default branch. A feature branch or a spike would need 7.5 instead.
- `event_type` is limited to 100 characters. Loopmill uses exactly one value, `loopmill-event`; routing
  is by `eventType` inside the envelope, not by `event_type` on the wire, so that adding an event type
  never requires touching a workflow's `types:` filter.

### 7.5 `workflow_dispatch` — **reserved** (`github-actions` integration)

```http
POST /repos/{owner}/{repo}/actions/workflows/loopmill-step.yml/dispatches
{ "ref": "refs/heads/<branch>", "inputs": { "envelope": "<the envelope as one JSON string>" } }
```

Also not used by the MVP; kept for the same reserved integration, because `ref` selects which version
of a workflow actually runs — needed on a feature branch or in a spike, where `repository_dispatch`
(7.4) cannot reach. The workflow file must still exist on the default branch for the event to be
dispatchable at all. `inputs` allows at most 25 top-level properties on github.com (10 on GitHub
Enterprise Server) and a maximum payload of 65,535 characters; Loopmill would use one input, `envelope`.

A second input, `run_id`, is permitted and carries the plain `runId` — not because the reader needs it
(it reads the envelope) but because an Actions `concurrency:` expression is evaluated before the job
exists and must not depend on parsing an input.
*Decision (not in sheet): the `run_id` companion input, for the concurrency group only. It is
informational; if it ever disagreed with the envelope, the envelope wins.*

**Measured (SPIKE-3, `docs/spikes/README.md` §5, 2026-09-06) `[V]`.** A 32,768-byte envelope (the
design's size rule) was accepted and applied through `workflow_dispatch` (a 33,045-byte record on the
branch); a 65,400-byte envelope was accepted and applied too (65,678-byte record); a 66,000-byte
envelope was refused by the API with HTTP 422 `inputs are too large` and no run was created — the
65,535-character ceiling documented for the `inputs` payload holds, and the 32 KiB rule (section 7.6)
leaves the escaping headroom it was designed to leave.

#### GitHub facts, with verification status

`docs.github.com` is not reachable from this build environment (blocked by the network egress proxy), so
each fact below was verified against the machine-readable sources GitHub publishes for those same docs,
fetched from `raw.githubusercontent.com` on 2026-09-06. These facts govern only the reserved 7.4/7.5
paths; nothing here bears on the MVP's own transports (7.1-7.3).

| Fact | Status | Source |
|---|---|---|
| `client_payload` allows at most 10 top-level properties; total JSON payload must be < 64KB | **verified** | `github/rest-api-description`, `descriptions/api.github.com/api.github.com.yaml`, `POST /repos/{owner}/{repo}/dispatches`: "The maximum number of top-level properties is 10. The total size of the JSON payload must be less than 64KB." |
| `repository_dispatch` `event_type` <= 100 characters | **verified** | same file (`maxLength: 100`), and `github/docs` `content/actions/reference/workflows-and-actions/events-that-trigger-workflows.md` |
| `repository_dispatch` triggers only workflows on the default branch (and `GITHUB_REF` is the default branch) | **verified** | `github/docs` events-that-trigger-workflows.md, `repository_dispatch` table row (`GITHUB_REF` = "Default branch") plus `data/reusables/actions/branch-requirement.md`: "This event will only trigger a workflow run if the workflow file exists on the default branch." |
| `workflow_dispatch` `inputs`: max 25 top-level properties (10 on GHES), max payload 65,535 characters | **verified** | `github/docs` `data/reusables/actions/inputs-vs-github-event-inputs.md`; OpenAPI `POST .../workflows/{workflow_id}/dispatches` (`maxProperties: 25`) |
| `workflow_dispatch` requires the workflow file to exist on the default branch to be dispatchable; `ref` then selects the version that runs | **verified** | `github/docs` events-that-trigger-workflows.md, `workflow_dispatch` section and the same reusable |
| `GITHUB_TOKEN`-triggered `workflow_dispatch` and `repository_dispatch` **do** start workflow runs; other `GITHUB_TOKEN`-triggered events do not | **verified** | `github/docs` events-that-trigger-workflows.md: "With the exception of `workflow_dispatch` and `repository_dispatch`, other `GITHUB_TOKEN`-triggered events do not create workflow runs at all." |
| A comment/issue body is limited to 65,536 characters | **partially verified** | Not found in GitHub Docs prose from the reachable sources. Corroborated by `github/docs`' own tooling (`src/links/lib/link-report.ts`: "GitHub rejects issue bodies over 65,536 characters") and, from memory, by the REST error `body is too long (maximum is 65536 characters)`. Treat as a soft limit and stay far below it. |
| Dispatching needs `contents: write` (repository dispatch) / `actions: write` (workflow dispatch) on `GITHUB_TOKEN` | **from memory** | Unconfirmed against the live API for this integration; not needed by the MVP's own transports. |

### 7.6 Size rule

**An envelope is at most 32 KiB serialised, on every path above, including the in-process one.**
Anything larger travels as `artifactRefs`.

Producers MUST check the size of the **encoded transport body** for any path that serialises, not only
the envelope: escaping an envelope into a JSON string can in the worst case double its length, and 32
KiB doubled is 64 KiB — at or above the `client_payload` ceiling of the reserved `repository_dispatch`
path, depending on whether GitHub's "64KB" means 64,000 or 65,536 bytes. The concrete rule:

- envelope <= 32 KiB (32,768 bytes), and
- the JSON-string-escaped form <= 60 KiB (61,440 bytes) for the reserved `repository_dispatch`, and
- <= 65,535 characters for the reserved `workflow_dispatch` inputs.

Measured on this specification's own examples, escaping costs about 10%: the largest example is 1,739 B
pretty-printed, 1,422 B compact, 1,568 B escaped (section 13, TV-3).

What moves out of the envelope when it does not fit: `result.structured` above 8 KiB (a `file` artifact
ref in the MVP; an uploaded Actions artifact, `kind: actions-artifact`, under the reserved integration),
any log or diff (never in an envelope at all), and long human text (link to the comment or PR instead).

---

## 8. Ingesting native GitHub events

GitHub's own events (`issues`, `pull_request`, `issue_comment`, `pull_request_review`) are not envelopes
and never reach `loopmill step` directly. **There is no `ingest` workflow in the MVP.** `resume --due`
(run on its own cadence, or by hand) and the explicit `loopmill ingest` command **poll** GitHub with the
operator's own `gh` login, decide whether what they find means anything to Loopmill, mint an envelope,
and apply it through `loopmill step` (7.2) in the same process. Polling is the only place where an
outside fact becomes a Loopmill fact, and therefore the only place where trust is established; Loopmill
never registers a webhook and runs nothing on GitHub's side.

Polling uses whatever scopes the operator's own `gh` login already has. It holds no separate vendor
credential of its own and writes nothing to the store directly — it converts what it reads into an
envelope and hands that to `loopmill step`, exactly like stdin or `--event-file` would.

### 8.1 Mapping table

Rules are evaluated top to bottom; the first match wins.

| GitHub event (activity types) | Precondition | Envelope | `producer` |
|---|---|---|---|
| `issues` (`unlabeled`) | the removed label is `loopmill:hold` on an in-flight `human` node with `mode: label`, and the actor has write access | `human-decided` with `human.decision: approve`, `subjectDigest` copied from the open `human-requested` | `human` |
| `issues` (`labeled`) | the added label is `loopmill:reject` on that same node | `human-decided` with `human.decision: reject` | `human` |
| `issues` (`opened`, `labeled`) | the Loop's `trigger.event.types` includes `issues` and the label filter matches; author association is `OWNER`/`MEMBER`/`COLLABORATOR` | `run-requested`, `trigger.kind: event`, `source: github:issues`, `dedupeKey: issue:<number>` | `trigger` |
| `issue_comment` (`created`) | the body contains a fenced `loopmill` block (7.3), the author is not a control-plane identity, and the body carries no control-plane marker | the parsed envelope, re-stamped (8.2) | `human`, or (**reserved**) `backend:observed` for an allow-listed vendor bot |
| `pull_request_review` (`submitted`) | the PR is the subject of an in-flight `human` node with `mode: pull-request-review` and the review's head sha matches the recorded `subjectDigest` | `human-decided`: `approved` -> `approve`, `changes_requested` -> `reject`, `commented` -> no envelope | `human` |
| `pull_request` (`opened`, `synchronize`) — **reserved, unreachable in the MVP** | an in-flight node is `OBSERVING` with a file matcher, and the PR head contains the declared JSON path | `node-observed` with `matcher{kind: file-in-diff, ref: <path>, outcome}` and `artifactRefs` of `kind: pr` and `kind: file` (with digests) | `backend:observed` |
| `pull_request` (`closed`) | the PR is the working branch's PR of an in-flight Run | no envelope; the node's own completion still governs. A merged PR may produce a `run-requested` for a follow-up Loop when one declares that trigger | `trigger` |
| `workflow_run` (`completed`) — **reserved for the `github-actions` integration, unreachable in the MVP** | `workflow_run.name` matches `loopmill:<runId>:<cycle>:<nodeId>:<attempt>` **and** that Attempt is still in flight | `conclusion: timed_out` -> `node-timed-out`; `cancelled` -> `node-failed` (`classified: cancelled`); `failure` -> `node-failed` (`classified: backend_error`); `success` -> **no envelope** | `backend:github-actions` |

Two notes on the last, reserved row. That integration's agent workflow would set
`run-name: loopmill:${{ inputs.run_id }}:${{ inputs.cycle }}:${{ inputs.node_id }}:${{ inputs.attempt }}`
so the attempt coordinates are recoverable from the `workflow_run` payload; this is the only reliable
join back to Loopmill state, since the payload has no room for Loopmill fields.
*Decision (not in sheet): the `run-name` convention and the join it enables.*
A `success` conclusion without a completion envelope is deliberately **not** ingested: the job may still
be uploading, and inventing a completion would race the real one. That case belongs to the lease
(`lease-expired`), which is designed for exactly the "no answer" state — and which the MVP's `local`
backend reaches through the `locks` row instead (`state-machine.md` §10.1-10.2).

### 8.2 Re-stamping: what polling keeps and what it overwrites

A comment-borne envelope is user input. Polling keeps `eventType`, `runId`, `cycle`, `nodeId`,
`attempt`, `matcher`, `result`, `artifactRefs` and `usage`; it **overwrites**:

- `producer` — set from the authenticated author (the `gh` identity behind the comment), never copied
  from the payload;
- `eventId` — replaced by the derivation of 8.3, so re-polling the same object is a duplicate rather
  than a new event;
- `occurredAt` — set from the source object's timestamp (`comment.created_at`, `review.submitted_at`),
  not from the comment's own claim and not from the polling clock;
- `loopId`, `loopVersion` — set from the Run's pinned header, so a comment cannot re-point a Run at
  another Loop or another version;
- `causationId` — set to the `node-dispatched` event of the in-flight Attempt.

*Decision (not in sheet): the exact keep/overwrite split. The sheet requires strict parsing of the
fenced block; in the MVP the enforcing boundary is the poll (`resume --due` / `loopmill ingest`) rather
than a separate ingest workflow, and this is what "strict" has to mean for it to be a boundary either
way.*

### 8.3 Deriving `eventId` from a delivery

GitHub's `X-GitHub-Delivery` GUID belongs to webhooks and is never seen by a poll, so `resume --due` /
`loopmill ingest` derive the id from the source object's own natural key, which is stable across
repeated polls and repeated `resume --due` runs:

```text
seed      = "loopmill/ingest/1" SP <github event name> SP <natural key> SP <source timestamp, RFC 3339>
entropy   = sha256(seed)[0..10]                         # first 10 bytes = 80 bits
timestamp = source timestamp in milliseconds since the epoch
eventId   = crockford32(timestamp, 10 chars) || crockford32(entropy, 16 chars)
```

| Source event | Natural key |
|---|---|
| `issue_comment` | `comment.id` |
| `pull_request_review` | `review.id` |
| `issues` | `issue.id` + `:` + `action` |
| `pull_request` | `pull_request.id` + `:` + `action` |
| `workflow_run` (reserved) | `workflow_run.id` + `:` + `run_attempt` |

Because both halves are functions of the source object, polling the same object twice always yields the
same `eventId` and the driver drops it as a duplicate (exit 0, nothing written). Should Loopmill ever
receive webhooks instead of polling, the delivery GUID would replace the natural key and the derivation
would otherwise be unchanged.
*Decision (not in sheet): the derivation itself. The sheet requires deduping by delivery identity; this
is the construction that also keeps `eventId` a valid, time-sortable ULID.* Test vector: TV-2.

### 8.4 Anti-loop rules

Loopmill posts comments, and comments are events. Without rules, that is a loop.

1. **Identity.** Ignore any event whose actor is a control-plane identity: `github-actions[bot]`
   (reserved, for the `github-actions` integration), plus any bot login the operator has configured as
   Loopmill's own. The MVP default posts as the operator's own `gh` login, for which rule 2 below is
   the operative defense.
2. **Marker.** Every comment Loopmill writes contains `<!-- loopmill:control-plane -->`. Polling drops
   any body containing that marker regardless of author, which also covers a human quoting Loopmill.
3. **Fenced block required.** No `loopmill` fence, no envelope. Prose never becomes an event.
4. **First block only.** One envelope per comment at most (7.3, rule 4).
5. **Derived ids.** Redeliveries and re-polls collapse onto one `eventId` (8.3).
6. **In-flight check.** Node-level events are accepted only for the expected Attempt and expected
   producer (6.2); everything else is `ignored-stale`.
7. **No implicit handoffs.** Loopmill's own steps are always explicit dispatches, so a polling bug can
   drop events but can never invent a step.
8. **Hard cap.** `maxStepsPerRun` (default 200) bounds any chain that survives 1-7. The reserved
   `github-actions` integration additionally uses a per-`runId` Actions concurrency group; the MVP's
   `local` backend is bounded instead by the `locks` row allowing only one live process per Run
   (`state-machine.md` §10.1).

---

## 9. How a node reports completion

### 9.1 The `local` backend (MVP)

The node executor is a **subprocess of `loopmill run`**, not a separate job: `run` spawns the runtime
CLI (`claude` or `codex`) directly in the Run's worktree, and owns the only first-hand account of what
happened. On exit it:

1. collects `result` (status, exit code, validated `structuredOutput`, a short summary), `usage`
   (section 4.6) and `artifactRefs` (commit, branch, a log file under `.loopmill/logs/`);
2. runs the redactor over every string (section 11.1);
3. builds the envelope with `producer: backend:local`, the coordinates it was dispatched with, and
   `causationId` = the `node-dispatched` `eventId` it received;
4. checks the size rule (7.6), moving oversized `structured` output into a `file` artifact ref;
5. hands the envelope back to the driver **in process** (7.1) — there is no dispatch call to make and
   nothing to retry with jitter, because nothing left the process.

`run` applies the completion as the next event, in its own transaction: the applied completion, the
events it emits, the new snapshot and the attempt record land together (`docs/design/mvp-design.md`
§9.2). The `node-dispatched` event was committed in an earlier transaction, before the subprocess was
spawned (§7.2 of the design), which is what makes a crash between the two recoverable. If the subprocess dies before it can report at all — killed,
crashed, the host lost power — there is no completion to apply; that state is exactly what the lease and
the sweep exist for (`state-machine.md` §10): the lease on the `locks` row expires, the sweep emits
`lease-expired`, and a new attempt is dispatched up to `maxAttempts`. Silence is a supported outcome; a
second protocol would not be.

### 9.2 The reserved `github-actions` variant

Under the reserved `github-actions` integration, the completion crosses a process boundary instead of
staying in one process. The agent job runs `loopmill run-node`, builds the same envelope shape with
`producer: backend:github-actions`, and dispatches it with the job's `GITHUB_TOKEN`:

```bash
jq -n --rawfile e envelope.json \
  '{event_type: "loopmill-event", client_payload: {envelope: $e}}' > body.json
gh api --method POST "/repos/$GITHUB_REPOSITORY/dispatches" --input body.json
```

This works because `workflow_dispatch` and `repository_dispatch` are the documented exception to
GitHub's rule that `GITHUB_TOKEN`-triggered events do not start workflow runs (verified, 7.5 GitHub
facts). It is also the reason a push to that integration's git-branch store cannot be the trigger: a
push made with `GITHUB_TOKEN` starts nothing, and the agent job has no credential for that branch
anyway.

If the dispatch call fails, the job **retries with jitter and then exits non-zero without inventing an
alternative channel**; the completion is unknown to the control plane until the lease expires and the
sweep emits `lease-expired`, exactly as in 9.1. The control plane's own workflow re-dispatches to itself
the same way when a step produces a follow-up event, subject to the chain cap of 8.4. This subsection is
measured (SPIKE-1, SPIKE-3) and kept as the reference for that integration (ADR-002 D4); it is not built
in the MVP.

## 10. How observed backends produce `node-observed`

**Reserved, unreachable in the MVP** (SPIKE-2 NO-GO: a vendor task's result never reaches GitHub as a
change without a human click — ADR-002 D4). This section is kept as the mechanism an artifact-matcher
backend would use if one is added later.

An `observed` node executes on a vendor's cloud. Loopmill emits the trigger (a comment, or a vendor CLI
call) and then watches for a declared artifact until a deadline. The matcher is declared per node in the
loop file (`artifact:`), and its outcome is what becomes an envelope:

| Matcher outcome | Envelope | Details |
|---|---|---|
| Artifact found, parses, conforms to the node's declared shape | `node-observed`, `matcher.outcome: found_valid` | `artifactRefs` names what was matched (`comment`/`pr`/`file`) **with `digest`**; `result.structured` carries the parsed object; `usage.provenance: unavailable` with all buckets null |
| Artifact found but invalid (bad JSON, schema mismatch, wrong run) | `node-observed`, `matcher.outcome: found_invalid` | `error.code: artifact_invalid`, `error.classified: artifact_invalid`; the artifact is still referenced so a human can see what arrived. The node retries or fails per `state-machine.md` §9.2 (N-23/N-24) |
| Nothing found by the deadline | `node-timed-out` | `error.classified: timeout`; the attempt may be retried as a new vendor task (observed backends are `retryable: true`) |
| Vendor status says the task errored (`matcher.kind: cloud-status`) | `node-observed`, `matcher.outcome: found_invalid` | `error.classified: backend_error`; an early failure signal that does not wait for the deadline |

Two matcher kinds exist in the MVP: a fenced `loopmill` block in a comment (7.3), and a JSON file at a
declared path in the PR or diff. Both are content-addressed: the digest recorded in `artifactRefs` is
what a later human gate approves, so an edited comment cannot silently change what was approved.
Observed usage is always `unavailable` — never zero — and every report counts those executions in the
denominator of Usage Coverage.

---

## 11. Security

### 11.1 No secrets in envelopes

Envelopes are persisted to the local journal, rendered into run reports, and — for a human handoff, or
under the reserved `github-actions` integration — posted into GitHub comments, where they are as public
as the repository is. Treat every envelope as if it were public, including one that never leaves the
local journal: it can always be exported (`loopmill export`) or copied into a comment later. Therefore:

- Nothing in an envelope may be a credential, and nothing may be derived from one (no token prefixes,
  no partial keys, no "redacted but recognisable" forms).
- `run-node` redacts every captured stream **before** it becomes a field: the same redactor that guards
  logs guards `result.summary`, `error.message` and every other string.
- The schema is a **backstop**, not the mechanism: free-text fields reject strings matching known
  credential shapes (`sk-ant-…`, `sk-…`, `oat01…`, `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`,
  `github_pat_…`, `xox…`, `AKIA…`, PEM private-key headers). It cannot scan `result.structured`
  recursively, and it is deliberately narrow to avoid false positives on ordinary prose (TV-5).
- An envelope that trips the backstop is **invalid**: `loopmill step` exits 2 and writes nothing. It
  does not silently sanitise, because a quietly rewritten audit record is worse than a loud failure, and
  the Attempt is not lost — the lease expires and a new attempt runs.

### 11.2 Size as a security property

The 32 KiB limit is not only about GitHub's ceilings on the reserved paths. A bounded envelope bounds
what an untrusted producer can push into the journal, into a run report, and into every reader's
terminal. Oversized envelopes are rejected before parsing anything but the length.

### 11.3 What a forged envelope could do, and why it cannot

Assume an attacker who can comment on the repository (on a public repo, anyone) and knows the run's
coordinates from a public comment.

| Attempted forgery | Why it fails |
|---|---|
| Post a `node-completed` claiming success for the in-flight Attempt | Polling sets `producer` from the authenticated author (`human`), so it can never equal the `expectedProducer` recorded at dispatch (`backend:local`, or `backend:github-actions` under the reserved integration). The driver records `ignored-stale` (`producer_not_expected`) and applies nothing. |
| Post an envelope for an Attempt that is not in flight (an old cycle, a finished node, a finished Run) | Coordinates must equal the expected in-flight Attempt; otherwise `ignored-stale` (`stale_attempt` / `unknown_node` / `run_terminal`). |
| Impersonate the observed backend by posting a matcher-shaped comment (**reserved**, unreachable in the MVP) | Comment-borne `node-observed` would be accepted only while that node is `OBSERVING`, only from the author allow-list declared for the node, and only with a digest computed from the fetched comment. |
| Forge a `human-decided` approval | Polling never mints `human-decided` from a bare comment: it mints it only from a `pull_request_review` or a label change performed by an identity GitHub authenticated that has write access, or `loopmill approve`/`reject` runs it directly on the host. The `subjectDigest` must equal the one recorded in `human-requested`; a new Attempt changes that digest and voids old approvals. |
| Start an expensive Run with `run-requested` | Polling only mints `run-requested` when the Loop declares that trigger and the actor's association is `OWNER`/`MEMBER`/`COLLABORATOR`. Budgets (`maxRunsPerWindow`, `minInterval`, `maxMeasuredTokens`) are checked before any dispatch. |
| Inflate a headline usage figure | Usage from an untrusted producer is not accepted at all (same producer check). Even legitimate `unavailable` usage cannot become zero, and coverage is shown next to every total. |
| Escalate privileges through an envelope | Envelopes carry no permissions. On the host, the node executor runs under the permission profile's sandbox and tool restrictions (`docs/design/mvp-design.md` §13); an envelope cannot grant it a `gh`/`git push` capability the profile denied. Under the reserved `github-actions` integration, job scopes are fixed in workflow files and the agent job never receives the state-branch credential (ADR-002 Appendix A). |
| Rewrite history | The journal is append-only inside one SQLite transaction; there is no operation that edits or deletes a past row, and a rejected event still leaves an `ignored-stale` record, so refusals are visible. (The reserved `github-actions` integration's git-branch store used push protection and compare-and-swap for the same property, measured in SPIKE-3.) |

The general principle: **an envelope is a claim, and a claim is only as strong as the identity the
receiving boundary attached to it.** Every trust decision is made at a boundary that has an
authenticated identity to work with — a poll (GitHub's own authentication of the `gh` login) or the
driver (its own dispatch record) — and never by reading a field the sender chose.

### 11.4 Untrusted content passing through

Envelope fields frequently carry text an agent read from an issue, a PR or a web page. That text is
untrusted input for the *next* agent. Loopmill marks it (its injection scanner runs over ingested
content) and never sanitises it: silently editing an agent's input is unreproducible. Nodes with
`effects: external` require a human gate unless `approval.policy: auto` is set with a reason.

### 11.5 Producer and permission model

One host, one operator; the boundary is now the process, not a GitHub job.

| Component | Permissions | Holds | Can emit |
|---|---|---|---|
| Driver (`control-plane`: `loopmill run` / `step`) | reads and writes `.loopmill/state.sqlite` and manages the Run's worktree on the host | no vendor credential | every `control-plane` event |
| `backend:local` (the node executor, a subprocess of `run`) | the runtime CLI's own permission profile (`readonly`/`workspace`/`full`); `gh`/`git push` denied by default (`docs/design/mvp-design.md` §13) | the CLI's own login on the host (`claude`, `codex`) | `node-started`, `node-completed`, `node-failed`, `node-timed-out` for its own Attempt |
| `backend:fake` | none — fixture replay for tests and CI | nothing | the same event set as `local`, sourced from a fixture |
| `human`, via polling or the host CLI | the GitHub identity a poll authenticated, or the host's own OS/`gh` identity for `loopmill approve`/`reject` | — | `human-decided`, `resumed`; a human-requested Run reaches the machine as a `run-requested` that polling stamps `producer: trigger` |
| `trigger` | the OS scheduler, an operator-invoked `loopmill run`, or a polled GitHub event | — | `run-requested` |
| (**reserved**) `backend:github-actions`, and that integration's polling | job-scoped GitHub permissions; a job secret for the vendor credential (ADR-002 Appendix A) | the vendor credential from a job secret | the same node-level and control-flow events, across a process boundary |

### 11.6 The reserved `signature` field

`signature` is reserved and unused in schema 1.x. Receivers MUST ignore it and MUST NOT treat its
presence or absence as evidence of anything. It exists now so that adding authentication later is a
minor version bump rather than a breaking change.

The intended future shape: a detached HMAC-SHA256 over the JCS-canonicalised (RFC 8785) envelope with
`signature` removed, formatted `hmac-sha256:<keyId>:<base64url>`, with per-producer keys distributed as
job secrets. It buys producer authentication on a transport nothing else authenticates — under the
reserved GitHub paths that is none of them today, since GitHub authenticates every one of them itself;
the MVP's in-process and stdin/`--event-file` transports are implicitly authenticated by process and
host ownership instead. That is exactly why `signature` is reserved rather than implemented: an
unverified signature field is worse than no field, because it invites readers to trust it.

---

## 12. Versioning

`schemaVersion` is a semantic version of **this specification**, independent of the Loopmill package
version and of the loop file's own `schemaVersion`.

| Change | Bump | Rule |
|---|---|---|
| New optional field; new enum member in a non-dispatching enum (`error.classified`, `artifactRef.kind`); new `reason` token; relaxed constraint | **minor** | Receivers on the same major must already tolerate it. |
| New `eventType` | **minor** | See the carve-out below. |
| Field removed or renamed; type or format tightened; a field made required; semantics of an existing field changed | **major** | Requires a translation step. |
| Wording, `$comment`, description | **patch** | No behaviour change. |

Receiver rules:

- A receiver validates against the schema for **its own** version and rejects a *major* it does not know
  (exit 2). A newer *minor* is accepted: unknown optional fields are preserved verbatim when the event
  is persisted, so that a downgrade does not silently erase data.
- **Unknown `eventType` carve-out.** Validation failure on `eventType` alone is not exit 2. The control
  plane records `ignored-stale` with `reason: unknown_event_type` and exits 0. Without this, adding an
  event type would break every older control plane, and the "additive is minor" rule would be a
  fiction. *Decision (not in sheet).*
- A major bump ships with `loopmill migrate-envelope --from <major> --to <major>` and a documented
  field-by-field translation table. The control plane accepts exactly one major back, translating on
  ingest and recording the translation in the event it persists (`schemaVersion` becomes the current
  version; the original is kept in the event record's envelope-as-received). Two majors back is
  refused, loudly.
- The published schema file is versioned alongside this document; historic versions stay readable so an
  old event log can still be validated years later.

---

## 13. Test vectors

**TV-1 — every example validates.** `docs/spec/envelope-examples/` holds one valid envelope per event
type (17) plus two invalid ones. `node docs/spec/validate-envelopes.mjs <dir-with-node_modules>`
validates all of them, asserts that the `invalid-*` files fail, and asserts that every `eventType` in
the enum has at least one valid example.

Expected output (2026-09-06, ajv 8 with ajv-formats):

```text
19 checked, 0 problem(s); 17/17 event types covered;
largest example 1739 B (1943 B when JSON-string escaped for a dispatch payload).
```

The two invalid ones must fail for exactly these reasons:

| File | Expected error |
|---|---|
| `invalid-node-completed-missing-attempt.json` | `/ must have required property 'attempt'` |
| `invalid-secret-in-summary.json` | `/result/summary must NOT be valid` (the credential-shape backstop) |

**TV-2 — `eventId` derivation (section 8.3).**

```text
seed        = "loopmill/ingest/1 issue_comment 3310042117 2026-09-06T09:04:11Z"
sha256(seed)= 4b5e057e07f0266729b8cb3f402568e311c50280b0d9196ffedb63748621e8b3
entropy     = 4b5e057e07f0266729b8                      (first 10 bytes)
timestamp   = 1788685451000                             (2026-09-06T09:04:11Z)
eventId     = 06G7BXFYZ09DF0AZG7Y0K6EADR
```

Deriving twice from the same delivery must give the same 26 characters; changing any byte of the seed
must change the last 16.

**TV-3 — size accounting (section 7.6).** `node-completed.json`, the largest example: 1,739 B as stored
(pretty-printed, 1,943 B when that text is escaped into a JSON string) and 1,422 B compact, which is the
wire form, 1,568 B escaped. Escaping costs about +10% on realistic content; the worst case is +100% (a
string of nothing but quotes and backslashes), which is why the encoded-body check exists and why the
budget is 60 KiB rather than 64 KB.

**TV-4 — codex cumulative-usage delta (section 4.6).** `turn.completed.usage` is thread-cumulative.

| | input | cached | cache_write | output | reasoning |
|---|---|---|---|---|---|
| cumulative at attempt start | 12,000 | 9,000 | 1,500 | 800 | 400 |
| cumulative at `turn.completed` | 31,000 | 24,000 | 3,000 | 2,600 | 1,500 |
| delta | 19,000 | 15,000 | 1,500 | 1,800 | 1,100 |

Envelope: `cacheReadTokens: 15000`, `cacheWriteTokens: 1500`,
`freshInputTokens: max(0, 19000 - 15000 - 1500) = 2500`, `outputTokens: 1800`,
`reasoningTokens: 1100`, `totalInputTokens: 19000`, `totalTokens: 20800`,
`provenance: "derived"`, `source.eventKind: "turn.completed.usage"`.

**TV-5 — the credential backstop must not fire on ordinary prose.**

| String | Expected |
|---|---|
| `a risk-averse approach to tokens` | accepted |
| `the task-12345678901234567890 finished` | accepted |
| `briskly-1234567890123456789012` | accepted |
| `sk-ant-EXAMPLENOTAREALKEY000000000000` | rejected |
| `CLAUDE_CODE_OAUTH_TOKEN=oat01_EXAMPLEEXAMPLE` | rejected |
| `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123` | rejected |

**TV-6 — fenced block extraction (section 7.3).** For a comment body of

````text
Thanks, here is the review result.

```loopmill
{"schemaVersion":"1.0.0","eventId":"06G7BWJ5V056N94SSK77T05TRH","eventType":"node-observed"}
```

(ignore the block below, it is a quote)

```loopmill
{"schemaVersion":"1.0.0","eventId":"06G7BWKMQ0WWH4E7Y7J3XGD41A","eventType":"node-completed"}
```
````

(both objects abbreviated to three keys for the vector; a real block carries a complete envelope)
the parser must yield exactly the first object (`eventId` ending `T05TRH`), must ignore all prose, and
must ignore the second block entirely. A body whose first fence line is ` ```loopmill ` (indented),
```` ```loopmill json ```` or ```` ```LOOPMILL ```` yields **no** envelope.

**TV-7 — idempotency.** Applying the same `eventId` twice persists no second event and commits no
second transaction. Applying a `node-completed` whose `(cycle, nodeId, attempt)` is not the in-flight Attempt
produces exactly one `ignored-stale` with `reason: stale_attempt` and no state change. Both are
control-plane behaviours, asserted by the control-plane test suite rather than by the schema.

---

## 14. Open items

- The dispatch permission scopes in 7.4-7.5 apply only to the reserved `github-actions` integration and
  are not needed by the MVP; confirming them against the live API is deferred until that integration is
  built.
- The comment body limit is a soft, community-corroborated number; if GitHub documents it differently,
  only the wording of 7.3 changes, never the 32 KiB rule.
- `signature` stays reserved until there is a transport nothing else authenticates for us.
