// Public API of the `envelope/` module: schema validation, producer policy, the wire/journal
// form and size rule, fenced-block extraction, eventId derivation, envelope construction and
// Outcome <-> OutcomePayload mapping (docs/spec/envelope.md §3-§7, §11, §13;
// docs/design/m1-plan.md §2 "envelope/").

export * from "./schema.ts";
export * from "./policy.ts";
export * from "./validate.ts";
export * from "./wire.ts";
export * from "./ids.ts";
export * from "./build.ts";
export * from "./outcome.ts";
