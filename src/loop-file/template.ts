// `${name}` templating (docs/spec/loop-file.md §10): the smallest thing that works. One
// construct, no functions, no filters, no conditionals; `$${` escapes a literal `${`.

import type { JsonScalar } from "../types/loop.ts";
import { LoopmillError } from "../util/errors.ts";

/**
 * Returns the placeholder names in `text`, in order, one entry per `${name}` occurrence
 * (duplicates included if a name is used more than once). `$${` is a literal `${` and
 * contributes no placeholder. Throws `LoopmillError` (code `template_invalid`) for an
 * unterminated `${`.
 */
export function templatePlaceholders(text: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "$" && text[i + 2] === "{") {
      i += 2;
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end === -1) {
        throw new LoopmillError("template_invalid", `unterminated "\${" placeholder at offset ${i}`);
      }
      names.push(text.slice(i + 2, end));
      i = end;
    }
  }
  return names;
}

/**
 * Renders `text`, substituting every `${name}` with `inputs[name]` rendered per §10: strings
 * verbatim, numbers in shortest round-trip form, booleans as `true`/`false`, `null` as `null`.
 * `$${` renders as a literal `${`. Throws `LoopmillError` for an unterminated `${`
 * (`template_invalid`) or a name that is not in `inputs` (`template_unresolved`) -- neither ever
 * becomes an empty string.
 */
export function renderTemplate(text: string, inputs: Record<string, JsonScalar>): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "$" && text[i + 2] === "{") {
      out += "${";
      i += 2;
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end === -1) {
        throw new LoopmillError("template_invalid", `unterminated "\${" placeholder at offset ${i}`);
      }
      const name = text.slice(i + 2, end);
      if (!Object.prototype.hasOwnProperty.call(inputs, name)) {
        throw new LoopmillError("template_unresolved", `\${${name}} is not a declared input`);
      }
      out += renderScalar(inputs[name] as JsonScalar);
      i = end;
      continue;
    }
    out += text[i];
  }
  return out;
}

function renderScalar(value: JsonScalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return value;
}

/**
 * Renders every element of `argv` per the §10.1 argv binding rule: the element count never
 * changes, and each `${name}` is substituted literally into place within its own element --
 * never split into more than one argv element, never re-parsed. This is a direct consequence of
 * substituting per-element with `renderTemplate` and never joining or re-splitting elements.
 */
export function renderArgv(argv: string[], inputs: Record<string, JsonScalar>): string[] {
  return argv.map((element) => renderTemplate(element, inputs));
}
