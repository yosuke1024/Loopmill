// RFC 3339 timestamp helpers. Every timestamp in the spec (`occurredAt`, `ctx.now`, snapshot
// timestamps) is RFC 3339 with an explicit `Z` or numeric offset (docs/spec/envelope.md §3.1,
// docs/spec/state-machine.md §5.1 `TransitionContext.now`).

import { LoopmillError } from "./errors.ts";

// Extended-format RFC 3339 date-time: 4-digit year, explicit offset (`Z` or `+HH:MM`/`-HH:MM`),
// optional fractional seconds. This is deliberately narrower than every RFC 3339 variant (no
// lower-case `t`/`z`, no omitted offset) because it is also the shape every producer in this
// codebase is required to emit (docs/spec/envelope.md §3.1: "RFC 3339 date-time").
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Parses an RFC 3339 timestamp to milliseconds since the epoch. Throws on anything else. */
export function parseRfc3339(s: string): number {
  if (typeof s !== "string" || !RFC3339_RE.test(s)) {
    throw new LoopmillError("invalid_rfc3339", `not an RFC 3339 timestamp: ${JSON.stringify(s)}`);
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new LoopmillError("invalid_rfc3339", `not an RFC 3339 timestamp: ${JSON.stringify(s)}`);
  }
  return ms;
}

/** True iff `s` is a well-formed, parseable RFC 3339 timestamp. Never throws. */
export function isRfc3339(s: string): boolean {
  try {
    parseRfc3339(s);
    return true;
  } catch {
    return false;
  }
}

/** Formats milliseconds since the epoch as an RFC 3339 timestamp: always UTC, `Z`, millisecond
 * precision — the shape `Date.prototype.toISOString()` already produces. */
export function formatRfc3339(ms: number): string {
  if (!Number.isFinite(ms)) {
    throw new LoopmillError(
      "invalid_rfc3339",
      `not a finite epoch-millisecond timestamp: ${String(ms)}`,
    );
  }
  return new Date(ms).toISOString();
}

/** Adds `deltaMs` (may be negative) to an epoch-millisecond timestamp. */
export function addMs(ms: number, deltaMs: number): number {
  return ms + deltaMs;
}
