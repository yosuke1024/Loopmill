import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIsoDuration, parseIsoDuration } from "../../src/util/duration.ts";
import { isLoopmillError } from "../../src/util/errors.ts";

test("parseIsoDuration: PT4H is 4 hours", () => {
  assert.equal(parseIsoDuration("PT4H"), 4 * 60 * 60 * 1000);
});

test("parseIsoDuration: PT15M is 15 minutes", () => {
  assert.equal(parseIsoDuration("PT15M"), 15 * 60 * 1000);
});

test("parseIsoDuration: PT12H is 12 hours", () => {
  assert.equal(parseIsoDuration("PT12H"), 12 * 60 * 60 * 1000);
});

test("parseIsoDuration: P1DT2H is 1 day and 2 hours", () => {
  assert.equal(parseIsoDuration("P1DT2H"), 26 * 60 * 60 * 1000);
});

test("parseIsoDuration: PT0.5S is half a second", () => {
  assert.equal(parseIsoDuration("PT0.5S"), 500);
});

test("parseIsoDuration: combined hours, minutes and seconds", () => {
  assert.equal(parseIsoDuration("PT1H30M15S"), (1 * 3600 + 30 * 60 + 15) * 1000);
});

test("parseIsoDuration: P1M (a month) throws with the unsupported-designator code", () => {
  assert.throws(() => parseIsoDuration("P1M"), (err: unknown) => {
    if (!isLoopmillError(err)) return false;
    assert.equal(err.code, "unsupported_duration_designator");
    return true;
  });
});

test("parseIsoDuration: years and weeks are also rejected as unsupported designators", () => {
  assert.throws(() => parseIsoDuration("P1Y"), (err: unknown) => {
    if (!isLoopmillError(err)) return false;
    assert.equal(err.code, "unsupported_duration_designator");
    return true;
  });
  assert.throws(() => parseIsoDuration("P1W"), (err: unknown) => {
    if (!isLoopmillError(err)) return false;
    assert.equal(err.code, "unsupported_duration_designator");
    return true;
  });
});

test("parseIsoDuration: garbage input is invalid_duration, not unsupported_duration_designator", () => {
  assert.throws(() => parseIsoDuration("not-a-duration"), (err: unknown) => {
    if (!isLoopmillError(err)) return false;
    assert.equal(err.code, "invalid_duration");
    return true;
  });
  assert.throws(() => parseIsoDuration("P"));
  assert.throws(() => parseIsoDuration("PT"));
  assert.throws(() => parseIsoDuration(""));
});

test("formatIsoDuration: exact string round-trip for every example from loop-file.md §7.3", () => {
  for (const s of ["PT4H", "PT15M", "PT12H", "P1DT2H", "PT0.5S"]) {
    assert.equal(formatIsoDuration(parseIsoDuration(s)), s);
  }
});

test("formatIsoDuration: the millisecond value round-trips even when the string form normalises", () => {
  // PT90S normalises to PT1M30S (formatIsoDuration always emits the largest units it can), but
  // the millisecond value it parses back to is unchanged.
  const ms = parseIsoDuration("PT90S");
  assert.equal(formatIsoDuration(ms), "PT1M30S");
  assert.equal(parseIsoDuration(formatIsoDuration(ms)), ms);
});

test("formatIsoDuration: zero is PT0S", () => {
  assert.equal(formatIsoDuration(0), "PT0S");
});

test("formatIsoDuration: rejects negative or non-finite durations", () => {
  assert.throws(() => formatIsoDuration(-1));
  assert.throws(() => formatIsoDuration(NaN));
  assert.throws(() => formatIsoDuration(Infinity));
});
