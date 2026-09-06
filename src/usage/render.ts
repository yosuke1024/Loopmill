// The `+` rendering rules (docs/spec/usage-normalization.md §3.3), the coverage percentage
// contract (§4.2) and the optional weighted view (§5.1).

import type { Coverage } from "../types/usage.ts";

/** Thousands-separated integer, e.g. `1171000` -> `"1,171,000"`. */
export function formatWithCommas(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * §3.3: a sum is a lower bound whenever its scope's coverage is below 100%, and MUST carry a
 * trailing `+` immediately after the digits, with no space. At 100% coverage — including the
 * vacuous case of a scope with no agent executions at all — no marker is rendered; the absence of
 * `+` is itself a positive claim and MUST NOT be produced by rounding.
 */
export function renderMeasuredTokens(total: number, coverage: Coverage): string {
  const isFull = coverage.agentExecutions === 0 || coverage.measuredExecutions === coverage.agentExecutions;
  const formatted = formatWithCommas(total);
  return isFull ? formatted : `${formatted}+`;
}

/**
 * §4.2: `p = floor(100 * measured / total)`, clamped to `[1, 99]` whenever
 * `0 < measured < total`. `100%` only when `measured === total` (0/0 included, vacuously);
 * `0%` only when `measured === 0` (and total > 0).
 */
export function renderCoverage(coverage: Coverage): string {
  const { measuredExecutions: m, agentExecutions: n } = coverage;
  let percent: number;
  if (m === n) {
    percent = 100;
  } else if (m === 0) {
    percent = 0;
  } else {
    percent = Math.min(99, Math.max(1, Math.floor((100 * m) / n)));
  }
  return `${m}/${n} (${percent}%)`;
}

/** §5.1: the default weighting profile. `Wread`/`Wwrite` are fixed by the decision sheet; `Wout`
 * is a `Decision (not in sheet)` of 1.0 (no output re-weighting) so `effectiveTokens` is expressed
 * in input-token equivalents. */
export const DEFAULT_WEIGHTING_PROFILE_ID = "loopmill-eq-v1";

export interface WeightingProfile {
  id?: string;
  /** Weight on `cacheWriteTokens`. Default (per `loopmill-eq-v1`) 1.25. */
  write: number;
  /** Weight on `cacheReadTokens`. Default (per `loopmill-eq-v1`) 0.1. */
  read: number;
  /** Weight on `outputTokens`. Default (per `loopmill-eq-v1`, `Decision (not in sheet)`) 1.0. */
  output: number;
}

const DEFAULT_WEIGHTING_PROFILE: Required<WeightingProfile> = {
  id: DEFAULT_WEIGHTING_PROFILE_ID,
  write: 1.25,
  read: 0.1,
  output: 1.0,
};

export interface EffectiveTokensInput {
  freshInputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
}

export interface EffectiveTokensResult {
  value: number;
  weightingProfileId: string;
  unit: "eq";
  provenance: "estimated";
}

/**
 * §5.1: `effectiveTokens = fresh*1.0 + write*Wwrite + read*Wread + output*Wout`. Recomputed on
 * read from the four stored buckets (never persisted), always labelled `estimated`, always in
 * `eq` units and always carries the profile that produced it (I17). Accepts either a `UsageRecord`
 * or an `AggregateUsage` — both shapes carry the four bucket fields this needs.
 */
export function effectiveTokens(
  usage: EffectiveTokensInput,
  profile: WeightingProfile = DEFAULT_WEIGHTING_PROFILE,
): EffectiveTokensResult {
  const fresh = usage.freshInputTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const read = usage.cacheReadTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const value = fresh * 1.0 + write * profile.write + read * profile.read + output * profile.output;
  return {
    value: Math.round(value),
    weightingProfileId: profile.id ?? "custom",
    unit: "eq",
    provenance: "estimated",
  };
}
