// The wire/journal form of an envelope (docs/spec/envelope.md §7.3, §7.6), the size rule, and
// fenced `loopmill` block extraction (§7.3, TV-6).

import { LoopmillError } from "../util/errors.ts";
import type { Envelope } from "../types/envelope.ts";

/** envelope.md §7.6: an envelope is at most 32 KiB (32,768 bytes) serialised, on every transport. */
const MAX_ENVELOPE_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------------------------
// toWire / fromWire
// ---------------------------------------------------------------------------------------------

/**
 * Renders `value` the same way `util/canonical-json.ts`'s `canonicalJson` does (recursively
 * key-sorted objects, arrays in their given order, 2-space indent) but accepts an explicit key
 * order for the outermost object only. `canonicalJson` cannot be reused directly for that
 * outermost object: it always re-sorts every key, including `schemaVersion`, which would not
 * satisfy the wire rule below. This function is otherwise identical to `canonicalJson`'s
 * rendering rules, deliberately duplicated here rather than exported from `util/canonical-json.ts`
 * for one-off use.
 */
function renderValue(value: unknown, indent: number): string {
  if (value === undefined) {
    throw new LoopmillError("wire_unsupported", "undefined is not representable on the envelope wire");
  }
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "boolean") {
    return String(value);
  }
  if (type === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new LoopmillError("wire_unsupported", `${String(n)} is not representable on the envelope wire`);
    }
    return String(n);
  }
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (type === "function" || type === "symbol" || type === "bigint") {
    throw new LoopmillError("wire_unsupported", `values of type ${type} are not representable on the envelope wire`);
  }
  if (Array.isArray(value)) {
    return renderArray(value, indent);
  }
  const obj = value as Record<string, unknown>;
  return renderObject(obj, indent, Object.keys(obj).sort());
}

function renderArray(items: unknown[], indent: number): string {
  if (items.length === 0) {
    return "[]";
  }
  const innerIndent = indent + 1;
  const pad = "  ".repeat(innerIndent);
  const closePad = "  ".repeat(indent);
  const body = items.map((item) => pad + renderValue(item, innerIndent)).join(",\n");
  return `[\n${body}\n${closePad}]`;
}

function renderObject(obj: Record<string, unknown>, indent: number, keys: string[]): string {
  if (keys.length === 0) {
    return "{}";
  }
  const innerIndent = indent + 1;
  const pad = "  ".repeat(innerIndent);
  const closePad = "  ".repeat(indent);
  const body = keys.map((key) => `${pad}${JSON.stringify(key)}: ${renderValue(obj[key], innerIndent)}`).join(",\n");
  return `{\n${body}\n${closePad}}`;
}

/**
 * The wire/journal form of an envelope: canonical JSON (recursively key-sorted, 2-space indent,
 * trailing newline — `util/canonical-json.ts`'s convention, which `docs/design/m1-plan.md` §3
 * makes the serialisation for every envelope) EXCEPT that `schemaVersion` is forced to be the
 * first key at the top level. That is the one deliberate deviation from plain canonical order:
 * envelope.md §3.1 and §7.3 rule 6 both require `schemaVersion` to be the first key on the wire
 * ("a Loopmill wire rule checked textually before parsing"), which plain recursive key-sorting
 * would not produce (`schemaVersion` does not sort first among an envelope's other keys).
 */
export function toWire(envelope: Envelope): string {
  const obj = envelope as unknown as Record<string, unknown>;
  const rest = Object.keys(obj)
    .filter((k) => k !== "schemaVersion")
    .sort();
  const keys = ["schemaVersion", ...rest];
  return `${renderObject(obj, 0, keys)}\n`;
}

/** Parses wire text back to an untyped value (envelope.md §7.2: `loopmill step` accepts exactly
 * one envelope as JSON; NDJSON, arrays and multi-document input are out of scope here). JSON
 * parse only — no repair, no schema check; pair with `validate.ts`'s `validateEnvelope`. */
export function fromWire(text: string): unknown {
  return JSON.parse(text) as unknown;
}

// ---------------------------------------------------------------------------------------------
// Size accounting (§7.6)
// ---------------------------------------------------------------------------------------------

export interface WireSize {
  /** Size in bytes of `toWire(envelope)`, UTF-8. */
  bytes: number;
  /** Size in bytes of that wire text once escaped into a JSON string (`JSON.stringify`), UTF-8 —
   * the worst case a reserved transport that nests the envelope in a string field pays. */
  escapedBytes: number;
}

/** envelope.md §7.6, TV-3: the wire form's own size, and its size once escaped into a JSON
 * string. */
export function wireSize(envelope: Envelope): WireSize {
  const wire = toWire(envelope);
  const bytes = Buffer.byteLength(wire, "utf8");
  const escapedBytes = Buffer.byteLength(JSON.stringify(wire), "utf8");
  return { bytes, escapedBytes };
}

export interface SizeCheck extends WireSize {
  ok: boolean;
  limit: number;
}

/**
 * envelope.md §7.6's concrete rule, the part that binds every transport including the in-process
 * one: "envelope <= 32 KiB (32,768 bytes)". `ok` gates on `bytes` against that 32 KiB budget;
 * `escapedBytes` is reported alongside for visibility but is not what `ok` gates on here — the 60
 * KiB escaped budget in §7.6 is specific to the *reserved* `repository_dispatch` transport, not a
 * universal envelope requirement.
 */
export function checkSize(envelope: Envelope): SizeCheck {
  const { bytes, escapedBytes } = wireSize(envelope);
  return { ok: bytes <= MAX_ENVELOPE_BYTES, bytes, escapedBytes, limit: MAX_ENVELOPE_BYTES };
}

// ---------------------------------------------------------------------------------------------
// Fenced `loopmill` block extraction (§7.3, TV-6)
// ---------------------------------------------------------------------------------------------

// Rule 1: the opening fence is a line matching exactly three backticks, the literal word
// "loopmill", and nothing else but trailing tabs/spaces — no indentation, no trailing text, no
// case variation.
const OPEN_FENCE_RE = /^```loopmill[ \t]*$/;
// Rule 3: the closing fence is a line matching exactly three backticks and nothing else but
// trailing tabs/spaces.
const CLOSE_FENCE_RE = /^```[ \t]*$/;

/**
 * Extracts the envelope from a comment body's fenced `loopmill` block (envelope.md §7.3, TV-6).
 * The grammar is exact and this function enforces every rule of it:
 *
 * 1. The opening fence must match `^```loopmill[ \t]*$` — an indented fence, one with trailing
 *    text (` ```loopmill json `), or a different case (` ```LOOPMILL `) is not a fence at all, so
 *    no block is found.
 * 2. Everything up to the closing fence is the payload: exactly one JSON object.
 * 3. The closing fence must match `^```[ \t]*$`. No closing fence before the body ends means the
 *    block is unterminated: no envelope.
 * 4. **Only the first block is ever looked at.** A second block is never even scanned for, so it
 *    can never contribute an envelope, whatever it contains.
 * 5. The payload is parsed as strict JSON (`JSON.parse`, no repair). A parse failure, or a
 *    payload that does not parse to a JSON object, yields no envelope.
 *
 * Returns an array of zero or one element: the parsed (but not yet schema-validated) envelope
 * value, or `[]` when no well-formed block was found. Pair with `validate.ts`'s
 * `validateEnvelope` to check the result against the schema, producer policy and the credential
 * backstop.
 */
export function extractFencedEnvelopes(commentBody: string): unknown[] {
  const lines = commentBody.split(/\r\n|\r|\n/);

  let openIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (OPEN_FENCE_RE.test(lines[i] ?? "")) {
      openIndex = i;
      break;
    }
  }
  if (openIndex === -1) {
    return [];
  }

  let closeIndex = -1;
  for (let i = openIndex + 1; i < lines.length; i++) {
    if (CLOSE_FENCE_RE.test(lines[i] ?? "")) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return []; // unterminated fence
  }

  const payload = lines.slice(openIndex + 1, closeIndex).join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return []; // non-JSON contents: rule 5, a parse failure yields nothing
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return []; // rule 2: the payload must be exactly one JSON object
  }
  return [parsed];
}
