// The Loop file: the raw document exactly as docs/spec/loop-file.schema.json defines it, and
// the loop after loading (docs/spec/loop-file.md §4-§8, §12). No logic: resolution (applying
// defaults, deriving `entry`, normalising inputs) belongs to the `loop-file/` module.

import type { AuthMode, RuntimeId } from "./capabilities.ts";

/** A JSON scalar: what Loopmill substitutes and what a reference resolves to (loop-file.md §9.1). */
export type JsonScalar = string | number | boolean | null;

/** Any JSON value (loop-file.md §8.1 `structuredOutput`, and generally). */
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------------------------
// Shared enums (loop-file.schema.json `$defs`)
// ---------------------------------------------------------------------------------------------

/**
 * loop-file.schema.json `$defs.backendId`: local | fake | github-actions. Distinct from
 * `capabilities.BackendId`, which additionally carries the `control-plane` pseudo-backend that
 * a loop file never names directly (mvp-design.md §6.2).
 */
export type LoopFileBackendId = "local" | "fake" | "github-actions";

/** loop-file.schema.json `$defs.permissionProfile`. Default `workspace` (loop-file.md §8.1). */
export type PermissionProfile = "readonly" | "workspace" | "full";

/** loop-file.schema.json `$defs.isolation`. Default `worktree` (loop-file.md §6.2). */
export type Isolation = "ephemeral" | "worktree" | "shared";

/** loop-file.schema.json `$defs.effects`. Default `none` (loop-file.md §8.0). */
export type Effects = "none" | "external";

/** loop-file.schema.json `$defs.onFailure`. Default `fail_run` (loop-file.md §8.0). */
export type OnFailure = "fail_run" | "continue" | `retry_edge:${string}`;

/** loop-file.schema.json `humanNode.properties.mode`. Same value set as `state.ts`'s `GateMode`. */
export type HumanMode = "cli" | "label" | "pull-request-review";

// ---------------------------------------------------------------------------------------------
// Trigger (loop-file.md §5)
// ---------------------------------------------------------------------------------------------

export type Trigger =
  | { kind: "manual" }
  | { kind: "schedule"; cron: string; tz?: string }
  // Reserved: rejected by validation (LM-VAL-029). Kept in the schema for forward compatibility.
  | { kind: "event"; source: "github"; types: string[] };

// ---------------------------------------------------------------------------------------------
// Repos, defaults, budget, env, approval (loop-file.md §6-§7)
// ---------------------------------------------------------------------------------------------

/** loop-file.md §6.1. Exactly one of `path` / `remote` is present (LM-VAL-001, schema `oneOf`);
 * not encoded at the type level — validation belongs to `loop-file/`. */
export interface Repo {
  id: string;
  path?: string;
  remote?: string;
  defaultBase: string;
}

/** loop-file.md §6.2. Every value is inherited by nodes that do not set it. */
export interface Defaults {
  backend?: LoopFileBackendId;
  runtime?: RuntimeId;
  authMode?: AuthMode;
  permissionProfile?: PermissionProfile;
  isolation?: Isolation;
}

/** loop-file.md §7. Every field's default is documented there; `budget` itself is optional. */
export interface Budget {
  maxAttempts?: number; // default 2
  maxIterations?: number; // no default: a loop-wide cap on every Retry Edge's own value
  maxRuntime?: string; // ISO-8601 duration; default PT4H
  maxMeasuredTokens?: number; // no default
  maxUnmeasuredExecutions?: number; // default 0
  maxRunsPerWindow?: { count: number; window: string }; // default {count: 1, window: PT5H}
  minInterval?: string; // ISO-8601 duration; default PT1H
}

/** loop-file.md §6.3. Additive to the built-in deny/preserve lists, which always apply. */
export interface EnvPolicy {
  deny?: string[];
  preserve?: string[];
  inject?: Record<string, string>;
}

/** loop-file.md §6.4. */
export interface Approval {
  policy?: "gated" | "auto"; // default gated
  reason?: string; // required when policy is "auto" (LM-VAL-024)
  nodes?: string[];
}

// ---------------------------------------------------------------------------------------------
// Inputs and references (loop-file.md §9)
// ---------------------------------------------------------------------------------------------

/** loop-file.md §9: a map from local name to either the short form (a bare reference) or the
 * long form (`{ from, default? }`). */
export type InputRef = string | { from: string; default?: JsonScalar };
export type Inputs = Record<string, InputRef>;

// ---------------------------------------------------------------------------------------------
// Nodes (loop-file.md §8)
// ---------------------------------------------------------------------------------------------

/** loop-file.md §8.1: a JSON Schema describing the agent's final answer. The one place the
 * schema allows unknown keywords, since it is a foreign document Loopmill hands to the runtime
 * rather than interprets. */
export interface StructuredOutputSchema {
  type: "object";
  properties?: Record<string, JsonValue>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface AgentNode {
  kind: "agent";
  /** Optional echo of the map key; when present it MUST equal the key (LM-VAL-004). */
  id?: string;
  runtime?: RuntimeId;
  backend?: LoopFileBackendId;
  auth?: AuthMode;
  model?: string;
  permissionProfile?: PermissionProfile;
  sessionPolicy?: "fresh";
  /** Exactly one of `prompt` / `promptFile` (LM-VAL-027); not encoded at the type level. */
  prompt?: string;
  promptFile?: string;
  structuredOutput?: StructuredOutputSchema;
  inputs?: Inputs;
  timeout?: string;
  onFailure?: OnFailure;
  effects?: Effects;
  next?: string;
}

export interface CommandNode {
  kind: "command";
  id?: string;
  backend?: LoopFileBackendId;
  argv: string[];
  cwd?: string;
  env?: string[];
  inputs?: Inputs;
  timeout?: string;
  onFailure?: OnFailure;
  effects?: Effects;
  next?: string;
}

export interface ConditionNode {
  kind: "condition";
  id?: string;
  /** Required and MUST be non-empty (loop-file.md §8.3). */
  inputs: Inputs;
  expr: string;
  then: string;
  else: string;
}

export interface HumanNode {
  kind: "human";
  id?: string;
  mode: HumanMode;
  /** `nodes.<id>`. Defaults to the Run's most recent Issue or PR; meaningless for `mode: cli`. */
  target?: string;
  /** `nodes.<id>`: the Node Execution whose artifact digest is being approved. */
  subject: string;
  timeout?: string;
  onFailure?: OnFailure;
  next?: string;
}

export interface EndNode {
  kind: "end";
  id?: string;
  outcome: string;
}

export type NodeSpec = AgentNode | CommandNode | ConditionNode | HumanNode | EndNode;

/** loop-file.md §12: the one kind of backward edge. Reused verbatim for the resolved shape
 * (`ResolvedLoop.edges`), since resolution only changes how edges are keyed (array -> map by
 * `id`), never their fields. */
export interface RetryEdge {
  id: string;
  from: string;
  to: string;
  when?: string;
  maxIterations: number;
}

// ---------------------------------------------------------------------------------------------
// LoopFile: the raw document (loop-file.md §4)
// ---------------------------------------------------------------------------------------------

export interface LoopFile {
  schemaVersion: string;
  slug: string;
  name: string;
  description?: string;
  entry?: string;
  trigger: Trigger;
  repos: Repo[];
  defaults?: Defaults;
  budget?: Budget;
  env?: EnvPolicy;
  approval?: Approval;
  nodes: Record<string, NodeSpec>;
  edges?: RetryEdge[];
}

// ---------------------------------------------------------------------------------------------
// ResolvedLoop: the loop after loading (defaults applied, entry derived)
// ---------------------------------------------------------------------------------------------

/** `inputs` normalised to the long form only, after resolution. */
export type ResolvedInputs = Record<string, { from: string; default?: JsonScalar }>;

export interface ResolvedAgentNode {
  kind: "agent";
  id: string;
  runtime: RuntimeId;
  backend: LoopFileBackendId;
  auth: AuthMode;
  model?: string;
  permissionProfile: PermissionProfile;
  sessionPolicy: "fresh";
  prompt?: string;
  promptFile?: string;
  structuredOutput?: StructuredOutputSchema;
  inputs: ResolvedInputs;
  timeout?: string; // ISO-8601 duration; absent iff the node declares no timeout
  timeoutMs?: number;
  onFailure: OnFailure;
  effects: Effects;
  next?: string;
}

export interface ResolvedCommandNode {
  kind: "command";
  id: string;
  backend: LoopFileBackendId;
  argv: string[];
  cwd: string; // resolved: repo root ('.') when the node did not set one
  env: string[] | null; // null when the node did not set one (no further restriction); [] is an explicit empty allowlist
  inputs: ResolvedInputs;
  timeout?: string;
  timeoutMs?: number;
  onFailure: OnFailure;
  effects: Effects;
  next?: string;
}

export interface ResolvedConditionNode {
  kind: "condition";
  id: string;
  inputs: ResolvedInputs;
  expr: string;
  then: string;
  else: string;
}

export interface ResolvedHumanNode {
  kind: "human";
  id: string;
  mode: HumanMode;
  target?: string;
  subject: string;
  timeout?: string;
  timeoutMs?: number;
  onFailure: OnFailure;
  next?: string;
}

export interface ResolvedEndNode {
  kind: "end";
  id: string;
  outcome: string;
}

export type ResolvedNode =
  | ResolvedAgentNode
  | ResolvedCommandNode
  | ResolvedConditionNode
  | ResolvedHumanNode
  | ResolvedEndNode;

/** loop-file.md §7, every field resolved to its effective value. Durations are carried as both
 * the ISO-8601 string and its millisecond equivalent, matching `ResolvedNode.timeout`/`timeoutMs`. */
export interface ResolvedBudget {
  maxAttempts: number; // default 2
  maxIterations?: number; // no default: absent iff no Retry Edge budget is capped loop-wide
  maxRuntime: string; // default PT4H
  maxRuntimeMs: number;
  maxMeasuredTokens?: number; // no default
  maxUnmeasuredExecutions: number; // default 0
  maxRunsPerWindow: { count: number; window: string; windowMs: number }; // default {1, PT5H}
  minInterval: string; // default PT1H
  minIntervalMs: number;
}

/** loop-file.md §6.3, with the built-in vendor-auth deny list and the built-in preserve list
 * merged in alongside whatever the loop file added. */
export interface ResolvedEnvPolicy {
  deny: string[];
  preserve: string[];
  inject: Record<string, string>;
}

export interface ResolvedApproval {
  policy: "gated" | "auto"; // default gated
  reason?: string;
  nodes?: string[];
}

export interface ResolvedLoop {
  slug: string;
  name: string;
  /** sha256 of the canonicalised loop file (loop-file.md §3). */
  loopVersion: `sha256:${string}`;
  /** Derived when the loop file omits `entry` (loop-file.md §4.2). */
  entry: string;
  nodes: Record<string, ResolvedNode>;
  edges: Record<string, RetryEdge>;
  budget: ResolvedBudget;
  env: ResolvedEnvPolicy;
  approval: ResolvedApproval;
  trigger: Trigger;
  repos: Repo[];
}
