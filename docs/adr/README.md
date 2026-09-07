# Architecture Decision Records

One ADR records one architectural decision: the context that forced it, the decision itself, and the alternatives rejected.
Filename `ADR-NNN-<kebab-title>.md`, numbered sequentially and never reused; sections in order are Title, Status, Context, Decision, Consequences (positive, negative, risks).
Status is `Proposed` | `Accepted` | `Rejected` | `Superseded by ADR-NNN` | `Deprecated`, each carrying a date.
An accepted ADR is immutable except for its Status line: a changed decision becomes a new ADR that supersedes the old one, which stays in place.
Every decision names the alternative it rejected and why; every fact cites a source, and facts that are unverified or second-hand say so in place.
Decisions that a binding coordination document did not cover are labelled `Decision (not in sheet)` so the maintainer can reconcile them.
`docs/design/` describes the system as it is built; ADRs explain why it is built that way, and win on questions of intent.

- [ADR-001](ADR-001-event-driven-control-plane.md) — Event-driven, non-resident control plane with pluggable execution backends — **Superseded by ADR-002**, 2026-09-06
- [ADR-002](ADR-002-local-self-hosted-execution.md) — Execute on a user-managed host; GitHub is the repository and the collaboration surface, not the control plane — Accepted, 2026-09-06
