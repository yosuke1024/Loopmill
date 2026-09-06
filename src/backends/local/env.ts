// Environment policy for agent and command subprocesses (docs/design/mvp-design.md §13.2;
// docs/spec/loop-file.md §6.3, §8.2). Pure: no I/O, just set arithmetic over the parent
// environment and the already-merged `ResolvedEnvPolicy` (`loop-file/resolve.ts`'s
// `BUILTIN_ENV_DENY`/`BUILTIN_ENV_PRESERVE` are already folded into `policy` by the time it
// reaches here).

import type { ResolvedEnvPolicy, ResolvedNode } from "../../types/loop.ts";

/** `gh`'s own two recognized token variables. `GH_TOKEN` is in `BUILTIN_ENV_DENY`
 * (`loop-file/resolve.ts`); `GITHUB_TOKEN` is not named there but gets identical treatment here,
 * per this task's instructions ("GH_TOKEN (and GITHUB_TOKEN) allowed only for command nodes with
 * effects: external, denied for every agent node") -- `gh` reads either name, so denying only one
 * would not close the hole. */
const GH_TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

export interface BuildChildEnvResult {
  /** The exact environment the child process should be spawned with. */
  env: Record<string, string>;
  /** Every deny-listed name that was actually present (in the parent env or the loop's own
   * `inject` map) and therefore had to be scrubbed -- reported even for a name that was never in
   * the effective preserve/inject allowlist to begin with, so `doctor`/`--dry-run` can show the
   * operator exactly what a vendor-auth variable in their shell would have leaked (A15). Sorted. */
  denied: string[];
  /** Every name whose value came from `policy.inject` rather than the parent environment. Sorted. */
  injected: string[];
}

/**
 * Builds the exact environment for one subprocess: `policy.preserve` names (plus every
 * `policy.inject` name) pass through, `policy.deny` names never do -- deny always wins, including
 * over an injected value of the same name (a loop file cannot use `inject` to reinstate a denied
 * vendor-auth variable; `Decision (not in sheet), m1`, since `loop-file.md` §6.3 only states this
 * for `preserve` but the same reasoning applies to `inject`). `GH_TOKEN`/`GITHUB_TOKEN` are denied
 * by default and allowed through only for a `command` node whose resolved `effects` is
 * `"external"` (mvp-design.md §13.2) -- for such a node they are also added to the allowlist even
 * if the node's own `env` field does not name them, since the exception is the executor's to grant,
 * not the loop author's to remember (`loop-file/resolve.ts`'s own comment on `BUILTIN_ENV_DENY`
 * makes the same point about where this decision is made).
 *
 * `Decision (not in sheet), m1`: a `command` node's own `env` allowlist defaults to `[]` after
 * resolution (`loop-file/resolve.ts`: `env: node.env ?? []`), which is indistinguishable from an
 * author writing `env: []` explicitly. Read literally, "an allowlist intersected with preserve +
 * inject" would then give every ordinary command node (none of which declares `env:` in the
 * reference loop) a completely empty environment -- no `PATH`, so `node:child_process` cannot even
 * resolve a bare executable name like `npm` or `gh`, which would break `run-tests` and
 * `create-issue`/`create-pr` in `examples/daily-content-improvement.loop.yaml`. The only reading
 * that keeps the reference loop runnable is: the intersection applies only when the node's own
 * `env` array is non-empty; an empty (or omitted) `env` means "no additional restriction beyond
 * deny/preserve/inject", the same as an agent node, which has no such field at all. Flagged for
 * the maintainer to confirm against the intended reading of `loop-file.md` §8.2.
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  policy: ResolvedEnvPolicy,
  node: ResolvedNode,
): BuildChildEnvResult {
  const isExternalCommand = node.kind === "command" && node.effects === "external";

  const deny = new Set(policy.deny);
  for (const name of GH_TOKEN_NAMES) deny.add(name);
  if (isExternalCommand) {
    for (const name of GH_TOKEN_NAMES) deny.delete(name);
  }

  let allowedNames = new Set<string>(policy.preserve);
  for (const name of Object.keys(policy.inject)) allowedNames.add(name);

  if (node.kind === "command" && node.env !== null) {
    const nodeAllow = new Set(node.env);
    allowedNames = new Set([...allowedNames].filter((name) => nodeAllow.has(name)));
  }

  if (isExternalCommand) {
    for (const name of GH_TOKEN_NAMES) allowedNames.add(name);
  }

  const denied = new Set<string>();
  const injected: string[] = [];
  const env: Record<string, string> = {};

  for (const name of allowedNames) {
    if (deny.has(name)) {
      denied.add(name);
      continue;
    }
    const injectedValue = policy.inject[name];
    if (injectedValue !== undefined) {
      env[name] = injectedValue;
      injected.push(name);
      continue;
    }
    const value = parentEnv[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  // Report every deny-listed name that was actually present somewhere, even if it was never in
  // the allowlist to begin with (A15).
  for (const name of deny) {
    if (parentEnv[name] !== undefined || policy.inject[name] !== undefined) {
      denied.add(name);
    }
  }

  return { env, denied: [...denied].sort(), injected: injected.sort() };
}
