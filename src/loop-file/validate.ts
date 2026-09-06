// Semantic validation (docs/spec/loop-file.md §13, LM-VAL-002 through LM-VAL-029, LM-VAL-020
// retired). Ports `docs/spec/validate-examples.mjs` faithfully: same codes, same rule grouping,
// the same messages where sensible, but built on this package's own `references.ts` / `expr.ts`
// / `template.ts` instead of the reference script's ad hoc regex probes, and reporting through a
// `Finding[]` rather than printing to a console.

import { basename } from "node:path";
import type {
  AgentNode,
  Inputs,
  LoopFile,
  NodeSpec,
  OnFailure,
} from "../types/loop.ts";
import type { AuthMode, BackendCapabilities, RuntimeId } from "../types/capabilities.ts";
import { validateAgainstSchema } from "./schema.ts";
import { BACKEND_CAPABILITIES } from "../backends/capabilities.ts";
import { computeDominators, findRoots, forwardTargets, reachableFrom } from "./graph.ts";
import { parseReference, type Reference } from "./references.ts";
import { templatePlaceholders } from "./template.ts";
import { expressionPaths, parseExpression } from "./expr.ts";
import { parseIsoDuration } from "../util/duration.ts";

export interface Finding {
  code: `LM-VAL-${string}`;
  path: string;
  message: string;
}

export interface ValidateLoopOptions {
  /** The file path the document was loaded from. Only when given is LM-VAL-002 (slug vs. file
   * name) checked -- a document validated in memory (no file of its own, e.g. a test fixture)
   * has nothing to compare `slug` against. */
  path?: string;
  /** Defaults to `BACKEND_CAPABILITIES`. Overridable so a test can validate against a deliberately
   * different capability record without touching the real one. */
  capabilities?: Record<string, BackendCapabilities>;
}

export interface ValidateLoopResult {
  ok: boolean;
  findings: Finding[];
  /** The parsed document, typed as `LoopFile`, once it has passed schema validation --
   * regardless of whether semantic findings remain. `null` when schema validation itself failed,
   * since there is then no guarantee the document even has the shape `LoopFile` promises. */
  file: LoopFile | null;
}

const CONTROL_PLANE_KINDS: ReadonlySet<string> = new Set(["condition", "human", "end"]);

/** Backend x Runtime -> allowed `auth` values (loop-file.md §13 "Supported combinations for
 * LM-VAL-019"). `fake` accepts any runtime/auth combination, since it only replays fixtures. */
const AUTH_MATRIX: Record<string, Partial<Record<RuntimeId, readonly AuthMode[]>>> = {
  local: {
    "claude-code": ["subscription-oauth", "api-key"],
    codex: ["subscription-login", "api-key"],
  },
  fake: {
    "claude-code": ["subscription-oauth", "subscription-login", "api-key"],
    codex: ["subscription-oauth", "subscription-login", "api-key"],
  },
};

/**
 * Validates a parsed Loop file document. Schema failure (LM-VAL-001, one `Finding` per ajv
 * error) stops here; every other rule requires a schema-valid document to even have somewhere
 * sensible to look. Findings are sorted by code, then path, then message.
 */
export function validateLoopDocument(document: unknown, opts: ValidateLoopOptions = {}): ValidateLoopResult {
  const findings: Finding[] = [];

  // Rules the JSON Schema also enforces (LM-VAL-022, 024, 027): run first, against the raw
  // document, and unconditionally -- so the reported code names the actual mistake even when the
  // document also fails the schema, rather than only ever surfacing as an opaque LM-VAL-001.
  shadowRules(document, findings);

  const schemaResult = validateAgainstSchema(document);
  if (!schemaResult.ok) {
    for (const e of schemaResult.errors) {
      findings.push({ code: "LM-VAL-001", path: e.path, message: e.message });
    }
    return { ok: false, findings: finalize(findings), file: null };
  }

  const file = document as LoopFile;
  const capabilities = opts.capabilities ?? BACKEND_CAPABILITIES;
  semanticRules(file, opts.path, capabilities, findings);

  const sorted = finalize(findings);
  return { ok: sorted.length === 0, findings: sorted, file };
}

function finalize(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.message !== b.message) return a.message < b.message ? -1 : 1;
    return 0;
  });
}

// -------------------------------------------------------------------------------------------
// Generic field access across the NodeSpec union. The reference script is untyped JS and reads
// whichever fields a node happens to have; this local view keeps that pattern without fighting
// the discriminated union everywhere a field is common to several (but not all) node kinds.
// -------------------------------------------------------------------------------------------

interface RawNodeFields {
  id?: string;
  next?: string;
  onFailure?: OnFailure;
  backend?: string;
  effects?: string;
  inputs?: Inputs;
  prompt?: string;
  argv?: string[];
  cwd?: string;
}

function raw(node: NodeSpec): RawNodeFields {
  return node as unknown as RawNodeFields;
}

function refTextOf(spec: Inputs[string]): string {
  return typeof spec === "string" ? spec : spec.from;
}

function backendOf(node: NodeSpec, defaults: LoopFile["defaults"]): string {
  if (CONTROL_PLANE_KINDS.has(node.kind)) return "control-plane";
  return raw(node).backend ?? defaults?.backend ?? "local";
}

// -------------------------------------------------------------------------------------------
// Shadow rules: also enforced by the schema (LM-VAL-022 repos, LM-VAL-024 approval.reason,
// LM-VAL-027 prompt xor promptFile), run defensively against `unknown` so they still fire when
// the document is not otherwise schema-valid.
// -------------------------------------------------------------------------------------------

function shadowRules(document: unknown, findings: Finding[]): void {
  if (!document || typeof document !== "object") return;
  const doc = document as Record<string, unknown>;

  if (Array.isArray(doc.repos) && doc.repos.length > 1) {
    findings.push({
      code: "LM-VAL-022",
      path: "repos",
      message: `${doc.repos.length} repos declared; the MVP allows exactly one`,
    });
  }

  const approval = doc.approval;
  if (approval && typeof approval === "object") {
    const a = approval as Record<string, unknown>;
    if (a.policy === "auto" && !a.reason) {
      findings.push({ code: "LM-VAL-024", path: "approval", message: "approval.policy: auto requires an explicit reason" });
    }
  }

  const nodes = doc.nodes && typeof doc.nodes === "object" ? (doc.nodes as Record<string, unknown>) : {};
  for (const [id, value] of Object.entries(nodes)) {
    if (!value || typeof value !== "object") continue;
    const n = value as Record<string, unknown>;
    if (n.kind !== "agent") continue;
    const hasPrompt = n.prompt !== undefined;
    const hasFile = n.promptFile !== undefined;
    if (hasPrompt === hasFile) {
      findings.push({
        code: "LM-VAL-027",
        path: `nodes.${id}`,
        message: hasPrompt ? "both prompt and promptFile are set" : "neither prompt nor promptFile is set",
      });
    }
  }
}

// -------------------------------------------------------------------------------------------
// Semantic rules over a schema-valid document.
// -------------------------------------------------------------------------------------------

function semanticRules(
  file: LoopFile,
  filePath: string | undefined,
  capabilities: Record<string, BackendCapabilities>,
  findings: Finding[],
): void {
  // LM-VAL-029 trigger.kind: event is reserved.
  if (file.trigger.kind === "event") {
    findings.push({ code: "LM-VAL-029", path: "trigger", message: 'trigger.kind "event" is reserved and not supported in this version' });
  }

  // LM-VAL-002 slug must match the file name (only checked when a path was given).
  if (filePath !== undefined) {
    const base = basename(filePath);
    if (base !== `${file.slug}.loop.yaml`) {
      findings.push({ code: "LM-VAL-002", path: base, message: `slug "${file.slug}" does not match file name (expected ${file.slug}.loop.yaml)` });
    }
  }

  // LM-VAL-003 duplicate edge ids / an edge id colliding with a node id. A duplicate YAML
  // mapping key is caught earlier, by `load.ts`, as a parse error -- by the time a document
  // exists as a plain JS value there is no way to tell "last-wins" from "never duplicated".
  const edges = file.edges ?? [];
  const nodes = file.nodes;
  const seenEdgeIds = new Set<string>();
  for (const edge of edges) {
    if (seenEdgeIds.has(edge.id)) {
      findings.push({ code: "LM-VAL-003", path: `edges.${edge.id}`, message: "duplicate edge id" });
    }
    seenEdgeIds.add(edge.id);
    if (nodes[edge.id]) {
      findings.push({ code: "LM-VAL-003", path: `edges.${edge.id}`, message: "edge id collides with a node id" });
    }
  }

  // LM-VAL-004 optional id echo must equal the map key.
  for (const [id, node] of Object.entries(nodes)) {
    const echo = raw(node).id;
    if (echo !== undefined && echo !== id) {
      findings.push({ code: "LM-VAL-004", path: `nodes.${id}`, message: `id echo "${echo}" does not equal the map key "${id}"` });
    }
  }

  // Forward graph + LM-VAL-006 (unknown targets).
  const edgeIds = new Set(edges.map((e) => e.id));
  const { succ, routesIntoEdge } = buildForwardGraph(file, edgeIds, findings);

  // LM-VAL-005 entry, LM-VAL-011 reachability, LM-VAL-012 termination.
  const { entry, dom } = entryReachabilityAndTermination(file, succ, routesIntoEdge, findings);

  // LM-VAL-018, 019, 021, 028: per-node capability rules.
  capabilityRules(file, capabilities, findings);

  // LM-VAL-013, 014, 015, 016, 017: data flow.
  const declaredInputs = new Map<string, Set<string>>();
  for (const [id, node] of Object.entries(nodes)) {
    declaredInputs.set(id, new Set(Object.keys(raw(node).inputs ?? {})));
  }
  inputReferenceRules(file, declaredInputs, findings);
  templateRules(file, declaredInputs, findings);
  expressionRules(file, declaredInputs, findings);

  // LM-VAL-007, 008, 009, 010, 025: retry edges (and LM-VAL-006 for edges.from/to).
  retryEdgeRules(file, succ, capabilities, routesIntoEdge, findings);

  // LM-VAL-014 (dominance) and LM-VAL-023 (approval gate) both need `dom`.
  if (dom) {
    dominanceRule(file, dom, findings);
    approvalRule(file, dom, findings);
  }

  // LM-VAL-026 schedule vs. budget.minInterval.
  scheduleRule(file, findings);
}

// --- LM-VAL-006 + the forward graph -----------------------------------------------------------

function buildForwardGraph(
  file: LoopFile,
  edgeIds: Set<string>,
  findings: Finding[],
): { succ: Map<string, string[]>; routesIntoEdge: Map<string, string[]> } {
  const nodes = file.nodes;
  const ids = Object.keys(nodes);
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  const routesIntoEdge = new Map<string, string[]>();
  const addRoute = (edgeId: string, from: string): void => {
    const existing = routesIntoEdge.get(edgeId);
    if (existing) existing.push(from);
    else routesIntoEdge.set(edgeId, [from]);
  };

  for (const [id, node] of Object.entries(nodes)) {
    for (const target of forwardTargets(node)) {
      if (edgeIds.has(target)) {
        addRoute(target, id);
      } else if (!nodes[target]) {
        findings.push({ code: "LM-VAL-006", path: `nodes.${id}`, message: `target "${target}" is neither a node nor a retry edge` });
      } else {
        succ.get(id)!.push(target);
      }
    }
    const onFailure = raw(node).onFailure;
    if (typeof onFailure === "string" && onFailure.startsWith("retry_edge:")) {
      const edgeId = onFailure.slice("retry_edge:".length);
      if (!edgeIds.has(edgeId)) {
        findings.push({ code: "LM-VAL-006", path: `nodes.${id}.onFailure`, message: `retry edge "${edgeId}" does not exist` });
      } else {
        addRoute(edgeId, id);
      }
    }
    if (node.kind === "human") {
      if (node.subject) {
        const target = node.subject.slice("nodes.".length);
        if (!nodes[target]) {
          findings.push({ code: "LM-VAL-006", path: `nodes.${id}.subject`, message: `subject node "${target}" does not exist` });
        }
      }
      if (node.target) {
        const target = node.target.slice("nodes.".length);
        if (!nodes[target]) {
          findings.push({ code: "LM-VAL-006", path: `nodes.${id}.target`, message: `target node "${target}" does not exist` });
        }
      }
    }
  }
  return { succ, routesIntoEdge };
}

// --- LM-VAL-005 / 011 / 012 -------------------------------------------------------------------

function entryReachabilityAndTermination(
  file: LoopFile,
  succ: Map<string, string[]>,
  routesIntoEdge: Map<string, string[]>,
  findings: Finding[],
): { entry: string | undefined; dom: Map<string, Set<string>> | undefined } {
  const nodes = file.nodes;
  const ids = Object.keys(nodes);
  let entry: string | undefined = file.entry;

  if (entry === undefined) {
    const roots = findRoots(ids, succ);
    if (roots.length !== 1) {
      findings.push({
        code: "LM-VAL-005",
        path: "entry",
        message: `entry node cannot be derived: ${roots.length} nodes have no incoming forward edge (${roots.join(", ") || "none"})`,
      });
      entry = undefined;
    } else {
      entry = roots[0];
    }
  } else if (!nodes[entry]) {
    findings.push({ code: "LM-VAL-005", path: "entry", message: `entry "${entry}" is not a node` });
    entry = undefined;
  }

  let dom: Map<string, Set<string>> | undefined;
  if (entry !== undefined) {
    const seen = reachableFrom(entry, succ, file.edges);
    for (const id of ids) {
      if (!seen.has(id)) {
        findings.push({ code: "LM-VAL-011", path: `nodes.${id}`, message: "node is unreachable from the entry node" });
      }
    }
    dom = computeDominators(ids, entry, succ);
  }

  for (const [id, node] of Object.entries(nodes)) {
    if (node.kind === "end") continue;
    const hasForward = (succ.get(id) ?? []).length > 0;
    const hasEdge = [...routesIntoEdge.values()].some((from) => from.includes(id));
    if (!hasForward && !hasEdge) {
      findings.push({ code: "LM-VAL-012", path: `nodes.${id}`, message: "node has no successor and is not an end node" });
    }
  }

  return { entry, dom };
}

// --- LM-VAL-018 / 019 / 021 / 028 ---------------------------------------------------------------

function capabilityRules(file: LoopFile, capabilities: Record<string, BackendCapabilities>, findings: Finding[]): void {
  const defaults = file.defaults;
  for (const [id, node] of Object.entries(file.nodes)) {
    const backend = backendOf(node, defaults);

    // LM-VAL-028: github-actions is reserved, regardless of runtime or auth, for any node kind
    // that would otherwise dispatch to a backend (i.e. not condition/human/end).
    if (!CONTROL_PLANE_KINDS.has(node.kind) && backend === "github-actions") {
      findings.push({ code: "LM-VAL-028", path: `nodes.${id}`, message: "backend github-actions is reserved and not supported in this version" });
    }

    if (node.kind !== "agent") continue;
    const agent: AgentNode = node;

    if (agent.structuredOutput) {
      const cap = capabilities[backend];
      if (cap && !cap.structuredOutput) {
        findings.push({
          code: "LM-VAL-018",
          path: `nodes.${id}`,
          message: `backend "${backend}" declares structuredOutput: false but the node sets structuredOutput`,
        });
      }
    }

    if (agent.sessionPolicy && agent.sessionPolicy !== "fresh") {
      findings.push({ code: "LM-VAL-021", path: `nodes.${id}`, message: `sessionPolicy "${agent.sessionPolicy}" is not supported in the MVP` });
    }

    // LM-VAL-019: the reserved backend already has its own finding (LM-VAL-028) above; do not
    // also report it as an unsupported combination here.
    if (backend !== "github-actions") {
      const runtime = agent.runtime ?? defaults?.runtime;
      const auth = agent.auth ?? defaults?.authMode;
      if (!runtime) {
        findings.push({ code: "LM-VAL-019", path: `nodes.${id}`, message: "no runtime: the node declares none and defaults.runtime is unset" });
      } else if (!auth) {
        findings.push({ code: "LM-VAL-019", path: `nodes.${id}`, message: "no auth mode: the node declares none and defaults.authMode is unset" });
      } else {
        const allowed = AUTH_MATRIX[backend]?.[runtime];
        if (!allowed) {
          findings.push({ code: "LM-VAL-019", path: `nodes.${id}`, message: `runtime "${runtime}" is not available on backend "${backend}"` });
        } else if (!allowed.includes(auth)) {
          findings.push({
            code: "LM-VAL-019",
            path: `nodes.${id}`,
            message: `auth "${auth}" is not available for ${runtime} on ${backend} (allowed: ${allowed.join(", ")})`,
          });
        }
      }
    }
  }
}

// --- LM-VAL-013 / 016 (input references) --------------------------------------------------------

function inputReferenceRules(file: LoopFile, declaredInputs: Map<string, Set<string>>, findings: Finding[]): void {
  const nodes = file.nodes;
  for (const [id, node] of Object.entries(nodes)) {
    const inputs = raw(node).inputs ?? {};
    for (const [local, spec] of Object.entries(inputs)) {
      const refText = refTextOf(spec);
      let ref: Reference;
      try {
        ref = parseReference(refText);
      } catch {
        findings.push({ code: "LM-VAL-013", path: `nodes.${id}.inputs.${local}`, message: `"${refText}" is not a legal reference` });
        continue;
      }
      if (ref.kind !== "node") continue;
      const target = nodes[ref.nodeId];
      if (!target) {
        findings.push({
          code: "LM-VAL-013",
          path: `nodes.${id}.inputs.${local}`,
          message: `reference "${refText}" names an unknown node "${ref.nodeId}"`,
        });
        continue;
      }
      if (ref.accessor === "structured") {
        if (target.kind !== "agent" || !target.structuredOutput) {
          findings.push({
            code: "LM-VAL-016",
            path: `nodes.${id}.inputs.${local}`,
            message: `"${ref.nodeId}" declares no structuredOutput, so structured.* is not available`,
          });
        }
      } else if (ref.accessor === "stdout" || ref.accessor === "exitCode") {
        if (target.kind !== "command") {
          findings.push({
            code: "LM-VAL-016",
            path: `nodes.${id}.inputs.${local}`,
            message: `${ref.accessor} is only available from a command node ("${ref.nodeId}" is ${target.kind})`,
          });
        }
      } else if (ref.accessor === "filesChanged") {
        if (target.kind !== "agent" && target.kind !== "command") {
          findings.push({
            code: "LM-VAL-016",
            path: `nodes.${id}.inputs.${local}`,
            message: `filesChanged is only available from an agent or command node ("${ref.nodeId}" is ${target.kind})`,
          });
        }
      }
    }
  }
}

// --- LM-VAL-015 (templates) ---------------------------------------------------------------------

function templateRules(file: LoopFile, declaredInputs: Map<string, Set<string>>, findings: Finding[]): void {
  for (const [id, node] of Object.entries(file.nodes)) {
    const declared = declaredInputs.get(id) ?? new Set<string>();
    const r = raw(node);
    const strings: Array<[string, string]> = [];
    if (typeof r.prompt === "string") strings.push(["prompt", r.prompt]);
    if (Array.isArray(r.argv)) r.argv.forEach((a, i) => strings.push([`argv[${i}]`, a]));
    if (typeof r.cwd === "string") strings.push(["cwd", r.cwd]);

    for (const [where, text] of strings) {
      let names: string[];
      try {
        names = templatePlaceholders(text);
      } catch {
        findings.push({ code: "LM-VAL-015", path: `nodes.${id}.${where}`, message: 'unterminated "${" placeholder' });
        continue;
      }
      for (const name of names) {
        if (!declared.has(name)) {
          findings.push({ code: "LM-VAL-015", path: `nodes.${id}.${where}`, message: `\${${name}} is not a declared input of this node` });
        }
      }
    }
  }
}

// --- LM-VAL-017 (expressions) -------------------------------------------------------------------

function expressionRules(file: LoopFile, declaredInputs: Map<string, Set<string>>, findings: Finding[]): void {
  const checkExpr = (source: string, path: string, declared: Set<string>, describe: string): void => {
    let expr;
    try {
      expr = parseExpression(source);
    } catch (err) {
      findings.push({ code: "LM-VAL-017", path, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const reported = new Set<string>();
    for (const segments of expressionPaths(expr)) {
      const root = segments[0];
      if (root === undefined || reported.has(root) || declared.has(root)) continue;
      findings.push({ code: "LM-VAL-017", path, message: `"${root}" is not a declared input of ${describe}` });
      reported.add(root);
    }
  };

  for (const [id, node] of Object.entries(file.nodes)) {
    if (node.kind !== "condition") continue;
    checkExpr(node.expr, `nodes.${id}.expr`, declaredInputs.get(id) ?? new Set(), "this node");
  }
  for (const edge of file.edges ?? []) {
    if (!edge.when) continue;
    checkExpr(edge.when, `edges.${edge.id}.when`, declaredInputs.get(edge.from) ?? new Set(), `the from node "${edge.from}"`);
  }
}

// --- LM-VAL-007 / 008 / 009 / 010 / 025 (retry edges, plus LM-VAL-006 for from/to) --------------

function retryEdgeRules(
  file: LoopFile,
  succ: Map<string, string[]>,
  capabilities: Record<string, BackendCapabilities>,
  routesIntoEdge: Map<string, string[]>,
  findings: Finding[],
): void {
  const nodes = file.nodes;
  const defaults = file.defaults;

  for (const edge of file.edges ?? []) {
    const fromNode = nodes[edge.from];
    const toNode = nodes[edge.to];
    if (!fromNode) {
      findings.push({ code: "LM-VAL-006", path: `edges.${edge.id}.from`, message: `"${edge.from}" is not a node` });
    }
    if (!toNode) {
      findings.push({ code: "LM-VAL-006", path: `edges.${edge.id}.to`, message: `"${edge.to}" is not a node` });
      continue;
    }

    // LM-VAL-007: `to` must run on a retryable backend.
    const toBackend = backendOf(toNode, defaults);
    const toCap = capabilities[toBackend] ?? capabilities["control-plane"];
    if (!toCap || !toCap.retryable) {
      const why = CONTROL_PLANE_KINDS.has(toNode.kind)
        ? `to "${edge.to}" is a ${toNode.kind} node, which runs on the control plane (retryable: false)`
        : `to "${edge.to}" runs on backend "${toBackend}" (retryable: false)`;
      findings.push({ code: "LM-VAL-007", path: `edges.${edge.id}`, message: `retry edge targets non-retryable backend: ${why}` });
    }

    // LM-VAL-008: `from` must be forward-reachable from `to` (the edge closes a cycle).
    const seen = new Set([edge.to]);
    const stack = [edge.to];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const t of succ.get(cur) ?? []) {
        if (!seen.has(t)) {
          seen.add(t);
          stack.push(t);
        }
      }
    }
    if (!seen.has(edge.from)) {
      findings.push({
        code: "LM-VAL-008",
        path: `edges.${edge.id}`,
        message: `retry edge does not close a cycle: "${edge.from}" is not forward-reachable from "${edge.to}"`,
      });
    } else {
      // LM-VAL-009: the body (nodes on a forward path from `to` to `from`, inclusive) must
      // contain at least one node on a retryable backend.
      const body = [...seen].filter((id) => {
        const localSeen = new Set([id]);
        const stack2 = [id];
        while (stack2.length > 0) {
          const cur = stack2.pop()!;
          for (const t of succ.get(cur) ?? []) {
            if (!localSeen.has(t)) {
              localSeen.add(t);
              stack2.push(t);
            }
          }
        }
        return localSeen.has(edge.from);
      });
      const anyRetryable = body.some((id) => {
        const node = nodes[id];
        if (!node) return false;
        const backend = backendOf(node, defaults);
        const cap = capabilities[backend] ?? capabilities["control-plane"];
        return cap?.retryable ?? false;
      });
      if (!anyRetryable) {
        findings.push({ code: "LM-VAL-009", path: `edges.${edge.id}`, message: "retry edge body contains no node on a retryable backend" });
      }
    }

    // LM-VAL-010: exactly one node routes into the edge, and it is `from`.
    const routers = routesIntoEdge.get(edge.id) ?? [];
    if (routers.length === 0) {
      findings.push({ code: "LM-VAL-010", path: `edges.${edge.id}`, message: "retry edge is never routed to by any next / then / else / onFailure" });
    } else if (routers.length > 1) {
      findings.push({
        code: "LM-VAL-010",
        path: `edges.${edge.id}`,
        message: `retry edge is routed to by more than one node (${routers.join(", ")})`,
      });
    } else if (routers[0] !== edge.from) {
      findings.push({
        code: "LM-VAL-010",
        path: `edges.${edge.id}`,
        message: `from is "${edge.from}" but the node routing into the edge is "${routers[0]}"`,
      });
    }

    // LM-VAL-025: the edge's own maxIterations must not exceed the loop-wide cap.
    const cap = file.budget?.maxIterations;
    if (cap !== undefined && edge.maxIterations > cap) {
      findings.push({
        code: "LM-VAL-025",
        path: `edges.${edge.id}`,
        message: `maxIterations ${edge.maxIterations} exceeds budget.maxIterations cap ${cap}`,
      });
    }
  }
}

// --- LM-VAL-014 (dominance) ----------------------------------------------------------------------

function dominanceRule(file: LoopFile, dom: Map<string, Set<string>>, findings: Finding[]): void {
  const nodes = file.nodes;
  for (const [id, node] of Object.entries(nodes)) {
    const inputs = raw(node).inputs ?? {};
    for (const [local, spec] of Object.entries(inputs)) {
      const refText = refTextOf(spec);
      let ref: Reference;
      try {
        ref = parseReference(refText);
      } catch {
        continue; // already reported as LM-VAL-013
      }
      if (ref.kind !== "node") continue;
      if (!nodes[ref.nodeId] || ref.nodeId === id) continue;
      if (!dom.get(id)?.has(ref.nodeId)) {
        findings.push({
          code: "LM-VAL-014",
          path: `nodes.${id}.inputs.${local}`,
          message: `"${ref.nodeId}" does not run on every path from the entry node to "${id}"`,
        });
      }
    }
  }
}

// --- LM-VAL-023 (approval gate) -------------------------------------------------------------------

function approvalRule(file: LoopFile, dom: Map<string, Set<string>>, findings: Finding[]): void {
  const nodes = file.nodes;
  const ids = Object.keys(nodes);
  const policy = file.approval?.policy ?? "gated";
  const exempt = new Set(file.approval?.nodes ?? (policy === "auto" ? ids : []));
  for (const [id, node] of Object.entries(nodes)) {
    if (raw(node).effects !== "external") continue;
    if (policy === "auto" && exempt.has(id)) continue;
    const gated = [...(dom.get(id) ?? [])].some((d) => nodes[d]?.kind === "human");
    if (!gated) {
      findings.push({
        code: "LM-VAL-023",
        path: `nodes.${id}`,
        message: "effects: external but no human node runs on every path from the entry node to it (and it is not exempted by approval.policy: auto)",
      });
    }
  }
}

// --- LM-VAL-026 (schedule vs. minInterval) -------------------------------------------------------

function scheduleRule(file: LoopFile, findings: Finding[]): void {
  if (file.trigger.kind !== "schedule" || !file.budget?.minInterval) return;
  const minSeconds = parseIsoDuration(file.budget.minInterval) / 1000;
  const everySeconds = cronMinSpacingSeconds(file.trigger.cron);
  if (everySeconds !== null && everySeconds < minSeconds) {
    findings.push({
      code: "LM-VAL-026",
      path: "trigger.cron",
      message: `schedule can fire every ${everySeconds}s but budget.minInterval is ${minSeconds}s`,
    });
  }
}

/** Coarse but honest (ported from `docs/spec/validate-examples.mjs`): only decides how often the
 * minute and hour fields allow a firing. Anything more precise belongs in the engine's own
 * scheduler reasoning, not in this static check. */
function cronMinSpacingSeconds(cron: string): number | null {
  const fields = cron.trim().split(/\s+/);
  const minute = fields[0] ?? "*";
  const hour = fields[1] ?? "*";
  const countField = (field: string, size: number): number => {
    if (field === "*") return size;
    const step = /^\*\/(\d+)$/.exec(field);
    if (step) return Math.ceil(size / Number(step[1]));
    return field.split(",").length;
  };
  const perHour = countField(minute, 60);
  const hours = countField(hour, 24);
  if (perHour > 1) return Math.floor(3600 / perHour);
  if (hours > 1) return Math.floor(86400 / hours);
  return 86400;
}
