// Turns a validated `LoopFile` into a `ResolvedLoop`: `defaults` applied (§6.2), `entry` derived
// when omitted (§4.2), `inputs` normalised to the long form, edges indexed by id, the built-in
// env deny/preserve lists merged with the file's own (§6.3), budget defaults applied (§7),
// per-kind node defaults applied (§8), durations computed in milliseconds, and `loopVersion` set
// (`canonical.ts`). Pure: assumes `file` already passed `validateLoopDocument` (or the caller
// deliberately asked to resolve an invalid one and accepts the consequences below).

import type {
  Budget,
  Inputs,
  LoopFile,
  ResolvedApproval,
  ResolvedBudget,
  ResolvedEnvPolicy,
  ResolvedInputs,
  ResolvedLoop,
  ResolvedNode,
} from "../types/loop.ts";
import { LoopmillError } from "../util/errors.ts";
import { parseIsoDuration } from "../util/duration.ts";
import { buildGraph, findRoots } from "./graph.ts";
import { loopVersionOf } from "./canonical.ts";

/** The built-in vendor-auth deny list (docs/spec/loop-file.md §6.3; docs/design/mvp-design.md
 * §13.2), always applied and always winning over a file's own `preserve`. `GH_TOKEN` is included
 * here as denied-by-default: the exception ("...for every node whose `effects` is not
 * `external`") is per-node, resolved at dispatch time by the node executor (`backends/local.ts`,
 * not yet built) against the node's own resolved `effects` -- a loop-wide `ResolvedEnvPolicy` has
 * nowhere to encode a per-node conditional, so the executor is expected to let `GH_TOKEN` through
 * specifically when dispatching an `effects: external` node, overriding this default denial. */
export const BUILTIN_ENV_DENY: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_CONNECTORS_TOKEN",
  "GH_TOKEN",
];

/** The built-in preserve list (same sources). Neither document spells out the exact "proxy
 * variables" names; the conventional upper- and lower-case `*_PROXY` set is used here -- see the
 * report for this deviation. */
export const BUILTIN_ENV_PRESERVE: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
];

export function resolveLoop(file: LoopFile): ResolvedLoop {
  const entry = resolveEntry(file);
  const nodes = resolveNodes(file);
  const edges = resolveEdges(file);
  const budget = resolveBudget(file.budget);
  const env = resolveEnv(file);
  const approval: ResolvedApproval = {
    policy: file.approval?.policy ?? "gated",
    ...(file.approval?.reason !== undefined ? { reason: file.approval.reason } : {}),
    ...(file.approval?.nodes !== undefined ? { nodes: file.approval.nodes } : {}),
  };

  return {
    slug: file.slug,
    name: file.name,
    loopVersion: loopVersionOf(file),
    entry,
    nodes,
    edges,
    budget,
    env,
    approval,
    trigger: file.trigger,
    repos: file.repos,
  };
}

// --- entry (§4.2) -------------------------------------------------------------------------------

function resolveEntry(file: LoopFile): string {
  if (file.entry !== undefined) {
    if (!file.nodes[file.entry]) {
      throw new LoopmillError("loop_entry_invalid", `entry "${file.entry}" is not a node`);
    }
    return file.entry;
  }
  const { succ } = buildGraph(file);
  const roots = findRoots(Object.keys(file.nodes), succ);
  if (roots.length !== 1) {
    throw new LoopmillError(
      "loop_entry_ambiguous",
      `entry node cannot be derived: ${roots.length} nodes have no incoming forward edge`,
    );
  }
  return roots[0]!;
}

// --- inputs --------------------------------------------------------------------------------------

function resolveInputsField(inputs: Inputs | undefined): ResolvedInputs {
  const out: ResolvedInputs = {};
  for (const [name, spec] of Object.entries(inputs ?? {})) {
    if (typeof spec === "string") {
      out[name] = { from: spec };
    } else {
      out[name] = spec.default !== undefined ? { from: spec.from, default: spec.default } : { from: spec.from };
    }
  }
  return out;
}

// --- nodes (§8) ------------------------------------------------------------------------------------

function resolveNodes(file: LoopFile): Record<string, ResolvedNode> {
  const defaults = file.defaults ?? {};
  const out: Record<string, ResolvedNode> = {};

  for (const [id, node] of Object.entries(file.nodes)) {
    if (node.kind === "agent") {
      const runtime = node.runtime ?? defaults.runtime;
      const auth = node.auth ?? defaults.authMode;
      if (!runtime) throw new LoopmillError("loop_resolve_invalid", `nodes.${id}: no runtime declared and no defaults.runtime`);
      if (!auth) throw new LoopmillError("loop_resolve_invalid", `nodes.${id}: no auth declared and no defaults.authMode`);
      out[id] = {
        kind: "agent",
        id,
        runtime,
        backend: node.backend ?? defaults.backend ?? "local",
        auth,
        ...(node.model !== undefined ? { model: node.model } : {}),
        permissionProfile: node.permissionProfile ?? defaults.permissionProfile ?? "workspace",
        sessionPolicy: node.sessionPolicy ?? "fresh",
        ...(node.prompt !== undefined ? { prompt: node.prompt } : {}),
        ...(node.promptFile !== undefined ? { promptFile: node.promptFile } : {}),
        ...(node.structuredOutput !== undefined ? { structuredOutput: node.structuredOutput } : {}),
        inputs: resolveInputsField(node.inputs),
        ...timeoutFields(node.timeout),
        onFailure: node.onFailure ?? "fail_run",
        effects: node.effects ?? "none",
        ...(node.next !== undefined ? { next: node.next } : {}),
      };
      continue;
    }

    if (node.kind === "command") {
      out[id] = {
        kind: "command",
        id,
        backend: node.backend ?? defaults.backend ?? "local",
        argv: node.argv,
        cwd: node.cwd ?? ".",
        env: node.env ?? null,
        inputs: resolveInputsField(node.inputs),
        ...timeoutFields(node.timeout),
        onFailure: node.onFailure ?? "fail_run",
        effects: node.effects ?? "none",
        ...(node.next !== undefined ? { next: node.next } : {}),
      };
      continue;
    }

    if (node.kind === "condition") {
      out[id] = {
        kind: "condition",
        id,
        inputs: resolveInputsField(node.inputs),
        expr: node.expr,
        then: node.then,
        else: node.else,
      };
      continue;
    }

    if (node.kind === "human") {
      out[id] = {
        kind: "human",
        id,
        mode: node.mode,
        ...(node.target !== undefined ? { target: node.target } : {}),
        subject: node.subject,
        ...timeoutFields(node.timeout),
        onFailure: node.onFailure ?? "fail_run",
        ...(node.next !== undefined ? { next: node.next } : {}),
      };
      continue;
    }

    // end
    out[id] = { kind: "end", id, outcome: node.outcome };
  }

  return out;
}

function timeoutFields(timeout: string | undefined): { timeout?: string; timeoutMs?: number } {
  return timeout !== undefined ? { timeout, timeoutMs: parseIsoDuration(timeout) } : {};
}

// --- edges: array -> map by id (§12), fields unchanged -------------------------------------------

function resolveEdges(file: LoopFile): ResolvedLoop["edges"] {
  const out: ResolvedLoop["edges"] = {};
  for (const edge of file.edges ?? []) {
    out[edge.id] = edge;
  }
  return out;
}

// --- budget (§7) -----------------------------------------------------------------------------------

function resolveBudget(budget: Budget | undefined): ResolvedBudget {
  const maxRuntime = budget?.maxRuntime ?? "PT4H";
  const minInterval = budget?.minInterval ?? "PT1H";
  const window = budget?.maxRunsPerWindow?.window ?? "PT5H";
  return {
    maxAttempts: budget?.maxAttempts ?? 2,
    ...(budget?.maxIterations !== undefined ? { maxIterations: budget.maxIterations } : {}),
    maxRuntime,
    maxRuntimeMs: parseIsoDuration(maxRuntime),
    ...(budget?.maxMeasuredTokens !== undefined ? { maxMeasuredTokens: budget.maxMeasuredTokens } : {}),
    maxUnmeasuredExecutions: budget?.maxUnmeasuredExecutions ?? 0,
    maxRunsPerWindow: {
      count: budget?.maxRunsPerWindow?.count ?? 1,
      window,
      windowMs: parseIsoDuration(window),
    },
    minInterval,
    minIntervalMs: parseIsoDuration(minInterval),
  };
}

// --- env policy (§6.3) -----------------------------------------------------------------------------

function resolveEnv(file: LoopFile): ResolvedEnvPolicy {
  return {
    deny: mergeUnique(BUILTIN_ENV_DENY, file.env?.deny),
    preserve: mergeUnique(BUILTIN_ENV_PRESERVE, file.env?.preserve),
    inject: { ...(file.env?.inject ?? {}) },
  };
}

function mergeUnique(builtin: readonly string[], extra: string[] | undefined): string[] {
  const out = [...builtin];
  const seen = new Set(builtin);
  for (const name of extra ?? []) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
