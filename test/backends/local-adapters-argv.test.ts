// The two runtime adapters' argv builders (`src/backends/local/adapters/`). These strings decide
// what an agent is allowed to do on the operator's own machine, so each is pinned here against
// the CLI contract measured on 2026-09-07 (claude 2.1.263, codex-cli 0.153.4) — the versions
// `docs/spikes/README.md` §3 and §6 record.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClaudeArgv } from "../../src/backends/local/adapters/claude-code.ts";
import { buildCodexArgv } from "../../src/backends/local/adapters/codex.ts";
import type { PermissionProfile, ResolvedAgentNode, StructuredOutputSchema } from "../../src/types/loop.ts";

function agentNode(overrides: Partial<ResolvedAgentNode> = {}): ResolvedAgentNode {
  return {
    kind: "agent",
    id: "implement",
    runtime: "claude-code",
    backend: "local",
    auth: "subscription-oauth",
    permissionProfile: "workspace",
    sessionPolicy: "fresh",
    prompt: "do the thing",
    inputs: {},
    onFailure: "fail_run",
    effects: "none",
    ...overrides,
  };
}

/** Every index at which `flag` appears in `argv`. */
function indicesOf(argv: string[], flag: string): number[] {
  return argv.flatMap((a, i) => (a === flag ? [i] : []));
}

// ---------------------------------------------------------------------------------------------
// claude-code
// ---------------------------------------------------------------------------------------------

test("buildClaudeArgv: the invariant argv head is `claude -p <prompt> --output-format json`", () => {
  const argv = buildClaudeArgv(agentNode(), "PROMPT", null);
  assert.deepEqual(argv.slice(0, 5), ["claude", "-p", "PROMPT", "--output-format", "json"]);
});

const CLAUDE_PERMISSION_MODE: Record<PermissionProfile, string> = {
  readonly: "plan",
  workspace: "acceptEdits",
  full: "bypassPermissions",
};

for (const [profile, mode] of Object.entries(CLAUDE_PERMISSION_MODE) as [PermissionProfile, string][]) {
  test(`buildClaudeArgv: permissionProfile "${profile}" maps to --permission-mode ${mode}`, () => {
    const argv = buildClaudeArgv(agentNode({ permissionProfile: profile }), "P", null);
    const at = argv.indexOf("--permission-mode");
    assert.notEqual(at, -1, "--permission-mode must always be passed");
    assert.equal(argv[at + 1], mode);
  });
}

test("buildClaudeArgv: --permission-prompts none is always passed (nothing may prompt: stdin is /dev/null)", () => {
  for (const profile of ["readonly", "workspace", "full"] as PermissionProfile[]) {
    const argv = buildClaudeArgv(agentNode({ permissionProfile: profile }), "P", null);
    const at = argv.indexOf("--permission-prompts");
    assert.notEqual(at, -1, `${profile}: --permission-prompts must be passed`);
    assert.equal(argv[at + 1], "none");
  }
});

test("buildClaudeArgv: workspace denies gh and git push through ONE variadic --disallowedTools", () => {
  const argv = buildClaudeArgv(agentNode({ permissionProfile: "workspace" }), "P", null);
  const at = indicesOf(argv, "--disallowedTools");
  // `claude --help` (2.1.263) declares `--disallowedTools, --disallowed-tools <tools...>`, a
  // variadic option: both patterns are two values of ONE occurrence. Emitting the flag twice
  // would leave it to Commander whether the second occurrence appends to or replaces the first —
  // and a replacement silently drops the `Bash(gh *)` denial, which is a lost safety property.
  assert.equal(at.length, 1, `--disallowedTools must appear exactly once, got ${at.length}: ${JSON.stringify(argv)}`);
  assert.deepEqual(argv.slice(at[0]! + 1, at[0]! + 3), ["Bash(gh *)", "Bash(git push *)"]);
  // The variadic must be terminated by the next flag, never by a bare value that would be
  // swallowed as a third tool pattern.
  assert.ok(argv[at[0]! + 3]?.startsWith("--"), `the value after the variadic must be a flag, got ${argv[at[0]! + 3]}`);
});

test("buildClaudeArgv: readonly and full deny no tools by name (the permission mode carries the restriction)", () => {
  for (const profile of ["readonly", "full"] as PermissionProfile[]) {
    const argv = buildClaudeArgv(agentNode({ permissionProfile: profile }), "P", null);
    assert.equal(indicesOf(argv, "--disallowedTools").length, 0, `${profile} must not pass --disallowedTools`);
  }
});

test("buildClaudeArgv: --json-schema is passed only when the node declares structuredOutput", () => {
  assert.equal(buildClaudeArgv(agentNode(), "P", null).includes("--json-schema"), false);
  // `claude --help` (2.1.263): "--json-schema <schema>  JSON Schema for structured output
  // validation. Example: {"type":"object",...}" -- the value is the schema's JSON text itself,
  // not a file path (unlike codex's `--output-schema <FILE>`, exercised separately below).
  const schemaJson = JSON.stringify({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
  const argv = buildClaudeArgv(agentNode(), "P", schemaJson);
  const at = argv.indexOf("--json-schema");
  assert.notEqual(at, -1);
  assert.equal(argv[at + 1], schemaJson);
});

test("buildClaudeArgv: what reaches --json-schema parses as JSON and deep-equals the node's own structuredOutput", () => {
  const structuredOutput: StructuredOutputSchema = {
    type: "object",
    properties: { changed: { type: "boolean" }, summary: { type: "string" } },
    required: ["changed", "summary"],
    additionalProperties: false,
  };
  const argv = buildClaudeArgv(agentNode({ structuredOutput }), "P", JSON.stringify(structuredOutput));
  const at = argv.indexOf("--json-schema");
  assert.notEqual(at, -1);
  const parsed: unknown = JSON.parse(argv[at + 1]!);
  assert.deepEqual(parsed, structuredOutput);
});

test("buildClaudeArgv: --model is passed only when the node declares one", () => {
  assert.equal(buildClaudeArgv(agentNode(), "P", null).includes("--model"), false);
  const argv = buildClaudeArgv(agentNode({ model: "sonnet" }), "P", null);
  const at = argv.indexOf("--model");
  assert.equal(argv[at + 1], "sonnet");
});

test("buildClaudeArgv: the prompt travels as one argv element, never re-parsed", () => {
  const nasty = 'a "quoted" $(whoami) `id` ; rm -rf /\nsecond line';
  const argv = buildClaudeArgv(agentNode(), nasty, null);
  assert.equal(argv.filter((a) => a === nasty).length, 1);
  assert.equal(argv[2], nasty);
});

// ---------------------------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------------------------

const CODEX_SANDBOX: Record<PermissionProfile, string> = {
  readonly: "read-only",
  workspace: "workspace-write",
  full: "danger-full-access",
};

for (const [profile, sandbox] of Object.entries(CODEX_SANDBOX) as [PermissionProfile, string][]) {
  test(`buildCodexArgv: permissionProfile "${profile}" maps to -s ${sandbox}`, () => {
    const node = agentNode({ runtime: "codex", auth: "subscription-login", permissionProfile: profile });
    const argv = buildCodexArgv(node, "P", null, "/tmp/last.txt", "/wt");
    const at = argv.indexOf("-s");
    assert.notEqual(at, -1);
    assert.equal(argv[at + 1], sandbox);
  });
}

test("buildCodexArgv: the invariant head, -C the worktree, and -o the last-message file", () => {
  const node = agentNode({ runtime: "codex", auth: "subscription-login" });
  const argv = buildCodexArgv(node, "P", null, "/tmp/last.txt", "/wt");
  assert.deepEqual(argv.slice(0, 5), ["codex", "exec", "--json", "--color", "never"]);
  assert.equal(argv[argv.indexOf("-C") + 1], "/wt");
  assert.equal(argv[argv.indexOf("-o") + 1], "/tmp/last.txt");
});

test("buildCodexArgv: the prompt is the last argv element, after every flag (codex takes it positionally)", () => {
  const node = agentNode({ runtime: "codex", auth: "subscription-login", model: "gpt-5" });
  const argv = buildCodexArgv(node, "PROMPT", "/tmp/schema.json", "/tmp/last.txt", "/wt");
  assert.equal(argv.at(-1), "PROMPT");
  assert.equal(argv[argv.indexOf("--output-schema") + 1], "/tmp/schema.json");
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5");
});

test("buildCodexArgv: --output-schema is passed only when the node declares structuredOutput", () => {
  const node = agentNode({ runtime: "codex", auth: "subscription-login" });
  assert.equal(buildCodexArgv(node, "P", null, "/tmp/last.txt", "/wt").includes("--output-schema"), false);
});

test("buildCodexArgv: no flag's value can be swallowed -- every flag is followed by exactly its own value", () => {
  const node = agentNode({ runtime: "codex", auth: "subscription-login", model: "gpt-5" });
  const argv = buildCodexArgv(node, "PROMPT", "/tmp/schema.json", "/tmp/last.txt", "/wt");
  for (const [flag, value] of [["-s", "workspace-write"], ["-C", "/wt"], ["--output-schema", "/tmp/schema.json"], ["-o", "/tmp/last.txt"], ["-m", "gpt-5"]] as const) {
    assert.equal(indicesOf(argv, flag).length, 1, `${flag} must appear exactly once`);
    assert.equal(argv[argv.indexOf(flag) + 1], value);
  }
});
