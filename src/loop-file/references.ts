// The §9.1 reference grammar: parsing a reference string into a structured `Reference`,
// resolving it against a Run's state (§9.2), and resolving a whole `inputs` block. Pure except
// for the caller-supplied `ReferenceContext.nodeOutput` lookup, which is how "the most recent
// Node Execution of the referenced node in the current Run" (§9.2) reaches this module without
// it knowing anything about the state store.

import type { JsonScalar, JsonValue, ResolvedInputs } from "../types/loop.ts";
import { LoopmillError } from "../util/errors.ts";

/**
 * A parsed reference (docs/spec/loop-file.md §9.1). `captured.<name>` and anything else outside
 * this closed grammar is not representable here -- `parseReference` throws for it instead.
 */
export type Reference =
  | { kind: "node"; nodeId: string; accessor: "structured" | "stdout" | "exitCode" | "filesChanged"; path: string[] }
  | { kind: "run"; name: "id" | "loop" | "version" | "trigger" }
  | { kind: "cycle" }
  | { kind: "trigger"; path: string[] };

const NODE_ID_RE = /^[a-z][a-z0-9-]*$/;
const RUN_NAMES = new Set(["id", "loop", "version", "trigger"]);

/**
 * Parses a reference string per the §9.1 grammar:
 *
 * ```
 * reference   = "nodes." node-id "." accessor
 *             | "run." name
 *             | "cycle.index"
 *             | "trigger." path
 * accessor    = "structured." dotted-path
 *             | "stdout" | "exitCode" | "filesChanged"
 * ```
 *
 * Throws `LoopmillError` (code `reference_invalid`) for anything outside this grammar,
 * `captured.<name>` included (reserved for a future artifact-matcher backend, §8.6).
 */
export function parseReference(text: string): Reference {
  if (typeof text !== "string" || text.length === 0) {
    throw invalidReference(text);
  }
  if (text === "cycle.index") {
    return { kind: "cycle" };
  }
  if (text.startsWith("run.")) {
    const name = text.slice("run.".length);
    if (RUN_NAMES.has(name)) {
      return { kind: "run", name: name as "id" | "loop" | "version" | "trigger" };
    }
    throw invalidReference(text);
  }
  if (text.startsWith("trigger.")) {
    const path = splitDottedPath(text.slice("trigger.".length), text);
    return { kind: "trigger", path };
  }
  if (text.startsWith("nodes.")) {
    const rest = text.slice("nodes.".length);
    const dot = rest.indexOf(".");
    if (dot === -1) throw invalidReference(text);
    const nodeId = rest.slice(0, dot);
    const accessorPart = rest.slice(dot + 1);
    if (!NODE_ID_RE.test(nodeId)) throw invalidReference(text);
    if (accessorPart === "stdout" || accessorPart === "exitCode" || accessorPart === "filesChanged") {
      return { kind: "node", nodeId, accessor: accessorPart, path: [] };
    }
    if (accessorPart.startsWith("structured.")) {
      const path = splitDottedPath(accessorPart.slice("structured.".length), text);
      return { kind: "node", nodeId, accessor: "structured", path };
    }
    throw invalidReference(text);
  }
  throw invalidReference(text);
}

function splitDottedPath(s: string, original: string): string[] {
  if (s.length === 0) throw invalidReference(original);
  const parts = s.split(".");
  if (parts.some((p) => p.length === 0)) throw invalidReference(original);
  return parts;
}

function invalidReference(text: unknown): LoopmillError {
  return new LoopmillError("reference_invalid", `not a legal reference: ${JSON.stringify(text)}`);
}

/** What a node execution makes available to a reference (§9.1's per-accessor table). Only the
 * fields the node's kind actually produces are present; validation (LM-VAL-016) keeps a
 * well-formed Loop from ever asking for one that is not. */
export interface NodeOutput {
  structured?: JsonValue;
  stdout?: string;
  exitCode?: number;
  filesChanged?: number;
}

/** Everything `resolveReference` needs to resolve a reference against one Run, supplied by the
 * caller (the driver / engine, once it exists) so this module stays free of I/O and of any
 * notion of a state store. `nodeOutput` returns the most recent Node Execution of `nodeId` in
 * the current Run (§9.2): for a node inside the current Retry Edge body that is the current
 * Cycle, for a node outside it the last Cycle in which it actually ran. */
export interface ReferenceContext {
  run: { id: string; loop: string; version: string; trigger: string };
  cycleIndex: number;
  trigger: JsonValue;
  nodeOutput: (nodeId: string) => NodeOutput | undefined;
}

export type ResolveResult = { resolved: true; value: JsonValue } | { resolved: false; reason: string };

/** Resolves one parsed reference against `ctx`. Never throws: an unresolvable reference is
 * reported through the `{ resolved: false }` branch so the caller (`resolveInputs`) can apply a
 * `default` before deciding whether it is actually an error. */
export function resolveReference(ref: Reference, ctx: ReferenceContext): ResolveResult {
  switch (ref.kind) {
    case "cycle":
      return { resolved: true, value: ctx.cycleIndex };
    case "run":
      return { resolved: true, value: ctx.run[ref.name] };
    case "trigger":
      return indexInto(ctx.trigger, ref.path, `trigger.${ref.path.join(".")}`);
    case "node": {
      const output = ctx.nodeOutput(ref.nodeId);
      if (!output) {
        return { resolved: false, reason: `no execution of node "${ref.nodeId}" found in this run` };
      }
      if (ref.accessor === "stdout") {
        return output.stdout === undefined
          ? { resolved: false, reason: `node "${ref.nodeId}" has no stdout` }
          : { resolved: true, value: output.stdout };
      }
      if (ref.accessor === "exitCode") {
        return output.exitCode === undefined
          ? { resolved: false, reason: `node "${ref.nodeId}" has no exitCode` }
          : { resolved: true, value: output.exitCode };
      }
      if (ref.accessor === "filesChanged") {
        return output.filesChanged === undefined
          ? { resolved: false, reason: `node "${ref.nodeId}" has no filesChanged` }
          : { resolved: true, value: output.filesChanged };
      }
      // structured.<path>
      if (output.structured === undefined) {
        return { resolved: false, reason: `node "${ref.nodeId}" has no structured output` };
      }
      return indexInto(output.structured, ref.path, `nodes.${ref.nodeId}.structured.${ref.path.join(".")}`);
    }
  }
}

function indexInto(root: JsonValue, path: string[], label: string): ResolveResult {
  let cur: JsonValue = root;
  for (const segment of path) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, segment)) {
      return { resolved: false, reason: `${label} does not resolve: "${segment}" is missing` };
    }
    cur = (cur as Record<string, JsonValue>)[segment] as JsonValue;
  }
  if (cur === undefined) {
    return { resolved: false, reason: `${label} does not resolve` };
  }
  return { resolved: true, value: cur };
}

/**
 * Resolves every declared input of one node against `ctx`, applying each input's `default` when
 * its reference does not resolve. Throws `LoopmillError` (code `unresolved_reference`) for a
 * reference with no default that does not resolve -- never an empty string (§9). The driver maps
 * this to its own exit code; here it carries `exitCode: 1` as a conservative placeholder (the
 * spec's "10-class" is a family of driver-level exit codes this module does not otherwise know
 * about).
 */
export function resolveInputs(inputs: ResolvedInputs, ctx: ReferenceContext): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [name, spec] of Object.entries(inputs)) {
    const ref = parseReference(spec.from);
    const result = resolveReference(ref, ctx);
    if (result.resolved) {
      out[name] = result.value;
    } else if (spec.default !== undefined) {
      out[name] = spec.default as JsonScalar;
    } else {
      throw new LoopmillError(
        "unresolved_reference",
        `input "${name}" (${spec.from}) did not resolve and has no default: ${result.reason}`,
        { exitCode: 1 },
      );
    }
  }
  return out;
}
