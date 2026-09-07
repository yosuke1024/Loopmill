// docs/spec/usage-normalization.md §4.3 (the display contract's examples) and §4.2 (the
// percentage floor and its [1, 99] clamp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMeasuredTokens, renderCoverage, formatWithCommas, effectiveTokens } from "../../src/usage/render.ts";
import type { Coverage } from "../../src/types/usage.ts";

function coverage(measured: number, total: number): Coverage {
  return { agentExecutions: total, measuredExecutions: measured, coverage: total === 0 ? 0 : measured / total, unmeasured: [] };
}

test("formatWithCommas: thousands separators", () => {
  assert.equal(formatWithCommas(1_171_000), "1,171,000");
  assert.equal(formatWithCommas(0), "0");
  assert.equal(formatWithCommas(946_682), "946,682");
});

test("renderMeasuredTokens: §4.3 example, 7/8 coverage renders a trailing +", () => {
  assert.equal(renderMeasuredTokens(1_171_000, coverage(7, 8)), "1,171,000+");
});

test("renderMeasuredTokens: 100% coverage renders with no marker at all", () => {
  assert.equal(renderMeasuredTokens(946_682, coverage(1, 1)), "946,682");
});

test("renderMeasuredTokens: a scope with 0/n coverage and nothing reported renders 0+", () => {
  assert.equal(renderMeasuredTokens(0, coverage(0, 1)), "0+");
});

test("renderMeasuredTokens: a reported-but-incomplete record still renders its figure as a lower bound (claude-recorded-sigint.json)", () => {
  assert.equal(renderMeasuredTokens(928, coverage(0, 1)), "928+");
});

test("renderMeasuredTokens: a scope with no agent executions at all renders with no marker (vacuous 100%)", () => {
  assert.equal(renderMeasuredTokens(0, coverage(0, 0)), "0");
});

test("renderCoverage: §4.3 example 7/8 (87%)", () => {
  assert.equal(renderCoverage(coverage(7, 8)), "7/8 (87%)");
});

test("renderCoverage: 0/1 (0%)", () => {
  assert.equal(renderCoverage(coverage(0, 1)), "0/1 (0%)");
});

test("renderCoverage: 1/1 (100%), 2/2 (100%)", () => {
  assert.equal(renderCoverage(coverage(1, 1)), "1/1 (100%)");
  assert.equal(renderCoverage(coverage(2, 2)), "2/2 (100%)");
});

test("renderCoverage: §4.2 clamp — 0 < p < 1 rounds up to 1%, never displays as 0%", () => {
  // floor(100 * 1 / 1000) = 0, but measured>0 so it must clamp to the [1, 99] floor, not 0%.
  assert.equal(renderCoverage(coverage(1, 1000)), "1/1000 (1%)");
});

test("renderCoverage: §4.2 clamp — 99 < p < 100 rounds down to 99%, never displays as 100%", () => {
  // floor(100 * 999 / 1000) = 99 already, but 999/1000 must never read as 100% (measured !== total).
  assert.equal(renderCoverage(coverage(999, 1000)), "999/1000 (99%)");
});

test("effectiveTokens: docs/spec/usage-normalization.md §7.3 worked example, profile loopmill-eq-v1", () => {
  // 486,210 + 21,442*1.25 + 420,102*0.1 + 18,928*1.0 = 573,950.7 -> 573,951 (claude-success.json).
  const result = effectiveTokens({
    freshInputTokens: 486_210,
    cacheWriteTokens: 21_442,
    cacheReadTokens: 420_102,
    outputTokens: 18_928,
  });
  assert.equal(result.value, 573_951);
  assert.equal(result.weightingProfileId, "loopmill-eq-v1");
  assert.equal(result.unit, "eq");
  assert.equal(result.provenance, "estimated");
});

test("effectiveTokens: a custom profile is honoured and labelled by its own id", () => {
  const result = effectiveTokens(
    { freshInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 },
    { id: "custom-profile", write: 2, read: 0.2, output: 5 },
  );
  assert.equal(result.value, 100 * 1.0 + 0 * 2 + 0 * 0.2 + 10 * 5);
  assert.equal(result.weightingProfileId, "custom-profile");
});
