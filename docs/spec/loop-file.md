# Loop file specification

Version 0.5 · schema `https://loopmill.dev/schema/loop-file/0.5.json` · 2026-09-06

The **Loop file** is the source of truth for a Loopmill Loop: a bounded, versioned
definition of an AI engineering loop that may span several vendors and several
execution backends, expressed as one file a human can read, review and diff.

Everything the control plane needs in order to run, resume, reconcile and report on
a Loop is in this file or derivable from it. Nothing about a Run is stored here: the
file is the definition, the state branch is the history.

This document is normative. Where it says **MUST**, `loopmill validate` rejects the
file with the numbered error code given in [§13](#13-validation-rules). Where the
v0.5 decision sheet is silent, the choice is marked **Decision (not in sheet)** with
its rationale, and [§16](#16-decision-index) indexes all of them.

---

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [File location and naming](#2-file-location-and-naming)
3. [Identity: `slug` and `loopVersion`](#3-identity-slug-and-loopversion)
4. [Document structure](#4-document-structure)
5. [Trigger](#5-trigger)
6. [Repos, defaults, env and approval](#6-repos-defaults-env-and-approval)
7. [Budget](#7-budget)
8. [Nodes](#8-nodes)
9. [Inputs and references](#9-inputs-and-references)
10. [Templating](#10-templating)
11. [Condition expressions](#11-condition-expressions)
12. [Retry Edges](#12-retry-edges)
13. [Validation rules](#13-validation-rules)
14. [Backend capabilities](#14-backend-capabilities)
15. [Worked examples](#15-worked-examples)
16. [Decision index](#16-decision-index)
17. [What the v0.4 design left undefined and this spec settles](#17-what-the-v04-design-left-undefined-and-this-spec-settles)

---

## 1. Purpose and scope

A Loop file describes:

* **what runs** — Nodes, each pinned to a Runtime (which agent CLI), an Execution
  Backend (where and how it runs) and an Authentication Mode (whose subscription
  pays for it);
* **in what order** — forward edges implied by `next` / `then` / `else`, and the one
  kind of backward edge, the **Retry Edge**;
* **under what bounds** — `budget`, the property that makes a Loopmill loop a
  *bounded* loop rather than an open-ended agent;
* **under what policy** — the environment policy applied to every subprocess, and
  the approval policy that decides whether a node with external effects may run
  without a human.

A Loop file does **not** describe: infrastructure (runner labels, images, secrets
names), the state store, retention, or anything about a particular Run. Those are
control-plane settings, not Loop definition. In particular `maxStepsPerRun` (the
runaway-chain cap, default 200) is a control-plane setting and is deliberately not
a Loop file field.

---

## 2. File location and naming

```
<repo root>/.loopmill/<slug>.loop.yaml
```

* The file is YAML 1.2. `loopmill validate` parses it with duplicate-key detection
  on: a repeated mapping key is an error (LM-VAL-003), never a silent last-wins.
* The basename before `.loop.yaml` MUST equal the `slug` field (LM-VAL-002). This is
  what makes `loopmill run <slug>` unambiguous without opening every file.
* `.loopmill/` may hold any number of Loop files. Files that do not end in
  `.loop.yaml` are ignored.
* **Decision (not in sheet):** the validator accepts a Loop file at any path whose
  basename is `<slug>.loop.yaml`, so that example and fixture loops (this
  repository's `examples/` and `docs/spec/examples/`) can be validated by the same
  code path as a real `.loopmill/` file. Only `.loopmill/` is scanned by
  `loopmill run` / `loopmill runs`.

A JSON file (`<slug>.loop.json`) with identical content is accepted by the schema
but is not the authored form: YAML is chosen because comments explaining a
Runtime × Backend × Auth choice are the most valuable part of a real Loop file, and
JSON cannot carry them.

---

## 3. Identity: `slug` and `loopVersion`

| Identity | Value | Stability |
|---|---|---|
| `loopId` | the `slug` field | immutable and user-visible; changing it creates a different Loop with no shared history |
| `loopVersion` | `sha256:<64 lowercase hex>` over the canonicalised file | changes whenever the *meaning* of the file changes |

A Run pins `loopVersion` at start. Resume, retry and reconcile replay the pinned
version, so editing a Loop file never rewrites the definition a Run in flight is
executing.

### 3.1 Canonicalisation (Decision (not in sheet))

The decision sheet fixes `loopVersion` as "sha256 of the canonicalised file" without
defining canonicalisation. The rule is:

1. Parse the file as YAML 1.2 into a JSON value using the core schema. Anchors and
   aliases are expanded; merge keys are resolved.
2. Do **not** apply defaults. The hash covers the document as authored, not the
   document as resolved.
3. Serialise that value as **RFC 8785 JSON Canonicalization Scheme**: UTF-8, object
   members sorted by code point of the member name, no insignificant whitespace,
   numbers in shortest round-trip form.
4. `loopVersion` = `"sha256:" + hex(sha256(bytes))`.

Consequences, all of them intended:

* A comment-only edit, a re-indent, a change of quoting style or a re-ordering of
  mapping keys does **not** change `loopVersion`. A scheduled Loop whose comments
  were tidied at 17:00 does not start a "new" Loop at 06:00.
* Re-ordering a YAML **sequence** *does* change it — `argv`, `repos`, `edges` and
  `types` are ordered and their order is meaningful.
* Because defaults are not materialised, a future change to a default value shows up
  as a `schemaVersion` change, not as a silent `loopVersion` change on files nobody
  touched. The engine records both.

---

## 4. Document structure

```yaml
schemaVersion: "0.5.0"       # required
slug: daily-content-improvement   # required
name: Daily Content Improvement   # required
description: ...             # optional
entry: review-content        # optional, see below
trigger: {...}               # required
repos: [...]                 # required, exactly one entry in the MVP
defaults: {...}              # optional
budget: {...}                # optional (every field has a default)
env: {...}                   # optional
approval: {...}              # optional
nodes: {...}                 # required, id-keyed map
edges: [...]                 # optional, Retry Edges only
```

Unknown keys are rejected everywhere (`additionalProperties: false`). A typo'd key is
a hard error, never a silently ignored field — a Loop file whose `promt:` was
accepted and quietly dropped would run every night, look healthy, and do nothing.

Three places are open by design and constrained a different way: `nodes`, `inputs`
and `env.inject` are keyed maps, so their **keys** are constrained by a pattern
(`propertyNames`) and their values are fully specified. One place is genuinely open:
`nodes.<id>.structuredOutput` is a foreign JSON Schema document that Loopmill hands
to a runtime rather than interprets (see [§8.1](#81-agent-node)).

| Field | Type | Default | Semantics |
|---|---|---|---|
| `schemaVersion` | semver string | — | Loop file format version. The MVP engine accepts `0.5.x` and refuses a major it does not know. |
| `slug` | `^[a-z][a-z0-9-]{1,63}$` | — | `loopId`. MUST match the file name (LM-VAL-002). |
| `name` | string, 1–120 | — | Human title shown in `loopmill runs`, the job summary and the read-only UI. |
| `description` | string, ≤4000 | — | What the Loop is for. Never sent to a runtime unless a prompt references it. |
| `entry` | node id | derived | Node the Run starts at. |
| `trigger` | object | — | [§5](#5-trigger). |
| `repos` | array, exactly 1 | — | [§6.1](#61-repos). |
| `defaults` | object | `{}` | [§6.2](#62-defaults). |
| `budget` | object | see [§7](#7-budget) | Bounds checked before every dispatch. |
| `env` | object | `{}` | [§6.3](#63-env-policy). |
| `approval` | object | `{policy: gated}` | [§6.4](#64-approval-policy). |
| `nodes` | map | — | [§8](#8-nodes). |
| `edges` | array | `[]` | [§12](#12-retry-edges). |

### 4.1 `nodes` is an id-keyed map

**Decision (not in sheet):** `nodes` is a mapping from node id to node object, not a
list. The decision sheet allows either.

The map is chosen because a node id appears in four other places — `next`, `then`,
`else`, `edges[].from`/`to`, `human.subject`, and every `nodes.<id>....` reference —
and a map makes the id exist exactly once, makes duplicate ids a YAML-level error
rather than a semantic one, and makes a `git diff` of a Loop file readable.

A node object MAY carry an `id` field echoing its key. If present it MUST equal the
key (LM-VAL-004). The echo exists for one reason: a model asked to emit a Loop file
overwhelmingly emits `{"nodes": [{"id": ..., ...}]}`, and Loopmill's authoring tools
fold that array into the map **mechanically, before spending a model call on a
correction**. Deterministic repair of a known-wrong shape is free; asking a model to
try again is not. The repaired document is then validated normally; the array form
itself is never valid.

### 4.2 Entry node

`entry` names the node a Run starts at. When `entry` is omitted it is derived as the
unique node with no incoming **forward** edge. If zero or more than one node
qualifies, the file is rejected (LM-VAL-005) rather than guessed at — with an
id-keyed map there is no document order to fall back on, and in-degree alone is too
easy to change by accident with a single mistyped `next`.

Every node MUST be reachable from the entry node (LM-VAL-011), and every node that
is not an `end` node MUST have a successor or route into a Retry Edge
(LM-VAL-012).

---

## 5. Trigger

Discriminated by `kind`. **Decision (not in sheet):** the discriminator key is
`kind`, matching `nodes.<id>.kind`, so every discriminated union in the file reads
the same way.

```yaml
trigger: { kind: manual }
```

```yaml
trigger:
  kind: schedule
  cron: "0 6 * * *"     # five fields: minute hour day-of-month month day-of-week
  tz: Asia/Tokyo        # IANA name; default UTC
```

```yaml
trigger:
  kind: event
  source: github        # the only source in the MVP
  types: [issues.opened, pull_request.synchronize]
```

| Field | Semantics |
|---|---|
| `schedule.cron` | Evaluated in `tz`. Loopmill is never resident: an external scheduler (a GitHub Actions `schedule:`, or the maintainer's own scheduler for `local`) invokes the control plane, which decides whether a Run is due. |
| `schedule.tz` | **Decision (not in sheet):** an IANA time zone name, default `UTC`. A named zone rather than a fixed offset, because a Loop that must run at 06:00 local must keep doing so across a DST transition. |
| `event.types` | GitHub event name, optionally narrowed by action. A Loop is never started by an unmediated webhook: GitHub-native events are ingested by an `ingest` workflow that converts them into Envelopes, so that a Run always begins from a validated Envelope with an `eventId`. |

A schedule that can fire more often than `budget.minInterval` is a validation error
(LM-VAL-026): a Loop whose schedule contradicts its own rate limit is a
configuration mistake, not a runtime condition to discover at 03:00.

---

## 6. Repos, defaults, env and approval

### 6.1 Repos

```yaml
repos:
  - id: site
    path: "."          # exactly one of path | remote
    defaultBase: main
```

| Field | Semantics |
|---|---|
| `id` | Identifier for the repo. Reserved for the multi-repo case; in the MVP there is exactly one, so nothing references it yet. |
| `path` | Repository-relative path to the working tree. `.` is the repository the Loop file lives in. Absolute paths and `..` segments are rejected. |
| `remote` | Clone URL, for a Loop that operates on a repository other than its own. |
| `defaultBase` | Branch working branches are cut from and pull requests target. |

The MVP allows exactly one repo (LM-VAL-022). The field is a list, not a scalar,
because the multi-repo case is a schema-compatible addition and the one-repo
restriction is a validation rule that can be lifted without a format change.

### 6.2 Defaults

```yaml
defaults:
  backend: github-actions
  runtime: claude-code
  authMode: subscription-oauth
  permissionProfile: workspace
  isolation: ephemeral
```

Every value is inherited by nodes that do not set it. **Decision (not in sheet):**
node-level values always win and defaults never *widen* a node-level value; in
particular a node with `permissionProfile: readonly` is never promoted to
`workspace` by a default. Tightening is allowed, loosening is not — a limit a node
declares for itself is the strictest that applies.

`runtime`, `authMode` and `permissionProfile` are meaningful only for `agent` nodes;
`backend` for `agent` and `command` nodes. `condition`, `human` and `end` nodes run
on the control plane and MUST NOT declare any of them (the schema rejects the
fields outright).

### 6.3 Env policy

```yaml
env:
  deny: [NPM_TOKEN]
  preserve: [CI]
  inject:
    LOOPMILL_LOOP: daily-content-improvement
```

Three lists, applied to every subprocess Loopmill spawns:

* **deny** — additive to the built-in deny list, which always applies and always
  wins: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`,
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_CONNECTORS_TOKEN`,
  and `GH_TOKEN` for every node whose `effects` is not `external`. A subscription
  run must not be silently converted into a metered API run by an inherited
  variable.
* **preserve** — additive to the built-in preserve list: `PATH`, `HOME`, `SHELL`,
  `LANG`, `TZ`, the proxy variables, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`. A name that
  also appears in a deny list stays denied.
* **inject** — literal name/value pairs added to every subprocess environment.
  **Decision (not in sheet):** injected values are literal strings only. No
  templating and no secret references: a Loop file is committed and reviewed, so it
  must not be a place where a secret can be written by accident, and an injected
  value that varied per node execution would not be reproducible from the pinned
  `loopVersion`.

A `command` node's own `env` field is an **allowlist**: only the names it lists,
intersected with the effective preserve + inject set, reach that command.

### 6.4 Approval policy

```yaml
approval:
  policy: auto              # gated (default) | auto
  reason: "Issue creation is reversible and is the intended unattended output."
  nodes: [create-issue]     # optional narrowing
```

A node with `effects: external` MUST be preceded by a `human` node on **every** path
from the entry node to it (LM-VAL-023). `policy: auto` lifts that requirement and
REQUIRES a `reason` (LM-VAL-024), which is recorded in the Run header and shown in
every report.

**Decision (not in sheet):** `approval.nodes` narrows `policy: auto` to a named set
of external nodes; every other external node still needs its gate. Blanket
auto-approval is the mistake this field exists to prevent: a Loop typically has one
external effect that is obviously safe to automate (opening an Issue) and one that
is not (opening a pull request), and forcing an author to choose between "gate
everything" and "gate nothing" produces the wrong answer. The reference Loop uses
exactly this shape.

---

## 7. Budget

Bounds are checked **before** each dispatch. A breach terminates the Run as
`BUDGET_EXCEEDED` (or `EXPIRED` for `maxRuntime`); an attempt is never killed
mid-flight on a token count — only on wall clock.

```yaml
budget:
  maxAttempts: 2
  maxIterations: 3
  maxRuntime: PT4H
  maxMeasuredTokens: 2000000
  maxUnmeasuredExecutions: 8
  maxRunsPerWindow: { count: 1, window: PT5H }
  minInterval: PT1H
```

| Field | Type | Default | Scope | Semantics |
|---|---|---|---|---|
| `maxAttempts` | integer ≥ 1 | `2` | Node Execution | Infrastructure-level dispatches. Attempts > 1 exist only for a `LOST` completion or a transient backend error — never for loop retries, which are Cycles. |
| `maxIterations` | integer ≥ 1 | none | Loop | **Cap** on every Retry Edge's own `maxIterations` (LM-VAL-025). |
| `maxRuntime` | ISO-8601 duration | `PT4H` | Run | Wall clock, **excluding** time spent in `WAITING_HUMAN`. A gate that waits overnight must not consume the runtime budget. Breach → `EXPIRED`. |
| `maxMeasuredTokens` | integer ≥ 1 | none | Run | Checked against **measured** tokens only — usage whose provenance is `reported` or `derived`. `estimated` and `unavailable` never count towards it, so the budget can never be satisfied by numbers Loopmill did not actually observe. |
| `maxUnmeasuredExecutions` | integer ≥ 0 | derived | Run | Agent Node Executions whose usage provenance is `unavailable`. Whenever usage coverage is below 100% this, not the token budget, is the binding guard. |
| `maxRunsPerWindow` | `{count, window}` | `{count: 1, window: PT5H}` | Loop | Rolling-window rate limit, aligned with the vendors' own rolling usage windows. |
| `minInterval` | ISO-8601 duration | `PT1H` | Loop | Minimum wall-clock distance between the starts of two Runs. |

### 7.1 `maxIterations` is per Retry Edge

The iteration budget is declared **on the Retry Edge**, where it belongs: two Retry
Edges in one Loop are two independent counters, and a Loop with no Retry Edge has no
iteration budget at all.

**Decision (not in sheet):** `budget.maxIterations` therefore exists only as a
loop-wide **cap**. It can tighten an edge, never loosen one; an edge declaring more
than the cap is rejected (LM-VAL-025) rather than silently clamped, so the file and
the behaviour never disagree. `edges[].maxIterations` remains required.

### 7.2 Default for `maxUnmeasuredExecutions`

**Decision (not in sheet):** the default is

```
max(1, observedAgentNodes × (1 + maxEdgeIterations))
```

where `observedAgentNodes` counts `agent` nodes whose resolved backend has
`usage: none`, and `maxEdgeIterations` is the largest `maxIterations` over all Retry
Edges (0 when there are none). The decision sheet writes this as "number of observed
nodes × maxIterations"; that undercounts by exactly one pass, because a Retry Edge
body executes once *before* any traversal (see [§12](#12-retry-edges)). The `+ 1`
makes the default equal to the worst case a correct Loop can actually reach, so the
default never terminates a Run that stayed inside its own iteration budget.

### 7.3 Duration format

Every duration in a Loop file is an ISO-8601 duration restricted to days, hours,
minutes and seconds: `PT30M`, `PT4H`, `P1DT12H`, `PT90S`. Years, months and weeks
are rejected because they are not a fixed number of seconds and a budget that
changes length depending on the month is not a budget. This applies to
`budget.maxRuntime`, `budget.minInterval`, `budget.maxRunsPerWindow.window`, every
node `timeout` and `artifact.deadline`.

---

## 8. Nodes

`nodes` is a map from node id (`^[a-z][a-z0-9-]{1,63}$`) to a node object,
discriminated by `kind`.

Common fields, and where each kind accepts them:

| Field | agent | command | condition | human | end | Semantics |
|---|:--:|:--:|:--:|:--:|:--:|---|
| `kind` | ● | ● | ● | ● | ● | Required discriminator. |
| `id` | ○ | ○ | ○ | ○ | ○ | Optional echo of the map key (LM-VAL-004). |
| `runtime` | ○ | — | — | — | — | `claude-code` \| `codex`. |
| `backend` | ○ | ○ | — | — | — | `github-actions` \| `observed` \| `local` \| `fake`. |
| `auth` | ○ | — | — | — | — | `subscription-oauth` \| `subscription-login` \| `api-key`. |
| `inputs` | ○ | ○ | ● | — | — | [§9](#9-inputs-and-references). Required and non-empty for `condition`. |
| `timeout` | ○ | ○ | — | ○ | — | ISO-8601 duration. |
| `onFailure` | ○ | ○ | — | ○ | — | `fail_run` (default) \| `continue` \| `retry_edge:<edgeId>`. |
| `effects` | ○ | ○ | — | — | — | `none` (default) \| `external`. |
| `next` | ○ | ○ | — | ○ | — | Successor: a node id or a Retry Edge id. |

● required · ○ optional · — rejected by the schema

### 8.0 Common field semantics

**`effects`.** **Decision (not in sheet):** `external` means the node creates or
changes something outside the Loop's working branch that a human or a third party
sees as the Loop's product — an Issue, a pull request, a release, a deployment, a
message. Loopmill's own coordination traffic (the dispatch that triggers an
`observed` node, the fenced `loopmill` blocks it reads back, the state branch) is
**not** an external effect: it is the control plane talking to itself, it is never
addressed to a human, and treating it as external would require a human gate before
every cross-vendor handoff, which would defeat the purpose of the product. The
distinction is load-bearing for security: only an `effects: external` node's job
receives `issues: write` / `pull-requests: write` and `GH_TOKEN`.

**`onFailure`.** `fail_run` makes the Run `FAILED` with the node's failure reason.
`continue` follows `next` anyway, which is how a red test suite becomes *evidence*
for a later condition rather than the end of the Run. `retry_edge:<edgeId>` routes
the failure into a Retry Edge.

**`timeout`.** Loopmill enforces the timeout itself, by killing the subprocess or
cancelling the job — it does not rely on the runtime having a timeout flag, because
`codex exec` has none. A timed-out node execution is `TIMED_OUT` and is then handled
by `onFailure`. For a node on the `observed` backend, `artifact.deadline` is the
operative limit; `timeout` is ignored there.

**`next`.** MVP execution is sequential: `next` is one target, never a list.

### 8.1 Agent node

```yaml
implement:
  kind: agent
  runtime: claude-code
  backend: github-actions
  auth: subscription-oauth
  model: sonnet
  permissionProfile: workspace
  sessionPolicy: fresh
  inputs:
    issue_url: nodes.create-issue.stdout
  prompt: |
    Fix the problem described in ${issue_url}.
  structuredOutput:
    type: object
    properties:
      changed: { type: boolean }
      summary: { type: string }
    required: [changed, summary]
    additionalProperties: false
  timeout: PT30M
  next: run-tests
```

| Field | Type | Default | Semantics |
|---|---|---|---|
| `prompt` | string | — | Exactly one of `prompt` / `promptFile` (LM-VAL-027). Templated ([§10](#10-templating)). |
| `promptFile` | repo-relative path | — | Contents are templated exactly like an inline prompt. Use it when a prompt outgrows the file. |
| `structuredOutput` | JSON Schema object | none | The shape the agent's final answer must take. |
| `model` | string | runtime default | Passed through verbatim. Loopmill never translates a model name between vendors: `sonnet` means something to `claude-code` and nothing to `codex`, and silently mapping it would be a lie about which model was billed. |
| `permissionProfile` | `readonly` \| `workspace` \| `full` | `workspace` | Mapped by the runtime adapter to that CLI's own permission flags. |
| `sessionPolicy` | `fresh` | `fresh` | MVP supports `fresh` only (LM-VAL-021): every Attempt is a new CLI process with no resumed session, so an Attempt is reproducible from the pinned `loopVersion` plus its resolved inputs. |
| `artifact` | matcher object | — | Required on an `observed` backend, rejected elsewhere (LM-VAL-020). See [§8.6](#86-artifact-matcher). |

**`structuredOutput`** is the one place the schema allows unknown keywords, because
it is a foreign JSON Schema document that Loopmill hands to the runtime rather than
interprets. Its top-level `type` MUST be `object`. It maps to:

* `claude-code`: `--json-schema <schema>` with `--output-format json`; the validated
  answer arrives in the result's `structured_output` field.
* `codex`: `--output-schema <file>`; the final agent message's text is the JSON
  document.

Declaring `structuredOutput` on a backend that declares `structuredOutput: false` is
an error (LM-VAL-018) — the `observed` backend cannot pass a schema to a vendor
cloud it does not control, so an observed node reports its answer through an
artifact matcher instead, read with `captured.*` rather than `structured.*`.

### 8.2 Command node

```yaml
create-issue:
  kind: command
  argv: [gh, issue, create, --title, "${title}", --body, "${body}"]
  cwd: .
  env: [CI]
  inputs:
    title: nodes.review-content.captured.title
    body: nodes.review-content.captured.summary
  effects: external
  timeout: PT5M
  next: implement
```

| Field | Type | Default | Semantics |
|---|---|---|---|
| `argv` | string[], ≥1 | — | Executed with `shell: false` on the backend that owns the working tree, never in the control-plane job. There is no shell, so there is no word splitting, no globbing, no `;`, no `&&`. |
| `cwd` | repo-relative path | repo root | Absolute paths and `..` segments are rejected. |
| `env` | string[] | `[]` | Allowlist of variable names, intersected with the effective preserve + inject set. |

A command node exposes `stdout`, `exitCode` and `filesChanged` to later nodes. It
has no `runtime` and no `auth`: it holds no vendor credential.

### 8.3 Condition node

```yaml
review-verdict:
  kind: condition
  inputs:
    approved: nodes.review-changes.captured.approved
    tests_exit: nodes.run-tests.exitCode
  expr: approved == true && tests_exit == 0
  then: approve-pr
  else: retry-implementation
```

`inputs` is required and MUST be non-empty; `expr`, `then` and `else` are all
required. There is no implicit fall-through: a condition with no `else` would make
the false branch invisible, and the false branch is the one that matters. `then` and
`else` each take a node id **or** a Retry Edge id.

A condition node runs on the control plane. A missing input, an input that is not a
JSON scalar, or a type mismatch inside the expression is an **error** that fails the
node — never a silent `false` ([§11](#11-condition-expressions)).

### 8.4 Human node

```yaml
approve-pr:
  kind: human
  mode: environment-reviewers
  subject: nodes.implement
  timeout: PT12H
  next: create-pr
```

| Field | Type | Semantics |
|---|---|---|
| `mode` | `environment-reviewers` \| `pull-request-review` \| `label` | How the approval is asked for. `environment-reviewers`: a GitHub Environment with required reviewers gates the *next* job before it starts. `pull-request-review`: an approving review on the pull request. `label`: removal of the `loopmill:hold` label. |
| `subject` | `nodes.<id>` | The Node Execution whose **artifact digest** is being approved. The digest is recorded in the `human-requested` event; a retry changes the digest and therefore invalidates prior approvals. |
| `timeout` | duration | Optional. On expiry the node is `TIMED_OUT` and `onFailure` applies. |

The Run enters `WAITING_HUMAN`. Nothing of Loopmill's is resident while it waits, and
the wait is excluded from `budget.maxRuntime`.

**Decision (not in sheet):** a *rejection* is a node failure with
`failureReason: human_rejected`, so `onFailure` governs it — `fail_run` (the default)
ends the Run `FAILED`, `continue` proceeds to `next`, and `retry_edge:<id>` sends the
work back for another attempt. No separate `onReject` field is introduced: rejection
and timeout are both "this gate did not produce an approval", and giving them one
mechanism means a Loop author cannot handle one and forget the other.

### 8.5 End node

```yaml
end-shipped: { kind: end, outcome: success }
end-no-change: { kind: end, outcome: no_change }
```

`outcome` is a label reported as `SUCCEEDED(end:<label>)`. `success` and `no_change`
are conventional; any `^[a-z][a-z0-9_-]{0,63}$` label is allowed, so a Loop can
distinguish its own outcomes ("shipped", "already-fixed", "escalated") in analytics
without a schema change. An end node has no `next`.

Reaching an end node is always a **success**: `FAILED`, `MAX_ITERATIONS_EXCEEDED`,
`BUDGET_EXCEEDED`, `EXPIRED` and `CANCELLED` are reached by *not* getting here.

### 8.6 Artifact matcher

For a node on the `observed` backend, Loopmill only (a) emits the trigger and
(b) watches for an artifact. The matcher says what to watch for.

```yaml
artifact:
  kind: file-in-diff             # comment-fenced-block | file-in-diff | pr-body
  path: .loopmill/review.json    # required for file-in-diff, rejected otherwise
  deadline: PT30M
```

| `kind` | What Loopmill looks for |
|---|---|
| `comment-fenced-block` | A fenced ` ```loopmill ` block containing one JSON object, in an Issue or pull request comment. Free text around the block is ignored; the block is parsed strictly. |
| `file-in-diff` | A JSON file at `path` in the task's diff. |
| `pr-body` | A fenced ` ```loopmill ` block in the pull request body. |

`deadline` is how long the Node Execution stays in `OBSERVING`. On expiry the node is
`TIMED_OUT`. A matched artifact that is not a JSON object fails the node with reason
`artifact_invalid`. The object's top-level scalar members are what later nodes read
through `captured.<name>`.

---

## 9. Inputs and references

A node declares the values it needs under `inputs`, as a map from a **local name** to
a **reference**:

```yaml
inputs:
  issue_url: nodes.create-issue.stdout
  attempt:
    from: cycle.index
    default: 1
```

The long form adds `default`, a JSON scalar used when the reference resolves to
nothing. Without a default, an unresolvable reference is an error — never an empty
string. The local name is what `${name}` and condition expressions see; the
reference never appears in a prompt.

### 9.1 Reference grammar

```
reference   = "nodes." node-id "." accessor
            | "run." name
            | "cycle.index"
            | "trigger." path
accessor    = "structured." dotted-path
            | "captured." name
            | "stdout" | "exitCode" | "filesChanged"
```

| Accessor | Available from | Type |
|---|---|---|
| `structured.<path>` | an `agent` node that declares `structuredOutput` | the JSON value at that path |
| `captured.<name>` | an `agent` node on an `observed` backend | a top-level scalar of the matched artifact |
| `stdout` | a `command` node | the captured standard output, redacted |
| `exitCode` | a `command` node | integer |
| `filesChanged` | an `agent` or `command` node | integer, see below |
| `run.id` `run.loop` `run.version` `run.trigger` | always | string |
| `cycle.index` | always | integer, see [§12](#12-retry-edges) |
| `trigger.<path>` | always | the trigger payload |

Using an accessor a node cannot produce is an error (LM-VAL-016), and referencing a
node that does not exist is an error (LM-VAL-013).

**Decision (not in sheet):** `filesChanged` resolves to an **integer**, the number of
files the referenced Node Execution changed in the current Cycle — not the list. The
reference grammar admits no sub-path under `filesChanged`, and the only thing an
expression can usefully do with a list of paths is ask whether it is empty. The list
itself is on the Node Execution record and in the Envelope's `artifactRefs`, where
it can be read without being squeezed through a scalar expression language.

**Decision (not in sheet):** `trigger.*` is the one reference that cannot be checked
statically, because a trigger payload has no declared shape. An unresolvable
`trigger.*` reference with no `default` is therefore a **run-time** error that fails
the node (never an empty string); every other reference form is a validation error.
Trigger payloads are untrusted input and are scanned as such.

### 9.2 Resolution across cycles

**Decision (not in sheet):** a reference resolves to the **most recent** Node
Execution of the referenced node in the current Run. For a node inside the current
Retry Edge body that is the current Cycle; for a node outside it (the `create-issue`
of the reference Loop, for example) it is the last Cycle in which that node actually
ran. This is the only rule under which a Retry Edge body can refer to setup work
performed once in Cycle 0 without re-running it.

Every reference must come from a node that runs on **every** path from the entry node
to the referencing node (LM-VAL-014) — i.e. a dominator of it. Anything weaker
would let a Loop validate and then fail at 03:00 on the branch nobody tested.

---

## 10. Templating

Templating is deliberately the smallest thing that works.

* The only construct is `${name}`, where `name` is a **declared input of the same
  node**. There are no functions, no filters, no defaults inside the placeholder, no
  conditionals, no loops.
* `$${` produces a literal `${`.
* An undeclared name, or an unterminated `${`, is a validation error (LM-VAL-015).
  A reference that cannot be resolved at run time fails the node. Neither ever
  becomes an empty string: an agent that receives a prompt with a hole in it will
  confidently do the wrong thing, and the resulting Run looks successful.
* Substitution happens in exactly these places: `agent.prompt`, the contents of
  `agent.promptFile`, every element of `command.argv`, `command.cwd`. Nowhere else —
  not in ids, not in `expr` or `when` (which name inputs directly), not inside
  `structuredOutput`, not in `env.inject`.
* Values are substituted as JSON scalars rendered as text: strings verbatim, numbers
  in shortest round-trip form, booleans as `true`/`false`, `null` as `null`.

### 10.1 The argv binding rule

In `command.argv`, **substitution never changes the number of argv elements**. One
`${name}` contributes to exactly one argv element, and the substituted value is
inserted literally: never word-split, never glob-expanded, never re-parsed by a
shell — there is no shell, because commands run with `shell: false`.

```yaml
argv: [gh, issue, create, --title, "${title}", --body, "${body}"]
```

If `title` is `Fix "docs"; rm -rf /`, the process receives that as one argument to
`--title`. This is the whole reason `argv` is a list and not a command string: the
values flowing through a Loopmill loop come from Issues, comments, web pages and
model output, all of which are untrusted, and the only robust defence against
injection into a command line is never to have a command line.

Mixed elements are allowed and follow the same rule — `--title=${title}` is one
element after substitution.

---

## 11. Condition expressions

Used by `condition.expr` and by `edges[].when`.

### 11.1 Grammar

```ebnf
expression   = or_expr ;
or_expr      = and_expr , { "||" , and_expr } ;
and_expr     = unary , { "&&" , unary } ;
unary        = "!" , unary
             | comparison ;
comparison   = operand , [ comp_op , operand ] ;
comp_op      = "==" | "!=" | "<" | "<=" | ">" | ">=" ;
operand      = "(" , expression , ")"
             | literal
             | path ;
literal      = number | string | "true" | "false" | "null" ;
number       = [ "-" ] , digit , { digit } , [ "." , digit , { digit } ] ;
string       = '"' , { char - '"' } , '"'
             | "'" , { char - "'" } , "'" ;
path         = name , { "." , name } ;
name         = ( letter | "_" ) , { letter | digit | "_" } ;
letter       = "A".."Z" | "a".."z" ;
digit        = "0".."9" ;
```

Precedence, tightest first: `( )`, `!`, comparison, `&&`, `||`. Whitespace between
tokens is insignificant. Comparisons do not chain: `a < b < c` is a syntax error.

### 11.2 Semantics

* The first segment of a `path` MUST be a declared input of the node the expression
  belongs to (for `edges[].when`, of the edge's `from` node) — LM-VAL-017. Further
  segments index into the JSON value bound to that input.
* Resolution happens for the **whole** expression before evaluation. A path that
  does not resolve, or resolves to something that is not a JSON scalar, is an
  **error** — regardless of whether short-circuiting would have skipped it. This is
  the rule that stops a renamed field from quietly turning every verdict into
  "false" and every night's run into a silent no-op.
* `==` and `!=` require both operands to be the same JSON scalar type. There is no
  coercion: `"0" == 0` is an error, not `false`.
* `<`, `<=`, `>`, `>=` require both operands to be numbers.
* `&&`, `||`, `!` require booleans. There is no truthiness: `!count` is an error.
* Evaluation is left to right and short-circuits, which matters only for cost, never
  for whether an error is raised.

An expression error fails the node with `failureReason: condition_error`, and
`onFailure` does not apply to condition nodes: a Loop that cannot decide must stop.

---

## 12. Retry Edges

The Retry Edge is the only backward edge, and the reason a Loopmill loop is a
*bounded* loop.

```yaml
edges:
  - id: retry-implementation
    from: review-verdict
    to: implement
    when: approved == false || tests_exit != 0
    maxIterations: 3
```

| Field | Required | Semantics |
|---|:--:|---|
| `id` | ● | Unique among edges, and distinct from every node id (LM-VAL-003). |
| `from` | ● | The node that routes into this edge. |
| `to` | ● | An earlier node. MUST be on a forward path back to `from` (LM-VAL-008) and MUST run on a retryable backend (LM-VAL-007). |
| `when` | ○ | An assertion, not a router. See below. |
| `maxIterations` | ● | Integer ≥ 1, ≤ `budget.maxIterations` when that cap is set. |

### 12.1 Routing is explicit

**Decision (not in sheet):** control reaches a Retry Edge only because a node named
it — in `next`, in a condition's `then`/`else`, or in `onFailure: retry_edge:<id>`.
Exactly one node may route into a given edge, and it MUST be the edge's `from`
(LM-VAL-010). An edge nothing routes into is an error, not dead weight.

The alternative — inferring the backward jump from the edge list and evaluating
guards to pick between the edge and the node's normal successor — puts the branch in
two places at once and makes a Loop file's control flow unreadable at exactly the
moment it matters. Here, reading a node tells you every place control can go next.

**Decision (not in sheet):** `when` is therefore an **assertion**, not a router. When
present it is evaluated over the `from` node's resolved inputs at the moment of
traversal and MUST be true; a false guard fails the Run with
`failureReason: retry_edge_guard_failed`. Its purpose is to state, in a form both
`loopmill validate` and a reviewer can read, the condition under which the backward
jump is legitimate — and to catch a `then`/`else` wired the wrong way round at run
time instead of after three cycles of retrying work that had already succeeded.

### 12.2 Cycles

`cycleIndex` starts at **0**. Nodes outside every Retry Edge body execute in cycle 0
— that is setup and teardown. The **body** of an edge is the set of nodes on a
forward path from `to` to `from`, inclusive.

* Control entering a body for the first time sets `cycleIndex` to **1**.
* Each traversal of the Retry Edge increments `cycleIndex`: 1 → 2 → 3 …

So `maxIterations` counts **traversals of the edge**, and a body with
`maxIterations: 3` executes at most four times:

| Cycle | What happened | Traversals so far |
|---|---|---|
| 0 | setup nodes outside every body | — |
| 1 | first pass through the body | 0 |
| 2 | after the 1st traversal | 1 |
| 3 | after the 2nd traversal | 2 |
| 4 | after the 3rd traversal | 3 |
| — | 4th traversal refused | — |

This is what "Maximum Retries: 3" means: the original attempt plus three retries.

`MAX_ITERATIONS` is checked **before** dispatching the edge's `to` node. When the
budget is exhausted the Run terminates with the outcome `MAX_ITERATIONS_EXCEEDED` —
**never** `FAILED`. Running out of a budget you declared is not the same as breaking,
it is the bound working, and conflating the two would make every honest report of a
hard problem look like a defect.

A Loop with no Retry Edge has only cycle 0. Per-cycle averages in reports exclude
cycle 0; Run totals include it.

### 12.3 Why `to` must be retryable

Re-entering the Loop at a node that cannot be re-executed produces a loop that is
guaranteed to burn its entire iteration budget without changing anything. The
mechanical rule is: the `to` node's backend MUST declare `retryable: true`
(LM-VAL-007), and the body MUST contain at least one node on a retryable backend
(LM-VAL-009).

In the MVP every real backend is retryable, so LM-VAL-007 fires on exactly one
class of mistake — and it is a common one: pointing the edge at a `condition`,
`human` or `end` node. Those run on the control plane, not on a backend
([§14](#14-backend-capabilities)), and re-entering at a condition re-reads the same
structured output of the same unchanged Node Execution, takes the same branch, and
does it again until the budget is gone. `docs/spec/examples/invalid-retry-edge.loop.yaml`
is exactly this mistake.

---

## 13. Validation rules

`loopmill validate` runs these, and so does the start of every `loopmill step`: a
Run never dispatches against a Loop file that has not just been validated.

Rules are grouped, and every error carries its code. Codes are stable; a rule that is
withdrawn leaves its code retired rather than reused.

`LM-VAL-001` covers everything the JSON Schema itself rejects. Several rules below
(`LM-VAL-022`, `LM-VAL-024`, `LM-VAL-027`) are enforced by both the schema and the
semantic pass; for those, the specific code is reported alongside `LM-VAL-001` so the
message names the actual mistake rather than a `oneOf` failure.

### Document

| Code | Rule |
|---|---|
| `LM-VAL-001` | file does not validate against the JSON Schema |
| `LM-VAL-002` | `slug` does not match the file name |
| `LM-VAL-003` | duplicate id: a duplicate YAML key in `nodes`, a duplicate `edges[].id`, or an edge id colliding with a node id |
| `LM-VAL-004` | node `id` echo does not equal its map key |

### Graph

| Code | Rule |
|---|---|
| `LM-VAL-005` | entry node cannot be determined: `entry` names an unknown node, or it is omitted and zero or several nodes have no incoming forward edge |
| `LM-VAL-006` | unknown target in `next`, `then`, `else`, `onFailure`, `human.subject`, `edges[].from` or `edges[].to` |
| `LM-VAL-007` | **retry edge targets non-retryable backend** |
| `LM-VAL-008` | retry edge does not close a cycle: `from` is not forward-reachable from `to` |
| `LM-VAL-009` | retry edge body contains no node on a retryable backend |
| `LM-VAL-010` | retry edge is never routed to, is routed to by more than one node, or its `from` is not the node routing into it |
| `LM-VAL-011` | node is unreachable from the entry node |
| `LM-VAL-012` | node has no successor and is not an `end` node |

### Data flow

| Code | Rule |
|---|---|
| `LM-VAL-013` | input reference names a node that does not exist |
| `LM-VAL-014` | referenced node does not run on every path from the entry node to the referencing node |
| `LM-VAL-015` | `${...}` placeholder names something that is not a declared input of that node, or is unterminated |
| `LM-VAL-016` | accessor is not available from the referenced node's kind or backend (`structured.*` without `structuredOutput`; `captured.*` from a non-observed node; `stdout`/`exitCode` from a non-command node) |
| `LM-VAL-017` | expression operand is not a declared input of the node (for `edges[].when`, of the edge's `from` node), or the expression is not well-formed |

### Capability

| Code | Rule |
|---|---|
| `LM-VAL-018` | node sets `structuredOutput` but its backend declares `structuredOutput: false` |
| `LM-VAL-019` | unsupported Runtime × Backend × Auth combination, or a required one of the three is neither declared nor defaulted |
| `LM-VAL-020` | `artifact` matcher missing on an `observed` node, or present on a node that is not `observed` |
| `LM-VAL-021` | `sessionPolicy` other than `fresh` (MVP) |
| `LM-VAL-022` | more than one entry in `repos` (MVP) |

### Policy and budget

| Code | Rule |
|---|---|
| `LM-VAL-023` | `effects: external` node with no `human` node on every path from the entry node, and not exempted by `approval.policy: auto` |
| `LM-VAL-024` | `approval.policy: auto` without a `reason` |
| `LM-VAL-025` | `edges[].maxIterations` exceeds the `budget.maxIterations` cap |
| `LM-VAL-026` | `trigger.kind: schedule` can fire more often than `budget.minInterval` |
| `LM-VAL-027` | agent node sets both `prompt` and `promptFile`, or neither |

### Supported combinations for LM-VAL-019

| Backend | Runtime | Allowed `auth` |
|---|---|---|
| `github-actions` | `claude-code` | `subscription-oauth`, `api-key` |
| `github-actions` | `codex` | `subscription-login` (EXPERIMENTAL, behind a flag until seeded-credential survival on ephemeral runners is proven), `api-key` |
| `local` | `claude-code` | `subscription-oauth`, `api-key` |
| `local` | `codex` | `subscription-login`, `api-key` |
| `observed` | `codex` | `subscription-login` |
| `fake` | any | any |

`observed` has no `claude-code` instance in the MVP. `api-key` is never a default and
never silent: a node that uses it is shown as metered in every report.

---

## 14. Backend capabilities

Each backend declares this record in code; `loopmill backends --json` echoes it.
Validation reads it, so a Loop file never has to restate it.

| Capability | `github-actions` | `observed` | `local` | `fake` | `control-plane` |
|---|---|---|---|---|---|
| `invocation` | on-demand | event or on-demand | on-demand | on-demand | on-demand |
| `result` | returned (+ streamed log) | observed | returned | returned | returned |
| `usage` | full | none | full | full | none |
| `quotaSignal` | classified | none | classified | classified | none |
| `structuredOutput` | true | false | true | true | false |
| `retryable` | true | true | true | true | **false** |
| `cancellable` | true (job cancel) | false | true | true | true |
| `isolation` | ephemeral | vendor-side | worktree | ephemeral | n/a |
| `credentialLocation` | job-secret | vendor-side | user-machine | none | none |

**`github-actions`** — Loopmill's own node executor runs inside a GitHub Actions job
and invokes the runtime CLI directly, never through a vendor-supplied action,
because usage, structured output and exit codes have to be captured by Loopmill
itself rather than inferred from someone else's logs. `claude-code` authenticates
with `CLAUDE_CODE_OAUTH_TOKEN`; `codex` with a seeded credential file under
`CODEX_HOME` (EXPERIMENTAL) or, explicitly opted in, an API key.

**`observed`** — the node executes on a vendor's own cloud. Loopmill emits the
trigger and watches for an artifact until the deadline; it holds no credential for
the execution. This is the only shape in which a ChatGPT subscription can do
unattended work today, and its price is written into the capability record: no
usage (every such execution is unmeasured and counts against
`budget.maxUnmeasuredExecutions`), no quota signal, no structured output, and no
cancellation. Completion is detected by the artifact matcher; the deadline yields
`TIMED_OUT`, a malformed artifact yields `FAILED` with reason `artifact_invalid`.

**`local`** — the same node executor on the maintainer's machine, for manual runs and
debugging. No OS scheduler integration in the MVP.

**`fake`** — a fixture-replaying backend shipped in the package for tests and CI.
Deterministic; its usage records carry provenance `estimated`, which is never summed
with `reported` or `derived` in a headline figure.

**Decision (not in sheet):** `control-plane` is added as a pseudo-backend covering
`condition`, `human` and `end` nodes. They are decided by `loopmill step` itself and
never dispatched, so they have no credential, no usage and no isolation — and, most
importantly, `retryable: false`, which is what gives LM-VAL-007 something to catch in
an MVP where every real backend is retryable ([§12.3](#123-why-to-must-be-retryable)).
`credentialLocation: none` is likewise added for `control-plane` and `fake`, because
recording "user-machine" for a backend that needs no credential would be a lie in
the one table an auditor reads first.

---

## 15. Worked examples

### 15.1 The reference Loop

`examples/daily-content-improvement.loop.yaml` — the dogfooding target, in full,
with the reasoning for every Runtime × Backend × Auth choice in comments.

```
06:00 Asia/Tokyo (schedule)
  │
  ├─ review-content     agent · codex · observed · subscription-login
  │                     artifact: file-in-diff .loopmill/review-content.json
  ├─ needs-issue        condition · needs_issue == true
  │      ├─ false ─────────────────────────────► end-no-change (no_change)
  │      └─ true
  ├─ create-issue       command · gh issue create · effects: external
  │                     pre-approved by name in approval.nodes
  ├─ implement          agent · claude-code · github-actions · subscription-oauth
  │                     structuredOutput {changed, summary}
  ├─ run-tests          command · npm test · onFailure: continue
  ├─ review-changes     agent · codex · observed · subscription-login
  │                     artifact: comment-fenced-block
  ├─ review-verdict     condition · approved == true && tests_exit == 0
  │      ├─ false ──► retry-implementation ──► implement   (maxIterations 3)
  │      └─ true
  ├─ approve-pr         human · environment-reviewers · subject nodes.implement
  ├─ create-pr          command · gh pr create · effects: external (gated)
  └─ end-shipped        end (success)
```

What each part of the spec is doing there:

* **Two vendors, two backends, one loop.** The reviewer is Codex on Codex Cloud; the
  implementer is Claude Code on GitHub Actions. The review is not the implementer
  marking its own homework, and neither leg needs an API key.
* **The cost of `observed` is visible.** Both Codex nodes report no usage, so they
  are counted by `budget.maxUnmeasuredExecutions: 8` (2 observed nodes × (1 + 3
  traversals)) rather than by the token budget, and every report of this Loop shows
  its usage coverage rather than a confident total.
* **`onFailure: continue` on `run-tests`.** A red test suite is evidence, not a
  failure: `review-verdict` reads `nodes.run-tests.exitCode` and decides.
* **One Retry Edge, one counter.** `review-verdict.else` routes into
  `retry-implementation`, whose `to` is `implement` — an agent node on
  `github-actions`, which is retryable. Body = {implement, run-tests, review-changes,
  review-verdict}, executed as cycles 1..4.
* **Two external effects, two different policies.** `create-issue` is pre-approved by
  name with a written reason; `create-pr` is gated by `approve-pr` on every path.
  Nothing merges.

Validate it with:

```bash
npm install --prefix <dir> ajv ajv-formats yaml
node docs/spec/validate-examples.mjs --modules <dir>
```

### 15.2 A minimal single-agent loop

Everything optional removed. One agent, one end node, manual trigger, no Retry Edge,
no budget block — the defaults still bind, which is the point: a Loopmill loop is
bounded even when its author writes nothing about bounds.

```yaml
schemaVersion: "0.5.0"
slug: tidy-changelog
name: Tidy the changelog

trigger: { kind: manual }

repos:
  - id: app
    path: "."
    defaultBase: main

defaults:
  backend: local
  runtime: claude-code
  authMode: subscription-oauth

nodes:
  tidy:
    kind: agent
    prompt: Rewrite CHANGELOG.md so every entry has a date and a link. Change nothing else.
    next: done
  done:
    kind: end
    outcome: success
```

`entry` is omitted and derived: `tidy` is the only node with no incoming forward
edge. `budget` is omitted, so `maxAttempts: 2`, `maxRuntime: PT4H`,
`maxRunsPerWindow: {count: 1, window: PT5H}` and `minInterval: PT1H` apply.
`effects` defaults to `none`, so no gate is required. There is no Retry Edge, so the
whole Run happens in cycle 0.

### 15.3 A Loop that fails validation

`docs/spec/examples/invalid-retry-edge.loop.yaml`. It is schema-valid, and it fails
exactly one semantic rule. The author meant to send a failed test run back to the
implementation node and pointed the Retry Edge at the condition guarding it instead:

```yaml
nodes:
  implement:
    kind: agent
    prompt: Fix the failing tests in this repository.
    structuredOutput:
      type: object
      properties:
        changed: { type: boolean }
      required: [changed]
    next: has-diff

  has-diff:
    kind: condition
    inputs:
      changed: nodes.implement.structured.changed
    expr: changed == true
    then: run-tests
    else: end-no-change

  run-tests:
    kind: command
    argv: [npm, test]
    onFailure: continue
    next: verdict

  verdict:
    kind: condition
    inputs:
      tests_exit: nodes.run-tests.exitCode
    expr: tests_exit == 0
    then: end-ok
    else: retry-implementation

edges:
  - id: retry-implementation
    from: verdict
    to: has-diff          # <-- should be `implement`
    when: tests_exit != 0
    maxIterations: 3
```

```
LM-VAL-007 edges.retry-implementation: retry edge targets non-retryable backend:
  to "has-diff" is a condition node, which runs on the control plane (retryable: false)
```

Everything else about the file is fine — the edge does close a cycle (LM-VAL-008
passes: `verdict` is forward-reachable from `has-diff`), and the body does contain a
retryable node (LM-VAL-009 passes: `run-tests`). Only LM-VAL-007 fires, and it fires
at validation time rather than at 04:00 on the third night, after the Loop has
re-read the same structured output three times, re-run the same tests three times
and changed nothing. The fix is one word.

---

## 16. Decision index

Choices this spec makes where the v0.5 decision sheet is silent.

| § | Decision |
|---|---|
| 2 | The validator accepts any path whose basename is `<slug>.loop.yaml`; only `.loopmill/` is scanned by the CLI. |
| 3.1 | `loopVersion` = sha256 over RFC 8785 canonical JSON of the parsed document, with defaults **not** materialised. Comment-only and key-order edits do not change it; sequence order does. |
| 4.1 | `nodes` is an id-keyed map; an optional `id` echo must match the key and exists so the common `{nodes: [...]}` model output can be repaired mechanically before a model call is spent on it. |
| 4.2 | `entry` is explicit-with-derivation: omitted means "the unique node with no incoming forward edge", and ambiguity is an error. |
| 5 | Trigger is discriminated by `kind`; `tz` is an IANA name defaulting to `UTC`. |
| 6.2 | Defaults never widen a node-level value. |
| 6.3 | `env.inject` values are literal strings; no templating, no secret references. |
| 6.4 | `approval.nodes` narrows `policy: auto` to named nodes so a Loop need not choose between gating everything and gating nothing. |
| 7.1 | `budget.maxIterations` is a loop-wide **cap** on per-edge values, and an edge exceeding it is rejected, not clamped. |
| 7.2 | `maxUnmeasuredExecutions` defaults to `observedAgentNodes × (1 + maxEdgeIterations)`; the sheet's formula undercounts the first body pass. |
| 7.3 | All durations are ISO-8601 restricted to D/H/M/S. |
| 8.0 | `effects: external` covers artifacts a human or third party sees; Loopmill's own coordination traffic is not external. |
| 8.4 | A human rejection is a node failure governed by `onFailure`; no separate `onReject` field. |
| 8.5 | `end.outcome` is a free label matching `^[a-z][a-z0-9_-]{0,63}$`. |
| 9.1 | `filesChanged` resolves to an integer count; the path list lives on the Node Execution record. |
| 9.1 | `trigger.*` is the only reference resolved at run time; unresolvable without a `default` fails the node. |
| 9.2 | A reference resolves to the most recent Node Execution of that node in the Run. |
| 10 | `$${` escapes a literal `${`; substitution sites are enumerated and closed. |
| 12.1 | Routing into a Retry Edge is explicit and single-source; `when` is an assertion, not a router. |
| 14 | `control-plane` is a pseudo-backend with `retryable: false`; `credentialLocation: none` is added for it and for `fake`. |
| 13 | The error-code scheme `LM-VAL-nnn`, its grouping, and the stability rule (retired, never reused). |

---

## 17. What the v0.4 design left undefined and this spec settles

The v0.4 MVP design (`docs/design/mvp-design.md`) describes the node types and the
reference Loop as pictures. It never defines a file. This section lists what was
genuinely open and what is now closed.

| v0.4 said | v0.5 settles |
|---|---|
| "Workflow", "Loop Edge", "Loop" used interchangeably. | The persisted object is a **Loop**; the backward edge is a **Retry Edge**. Old names survive only in a glossary. |
| Nodes drawn as boxes; no file, no ids, no schema. | `.loopmill/<slug>.loop.yaml`, id-keyed `nodes` map, published JSON Schema, `additionalProperties: false` everywhere so a typo is an error. |
| No Loop identity or versioning. | `loopId` = `slug`; `loopVersion` = sha256 over a defined canonical form ([§3](#3-identity-slug-and-loopversion)); a Run pins the version it started with. |
| "Agent Node · Runtime · Prompt · Working Directory · Timeout · Expected Structured Output" as a settings list. | Runtime, Backend and Auth are **three separate axes**, declared per node, with a validated compatibility matrix (LM-VAL-019) and a backend capability table that validation actually reads. v0.4 had no concept of an execution backend at all. |
| "Expected Structured Output" with no mechanism. | `structuredOutput` is a JSON Schema mapped to `--json-schema` / `--output-schema`, permitted only on backends that declare the capability (LM-VAL-018), and read back through `nodes.<id>.structured.<path>`. Backends that cannot do it (`observed`) use an artifact matcher and `captured.<name>` instead — a distinction v0.4 could not express, and the one that decides whether a cross-vendor loop is possible at all. |
| "Condition Node evaluates the previous node's structured output", example `needs_issue == true`. | An explicit grammar ([§11](#11-condition-expressions)) with typed operands, no coercion, no truthiness, and a hard rule that a missing or non-conforming input is an **error**, never a silent `false`. Inputs are declared, so `loopmill validate` checks the operands. |
| "Command Node executes a local shell command", examples written as shell strings. | `argv: string[]` executed with `shell: false`, on the backend that owns the working tree, never in the control-plane job, with a binding rule that guarantees one placeholder cannot become two arguments ([§10.1](#101-the-argv-binding-rule)). |
| "Human Approval Node · Approve / Reject". | `mode` (how the approval is asked for), `subject` (the artifact digest being approved, so a retry invalidates a stale approval), `timeout`, and rejection routed through `onFailure`. The rule that external effects **require** a gate on every path is now checkable (LM-VAL-023), with a narrowable escape hatch that must carry a written reason. |
| "A Loop Edge always has a maximum iteration count. maxIterations = 3." | Retry Edge semantics in full: what a Cycle is, that cycle 0 is setup, that traversals — not body executions — are counted, that `maxIterations: 3` means four body executions, that the check happens before dispatching the target, that exhaustion is `MAX_ITERATIONS_EXCEEDED` and never `FAILED`, and that the target must be retryable ([§12](#12-retry-edges)). |
| No data flow between nodes at all. | A closed reference grammar ([§9](#9-inputs-and-references)) with per-accessor availability rules, declared inputs, cross-cycle resolution, and a dominance requirement so a reference cannot be valid on the path that was tested and missing on the one that was not (LM-VAL-014). |
| "Safety Limits" as prose. | A `budget` block whose every field has a scope, a default and a defined breach outcome, checked before dispatch, with the token budget counting only measured tokens and `maxUnmeasuredExecutions` binding whenever coverage is below 100% ([§7](#7-budget)). |
| Environment and secrets not mentioned in the loop definition. | An `env` policy of deny / preserve / inject layered over a built-in vendor-auth deny list, so a subscription run cannot be silently converted into a metered API run by an inherited variable ([§6.3](#63-env-policy)). |
| Trigger types listed, never specified. | `manual` / `schedule {cron, tz}` / `event {source, types}`, with named time zones, ingestion of GitHub events into Envelopes rather than reliance on incidental webhook chaining, and a check that a schedule cannot contradict its own rate limit (LM-VAL-026). |
| Validation not mentioned. | 27 numbered rules with stable codes, run by `loopmill validate` and again at the start of every `loopmill step`, so no Run ever dispatches against a file that has not just been checked. |
