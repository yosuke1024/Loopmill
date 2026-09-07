// `loopVersion` (docs/spec/loop-file.md §3, §3.1): sha256 over the RFC 8785 JSON Canonicalization
// Scheme (JCS) serialisation of the parsed-but-unresolved document. Deliberately not
// `util/canonical-json.ts`: that module's 2-space-indented form is for engine-internal
// determinism (snapshots, envelopes), not for a hash whose exact byte-compactness matters, and
// it does not implement JCS's number/string/key-ordering rules.
//
// §3.1 in full: (1) parse as YAML 1.2 into a JSON value, core schema, anchors/aliases expanded,
// merge keys resolved -- `load.ts`'s job; (2) do NOT apply defaults, so the hash covers the
// document as authored, not as resolved -- `canonicalizeLoopFile` therefore takes the raw
// `LoopFile` load.ts + schema.ts produced, never a `ResolvedLoop`; (3) serialise as JCS: UTF-8,
// object members sorted by code point of the member name, no insignificant whitespace, numbers
// in shortest round-trip form; (4) `loopVersion` = `"sha256:" + hex(sha256(bytes))`.

import { sha256Prefixed } from "../util/hash.ts";
import { LoopmillError } from "../util/errors.ts";
import type { LoopFile } from "../types/loop.ts";

/** Serialises `file` as RFC 8785 JCS. A comment-only edit, a re-indent, a change of quoting
 * style, or a re-ordering of mapping keys never changes this output (object keys are sorted);
 * re-ordering a YAML **sequence** does (`argv`, `repos`, `edges`, `types` are ordered and their
 * order is meaningful, so arrays are serialised in the given order, unsorted). */
export function canonicalizeLoopFile(file: LoopFile): string {
  return jcs(file);
}

/** `sha256:<64 lowercase hex>` of `canonicalizeLoopFile(file)`, UTF-8 encoded. */
export function loopVersionOf(file: LoopFile): `sha256:${string}` {
  return sha256Prefixed(canonicalizeLoopFile(file)) as `sha256:${string}`;
}

function jcs(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return jcsNumber(value as number);
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcs(item)).join(",")}]`;
  }
  if (type === "object") {
    const obj = value as Record<string, unknown>;
    // Plain `Array.prototype.sort()` on strings compares UTF-16 code units, which is exactly
    // what RFC 8785 §3.2.3 requires for property-name ordering.
    const keys = Object.keys(obj).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${jcs(obj[key])}`).join(",");
    return `{${body}}`;
  }
  throw new LoopmillError("canonical_json_unsupported", `values of type ${type} are not representable in a Loop file's canonical form`);
}

function jcsNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new LoopmillError("canonical_json_unsupported", `${String(n)} is not representable in a Loop file's canonical form`);
  }
  // V8's Number::toString already implements the ECMAScript shortest-round-trip algorithm RFC
  // 8785 mandates (and normalises -0 to "0"), so `String(n)` needs no further massaging here.
  return String(n);
}
