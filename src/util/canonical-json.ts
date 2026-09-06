// Canonical JSON serialisation: recursively key-sorted objects, arrays kept in their given
// order, 2-space indent, trailing newline. This is the serialisation for every snapshot,
// envelope and digest (docs/design/m1-plan.md §3 "Canonical JSON"; docs/spec/state-machine.md
// §5.2 P-2). It intentionally differs from RFC 8785 (which loop-file.md §3.1 uses for
// `loopVersion`) by using indentation instead of a compact wire form: this canonical form is
// for engine-internal determinism and human-diffable persistence, not for a hash whose exact
// byte-compactness matters.

import { LoopmillError } from "./errors.ts";

/**
 * Serialises `value` as canonical JSON. Throws `LoopmillError` (code
 * `canonical_json_unsupported`) for `undefined`, functions, symbols, bigints, NaN and
 * Infinity, at any depth — not only at the top level. Decision (not in sheet): the spec says
 * canonical JSON "rejects undefined"; nested `undefined` is rejected the same way as a
 * top-level one; a hash or a stored snapshot must not silently drop a field the way
 * `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  return `${render(value, 0)}\n`;
}

/** Thin wrapper over `JSON.parse`, kept alongside `canonicalJson` for symmetry at call sites. */
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function render(value: unknown, indent: number): string {
  if (value === undefined) {
    throw new LoopmillError(
      "canonical_json_unsupported",
      "undefined is not representable in canonical JSON",
    );
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
      throw new LoopmillError(
        "canonical_json_unsupported",
        `${String(n)} is not representable in canonical JSON`,
      );
    }
    return String(n);
  }
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (type === "function" || type === "symbol" || type === "bigint") {
    throw new LoopmillError(
      "canonical_json_unsupported",
      `values of type ${type} are not representable in canonical JSON`,
    );
  }
  if (Array.isArray(value)) {
    return renderArray(value, indent);
  }
  return renderObject(value as Record<string, unknown>, indent);
}

function renderArray(items: unknown[], indent: number): string {
  if (items.length === 0) {
    return "[]";
  }
  const innerIndent = indent + 1;
  const pad = "  ".repeat(innerIndent);
  const closePad = "  ".repeat(indent);
  const body = items.map((item) => pad + render(item, innerIndent)).join(",\n");
  return `[\n${body}\n${closePad}]`;
}

function renderObject(obj: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) {
    return "{}";
  }
  const innerIndent = indent + 1;
  const pad = "  ".repeat(innerIndent);
  const closePad = "  ".repeat(indent);
  const body = keys
    .map((key) => `${pad}${JSON.stringify(key)}: ${render(obj[key], innerIndent)}`)
    .join(",\n");
  return `{\n${body}\n${closePad}}`;
}
