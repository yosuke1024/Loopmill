# Loopmill — working notes for AI assistants

## Language
- Everything committed to this repository (code, comments, docs, commit messages) is written in English.
- Conversations with the maintainer may happen in Japanese; that does not change the repository language.

## Delegating to subagents
- Pick the model per task instead of inheriting the parent session's model for every subagent.
- Rough guide: mechanical or high-volume work (translation, formatting, fixture extraction, simple lookups) → a small or mid-size model; web research, fact verification, adversarial checks → a mid-size model; design critique, architecture, judging, synthesis → the strongest model available.
- State the chosen model in the delegation so the choice is visible and reviewable.

## Current state
- Design documents live under `docs/design/`. `mvp-design.md` is the English source of truth for the MVP design.
