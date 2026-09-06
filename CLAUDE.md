# Loopmill — working notes for AI assistants

## Language
- Everything committed to this repository (code, comments, docs, commit messages) is written in English.
- Conversations with the maintainer may happen in Japanese; that does not change the repository language.

## Delegating to subagents
- Pick the model per task instead of inheriting the parent session's model for every subagent.
- Rough guide: mechanical or high-volume work (translation, formatting, fixture extraction, simple lookups) → a small or mid-size model; web research, fact verification, adversarial checks → a mid-size model; design critique, architecture, judging, synthesis → the strongest model available.
- State the chosen model in the delegation so the choice is visible and reviewable.

## Current state
- Design documents live under `docs/design/` (`mvp-design.md` is the source of truth, v0.6: execution on a
  user-managed host, see `docs/adr/ADR-002-local-self-hosted-execution.md`), decisions under `docs/adr/`,
  contracts under `docs/spec/`, spike plans and results under `docs/spikes/`.
- `spikes/` holds throwaway prototypes and harnesses; they are not the product and may be deleted once their question is answered.
- No product code exists yet. Do not start implementing the engine before the m0 contract freeze in
  `docs/design/mvp-design.md` §20.2 is done; SPIKE-4 (`docs/spikes/README.md`) is part of m0.
