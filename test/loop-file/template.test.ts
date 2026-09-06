// `template.ts`: `${name}` templating (docs/spec/loop-file.md §10, §10.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { templatePlaceholders, renderTemplate, renderArgv } from "../../src/loop-file/template.ts";
import { isLoopmillError, LoopmillError } from "../../src/util/errors.ts";

// --- templatePlaceholders -------------------------------------------------------------------------

test("templatePlaceholders: names in order, duplicates included", () => {
  assert.deepEqual(templatePlaceholders("Fix ${issue_url}. Reviewer's finding: ${finding}."), ["issue_url", "finding"]);
  assert.deepEqual(templatePlaceholders("${a}${a}${b}"), ["a", "a", "b"]);
  assert.deepEqual(templatePlaceholders("no placeholders here"), []);
});

test('templatePlaceholders: "$${" is a literal "${" and contributes no placeholder', () => {
  assert.deepEqual(templatePlaceholders("$${literal} and ${real}"), ["real"]);
  assert.deepEqual(templatePlaceholders("$${a}$${b}"), []);
});

test("templatePlaceholders: an unterminated ${ throws template_invalid", () => {
  assert.throws(() => templatePlaceholders("abc ${unterminated"), (err: unknown) => {
    assert.ok(isLoopmillError(err));
    assert.equal((err as LoopmillError).code, "template_invalid");
    return true;
  });
});

// --- renderTemplate: scalar rendering per §10 ------------------------------------------------------

test("renderTemplate: strings render verbatim", () => {
  assert.equal(renderTemplate("hello ${name}", { name: "world" }), "hello world");
});

test("renderTemplate: numbers render in shortest round-trip form", () => {
  assert.equal(renderTemplate("n=${n}", { n: 3 }), "n=3");
  assert.equal(renderTemplate("n=${n}", { n: 3.5 }), "n=3.5");
  assert.equal(renderTemplate("n=${n}", { n: 0 }), "n=0");
});

test("renderTemplate: booleans render as true/false", () => {
  assert.equal(renderTemplate("ok=${ok}", { ok: true }), "ok=true");
  assert.equal(renderTemplate("ok=${ok}", { ok: false }), "ok=false");
});

test("renderTemplate: null renders as the literal text null", () => {
  assert.equal(renderTemplate("v=${v}", { v: null }), "v=null");
});

test('renderTemplate: "$${" renders as a literal "${", including the placeholder text after it', () => {
  assert.equal(renderTemplate("$${title}", {}), "${title}");
  assert.equal(renderTemplate("$${a} ${b}", { b: "B" }), "${a} B");
});

test("renderTemplate: an undeclared name throws template_unresolved, never an empty string", () => {
  assert.throws(() => renderTemplate("${missing}", {}), (err: unknown) => {
    assert.ok(isLoopmillError(err));
    assert.equal((err as LoopmillError).code, "template_unresolved");
    return true;
  });
});

test("renderTemplate: an unterminated ${ throws template_invalid", () => {
  assert.throws(() => renderTemplate("abc ${x", { x: "y" }), (err: unknown) => {
    assert.ok(isLoopmillError(err));
    assert.equal((err as LoopmillError).code, "template_invalid");
    return true;
  });
});

// --- renderArgv: the §10.1 argv binding rule -------------------------------------------------------

test("renderArgv: element count never changes", () => {
  const argv = ["gh", "issue", "create", "--title", "${title}", "--body", "${body}"];
  const out = renderArgv(argv, { title: "T", body: "B" });
  assert.equal(out.length, argv.length);
});

test("renderArgv: a value with spaces, quotes and a semicolon lands in exactly one argv element, unsplit and unparsed", () => {
  const dangerous = 'Fix "docs"; rm -rf /';
  const argv = ["gh", "issue", "create", "--title", "${title}", "--body", "static"];
  const out = renderArgv(argv, { title: dangerous });
  assert.equal(out.length, argv.length);
  assert.equal(out[4], dangerous);
  // Nothing else in the argv changed shape because of it.
  assert.deepEqual(
    out,
    ["gh", "issue", "create", "--title", dangerous, "--body", "static"],
  );
});

test("renderArgv: mixed elements (literal text plus one placeholder) render as one element", () => {
  const out = renderArgv(["--title=${title}"], { title: "T" });
  assert.deepEqual(out, ["--title=T"]);
});

test("renderArgv: an element with no placeholder passes through unchanged", () => {
  const out = renderArgv(["npm", "test"], {});
  assert.deepEqual(out, ["npm", "test"]);
});
