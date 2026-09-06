// ISO-8601 duration helpers, restricted to the subset `loop-file.schema.json`'s `duration`
// $def allows: `P[nD]T[nH][nM][nS]`, integer or decimal seconds (docs/spec/loop-file.md §7.3).
// Years, months and weeks are rejected because they are not a fixed number of seconds.

import { LoopmillError } from "./errors.ts";

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DATE_PART_RE = /^(\d+)D$/;
const TIME_PART_RE = /^(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/;
const UNSUPPORTED_DESIGNATOR_RE = /[YMW]/;

/**
 * Parses a duration of the form `P[nD]T[nH][nM][nS]` (days, hours, minutes, seconds only) to
 * milliseconds. Throws `LoopmillError` with a code naming the specific problem: an unsupported
 * designator (years/months/weeks) gets its own code and a message that says so, since it is
 * the mistake this restricted grammar exists to catch loudly rather than silently mis-parse.
 */
export function parseIsoDuration(s: string): number {
  if (typeof s !== "string" || s.length === 0 || s[0] !== "P") {
    throw new LoopmillError("invalid_duration", `not an ISO-8601 duration: ${JSON.stringify(s)}`);
  }
  const body = s.slice(1);
  const splitIndex = body.indexOf("T");
  const datePart = splitIndex === -1 ? body : body.slice(0, splitIndex);
  const timePart = splitIndex === -1 ? "" : body.slice(splitIndex + 1);
  if (splitIndex !== -1 && timePart.length === 0) {
    // A bare trailing "T" with nothing after it names no unit at all.
    throw new LoopmillError("invalid_duration", `not an ISO-8601 duration: ${JSON.stringify(s)}`);
  }

  let ms = 0;
  let matchedAnything = false;

  if (datePart.length > 0) {
    const dateMatch = DATE_PART_RE.exec(datePart);
    if (dateMatch) {
      ms += Number(dateMatch[1]) * MS_PER_DAY;
      matchedAnything = true;
    } else if (UNSUPPORTED_DESIGNATOR_RE.test(datePart)) {
      throw new LoopmillError(
        "unsupported_duration_designator",
        `duration ${JSON.stringify(s)} uses years, months or weeks, which are not a fixed ` +
          "number of seconds; only days (D), hours (H), minutes (M) and seconds (S) are supported",
      );
    } else {
      throw new LoopmillError("invalid_duration", `not an ISO-8601 duration: ${JSON.stringify(s)}`);
    }
  }

  if (timePart.length > 0) {
    const timeMatch = TIME_PART_RE.exec(timePart);
    const hours = timeMatch?.[1];
    const minutes = timeMatch?.[2];
    const seconds = timeMatch?.[3];
    if (!timeMatch || (!hours && !minutes && !seconds)) {
      if (UNSUPPORTED_DESIGNATOR_RE.test(timePart.replace(/[HMS0-9.]/g, ""))) {
        throw new LoopmillError(
          "unsupported_duration_designator",
          `duration ${JSON.stringify(s)} uses an unsupported time designator; only hours (H), ` +
            "minutes (M) and seconds (S) are supported",
        );
      }
      throw new LoopmillError("invalid_duration", `not an ISO-8601 duration: ${JSON.stringify(s)}`);
    }
    if (hours) ms += Number(hours) * MS_PER_HOUR;
    if (minutes) ms += Number(minutes) * MS_PER_MINUTE;
    if (seconds) ms += Number(seconds) * MS_PER_SECOND;
    matchedAnything = true;
  }

  if (!matchedAnything) {
    throw new LoopmillError("invalid_duration", `not an ISO-8601 duration: ${JSON.stringify(s)}`);
  }
  return ms;
}

/** Formats milliseconds as the smallest `P[nD]T[nH][nM][nS]` duration string that round-trips. */
export function formatIsoDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new LoopmillError(
      "invalid_duration",
      `not a representable duration in milliseconds: ${String(ms)}`,
    );
  }
  if (ms === 0) {
    return "PT0S";
  }

  let remaining = ms;
  const days = Math.floor(remaining / MS_PER_DAY);
  remaining -= days * MS_PER_DAY;
  const hours = Math.floor(remaining / MS_PER_HOUR);
  remaining -= hours * MS_PER_HOUR;
  const minutes = Math.floor(remaining / MS_PER_MINUTE);
  remaining -= minutes * MS_PER_MINUTE;
  const seconds = remaining / MS_PER_SECOND;

  let out = "P";
  if (days > 0) out += `${days}D`;

  let timePart = "";
  if (hours > 0) timePart += `${hours}H`;
  if (minutes > 0) timePart += `${minutes}M`;
  if (seconds > 0) {
    const secondsStr = Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)));
    timePart += `${secondsStr}S`;
  }
  if (timePart.length > 0) out += `T${timePart}`;
  return out;
}
