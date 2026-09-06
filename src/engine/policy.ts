// Engine policy defaults, loaded from `docs/spec/state-machine.json`'s `policyDefaults`
// (docs/design/m1-plan.md §2 decision 5: the schemas are read from `docs/spec/` at run time,
// not copied). Mirrors the pattern `loop-file/schema.ts` and `envelope/schema.ts` already use:
// resolve the path relative to this module, read once, memoise.
//
// P-1 note: `readFileSync` here is a one-time, memoised load at (or before) first use, not a
// per-call I/O — the same allowance `docs/spec/state-machine.md` §5.2 P-1 grants
// `loadStateMachineJson` explicitly ("may read the file once at module init"). Nothing under
// `transition`/`fold`/`classify`/`preDispatch`/`route` calls `readFileSync` itself; they only
// read the cached object this module returns.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnginePolicy } from "../types/state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the normative machine-readable spec, resolved relative to this module so it
 * is found the same way whether the package runs from `src/` or from the built `dist/` (both
 * sit two directories under the package root; `docs/spec/state-machine.json` ships in
 * package.json's `files`). */
export const STATE_MACHINE_JSON_PATH: string = join(HERE, "..", "..", "docs", "spec", "state-machine.json");

/**
 * The slice of `state-machine.json` the engine actually reads. Deliberately loose (`unknown`
 * fallbacks) beyond the fields this package consumes — `classify.ts` (`quotaPatterns`,
 * `classifyFailureOrder`), `budget.ts` (`preDispatchOrder`, `machines.run.states.*.clock`),
 * `policy.ts` (`policyDefaults`) and the test suite's I-30-in-spirit meta-test
 * (`transitions.run/nodeExecution/attempt[].id`) — rather than a full transcription of the
 * document's shape, which is `docs/spec/state-machine.md` §4's business, not a TypeScript
 * interface's.
 */
export interface StateMachineJson {
  schemaVersion: string;
  specVersion: string;
  policyDefaults: {
    maxAttempts: number;
    maxIterationsRequired: boolean;
    maxRuntimeMs: number;
    maxStepsPerRun: number;
    maxQuotaParks: number;
    dispatchGraceSeconds: number;
    leaseExtensionSeconds: number;
    pendingGraceSeconds: number;
    quotaJitterSeconds: number;
    noProgressStreakLimit: number;
    casPushRetries: number;
  };
  enums: Record<string, unknown>;
  quotaPatterns: Record<
    string,
    {
      positive: string[];
      negative: string[];
      resetSuffix?: string;
      resetSource?: string;
      derivedWindowSeconds?: Record<string, number>;
    }
  >;
  preDispatchOrder: Array<{ step: number; check: string; outcome: string }>;
  classifyFailureOrder: Array<{ order: number; result: string; condition: string }>;
  machines: {
    run: { states: Record<string, { clock?: "active" | "wait"; terminal: boolean }> };
    nodeExecution: { states: Record<string, { terminal: boolean }> };
    attempt: { states: Record<string, { terminal: boolean }> };
  };
  transitions: {
    run: Array<{ id: string; [key: string]: unknown }>;
    nodeExecution: Array<{ id: string; [key: string]: unknown }>;
    attempt: Array<{ id: string; [key: string]: unknown }>;
  };
  [key: string]: unknown;
}

let cached: StateMachineJson | undefined;

/** Reads and parses `state-machine.json` once, memoised thereafter (P-1: the one file read the
 * spec explicitly allows at "module init"). */
export function loadStateMachineJson(): StateMachineJson {
  if (!cached) {
    const text = readFileSync(STATE_MACHINE_JSON_PATH, "utf8");
    cached = JSON.parse(text) as StateMachineJson;
  }
  return cached;
}

/**
 * `EnginePolicy` (state.ts §5.1) plus the additional engine defaults the spec names outside that
 * interface: `heartbeatSeconds` (§10.1, default 30 — not present in `state-machine.json`'s
 * `policyDefaults` at all; **report**: the JSON should probably gain it), `leaseExtensionSeconds`
 * (D-12), `pendingGraceSeconds` (D-22) and `noProgressStreakLimit` (§6.6). The last of these
 * duplicates `EnginePolicy.convergenceLimit` in value — `state.ts` names the NO_PROGRESS streak
 * threshold `convergenceLimit`, `state-machine.json` names the same default `noProgressStreakLimit`
 * — kept as two fields here (not aliased via a getter) so `EnginePolicyFull` is a plain,
 * JSON-serialisable object; `DEFAULT_POLICY_FULL` below guarantees the two never disagree.
 * `transition()` itself is typed against the narrower `EnginePolicy` (`TransitionContext.policy`)
 * and reads `policy.convergenceLimit`, never `noProgressStreakLimit` — this extra field exists for
 * spec-name fidelity and for whatever future engine code needs the sweep-facing defaults.
 * **Decision (not in sheet), m1.**
 */
export interface EnginePolicyFull extends EnginePolicy {
  heartbeatSeconds: number;
  leaseExtensionSeconds: number;
  pendingGraceSeconds: number;
  noProgressStreakLimit: number;
}

/** `EnginePolicy` populated from `state-machine.json`'s `policyDefaults` (state-machine.md §5.1's
 * comment: "engine defaults: maxAttempts, dispatchGraceSeconds, convergenceLimit, maxQuotaParks,
 * maxStepsPerRun, quotaJitterSeconds"). */
export const DEFAULT_POLICY: EnginePolicy = buildDefaultPolicy();

/** `DEFAULT_POLICY` plus the extra defaults named above. `heartbeatSeconds` is not present in
 * `state-machine.json`; its value (30) is transcribed from state-machine.md §10.1's prose ("The
 * running `loopmill run` process refreshes `heartbeatAt` every `policy.heartbeatSeconds` (default
 * 30 s)") since the JSON has no field to read it from — **report**. */
export const DEFAULT_POLICY_FULL: EnginePolicyFull = buildDefaultPolicyFull();

function buildDefaultPolicy(): EnginePolicy {
  const { policyDefaults } = loadStateMachineJson();
  return {
    maxAttempts: policyDefaults.maxAttempts,
    dispatchGraceSeconds: policyDefaults.dispatchGraceSeconds,
    convergenceLimit: policyDefaults.noProgressStreakLimit,
    maxQuotaParks: policyDefaults.maxQuotaParks,
    maxStepsPerRun: policyDefaults.maxStepsPerRun,
    quotaJitterSeconds: policyDefaults.quotaJitterSeconds,
  };
}

function buildDefaultPolicyFull(): EnginePolicyFull {
  const { policyDefaults } = loadStateMachineJson();
  return {
    ...buildDefaultPolicy(),
    heartbeatSeconds: 30,
    leaseExtensionSeconds: policyDefaults.leaseExtensionSeconds,
    pendingGraceSeconds: policyDefaults.pendingGraceSeconds,
    noProgressStreakLimit: policyDefaults.noProgressStreakLimit,
  };
}
