# Loopmill spec: token usage normalization, coverage and budget

Status: normative for v0.5. Date: 2026-09-06.

This document is bound by the v0.5 decision sheet, in particular its sections 2 (domain model), 4
(backends and capabilities), 10 (usage, coverage, budget) and 11 (MVP scope). Where this document and
any older document disagree, the decision sheet wins and this document is the implementation contract
derived from it. Where the sheet is silent, a decision is recorded inline and marked
`Decision (not in sheet)`. Where the sheet states two things that both apply to one condition, the
resolution is marked `Reconciliation (both in sheet)`.

Conformance language: MUST, MUST NOT, SHOULD, MAY.

Vendor facts used here (Anthropic's three input fields are disjoint and additive; OpenAI's cached and
cache-write counts are subsets of `input_tokens`; reasoning is a subset of output; the Codex
`turn.completed.usage` object is thread-cumulative; a failed Codex turn emits no usage; Claude Code's
`result.usage` excludes subagents while `modelUsage` includes them) come from the verified runtime
research briefs dated 2026-09-06 and are treated as settled input, not re-argued here.

---

## 1. The canonical Usage record

One Usage record is attached to one **Attempt**, the identity `(runId, cycleIndex, nodeId, attempt)`.
Nothing else in Loopmill owns a token count. Every number shown at Node Execution, Cycle, Run or Loop
level is computed from Attempt records by the rules in section 3.

### 1.1 Core interface (exactly the sheet's fields)

```ts
type Provenance = "reported" | "derived" | "estimated" | "unavailable";

/** The record the decision sheet defines. Every field below is required. */
interface Usage {
  runtime: "claude-code" | "codex" | string;
  model?: string | null;

  // The four disjoint buckets. Non-null iff provenance is "reported" | "derived" | "estimated".
  freshInputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;

  /** Informational SUBSET of outputTokens. Never a summand of any total, at any level. */
  reasoningTokens?: number | null;

  /** = freshInputTokens + cacheWriteTokens + cacheReadTokens. Derived, never independently sourced. */
  totalInputTokens: number | null;
  /** = totalInputTokens + outputTokens. Derived, never independently sourced. */
  totalTokens: number | null;

  provenance: Provenance;
  /** Free text, always populated. Says which event produced the record and what was done to it. */
  provenanceNote: string;

  source: {
    runtimeVersion: string | null;
    /** The event kind the record was built from, or null when no such event existed. */
    eventKind: string | null;
  };

  /** false whenever the record does not account for the whole attempt. */
  complete: boolean;
}
```

The sheet writes the bucket fields without a null branch and separately states that on
`unavailable` "all buckets null". Both are honoured by typing every bucket `number | null` and
constraining nullability by provenance (section 1.3). That is a widening of notation, not of meaning.

### 1.2 Stored record (core plus extensions)

`Decision (not in sheet)`: the persisted row carries six fields beyond the sheet's list. Each exists
because a rule in this document cannot be implemented or audited without it. None of them may appear
in a headline figure.

```ts
interface UsageRecord extends Usage {
  /** Which vendor structure the record was normalized from. Auditability of section 2. */
  usageBasis: "result.usage" | "modelUsage" | "turn.completed" | "fixture" | "none";

  /** The runtime's own conversation handle, needed to audit the Codex delta rule. */
  sessionRef: { kind: "claude-session" | "codex-thread"; id: string } | null;

  /** For cumulative runtimes: the vendor cumulative snapshot at the START of this attempt,
   *  stored verbatim in the vendor's own field names. null for non-cumulative runtimes. */
  usageAtAttemptStart: Record<string, number> | null;

  /** Vendor client-side list-price estimate, stored verbatim, never recomputed. Section 5.2. */
  listPriceEquivalentUsd: number | null;

  /** Per-model split when the runtime reports one. The four buckets of the parent record MUST
   *  equal the element-wise sum of this array. */
  perModel: Array<{
    model: string;
    freshInputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    /** Same rule as the parent's reasoningTokens: reference only, never summed. */
    reasoningTokens: number | null;
    totalInputTokens: number;
    totalTokens: number;
    listPriceEquivalentUsd: number | null;
    costBasis: "list" | "managed" | "unknown" | null;
  }> | null;
}
```

`effectiveTokens` is deliberately **not** a stored field. It is recomputed on read from the four
buckets and a named weighting profile (section 5.1), so that changing a profile never rewrites
history.

### 1.3 Field semantics and nullability

| Field | Meaning | Null when | Never |
|---|---|---|---|
| `runtime` | Which agent CLI produced the work. Present even when no usage was obtained. | never | inferred from the backend |
| `model` | Model id, when a single model can be named for the whole attempt. | runtime does not report it, or several models contributed (then `perModel` carries the split) | invented from a CLI alias |
| `freshInputTokens` | Input processed fresh: neither served from cache nor written to cache. | `provenance: "unavailable"` | negative |
| `cacheWriteTokens` | Input written to the cache by this attempt. | as above | negative |
| `cacheReadTokens` | Input served from the cache. | as above | negative |
| `outputTokens` | All generated tokens, reasoning/thinking included. | as above | negative |
| `reasoningTokens` | Informational subset of `outputTokens`. `null` means "the runtime does not break it out" (claude-code before 2.1.263) and is distinct from `0` ("broken out, and it was zero"). | runtime does not report it, or provenance is `unavailable` | added to any total |
| `totalInputTokens` | `fresh + write + read`. | `provenance: "unavailable"` | stored from a vendor field |
| `totalTokens` | `totalInputTokens + outputTokens`. | as above | stored from a vendor field |
| `provenance` | `reported` = the runtime stated these numbers for this attempt. `derived` = Loopmill computed them from runtime numbers by a documented rule (a subtraction, a subset split, or a sum over the runtime's own breakdown). `estimated` = a Loopmill model, not a measurement. `unavailable` = no source existed. | never | absent |
| `provenanceNote` | Which event, and what arithmetic. Rendered in the Node Inspector. | never (empty string is a conformance failure) | silently omitted |
| `source.runtimeVersion` | Best effort. | probe unavailable | fabricated |
| `source.eventKind` | `result`, `turn.completed`, `turn.failed`, `node-observed`, ... | no event was seen at all | guessed |
| `complete` | `true` iff the record accounts for the whole attempt. | never | `true` alongside `unavailable` |

Constraints, enforced at write time:

- `provenance ∈ {reported, derived, estimated}` ⟹ all four buckets and both totals are non-null
  integers ≥ 0, and `complete` is `true` unless `provenanceNote` explains the partiality.
- `provenance === "unavailable"` ⟹ all four buckets, both totals, `reasoningTokens` and
  `listPriceEquivalentUsd` are `null`, and `complete === false`. **Storing `0` here is a conformance
  failure**, not a rounding choice (sheet section 11 acceptance list: "`unavailable` usage never
  stored as 0").

### 1.4 JSON shape

```json
{
  "runtime": "claude-code",
  "model": "claude-sonnet-5",
  "freshInputTokens": 486210,
  "cacheWriteTokens": 21442,
  "cacheReadTokens": 420102,
  "outputTokens": 18928,
  "reasoningTokens": null,
  "totalInputTokens": 927754,
  "totalTokens": 946682,
  "provenance": "reported",
  "provenanceNote": "result.usage; modelUsage absent, so no subagent tokens exist to fold in",
  "source": { "runtimeVersion": "2.1.261", "eventKind": "result" },
  "complete": true,

  "usageBasis": "result.usage",
  "sessionRef": { "kind": "claude-session", "id": "0f6c1e4a-9b52-4c31-8a77-2d1e5b6c9a04" },
  "usageAtAttemptStart": null,
  "listPriceEquivalentUsd": 1.2993254,
  "perModel": null
}
```

The `unavailable` shape, in full:

```json
{
  "runtime": "codex",
  "model": null,
  "freshInputTokens": null,
  "cacheWriteTokens": null,
  "cacheReadTokens": null,
  "outputTokens": null,
  "reasoningTokens": null,
  "totalInputTokens": null,
  "totalTokens": null,
  "provenance": "unavailable",
  "provenanceNote": "turn.failed with no preceding turn.completed on this thread",
  "source": { "runtimeVersion": "0.153.4", "eventKind": "turn.failed" },
  "complete": false,
  "usageBasis": "none",
  "sessionRef": { "kind": "codex-thread", "id": "th_01JQ8ZF0Y2Z5B8E1G4J7M0Q3S9" },
  "usageAtAttemptStart": { "input_tokens": 0, "cached_input_tokens": 0, "cache_write_input_tokens": 0, "output_tokens": 0, "reasoning_output_tokens": 0 },
  "listPriceEquivalentUsd": null,
  "perModel": null
}
```

---

## 2. Per-runtime mapping

The one difference that governs everything: **Anthropic's three input fields are siblings you add up;
OpenAI's cache counts are children of `input_tokens` you must not add up.** A single additive
renderer applied to both inflates a cache-heavy Codex figure by roughly the cached share, twice over.

### 2.1 `claude-code` (backend `local`; `github-actions` reserved)

Usage is read from the **terminal `result` message only**, whether the invocation used
`--output-format json` or `--output-format stream-json` (the stream ends with the same object).

Precedence, in order:

1. `result.modelUsage` present and non-empty → **basis `modelUsage`**. Sum element-wise over all
   models; also store the per-model split in `perModel`.
2. Otherwise `result.usage` present → **basis `result.usage`**.
3. Otherwise → `unavailable` (section 2.5).

`modelUsage` wins unconditionally because `result.usage` covers the main loop only while `modelUsage`
covers the whole tree including subagents. The two MUST NOT both contribute to one record — that is
the classic double count. In `claude-with-subagents.json` the difference is 111,100 tokens (14.5%
undercount if `result.usage` were used; 85% overcount if both were summed).

Measured on 2026-09-06 (claude-code 2.1.263 on a GitHub-hosted runner, `claude-recorded-*.json`):
`modelUsage` is present on **every** result — as an empty object `{}` when no API call completed (an
unauthenticated run, an invalid API key) — and, even with no subagents, it routinely carries a second
entry for a short helper call on a smaller model (`claude-haiku-4-5-20251001`, about 900 input tokens)
next to the main model. `{}` counts as absent for rule 1. In practice the basis is therefore
`modelUsage` in every healthy run, and `result.usage` alone undercounts by the helper call
(`claude-recorded-success.json`: 29,560 against 30,476).

| Canonical field | From `result.usage` | From `result.modelUsage` (summed over models) |
|---|---|---|
| `freshInputTokens` | `input_tokens` | `Σ inputTokens` |
| `cacheWriteTokens` | `cache_creation_input_tokens` | `Σ cacheCreationInputTokens` |
| `cacheReadTokens` | `cache_read_input_tokens` | `Σ cacheReadInputTokens` |
| `outputTokens` | `output_tokens` | `Σ outputTokens` |
| `reasoningTokens` | `usage.output_tokens_details.thinking_tokens` when present (2.1.263 `[V]`), else `null` | `Σ thinkingTokens` when every model entry carries it (2.1.263 `[V]`), else `null` |
| `totalInputTokens` | `fresh + write + read` | same |
| `totalTokens` | `totalInputTokens + output` | same |
| `listPriceEquivalentUsd` | `total_cost_usd` | `total_cost_usd` (and `costUSD` per model) |
| `provenance` | `reported` | `reported` |
| `source.eventKind` | `result` | `result` |

`freshInputTokens` maps straight from `input_tokens` with no subtraction because Anthropic's
`input_tokens` already excludes cache reads and cache creations.

`reasoningTokens` stays a reference field (invariant I3): thinking is billed as output, and since
2.1.263 the CLI also breaks it out (`thinkingTokens` per model, `output_tokens_details.thinking_tokens`
on `usage`). `0` means "broken out, and it was zero"; `null` means the version does not break it out.
Each `perModel` entry carries its own `reasoningTokens` under the same rule, and its `model` is the
`modelUsage` key — the concrete model id such as `claude-haiku-4-5-20251001` — not the `canonicalModel`
alias the entry also carries.

**Provenance is `reported`** for both bases: Loopmill only adds up numbers the runtime stated for this
invocation. Summing `modelUsage` is not a derivation in the sense of section 1.3 — no vendor semantics
are being reinterpreted — so it stays `reported`, with the sum recorded in `provenanceNote`.

**Stream-json lines that MUST be ignored as a usage source** (they may still be persisted as log):

| Line | Why ignored |
|---|---|
| `assistant` message `message.usage.output_tokens` | a placeholder written at message start, repeated on every message of one API response |
| several `assistant` messages sharing one `message.id` | parallel tool calls repeat one response's usage; summing double counts |
| `assistant` messages with non-null `parent_tool_use_id` | subagent traffic, already inside `modelUsage` |
| `system` / `init` | no token data |
| `system` / `api_retry` | no token data (it carries `attempt`, `error` category and retry delay only) |
| any partial-message event | fragments, not accounting |

`Decision (not in sheet)`: the MVP performs **no** stream-based usage reconstruction at all, not even
as a fallback for a missing result. A number rebuilt from de-duplicated stream lines would be a
Loopmill model of the truth and would have to be labelled `estimated`; an `estimated` figure that
cannot enter a headline sum is worth less than an honest `unavailable`, and it invites exactly the
false precision this spec exists to prevent. A record whose `usageBasis` names a stream event is a
conformance failure (invariant I7).

**Result subtypes.**

| `result.subtype` | Usage handling | Node outcome (informative) |
|---|---|---|
| `success` | as above, `reported` | `SUCCEEDED` |
| `error_max_turns` | as above, `reported` | `FAILED(max_turns)` |
| `error_max_structured_output_retries` | as above, `reported` | `FAILED(schema)` |
| `error_max_budget_usd` | as above, `reported`, basis `modelUsage` **required** — `result.usage` omits the response that crossed the cap while `modelUsage` includes it. If `modelUsage` is absent, `complete: false`. | `BUDGET_EXCEEDED` (runtime-side cap) |
| `error_during_execution` | as above, **unless** the zeroed-crash rule below fires | `FAILED`, or `WAITING_FOR_QUOTA` when `classifyFailure` returns QUOTA |

**`is_error` and `terminal_reason` (2.1.263 `[V]`).** `subtype` alone does not identify success: an
unauthenticated run and an invalid-API-key run both end with `subtype: "success"`, `is_error: true`,
`terminal_reason: "api_error"`, exit 1 and all-zero usage. The result additionally carries
`terminal_reason`, observed as `completed`, `max_turns`, `api_error` and `aborted_streaming`:

| `terminal_reason` | Observed with | `complete` |
|---|---|---|
| `completed` | `subtype: success`, `is_error: false`, exit 0 | `true` |
| `max_turns` | `subtype: error_max_turns`, `is_error: true`, exit 1; usage reported in full (`claude-recorded-max-turns.json`) | `true` |
| `api_error` | `subtype: success`, `is_error: true`, exit 1, `modelUsage: {}`, zeroed `usage` | zeroed-crash rule below → `unavailable` |
| `aborted_streaming` | SIGINT mid-turn: `subtype: error_during_execution`, `is_error: true`, exit **0**, `result: null`; `result.usage` all zero; `modelUsage` lists only the calls that completed before the interrupt (`claude-recorded-sigint.json`) | **`false`** |

`Decision (not in sheet)` — **`terminal_reason: "aborted_streaming"` ⟹ `complete: false`**, whatever
the numbers say. The interrupted response's tokens appear in no field, so the record is a lower bound
of the attempt. Provenance stays `reported` because every number in the record was stated by the
runtime; `provenanceNote` names the reason; and the attempt is **unmeasured** for coverage (section
4.1). This is the first MVP case where `complete: false` occurs together with a provenance other than
`unavailable`.

`Decision (not in sheet)` — **zeroed crash results.** A crashed session can emit a `result` message
with every cost field zeroed. A claude-code turn that reached the model cannot have consumed zero
input tokens. Therefore: if a record would be written with `provenance: "reported"` and
`totalInputTokens === 0`, it is instead written as `unavailable` with
`provenanceNote: "result present but all usage fields zero; treated as unavailable, not as a
measurement of zero"`. This is the only place where Loopmill overrides a number the runtime stated,
and it exists because storing that particular zero would silently bias every average downward for
exactly the expensive runs that crashed.

**Cancellation.** Loopmill cancels a claude-code attempt with **SIGINT**. Measured (2.1.263,
GitHub-hosted runner, `claude-recorded-sigint.json`): the process exits **0** and still writes a
`result` (`subtype: error_during_execution`, `is_error: true`, `terminal_reason: aborted_streaming`),
so the session id, the cost and the usage of every call that completed before the interrupt survive —
but the interrupted response's tokens appear nowhere, which is why that record is `complete: false`.
SIGTERM, measured on the same runner and version: the process ends with exit **143** and writes
**nothing** to stdout — no `result`, no usage — so the record is `unavailable`, `complete: false`,
exactly the shape `claude-killed.json` was hand-written to describe. SIGKILL is not measured and is
assumed to be no better than SIGTERM. This is why `cancel` is SIGINT first, grace, then SIGKILL.

### 2.2 `codex` (backend `local`; `github-actions` reserved)

Usage is read from `turn.completed.usage` in the `codex exec --json` stream. Two corrections are
applied, and both are why the provenance is **`derived`**, never `reported`:

**(a) Subset arithmetic.** `cached_input_tokens` and `cache_write_input_tokens` are *inside*
`input_tokens`, not beside it.

```
cacheReadTokens  = cached_input_tokens
cacheWriteTokens = cache_write_input_tokens
freshInputTokens = max(0, input_tokens - cached_input_tokens - cache_write_input_tokens)
outputTokens     = output_tokens                    // reasoning already inside
reasoningTokens  = reasoning_output_tokens          // reference only, never summed
totalInputTokens = freshInputTokens + cacheWriteTokens + cacheReadTokens   // == input_tokens
totalTokens      = totalInputTokens + outputTokens
```

The `max(0, ...)` clamp is required, not defensive: if a future runtime version ever reports
overlapping subsets, a negative fresh bucket would break invariant I2 and poison every sum above it.
When the clamp actually fires (the subtraction went negative), `provenanceNote` MUST say so and
`complete` MUST be set `false`, because `totalInputTokens` then no longer equals `input_tokens`.

There is no `total_tokens` field in the exec JSONL usage object, so a Codex total is by construction
computed by Loopmill. That alone forbids `reported`.

**(b) The thread-delta rule.** `turn.completed.usage` carries the **thread-cumulative** total, not the
turn delta. For an attempt:

```
delta        = lastTurnCompletedUsage - usageAtAttemptStart      // field-by-field, clamped at 0
usageAtAttemptStart = the thread cumulative recorded when this attempt was dispatched
                      (all-zero for a fresh thread)
```

Only the **last** `turn.completed` of the attempt is used. The several `turn.completed` lines an
attempt may emit are successive cumulative snapshots; summing them is wrong by construction.

The MVP default `sessionPolicy: fresh` gives every attempt its own thread, so `usageAtAttemptStart` is
zero and the delta equals the cumulative. Thread reuse (`codex exec resume`) is an explicit opt-in and
requires the persisted `sessionRef.id` + `usageAtAttemptStart` pair to be auditable.

#### Worked example A — two attempts on one thread

Thread `th_01JQ8ZE8...`, reused. (The same arithmetic applies whether the two attempts are two
dispatches of one node execution — attempt 1 `LOST`, attempt 2 resumes — or two node executions in
different cycles sharing a thread.)

| | attempt 1 (cycle 1) | attempt 2 (cycle 2) |
|---|---|---|
| `usageAtAttemptStart` | 0 / 0 / 0 / 0 | 132,000 / 96,000 / 12,000 / 8,000 |
| `turn.completed.usage` (cumulative) | 132,000 / 96,000 / 12,000 / 8,000 | 227,000 / 168,000 / 19,000 / 14,300 |
| delta (`input` / `cached` / `write` / `output`) | 132,000 / 96,000 / 12,000 / 8,000 | **95,000 / 72,000 / 7,000 / 6,300** |
| `freshInputTokens` | `max(0, 132,000−96,000−12,000)` = **24,000** | `max(0, 95,000−72,000−7,000)` = **16,000** |
| `cacheWriteTokens` | 12,000 | 7,000 |
| `cacheReadTokens` | 96,000 | 72,000 |
| `outputTokens` | 8,000 | 6,300 |
| `reasoningTokens` (reference) | 3,200 | 2,700 |
| `totalInputTokens` | 132,000 | 95,000 |
| `totalTokens` | **140,000** | **101,300** |

Run total = 140,000 + 101,300 = **241,300**, which is exactly the last cumulative
(227,000 input + 14,300 output). That identity is invariant I5 and is the cheapest available check
that the delta rule was applied.

Storing the raw cumulative for attempt 2 would report **241,300** for a 101,300-token attempt and give
a run total of **381,300** — an overcount of 140,000, i.e. attempt 1 counted twice. With
`maxIterations: 3` the overcount grows quadratically in the number of cycles.

#### Worked example B — a fresh thread

`usageAtAttemptStart` is all-zero, so cumulative *is* delta:

```
turn.completed.usage = { input_tokens: 24,763, cached_input_tokens: 24,448,
                         cache_write_input_tokens: 0, output_tokens: 1,210,
                         reasoning_output_tokens: 940 }

cacheReadTokens  = 24,448
cacheWriteTokens = 0
freshInputTokens = max(0, 24,763 − 24,448 − 0) = 315
outputTokens     = 1,210          reasoningTokens = 940   (reference only)
totalInputTokens = 315 + 0 + 24,448 = 24,763   ( == input_tokens )
totalTokens      = 24,763 + 1,210 = 25,973
provenance       = derived
```

The two ways to get this wrong, both caught by the fixture: adding `cached_input_tokens` to
`input_tokens` gives 50,421; adding `reasoning_output_tokens` to `output_tokens` gives 26,913.

`Decision (not in sheet)` — **`reasoningTokens` is a reference field only.** It is displayed in the
Node Inspector as "of which reasoning", is never a summand, is never aggregated above Node Execution,
and is never used in a ratio that also uses `outputTokens` from a runtime that does not report it
(claude-code reports none), because that ratio would be a comparison of reporting practice rather
than of work.

**Rate-limit and quota data are not available from the exec JSONL stream** and are therefore not part
of the Usage record. Quota classification is carried on the `node-failed` event, never on the usage
record, and never fills a bucket.

### 2.3 `observed` backends — reserved

**Reserved.** No MVP backend declares `usage: none`: `observed` was removed after SPIKE-2 (NO-GO — a
vendor task's result never reaches GitHub as a change without a human click, ADR-002 D4). This section
is retained for a future backend that might declare `usage: none`, and for the reserved
`github-actions`/`observed` integration. If a backend's capability record does declare `usage: none`,
the work happens on a vendor's own cloud and Loopmill only emits a trigger and observes an artifact.
Every attempt on such a backend gets:

```
provenance    = "unavailable"
complete      = false
all buckets   = null
usageBasis    = "none"
source        = { runtimeVersion: null, eventKind: "node-observed" }
```

This is structural, not a parse failure, and it is independent of the node's outcome: a `SUCCEEDED`
node execution with `unavailable` usage is normal. A backend like this is why `maxUnmeasuredExecutions`
stays in the budget model at all, even though its MVP default is `0` because no MVP backend can produce
one (section 6).

`Decision (not in sheet)`: a backend whose capability record says `usage: none` MUST NOT produce a
non-`unavailable` usage record even if some future artifact happens to contain token numbers. Numbers
found inside an untrusted artifact are untrusted input, not a measurement.

### 2.4 `fake` backend

The fixture-replaying backend used in tests and CI. Its capability record says `usage: full`, and the
fixture itself declares the provenance the replay must produce:

- `reported` / `derived` — the fixture replays a runtime event shape and the adapter under test must
  normalize it exactly as sections 2.1/2.2 require. This is how the mapping rules are tested.
- `estimated` — the fixture asserts the estimated path: the record is written with all four buckets
  populated, `provenance: "estimated"`, `usageBasis: "fixture"`, and it MUST be excluded from every
  headline sum and every ratio (section 3.2, invariant I11).
- `unavailable` — the fixture asserts a failure path (sections 2.5).

`Decision (not in sheet)`: `estimated` exists in the MVP only through the fake backend. **Loopmill
ships no token estimator.** There is no character-count heuristic, no tokenizer approximation, no
"assume the median of the last N runs". A missing measurement stays missing. The `estimated`
provenance value is reserved so that the weighted view (section 5.1) and any future heuristic have a
label that already carries the "never summed with measured values" rule.

### 2.5 Failure cases

| Case | Detection | Record |
|---|---|---|
| Process killed (SIGTERM/SIGKILL, OOM, an operator-cancelled run, a host reboot mid-attempt) | non-zero exit with a signal, no terminal event on stdout (claude-code SIGTERM: exit 143, empty stdout, measured on 2.1.263 `[V]`) | `unavailable`, `complete: false`, `eventKind: null`, note names the signal |
| No terminal event (stream ends mid-turn; deadline hit; `codex` turn interrupted) | stream closed without `result` / `turn.completed` | `unavailable`, `complete: false`, `eventKind: null` |
| `codex` `turn.failed` | `turn.failed` seen, no `turn.completed` on the thread | `unavailable`, `complete: false`, `eventKind: "turn.failed"` |
| Malformed JSON (a truncated line, a non-JSON line, a schema-invalid usage object, a negative or non-integer field) | parse or validation failure | `unavailable`, `complete: false`, `eventKind` names the line kind, note carries the parse error |
| `claude-code` result with all-zero usage after a crash or an authentication failure | `totalInputTokens === 0` on the chosen basis (`modelUsage: {}` and zeroed `usage`); seen with `subtype: "error_during_execution"`, and with `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"` `[V]` | `unavailable` (section 2.1 zeroed-crash rule) |
| `claude-code` interrupted mid-turn (SIGINT) | `terminal_reason: "aborted_streaming"`, exit 0, a `result` whose `modelUsage` covers only the completed calls `[V]` | `reported`, `complete: false`, basis `modelUsage`; unmeasured for coverage (`claude-recorded-sigint.json`) |
| Attempt state `LOST` (no completion by deadline) | control-plane sweep | `unavailable`, `complete: false`. The attempt burned tokens; the next attempt's record does not cover them. |
| `observed` backend | capability `usage: none` | `unavailable`, `complete: false` |

In every one of these rows the tokens were, or may have been, really consumed. `unavailable` means
*"we do not know"*, and it MUST NOT be rendered, stored, summed or budgeted as `0`.

A malformed line MUST NOT be partially salvaged. If `input_tokens` parses and `output_tokens` does
not, the record is `unavailable` — a half-parsed usage object is an estimate wearing a measurement's
label.

---

## 3. Aggregation

### 3.1 The chain

```
Attempt  →  Node Execution  →  Cycle  →  Run  →  Loop window
```

Usage aggregates upward along this chain **only**. There is no cross-Run, cross-Loop or cross-backend
aggregation path other than the Loop window, and nothing is summed across a boundary that a
provenance of `unavailable` or `estimated` would poison.

| Level | Sums over | Notes |
|---|---|---|
| Node Execution | all its Attempts that produced a measured record | attempts are disjoint by construction, including on a reused Codex thread (invariant I5). Retried attempts both count; there is no de-duplication. |
| Cycle | all Node Executions in `(runId, cycleIndex)` | only `agent` nodes ever carry usage; `command`, `condition`, `human` and `end` nodes contribute nothing and are not counted anywhere, including in the coverage denominator |
| Run | all Cycles, **including cycle 0** | cycle 0 is setup/teardown: nodes outside every Retry Edge body |
| Loop window | all Runs whose `startedAt` falls in the window | window is rolling, defined in section 6.4 |

### 3.2 What sums, and what never sums

**Sums** (element-wise, at every level):
`freshInputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `outputTokens`.

**Derived at every level, never carried up as an opaque scalar**:
`totalInputTokens = fresh + write + read`, `totalTokens = totalInputTokens + output`. Recomputing
these from the four buckets at any level MUST reproduce the stored value (invariant I8). Summing
child totals gives the same answer because the operation is linear — that is a property to assert,
not a licence to skip the recomputation.

**Never sums:**

| Quantity | Why |
|---|---|
| `reasoningTokens` | it is a subset of `outputTokens`; adding it double counts, and it is reported by one MVP runtime and not the other, so an aggregate would measure reporting practice |
| `estimated` records with `reported`/`derived` records | a headline figure MUST be homogeneous in measurement status. If a scope contains estimated records, the headline is computed from the measured records only and the estimated ones are listed beside it under their own label |
| `unavailable` records | there is nothing to add; they raise the unmeasured count instead (section 4) |
| `listPriceEquivalentUsd` above Node Execution | one MVP runtime emits it and the other does not, so any roll-up would be silently partial (section 5.2) |
| `effectiveTokens` across different `weightingProfileId` values | different units |
| `totalTokens` across runtimes **without** the per-runtime split alongside | permitted, but the split MUST remain visible: a cache-read token and a fresh input token are not units of the same thing |

**Aggregate provenance** `Decision (not in sheet)`: the provenance of an aggregate is the weakest of
its contributing records under the order `reported > derived > estimated`, with `unavailable` records
excluded from the sum and counted against coverage instead. A Cycle containing one `reported` and one
`derived` record is `derived`. This is why the sheet's cross-runtime Cycle total is legitimate only
after normalization: before it, the addition mixes two incompatible field semantics.

### 3.3 Rendering lower bounds

Whenever the coverage of a scope is below 100%, **every** sum in that scope is a lower bound and MUST
be rendered with a trailing `+`, immediately after the digits, with no space:

```
Measured Tokens        1,171,000+
```

`Decision (not in sheet)` — rendering rules:

- Full precision uses thousands separators: `1,171,000+`. Abbreviated form keeps the marker outside
  the unit: `1.17M+`, `947K+`.
- A single `unavailable` record renders as `—` (em dash). Never `0`, never `0+`, never blank.
- A scope with coverage `0/n` and no reported figure at all renders `0+`, which reads correctly as
  "at least zero, and we measured none of it", and is always accompanied by the coverage line. A
  `reported` record with `complete: false` (section 2.1, `aborted_streaming`) is unmeasured for
  coverage but still contributes its figure to the lower bound, so a `0/1` scope holding one such
  record renders that figure with the marker (`claude-recorded-sigint.json`: `928+`, `0/1 (0%)`).
- A scope at 100% coverage renders with no marker at all. The absence of `+` is a positive claim and
  MUST NOT be produced by rounding.
- The `+` is not a footnote: it is never dropped in a compact view, a CSV export, the run report or a
  chart tooltip. Machine-readable exports carry `{ value, isLowerBound, coverage }` rather than a
  decorated string.

### 3.4 Cycle 0

Nodes outside every Retry Edge body execute in cycle 0. A Loop with no Retry Edge has only cycle 0.

- Run totals **include** cycle 0.
- Per-cycle **averages and distributions exclude** cycle 0. `averageTokensPerCycle(run) =
  Σ tokens over cycles 1..N / N`, with `N = 0` rendering `—`, not `0`.
- Coverage is computed **including** cycle 0 (it is a real scope with real agent executions), but the
  per-cycle average's own coverage is computed over cycles 1..N only, so the two numbers can differ
  and both are labelled.
- Cycle 0 is shown as its own row labelled `setup/teardown`, never merged into cycle 1.

Including cycle 0 in the average would understate per-cycle cost in a Loop whose expensive
one-off work (observation, issue creation) happens outside the retry body, and would make the average
depend on how many nodes the author placed outside the body — a property of the Loop file, not of the
loop's efficiency.

### 3.5 Attempts and retries

- Every dispatched attempt that produced a measured record contributes. An infrastructure retry
  therefore raises a node execution's total; that is correct, the tokens were spent twice.
- An attempt in state `LOST` contributes an unmeasured execution, not a zero.
- A node execution in state `NO_PROGRESS` still contributes its usage: the agent consumed tokens and
  changed nothing. It does not consume the iteration budget, but it does consume the token budget.
- A node execution in state `SKIPPED` has no attempts and contributes nothing, and is **not** counted
  in the coverage denominator (nothing was dispatched, so nothing was unmeasured).

---

## 4. Usage Coverage

### 4.1 Definition

> **Usage Coverage** is the share of **agent Node Executions** in a scope whose usage provenance is
> `reported` or `derived`.

```
coverage(scope) = measuredExecutions(scope) / agentExecutions(scope)
```

`agentExecutions` counts Node Executions of kind `agent` that were dispatched at least once, in any
terminal or non-terminal state except `SKIPPED`. Command, condition, human and end nodes are never
counted, in numerator or denominator.

`Decision (not in sheet)` — **when is a Node Execution "measured"?** The sheet defines coverage on
provenance alone. A Node Execution counts as measured iff its aggregated record has provenance
`reported` or `derived` **and** every contributing attempt has `complete === true`. For the MVP
runtimes the two definitions coincide with one measured exception: a claude-code attempt interrupted
by SIGINT ends with a `terminal_reason: aborted_streaming` result whose usage covers only the calls
that completed (section 2.1) — `reported`, `complete: false`, and therefore **unmeasured**. The clause
is what keeps such a partial turn from inflating coverage; its tokens still enter the scope's sum as a
lower bound, marked per section 3.3.

A Node Execution whose provenance is `estimated` counts as **unmeasured**. An estimate is not a
measurement, and coverage is a statement about measurement.

### 4.2 Computation per scope

| Scope | Denominator | Numerator |
|---|---|---|
| Cycle `(runId, cycleIndex)` | agent Node Executions in that cycle | those that are measured |
| Run `runId` | agent Node Executions in the Run, cycles 0..N | those that are measured |
| Loop window | agent Node Executions across all Runs in the window | those that are measured |

Coverage of a parent is computed on the **union of its children's executions**, never as the mean of
the children's percentages (invariant I10). A Run with a 1-execution cycle at 0% and a 9-execution
cycle at 100% has coverage 9/10 (90%), not 50%.

Percentage rendering `Decision (not in sheet)`: `p = floor(100 × measured / total)`, clamped to
`[1, 99]` whenever `0 < measured < total`. `100%` is rendered only when `measured === total`, and
`0%` only when `measured === 0`. This prevents a 999/1000 scope from displaying as a complete one.

### 4.3 Display contract

Every view that shows a token sum MUST show these three things together, in this order:

```
Measured Tokens              1,171,000+
Usage Coverage               7/8 (87%)
Unmeasured Agent Executions
  cycle 2  implement      claude-code   interrupted before completion (SIGINT; aborted_streaming)
```

Rules:

1. The three lines travel together. A token sum without its coverage line is a conformance failure —
   in the terminal, in the read-only UI, in the run report, in a CSV export, in a chart tooltip.
2. `Measured Tokens` carries the trailing `+` per section 3.3 whenever coverage < 100%.
3. `Unmeasured Agent Executions` lists **every** unmeasured execution with `(cycleIndex, nodeId,
   runtime, reason)`. The reason is taken verbatim from `provenanceNote`. The list is not truncated
   below 10 entries; above that it shows the first 10 and a count.
4. At 100% coverage the label reads `Total Tokens`, without the `+` and without the list. The change
   of label is the signal that the number is final.
5. The word "Total" MUST NOT be used for a figure below 100% coverage anywhere in the product.

### 4.4 Ratios are final only at 100% coverage

`Tokens per successful outcome`, `tokens per merged PR`, `tokens per cycle`, `average tokens per node`
and every other ratio whose numerator is a token sum are **final only at 100% coverage**. Below it
they are rendered as lower bounds with the coverage beside them:

```
Tokens per successful outcome    1,171,000+ / 1   (lower bound, coverage 87%)
```

At 100%:

```
Tokens per successful outcome    1,171,000
```

`Decision (not in sheet)`: a ratio whose **denominator** is affected by unmeasured executions (for
example an average over node executions) MUST use the measured count as its denominator and say so —
`Avg tokens per node execution 146,375+ (7 of 8 measured)` — rather than dividing a partial numerator
by a complete denominator, which understates the average precisely when the missing runs were the
expensive ones. A ratio whose denominator is an outcome count (successful outcomes, merged PRs) keeps
the true denominator, because outcomes are always countable.

Ratios MUST NOT be compared across scopes with different coverage without both coverages shown.

### 4.5 Partial coverage in Loop-level time series

`Decision (not in sheet)` — the chart contract, which the sheet does not cover.

Every point in a Loop-level series carries its own coverage:

```ts
interface SeriesPoint {
  at: string;                 // RFC 3339
  scope: { runId: string; cycleIndex?: number };
  value: number;              // measured sum for that point's scope
  isLowerBound: boolean;      // value < truth
  measured: number;
  total: number;
  coverageClass: "full" | "partial" | "none";   // 100% | 0<p<100 | 0%
}
```

Rendering rules:

1. A solid line segment may connect two points **only if both are `full`**.
2. Any segment with at least one non-`full` endpoint is drawn **dashed**, and the non-`full` endpoint
   is drawn as a hollow marker. Hovering it shows `n/m (p%)` and the unmeasured list.
3. A `none` point is never interpolated across. The line breaks at it; a gap marker is drawn.
4. The chart legend carries a persistent coverage key whenever any point in the visible range is not
   `full`. It is not a tooltip-only disclosure.
5. Aggregating a series to a coarser bucket (per day, per week) recomputes coverage on the union of
   the underlying executions; the bucket's class is `full` only if every underlying execution is
   measured. A coarse bucket MUST NOT inherit `full` from a majority of its points.
6. Trend statistics (slope, mean, percentile) computed over a range containing any non-`full` point
   are labelled lower bounds and carry the range's aggregate coverage.

A chart that silently joins a 100%-coverage point to a 40%-coverage point draws a "usage went down"
story out of a measurement gap. That is the single most damaging thing this pillar can do, which is
why the marking is normative rather than advisory.

Two annotations SHOULD accompany a Loop-level token series, because they change what the series
means without changing the work done: a marker where the model or runtime changed, and a second
series showing cache-read share (`cacheReadTokens / totalInputTokens`).

---

## 5. Optional weighted view, and the list-price field

### 5.1 `effectiveTokens`

Off by default. A secondary line, never a headline, never a currency.

```
effectiveTokens = freshInputTokens × 1.0
                + cacheWriteTokens × Wwrite
                + cacheReadTokens  × Wread
                + outputTokens     × Wout
```

Default profile, fixed by the decision sheet for the two cache weights:

| `weightingProfileId` | `Wwrite` | `Wread` | `Wout` | Status |
|---|---|---|---|---|
| `loopmill-eq-v1` (default) | 1.25 | 0.1 | 1.0 | ships enabled-but-hidden |

`Decision (not in sheet)`: the sheet fixes `Wread = 0.1` and `Wwrite = 1.25` and says nothing about
output, so the default profile uses `Wout = 1.0` — `effectiveTokens` is expressed in *input-token
equivalents* and does not re-weight output. Profiles that set `Wout` to an output/input price ratio,
or `Wwrite = 2.0` for a one-hour cache TTL, are configuration and MUST be named
(`loopmill-eq-v1-ttl1h`, and so on); none of them ships as the default, because a price ratio is a
vendor number that moves and would silently rewrite the meaning of stored history.

Rules:

- Always labelled `estimated`, always in `eq` units, never in a currency, never called a cost.
- Always carries `weightingProfileId` and the literal weights used, next to the number.
- **Recomputed on read** from the four stored buckets. Never persisted, never overwrites a raw value.
- Never summed across different profiles.
- Off by default, behind an explicit toggle, and absent from the default terminal output, the run
  report and every headline.
- Subject to the same coverage rules as any other sum: a `+` marker and a coverage line below 100%.

Its purpose is diagnostic: raw totals cannot distinguish "the agent re-read a large cached context
many times" (cheap) from "the agent rebuilt that context from scratch" (expensive). The cheapest
version of the same signal, and the one that SHOULD be shown by default beside the raw split, is the
cache-read share `cacheReadTokens / totalInputTokens` — free to compute, needs no weights, and carries
no estimate label.

### 5.2 `listPriceEquivalentUsd`

The claude-code result carries a client-side dollar estimate (`total_cost_usd`, plus `costUSD` per
model). It is a client-side estimate at list price, is explicitly not a bill on a subscription, and
has no counterpart in the other MVP runtime.

Storage rule:

- Stored **verbatim** as `listPriceEquivalentUsd` on the Attempt record (and per model in
  `perModel[].listPriceEquivalentUsd`). Never recomputed, never validated, never repaired.
- Named `listPriceEquivalentUsd`. Never `cost`, never `spend`, never `price`.
- **Hidden by default.** Visible only behind an explicit toggle, labelled
  *"list-price equivalent — not what you are billed on a subscription"*.
- **Never in a headline**, never in a running-spend widget, never in a chart axis.
- **Never aggregated above Node Execution** (invariant I16). One MVP runtime emits it and the other
  does not, so any Cycle, Run or Loop roll-up would be silently partial in a way coverage does not
  express, because the gap is per-runtime rather than per-execution.
- It is **not** an input to the budget. Loopmill's token budgets are denominated in tokens
  (section 6). No USD figure ever stops a run.
- It MAY be used internally as a cross-model normalizer when deriving a weighting profile, with the
  result expressed in `eq` units, never in dollars.

---

## 6. Budget

The `budget:` block of the Loop file. `Decision (not in sheet)`: every field is optional in the file
and every one has a default, except `maxIterations`, which the sheet makes required per Retry Edge;
`loopmill validate` rejects a Retry Edge without it.

### 6.1 Fields

| Field | Type | Default | Scope | Checked | Counts | Breach outcome |
|---|---|---|---|---|---|---|
| `maxAttempts` | integer ≥ 1 | `2` | Node Execution | before dispatching attempt *n* | dispatched attempts | Node Execution `FAILED(attempts_exhausted)`; the Run outcome follows the node's `onFailure` |
| `maxIterations` | integer ≥ 1 | required | Retry Edge | before dispatching the Retry Edge target | traversals of that edge | Run `MAX_ITERATIONS_EXCEEDED` (never `FAILED`) |
| `maxRuntime` | duration | `4h` | Run | before every dispatch, and by the sweep | Run wall clock **excluding human waits** (section 6.3) | Run `EXPIRED` |
| `maxMeasuredTokens` | integer tokens | unset (no cap) | Run | before every dispatch | `totalTokens` of measured records only (section 6.2) | Run `BUDGET_EXCEEDED` |
| `maxUnmeasuredExecutions` | integer ≥ 0 | `0` (section 6.2) | Run | before every dispatch | agent Node Executions with `unavailable` or `estimated` provenance | Run `BUDGET_EXCEEDED(maxUnmeasuredExecutions)` |
| `maxRunsPerWindow` | integer ≥ 1 | `1` per rolling `5h` | Loop | before starting a Run | Run starts in the window (section 6.4) | Run `SKIPPED(runs_per_window)`, recorded before it starts |
| `minInterval` | duration | `1h` | Loop | before starting a Run | time since the previous Run's start | Run `SKIPPED(min_interval)`, recorded before it starts |

`Reconciliation (both in sheet)`: section 10 of the sheet says a budget breach yields
`BUDGET_EXCEEDED`, and section 5 assigns `MAX_ITERATIONS_EXCEEDED` and `EXPIRED` to two of these same
conditions. Where section 5 names a more specific terminal outcome for a condition, that outcome
wins; `BUDGET_EXCEEDED` covers the remaining fields. `maxAttempts` exhaustion is a node failure, not a
run-level budget breach, because the sheet's Attempt state machine already defines it that way. The
two Loop-level rate limits are refusals *before* a Run starts, so they are `SKIPPED` rather than
`BUDGET_EXCEEDED` (section 6.4); `BudgetKey` is therefore the closed set
`maxMeasuredTokens | maxUnmeasuredExecutions | maxStepsPerRun` of `state-machine.md` §2.2.

### 6.2 Token budgets count measured tokens only

`maxMeasuredTokens` is evaluated against

```
Σ totalTokens over Attempt records in the Run with provenance ∈ {reported, derived}
```

Unmeasured and estimated executions contribute **nothing** to it. This is deliberate and it is the
uncomfortable part of the design: a Run made entirely of observed nodes could never breach a token
budget, because Loopmill has no measurement to breach it with. Two consequences follow, and both are
normative:

1. **Whenever the Run's coverage is below 100%, the token budget is marked `partially observable`** in
   every report, the run report, and in the `run-finished` event. The mark names the coverage and
   the count of unmeasured executions. A token budget under incomplete coverage is a floor on spend,
   not a ceiling.
2. **`maxUnmeasuredExecutions` is the binding guard** under incomplete coverage. It is the only limit
   that can stop a Run whose spend Loopmill cannot see, and it is therefore not optional in practice.

**Default for `maxUnmeasuredExecutions` is `0`.** No MVP backend declares `usage: none` — `observed`
was removed (SPIKE-2 NO-GO, ADR-002 D4) and `local`/`fake` both declare full usage — so there is nothing
for a nonzero default to buffer against, and a `0` default means the guard trips on the first unmeasured
execution rather than tolerating any. This is not a vacuous limit even though no MVP backend can
*declare* `usage: none`: **an interrupted attempt is still an unmeasured execution.** A `LOST` attempt
(sweep-declared, section 2.5) and a claude-code turn that ends `aborted_streaming` under SIGINT
(`reported`, `complete: false`, section 2.1) both count against it, so a Run that survives one such
interruption still needs `maxUnmeasuredExecutions` raised above `0` to keep going past it.

The field, and its old computed value, stay in the model for a future backend that *does* declare
`usage: none` — `docs/spec/loop-file.md` §7.2 owns the field:

```
max( 1, observedAgentNodes × (1 + maxEdgeIterations) )     # only when observedAgentNodes > 0
```

where `observedAgentNodes` counts `agent` nodes whose resolved backend declares `usage: none`
(`0` for every MVP loop, which is what makes the MVP default `0` rather than the formula's own floor of
`1`) and `maxEdgeIterations` is the largest `maxIterations` over all Retry Edges (0 when there are
none). It is evaluated by `loopmill validate` at load time and recorded on the Run header, so that
changing the Loop file mid-history does not retroactively change a past Run's budget.

### 6.3 `maxRuntime` excludes human waits

Run wall clock accumulates only while the Run is making progress. `Decision (not in sheet)` for the
split, since the sheet names only human waits:

| Run state | Counts toward `maxRuntime` |
|---|---|
| `RUNNING` | yes |
| `PENDING` | yes (dispatch latency is Loopmill's own) |
| `WAITING_OBSERVED` | **yes** — the vendor cloud is doing the loop's work, and an observed node that never returns must be bounded by something |
| `WAITING_HUMAN` | **no** — fixed by the sheet |
| `WAITING_FOR_QUOTA` | **no** — a vendor reset window can exceed the whole default budget, and waiting for it is not the loop spending time |
| `INTERRUPTED` (lease expired, awaiting sweep) | no |

Two further rules:

- The remaining runtime budget clamps each dispatch's own timeout, so a hung attempt cannot outlive
  the Run deadline.
- `maxRuntime` is the **only** budget that may act on an in-flight attempt. A token budget MUST NOT
  kill a running attempt (invariant I14): tokens already spent are not recovered by killing the
  process, and the kill would destroy the very completion event that would have measured them.

### 6.4 `maxRunsPerWindow` and `minInterval`

Both are per Loop and both are checked before a Run is created, in `loopmill step` while handling
`run-requested`.

- The window is **rolling**, not calendar-aligned: at intended start `t`, count Runs of this Loop
  whose `startedAt ∈ (t − window, t]`. The default window is `5h`, which mirrors the rolling
  five-hour window both vendors meter on; the weekly window is the second limit both vendors run, and
  a `7d` window MAY be configured alongside.
- `minInterval` (default `1h`) compares `t` against the most recent Run's `startedAt`. It mirrors the
  documented one-hour minimum interval of Anthropic's own unattended-run product, and it exists so
  that a reconcile storm after a laptop wakes cannot fire a Loop repeatedly.
- Both are enforced from **Loopmill's own ledger of Run start times**, not from a vendor meter. One
  MVP runtime exposes no quota percentage to a headless process at all, so the ledger is the only
  quota-shaped number that exists for it. When a vendor-side meter is available, it MAY be consulted
  *in addition*, never instead.
- A Run refused by either guard is recorded as a Run in terminal state `SKIPPED`, with
  `skipReason: runs_per_window | min_interval` (`state-machine.md` D-18, R-03), **not** as
  `BUDGET_EXCEEDED` and **not** as `FAILED`. A first-class record is what stops a repeating trigger
  from retrying the refusal in a loop, and what lets the user see that the schedule is over budget
  rather than broken; `SKIPPED` is the sheet's own shape for "this Run was refused before it started",
  and a nightly schedule that correctly declines must not read as a failure in the scheduler's log.

### 6.5 Check point and enforcement shape

Budget evaluation happens in `loopmill step`, in the "decide the next action" phase, **before** the
dispatch phase. Therefore:

- On a breach, `node-dispatched` is **not** written and the backend is **not** called.
- Nothing is ever killed mid-attempt on a token budget (invariant I14); `maxRuntime` is the sole
  exception and acts through the clamped dispatch timeout.
- Budgets **tighten, never loosen**: a value carried on a Run header at creation is the value enforced
  for that Run's whole life. Resume, retry and reconcile replay the pinned Loop version and the pinned
  budget; a resumed Run does not get a fresh allowance, and a Loop file edited mid-flight cannot raise
  a running Run's ceiling. Any nested or self-planned sub-scope may only lower a limit.

### 6.6 What is reported when a budget stops a run

The `run-finished` event carries a `budgetReport` block, and the same block is rendered by
`loopmill status`, the run report and the UI:

```json
{
  "outcome": "BUDGET_EXCEEDED",
  "budgetField": "maxMeasuredTokens",
  "limit": 3000000,
  "observed": 3041882,
  "observedIsLowerBound": true,
  "partiallyObservable": true,
  "coverage": { "measured": 7, "total": 8, "percent": 87 },
  "unmeasuredExecutions": [
    { "cycleIndex": 2, "nodeId": "implement", "runtime": "claude-code", "reason": "interrupted before completion (SIGINT; aborted_streaming)" }
  ],
  "unmeasuredExecutionCount": 1,
  "maxUnmeasuredExecutions": 3,
  "lastCompletedNode": { "cycleIndex": 3, "nodeId": "implement" },
  "wouldHaveDispatched": { "cycleIndex": 3, "nodeId": "test" },
  "runtimeElapsedMs": 4821000,
  "humanWaitExcludedMs": 900000,
  "note": "Token budgets count measured tokens only. Coverage was 87%, so the observed figure is a lower bound and the real spend was higher."
}
```

Required properties of the report: it names the field that bound, the limit and the observed value; it
states whether the observed value is a lower bound; it carries the coverage and the unmeasured list;
it names the node that would have run next, so the user knows what the Run did not do. A budget stop
that only says "budget exceeded" is not conformant.

---

## 7. Correction of the v0.4 design, section 21

The v0.4 design's only concrete statement of the token model is arithmetically wrong, and section 22
inherits the error. This section is the correction; `claude-success.json` is its regression test.

### 7.1 As printed in v0.4

```
Claude Code / Implementation
Input              486,210
Cache read         420,102
Cache creation      21,442
Output              18,928
─────────────────────────
Total              526,682     ← printed
Source            Reported
```

The four printed numbers are `486,210`, `420,102`, `21,442`, `18,928`. **No vendor's semantics
produce 526,682 from them**, and the design never states which fields the total is over.

### 7.2 The correct figure

These are labelled as claude-code output, so Anthropic semantics apply and the three input fields are
disjoint and additive:

```
Input (fresh)        486,210
Cache creation        21,442
Cache read           420,102
──────────────────────────
Total input          927,754
Output                18,928
──────────────────────────
TOTAL                946,682
Cache read              45%
Source              Reported
```

`totalInputTokens = 486,210 + 21,442 + 420,102 = 927,754`;
`totalTokens = 927,754 + 18,928 = 946,682`.

### 7.3 The same node under each display rule

| Display rule | Formula | Value |
|---|---|---|
| **Total tokens** (canonical, section 1) | `fresh + write + read + output` | **946,682** |
| Total input | `fresh + write + read` | 927,754 |
| New tokens (`work actually done`) | `fresh + write + output` | 526,580 |
| Effective, profile `loopmill-eq-v1` | `486,210 + 21,442×1.25 + 420,102×0.1 + 18,928×1.0` | 573,951 eq (`estimated`) |
| Effective, an output-weighted profile with `Wout = 5.0` | `486,210 + 26,802.5 + 42,010.2 + 94,640` | 649,663 eq (`estimated`, non-default) |
| Cache-read share | `420,102 / 927,754` | 45% |
| *If the same four numbers had come from `codex`* — total | `input_tokens + output_tokens`, cache counts being subsets | 505,138 |
| *If the same four numbers had come from `codex`* — the vendor's own headline | `(input − cached) + output` | 85,036 |
| **As printed in v0.4** | — | **526,682** |

The printed 526,682 is 102 above `New tokens` (526,580) — the same trailing digits as the cache-read
figure — so it looks like a transcription slip layered on a formula that had already dropped cache
reads while still displaying them as a component of the same column. Two defects, one number.

The Codex rows are in the table for one reason: with a runtime-blind additive renderer the same four
numbers would be printed as 946,682 for a Codex node whose true total is 505,138 — an inflation of
**1.87×** on a cache-heavy turn. That is why section 2's mapping is per-runtime and why the aggregation
layer must know which runtime produced a row.

### 7.4 The section 22 cycle example inherits it

v0.4 shows `Codex Review 132K + Claude Implementation 527K + Codex Code Review 92K = Total 751K`. With
the Claude node corrected to 947K the cycle total is **1,171K**, and the addition is legitimate only
once the two Codex figures have been through section 2.2 (subset arithmetic and, if the thread was
resumed, the delta rule). Before normalization the cycle total is not a quantity. After it, the Cycle
row MUST still show the per-runtime split and, if any contributing node is unmeasured, render as
`1,171K+` with its coverage line.

---

## 8. Test fixtures

`docs/spec/usage-fixtures/*.json`. Two kinds of file live here. **`handWritten: true`** files are
hand-written from the documented event shapes and are not recordings; no CLI was executed to produce
them, every one says so in its `notARecording` field, and their numbers are illustrative but
internally consistent with the rules above. **`handWritten: false`** files (`claude-recorded-*.json`)
are verbatim recordings from the SPIKE-1 harness (claude-code 2.1.263 on a GitHub-hosted runner,
2026-09-06, workflow run 34024962852) with their provenance under `recording`; the expected records
were derived from them by the rules above and can be checked by hand.

Common shape:

```
fixtureId, title, handWritten, notARecording, spec,
scenario  { backend, runtime, authMode, runId, cycleIndex, nodeId, attempt, ... }
input     { invocation, exitCode, signal, events | terminalEvent | envelope,
            ignoredStreamLines[], usageAtAttemptStart }
expected  { attempts[{ key, usage }], nodeExecution | run, coverage,
            mustNotEqual, display, derivedViews }
assertsInvariants [ "I1", ... ]
```

`expected.attempts[].usage` is the canonical record the adapter must produce, byte for byte in
semantics. `expected.mustNotEqual` holds the values a wrong implementation would produce; a test that
matches one of them fails with a named diagnosis rather than a bare inequality.

| File | Exercises | Expected record |
|---|---|---|
| `claude-success.json` | `result.usage` basis; the four v0.4 numbers; stream placeholder lines and a repeated `message.id` present and ignored | `reported`, 486,210 / 21,442 / 420,102 / 18,928 → **946,682** |
| `claude-with-subagents.json` | `modelUsage` overrides `usage`; `perModel` split; two models | `reported`, basis `modelUsage`, **767,400**; must not equal 656,300 (usage only) or 1,423,700 (both summed) |
| `claude-killed.json` | SIGTERM, exit 143, no `result` line; stream lines that a tempting reconstruction would use (shape confirmed by measurement on 2.1.263; the numbers stay illustrative) | `unavailable`, all null, `complete: false`; must not equal 0 or 359,800 |
| `claude-recorded-success.json` (recording) | 2.1.263 clean success: `modelUsage` with a helper-model entry beside the main model; `thinkingTokens` broken out | `reported`, basis `modelUsage`, two `perModel` entries, **30,476**; must not equal 29,560 (`result.usage` alone) |
| `claude-recorded-max-turns.json` (recording) | `error_max_turns`, `is_error: true`, exit 1, `terminal_reason: max_turns`: usage is reported in full on a failed attempt | `reported`, `complete: true`; must not be `unavailable` |
| `claude-recorded-sigint.json` (recording) | SIGINT mid-turn: exit 0, `terminal_reason: aborted_streaming`, `result.usage` zeroed, `modelUsage` with the completed helper call only | `reported`, `complete: false`, unmeasured for coverage; must not equal 0 and must not be `complete: true` |
| `codex-two-turns-cumulative.json` | thread reuse; the delta rule; the sum-of-deltas identity | two `derived` records, **140,000** and **101,300**, run total **241,300**; must not equal 381,300 |
| `codex-fresh-thread.json` | fresh thread; subset arithmetic; reasoning as reference | `derived`, fresh = `max(0, 24,763−24,448−0)` = 315, total **25,973**; must not equal 50,421 or 26,913 |
| `codex-turn-failed.json` | `turn.failed` with no `turn.completed`; quota classification kept off the usage record | `unavailable`, `complete: false`; must not equal 0 |
| `observed-unavailable.json` | `observed` backend (**reserved**, unreachable in the MVP), `usage: none`, node `SUCCEEDED` anyway; budget attribution | `unavailable`; counts 0 toward `maxMeasuredTokens` and 1 toward `maxUnmeasuredExecutions` |

Every fixture also carries `expected.coverage`, so the coverage computation of section 4 is tested by
the same files as the mapping of section 2.

---

## 9. Invariants that tests MUST assert

Numbered, so acceptance criteria and test names can cite them.

**I1 — Totals are derived, and the buckets are disjoint.**
For every record with provenance `reported`, `derived` or `estimated`, at every aggregation level:
`totalInputTokens === freshInputTokens + cacheWriteTokens + cacheReadTokens` and
`totalTokens === totalInputTokens + outputTokens`.

**I2 — No negative and no fractional token counts.**
Every bucket and every total is an integer ≥ 0. The Codex `max(0, ...)` clamp never leaves a negative
value behind, and when it fires it sets `complete: false`.

**I3 — Reasoning is a subset and is never summed.**
When `reasoningTokens` is non-null: `0 ≤ reasoningTokens ≤ outputTokens`. It appears in no total at
any level, and no aggregate carries a `reasoningTokens` field at all.

**I4 — `unavailable` is never zero.**
`provenance === "unavailable"` ⟺ all four buckets, both totals, `reasoningTokens` and
`listPriceEquivalentUsd` are `null`, and `complete === false`. No storage path, no export and no
render may turn it into `0`. It displays as `—`.

**I5 — No double counting on a cumulative runtime.**
For one Codex thread: `Σ over attempts of delta === lastCumulative − firstAttemptStartCumulative`,
field by field. With a fresh first attempt this reduces to
`Σ totalTokens === lastCumulative.input_tokens + lastCumulative.output_tokens`. Attempt deltas on one
thread are pairwise disjoint.

**I6 — One basis per claude-code record.**
Exactly one of `result.usage` and `modelUsage` contributes; `usageBasis` names it. If `modelUsage` is
present and non-empty it MUST be the basis. When `perModel` is populated, the parent record's four
buckets equal the element-wise sum of `perModel`.

**I7 — The stream is never a usage source.**
No record has a `usageBasis` naming a stream event, and no code path sums `assistant` message usage,
de-duplicated or not.

**I8 — Recomputation reproduces every stored aggregate.**
Recomputing any Node Execution, Cycle, Run or Loop-window total from the underlying Attempt records
reproduces the stored value exactly. Aggregates are a fold of immutable records, never an accumulator.

**I9 — Coverage is bounded, deterministic and monotone in evidence.**
`0 ≤ measuredExecutions ≤ agentExecutions`. Re-folding the same immutable event set yields the same
coverage. For a fixed set of executions, coverage is non-decreasing as events are applied: a Node
Execution may move from `unavailable` to `derived`/`reported` when a late completion arrives, never
the reverse. (Coverage may of course fall when a *new* unmeasured execution is added to the scope;
that is a change of scope, not a regression of evidence.)

**I10 — Coverage nests by union, not by average.**
`coverage(parent) = Σ measured(children) / Σ agentExecutions(children)`, never the mean of the
children's percentages. Command, condition, human and end nodes appear in neither term. `SKIPPED`
node executions appear in neither term.

**I11 — Measurement statuses do not mix in a headline.**
No headline sum contains both an `estimated` record and a `reported`/`derived` record. If a scope
contains `estimated` records, the headline is the measured sum and the estimated records are reported
separately under their own label.

**I12 — Below 100% coverage, every sum is marked.**
Coverage `< 100%` ⟹ every rendered sum in that scope carries the trailing `+` (or, in machine-readable
form, `isLowerBound: true`), the coverage line is present, and the label is not "Total". Coverage
`=== 100%` ⟹ no `+` is rendered anywhere in that scope.

**I13 — Budgets count what they say they count.**
`maxMeasuredTokens` is evaluated against measured records only; unmeasured executions contribute zero
to it and one each to `maxUnmeasuredExecutions`. Whenever coverage `< 100%`, the run's reports carry
`partiallyObservable: true`.

**I14 — No token budget ever kills an in-flight attempt.**
Every budget decision is taken before a dispatch and no `node-dispatched` event exists for a dispatch
refused by a budget. Only `maxRuntime` may act on running work, and it does so through the clamped
dispatch timeout.

**I15 — Cycle 0 in, cycle 0 out.**
Cycle 0 is included in Run totals and excluded from every per-cycle average and distribution. A Run
with only cycle 0 renders its per-cycle average as `—`.

**I16 — `listPriceEquivalentUsd` stays put.**
It exists only on Attempt and per-model records, never aggregates above Node Execution, never appears
in a headline or a default view, and is never an input to a budget decision.

**I17 — `effectiveTokens` is labelled, weighted and dimensionless.**
It is recomputed on read, always carries its `weightingProfileId` and literal weights, is always
labelled `estimated`, is never expressed in a currency, and is never summed across profiles.

**I18 — Idempotence.**
Applying the same event twice (same `eventId`, or the same
`(runId, nodeId, cycle, attempt, eventType)`) changes no usage figure and no coverage figure.

---

## 10. Index of decisions recorded here

Decisions taken where the decision sheet is silent, each stated at its point of use above:

1. §1.2 — six extension fields on the stored record (`usageBasis`, `sessionRef`,
   `usageAtAttemptStart`, `listPriceEquivalentUsd`, `perModel`), none of them headline-visible.
2. §2.1 — no stream-based usage reconstruction at all, not even as a fallback.
3. §2.1 — zeroed crash results are stored as `unavailable`, not as a measured zero.
4. §2.2 — `reasoningTokens` is a reference field: never summed, never aggregated, never in a
   cross-runtime ratio.
5. §2.3 — a backend declaring `usage: none` can never produce a measured record, whatever an artifact
   contains.
6. §2.4 — the MVP ships no token estimator; `estimated` reaches production only through the fake
   backend.
7. §3.2 — aggregate provenance is the weakest contributor, `reported > derived > estimated`.
8. §3.3 — the `+` rendering rules, including `—` for a single unavailable record and the ban on
   dropping the marker in compact views and exports.
9. §4.1 — "measured" additionally requires `complete === true` on every contributing attempt.
10. §4.2 — percentage floor with a `[1, 99]` clamp, so 100% and 0% are exact claims.
11. §4.4 — ratios over node executions divide by the measured count and say so.
12. §4.5 — the whole time-series coverage contract (point classes, dashed segments, gap at `none`,
    bucket aggregation, trend labelling).
13. §5.1 — `Wout = 1.0` in the default weighting profile; price-ratio profiles are named
    configuration and do not ship as the default.
14. §6.1 — `maxAttempts` exhaustion is a node failure, not a run budget breach.
15. §6.2 — the `maxUnmeasuredExecutions` default is `0` for the MVP (no backend declares
    `usage: none`); the old computed formula is kept, pinned on the Run header, for a future backend
    that does.
16. §6.3 — `WAITING_OBSERVED` counts toward `maxRuntime`; `WAITING_FOR_QUOTA` does not.
17. §6.4 — a Run refused by `maxRunsPerWindow` or `minInterval` is recorded as a Run in terminal
    `SKIPPED` with a `skipReason`, never `BUDGET_EXCEEDED` and never `FAILED` (the shape
    `state-machine.md` D-18 fixes).

Reconciliation of two statements both present in the sheet:

- §6.1 — where the sheet's state machine names a specific terminal outcome for a budget condition
  (`MAX_ITERATIONS_EXCEEDED`, `EXPIRED`), that outcome wins over the generic `BUDGET_EXCEEDED`.
