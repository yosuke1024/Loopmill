import { test } from "node:test";
import assert from "node:assert/strict";
import { addMs, formatRfc3339, isRfc3339, parseRfc3339 } from "../../src/util/time.ts";

test("parseRfc3339 / formatRfc3339: round-trip a UTC timestamp", () => {
  const s = "2026-09-06T09:41:12.740Z";
  assert.equal(formatRfc3339(parseRfc3339(s)), s);
});

test("parseRfc3339: known epoch-millisecond value", () => {
  assert.equal(parseRfc3339("2026-09-06T09:04:11.000Z"), 1_788_685_451_000);
});

test("parseRfc3339: a numeric offset normalises to the same instant in UTC", () => {
  const withOffset = parseRfc3339("2026-09-06T18:41:12.740+09:00");
  const withZ = parseRfc3339("2026-09-06T09:41:12.740Z");
  assert.equal(withOffset, withZ);
  assert.equal(formatRfc3339(withOffset), "2026-09-06T09:41:12.740Z");
});

test("parseRfc3339: a negative offset normalises too", () => {
  const withOffset = parseRfc3339("2026-09-06T04:41:12.740-05:00");
  assert.equal(formatRfc3339(withOffset), "2026-09-06T09:41:12.740Z");
});

test("formatRfc3339: always renders millisecond precision and a trailing Z", () => {
  const out = formatRfc3339(0);
  assert.equal(out, "1970-01-01T00:00:00.000Z");
  assert.match(out, /\.\d{3}Z$/);
});

test("isRfc3339: true for well-formed timestamps, false for garbage", () => {
  assert.equal(isRfc3339("2026-09-06T09:41:12.740Z"), true);
  assert.equal(isRfc3339("2026-09-06T09:41:12+09:00"), true);
  assert.equal(isRfc3339("not-a-date"), false);
  assert.equal(isRfc3339("2026-09-06"), false); // date only, no time
  assert.equal(isRfc3339("2026-09-06T09:41:12"), false); // missing offset
});

test("parseRfc3339: throws on garbage input", () => {
  assert.throws(() => parseRfc3339("not-a-date"));
  assert.throws(() => parseRfc3339(""));
  assert.throws(() => parseRfc3339("2026-09-06T09:41:12"));
});

test("addMs: adds (and subtracts) milliseconds", () => {
  assert.equal(addMs(1000, 500), 1500);
  assert.equal(addMs(1000, -500), 500);
});
