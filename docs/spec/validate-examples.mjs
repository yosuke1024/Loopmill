#!/usr/bin/env node
// Validate Loopmill Loop files against docs/spec/loop-file.schema.json and the
// semantic rules of docs/spec/loop-file.md that are cheap to check statically.
//
// Usage:
//   node docs/spec/validate-examples.mjs [--modules <dir>] [file-or-glob ...]
//
// With no file arguments it checks:
//   examples/*.loop.yaml              -- must be valid
//   docs/spec/examples/*.loop.yaml    -- negative fixtures; each declares the
//                                        code it must produce on its first line
//                                        as `# expect: LM-VAL-nnn`
//
// Dependencies (ajv, ajv-formats, yaml) are NOT vendored into this repository.
// Install them anywhere outside the repo and point the script at them:
//   npm install --prefix <dir> ajv ajv-formats yaml
//   node docs/spec/validate-examples.mjs --modules <dir>
// NODE_PATH=<dir>/node_modules and LOOPMILL_SPEC_TOOLS=<dir> are also honoured.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCHEMA_PATH = path.join(HERE, 'loop-file.schema.json')

// ---------------------------------------------------------------- dependencies

function moduleSearchDirs (explicit) {
  const dirs = []
  if (explicit) dirs.push(path.resolve(explicit))
  if (process.env.LOOPMILL_SPEC_TOOLS) dirs.push(path.resolve(process.env.LOOPMILL_SPEC_TOOLS))
  for (const entry of (process.env.NODE_PATH || '').split(path.delimiter)) {
    if (!entry) continue
    // NODE_PATH usually points at a node_modules directory; accept its parent too.
    dirs.push(path.resolve(entry), path.resolve(entry, '..'))
  }
  dirs.push(REPO, process.cwd())
  return [...new Set(dirs)]
}

async function loadDep (name, dirs) {
  try { return await import(name) } catch { /* fall through */ }
  for (const dir of dirs) {
    try {
      const req = createRequire(path.join(dir, '__resolve__.cjs'))
      const resolved = req.resolve(name)
      return await import(pathToFileURL(resolved).href)
    } catch { /* try next */ }
  }
  return null
}

function interop (mod) {
  return mod?.default?.default ?? mod?.default ?? mod
}

// ------------------------------------------------------------------ capability
//
// Mirrors the backend capability table in docs/spec/loop-file.md. In the real
// engine each backend declares this record in code and `loopmill backends --json`
// echoes it; here it is transcribed so the validator can reason about it.

const BACKENDS = {
  // Reserved: kept only so retry-edge/dominance checks that resolve to it still
  // have a capability record. Naming it as a node or defaults.backend fails
  // validation on its own (LM-VAL-028), regardless of runtime or auth.
  'github-actions': { retryable: true, structuredOutput: true, usage: 'full' },
  local: { retryable: true, structuredOutput: true, usage: 'full' },
  fake: { retryable: true, structuredOutput: true, usage: 'full' },
  // Pseudo-backend for condition / human / end nodes: they are decided by the
  // control plane and never dispatched, so they are not retryable.
  'control-plane': { retryable: false, structuredOutput: false, usage: 'none' },
}

const AUTH_MATRIX = {
  local: {
    'claude-code': ['subscription-oauth', 'api-key'],
    codex: ['subscription-login', 'api-key'],
  },
  fake: {
    'claude-code': ['subscription-oauth', 'subscription-login', 'api-key'],
    codex: ['subscription-oauth', 'subscription-login', 'api-key'],
  },
}

const CONTROL_PLANE_KINDS = new Set(['condition', 'human', 'end'])

// ----------------------------------------------------------------- rule engine

class Findings {
  constructor () { this.list = [] }
  add (code, where, message) { this.list.push({ code, where, message }) }
  get codes () { return [...new Set(this.list.map((f) => f.code))].sort() }
  get ok () { return this.list.length === 0 }
}

function backendOf (node, defaults) {
  if (CONTROL_PLANE_KINDS.has(node.kind)) return 'control-plane'
  // defaults.backend itself defaults to `local` (ADR-002 D4): unlike runtime and
  // authMode, a node's backend always resolves to something.
  return node.backend ?? defaults.backend ?? 'local'
}

function forwardTargets (node) {
  if (node.kind === 'condition') return [node.then, node.else].filter(Boolean)
  return node.next ? [node.next] : []
}

function templatePlaceholders (text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '$' && text[i + 2] === '{') { i += 2; continue }
    if (text[i] === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2)
      if (end === -1) { out.push({ name: null }); break }
      out.push({ name: text.slice(i + 2, end) })
      i = end
    }
  }
  return out
}

const EXPR_KEYWORDS = new Set(['true', 'false', 'null'])

function expressionRoots (expr) {
  // Strip quoted string literals, then take the first segment of every dotted path.
  const stripped = expr.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/'(?:[^'\\]|\\.)*'/g, ' ')
  const roots = []
  for (const m of stripped.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    const root = m[0].split('.')[0]
    if (!EXPR_KEYWORDS.has(root)) roots.push(root)
  }
  return [...new Set(roots)]
}

function computeDominators (nodeIds, entry, succ) {
  // Classic iterative dominator computation over the forward graph.
  const pred = new Map(nodeIds.map((id) => [id, []]))
  for (const id of nodeIds) for (const t of succ.get(id) ?? []) pred.get(t)?.push(id)
  const all = new Set(nodeIds)
  const dom = new Map(nodeIds.map((id) => [id, id === entry ? new Set([entry]) : new Set(all)]))
  let changed = true
  while (changed) {
    changed = false
    for (const id of nodeIds) {
      if (id === entry) continue
      const preds = pred.get(id).filter((p) => dom.has(p))
      let next
      if (preds.length === 0) { next = new Set([id]) } else {
        next = new Set(dom.get(preds[0]))
        for (const p of preds.slice(1)) next = new Set([...next].filter((x) => dom.get(p).has(x)))
      }
      next.add(id)
      const prev = dom.get(id)
      if (prev.size !== next.size || [...next].some((x) => !prev.has(x))) {
        dom.set(id, next)
        changed = true
      }
    }
  }
  return dom
}

// Rules the JSON Schema also enforces, re-checked here so that a file which fails
// the schema still reports the specific code this spec promises alongside LM-VAL-001.
function shadowRules (doc, f) {
  if (!doc || typeof doc !== 'object') return
  if (Array.isArray(doc.repos) && doc.repos.length > 1) {
    f.add('LM-VAL-022', 'repos', `${doc.repos.length} repos declared; the MVP allows exactly one`)
  }
  if (doc.approval && doc.approval.policy === 'auto' && !doc.approval.reason) {
    f.add('LM-VAL-024', 'approval', 'approval.policy: auto requires an explicit reason')
  }
  const nodes = (doc.nodes && typeof doc.nodes === 'object') ? doc.nodes : {}
  for (const [id, n] of Object.entries(nodes)) {
    if (!n || typeof n !== 'object' || n.kind !== 'agent') continue
    const hasPrompt = n.prompt !== undefined
    const hasFile = n.promptFile !== undefined
    if (hasPrompt === hasFile) {
      f.add('LM-VAL-027', `nodes.${id}`, hasPrompt ? 'both prompt and promptFile are set' : 'neither prompt nor promptFile is set')
    }
  }
}

function semanticRules (doc, file, f) {
  const nodes = doc.nodes ?? {}
  const ids = Object.keys(nodes)
  const edges = doc.edges ?? []
  const defaults = doc.defaults ?? {}
  const edgeIds = new Set(edges.map((e) => e.id))

  // LM-VAL-029 trigger.kind: event is reserved in this version.
  if (doc.trigger?.kind === 'event') {
    f.add('LM-VAL-029', 'trigger', 'trigger.kind "event" is reserved and not supported in this version')
  }

  // LM-VAL-002 slug must match the file name.
  const base = path.basename(file)
  if (base !== `${doc.slug}.loop.yaml`) {
    f.add('LM-VAL-002', base, `slug "${doc.slug}" does not match file name (expected ${doc.slug}.loop.yaml)`)
  }

  // LM-VAL-003 duplicate edge ids (duplicate node ids are impossible in a map and
  // are reported as a YAML duplicate-key error before we get here).
  const seenEdge = new Set()
  for (const e of edges) {
    if (seenEdge.has(e.id)) f.add('LM-VAL-003', `edges.${e.id}`, 'duplicate edge id')
    seenEdge.add(e.id)
    if (nodes[e.id]) f.add('LM-VAL-003', `edges.${e.id}`, 'edge id collides with a node id')
  }

  // LM-VAL-004 optional id echo must equal the map key.
  for (const [id, n] of Object.entries(nodes)) {
    if (n.id !== undefined && n.id !== id) {
      f.add('LM-VAL-004', `nodes.${id}`, `id echo "${n.id}" does not equal the map key "${id}"`)
    }
  }

  // Forward graph. Routing into a retry edge is not a forward edge.
  const succ = new Map(ids.map((id) => [id, []]))
  const routesIntoEdge = new Map()
  for (const [id, n] of Object.entries(nodes)) {
    const targets = forwardTargets(n)
    for (const t of targets) {
      if (edgeIds.has(t)) {
        if (!routesIntoEdge.has(t)) routesIntoEdge.set(t, [])
        routesIntoEdge.get(t).push(id)
      } else if (!nodes[t]) {
        f.add('LM-VAL-006', `nodes.${id}`, `target "${t}" is neither a node nor a retry edge`)
      } else {
        succ.get(id).push(t)
      }
    }
    const of = n.onFailure
    if (typeof of === 'string' && of.startsWith('retry_edge:')) {
      const t = of.slice('retry_edge:'.length)
      if (!edgeIds.has(t)) {
        f.add('LM-VAL-006', `nodes.${id}.onFailure`, `retry edge "${t}" does not exist`)
      } else {
        if (!routesIntoEdge.has(t)) routesIntoEdge.set(t, [])
        routesIntoEdge.get(t).push(id)
      }
    }
    if (n.kind === 'human' && n.subject) {
      const target = n.subject.slice('nodes.'.length)
      if (!nodes[target]) f.add('LM-VAL-006', `nodes.${id}.subject`, `subject node "${target}" does not exist`)
    }
    if (n.kind === 'human' && n.target) {
      const targetNode = n.target.slice('nodes.'.length)
      if (!nodes[targetNode]) f.add('LM-VAL-006', `nodes.${id}.target`, `target node "${targetNode}" does not exist`)
    }
  }

  // LM-VAL-005 entry node.
  let entry = doc.entry
  const inDegree = new Map(ids.map((id) => [id, 0]))
  for (const id of ids) for (const t of succ.get(id)) inDegree.set(t, inDegree.get(t) + 1)
  const roots = ids.filter((id) => inDegree.get(id) === 0)
  if (entry === undefined) {
    if (roots.length !== 1) {
      f.add('LM-VAL-005', 'entry', `entry node cannot be derived: ${roots.length} nodes have no incoming forward edge (${roots.join(', ') || 'none'})`)
    } else { entry = roots[0] }
  } else if (!nodes[entry]) {
    f.add('LM-VAL-005', 'entry', `entry "${entry}" is not a node`)
    entry = undefined
  }

  // LM-VAL-011 reachability, LM-VAL-012 termination.
  if (entry) {
    const seen = new Set([entry])
    const stack = [entry]
    while (stack.length) {
      const id = stack.pop()
      for (const t of succ.get(id) ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t) }
    }
    for (const e of edges) if (seen.has(e.from) && nodes[e.to] && !seen.has(e.to)) seen.add(e.to)
    for (const id of ids) if (!seen.has(id)) f.add('LM-VAL-011', `nodes.${id}`, 'node is unreachable from the entry node')
  }
  for (const [id, n] of Object.entries(nodes)) {
    if (n.kind === 'end') continue
    const hasForward = (succ.get(id) ?? []).length > 0
    const hasEdge = [...routesIntoEdge.entries()].some(([, from]) => from.includes(id))
    if (!hasForward && !hasEdge) {
      f.add('LM-VAL-012', `nodes.${id}`, 'node has no successor and is not an end node')
    }
  }

  // Per-node capability rules.
  for (const [id, n] of Object.entries(nodes)) {
    const backend = backendOf(n, defaults)
    const cap = BACKENDS[backend]

    // LM-VAL-028 github-actions is reserved, regardless of runtime or auth.
    if (!CONTROL_PLANE_KINDS.has(n.kind) && backend === 'github-actions') {
      f.add('LM-VAL-028', `nodes.${id}`, 'backend github-actions is reserved and not supported in this version')
    }

    if (n.kind !== 'agent') continue

    // LM-VAL-018 structuredOutput needs the capability.
    if (n.structuredOutput && !cap.structuredOutput) {
      f.add('LM-VAL-018', `nodes.${id}`, `backend "${backend}" declares structuredOutput: false but the node sets structuredOutput`)
    }
    // LM-VAL-021 MVP session policy.
    if (n.sessionPolicy && n.sessionPolicy !== 'fresh') {
      f.add('LM-VAL-021', `nodes.${id}`, `sessionPolicy "${n.sessionPolicy}" is not supported in the MVP`)
    }
    // LM-VAL-019 runtime x backend x auth. The reserved backend already has its
    // own finding (LM-VAL-028) above; do not also report it as an unsupported
    // combination here.
    if (backend !== 'github-actions') {
      const runtime = n.runtime ?? defaults.runtime
      const auth = n.auth ?? defaults.authMode
      if (!runtime) {
        f.add('LM-VAL-019', `nodes.${id}`, 'no runtime: the node declares none and defaults.runtime is unset')
      } else if (!auth) {
        f.add('LM-VAL-019', `nodes.${id}`, 'no auth mode: the node declares none and defaults.authMode is unset')
      } else {
        const allowed = AUTH_MATRIX[backend]?.[runtime]
        if (!allowed) {
          f.add('LM-VAL-019', `nodes.${id}`, `runtime "${runtime}" is not available on backend "${backend}"`)
        } else if (!allowed.includes(auth)) {
          f.add('LM-VAL-019', `nodes.${id}`, `auth "${auth}" is not available for ${runtime} on ${backend} (allowed: ${allowed.join(', ')})`)
        }
      }
    }
  }

  // Input references: LM-VAL-013 existence, LM-VAL-016 accessor availability.
  const declaredInputs = new Map()
  for (const [id, n] of Object.entries(nodes)) {
    const names = new Set(Object.keys(n.inputs ?? {}))
    declaredInputs.set(id, names)
    for (const [local, spec] of Object.entries(n.inputs ?? {})) {
      const ref = typeof spec === 'string' ? spec : spec.from
      if (!ref.startsWith('nodes.')) continue
      const rest = ref.slice('nodes.'.length)
      const dot = rest.indexOf('.')
      const target = rest.slice(0, dot)
      const accessor = rest.slice(dot + 1)
      const t = nodes[target]
      if (!t) {
        f.add('LM-VAL-013', `nodes.${id}.inputs.${local}`, `reference "${ref}" names an unknown node "${target}"`)
        continue
      }
      if (accessor.startsWith('structured.')) {
        if (t.kind !== 'agent' || !t.structuredOutput) {
          f.add('LM-VAL-016', `nodes.${id}.inputs.${local}`, `"${target}" declares no structuredOutput, so structured.* is not available`)
        }
      } else if (accessor === 'stdout' || accessor === 'exitCode') {
        if (t.kind !== 'command') {
          f.add('LM-VAL-016', `nodes.${id}.inputs.${local}`, `${accessor} is only available from a command node ("${target}" is ${t.kind})`)
        }
      } else if (accessor === 'filesChanged') {
        if (t.kind !== 'agent' && t.kind !== 'command') {
          f.add('LM-VAL-016', `nodes.${id}.inputs.${local}`, `filesChanged is only available from an agent or command node ("${target}" is ${t.kind})`)
        }
      }
    }
  }

  // LM-VAL-015 templates reference declared inputs only.
  for (const [id, n] of Object.entries(nodes)) {
    const declared = declaredInputs.get(id)
    const strings = []
    if (typeof n.prompt === 'string') strings.push(['prompt', n.prompt])
    if (Array.isArray(n.argv)) n.argv.forEach((a, i) => strings.push([`argv[${i}]`, a]))
    if (typeof n.cwd === 'string') strings.push(['cwd', n.cwd])
    for (const [where, text] of strings) {
      for (const ph of templatePlaceholders(text)) {
        if (ph.name === null) {
          f.add('LM-VAL-015', `nodes.${id}.${where}`, 'unterminated "${" placeholder')
        } else if (!declared.has(ph.name)) {
          f.add('LM-VAL-015', `nodes.${id}.${where}`, `\${${ph.name}} is not a declared input of this node`)
        }
      }
    }
  }

  // LM-VAL-017 expression operands must be declared inputs.
  for (const [id, n] of Object.entries(nodes)) {
    if (n.kind !== 'condition') continue
    for (const root of expressionRoots(n.expr)) {
      if (!declaredInputs.get(id).has(root)) {
        f.add('LM-VAL-017', `nodes.${id}.expr`, `"${root}" is not a declared input of this node`)
      }
    }
  }
  for (const e of edges) {
    if (!e.when) continue
    const declared = declaredInputs.get(e.from) ?? new Set()
    for (const root of expressionRoots(e.when)) {
      if (!declared.has(root)) {
        f.add('LM-VAL-017', `edges.${e.id}.when`, `"${root}" is not a declared input of the from node "${e.from}"`)
      }
    }
  }

  // Retry edges.
  for (const e of edges) {
    const to = nodes[e.to]
    const from = nodes[e.from]
    if (!from) f.add('LM-VAL-006', `edges.${e.id}.from`, `"${e.from}" is not a node`)
    if (!to) { f.add('LM-VAL-006', `edges.${e.id}.to`, `"${e.to}" is not a node`); continue }

    // LM-VAL-007 target must run on a retryable backend.
    const toBackend = backendOf(to, defaults)
    const toCap = BACKENDS[toBackend] ?? BACKENDS['control-plane']
    if (!toCap.retryable) {
      const why = CONTROL_PLANE_KINDS.has(to.kind)
        ? `to "${e.to}" is a ${to.kind} node, which runs on the control plane (retryable: false)`
        : `to "${e.to}" runs on backend "${toBackend}" (retryable: false)`
      f.add('LM-VAL-007', `edges.${e.id}`, `retry edge targets non-retryable backend: ${why}`)
    }

    // LM-VAL-008 the edge must close a cycle: `from` must be forward-reachable from `to`.
    const seen = new Set([e.to])
    const stack = [e.to]
    while (stack.length) {
      const id = stack.pop()
      for (const t of succ.get(id) ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t) }
    }
    if (!seen.has(e.from)) {
      f.add('LM-VAL-008', `edges.${e.id}`, `retry edge does not close a cycle: "${e.from}" is not forward-reachable from "${e.to}"`)
    } else {
      // LM-VAL-009 the body must contain at least one retryable node.
      const body = [...seen].filter((id) => {
        const s = new Set([id]); const st = [id]
        while (st.length) { const c = st.pop(); for (const t of succ.get(c) ?? []) if (!s.has(t)) { s.add(t); st.push(t) } }
        return s.has(e.from)
      })
      const anyRetryable = body.some((id) => (BACKENDS[backendOf(nodes[id], defaults)] ?? BACKENDS['control-plane']).retryable)
      if (!anyRetryable) {
        f.add('LM-VAL-009', `edges.${e.id}`, 'retry edge body contains no node on a retryable backend')
      }
    }

    // LM-VAL-010 exactly one node routes into the edge, and it is `from`.
    const routers = routesIntoEdge.get(e.id) ?? []
    if (routers.length === 0) {
      f.add('LM-VAL-010', `edges.${e.id}`, 'retry edge is never routed to by any next / then / else / onFailure')
    } else if (routers.length > 1) {
      f.add('LM-VAL-010', `edges.${e.id}`, `retry edge is routed to by more than one node (${routers.join(', ')})`)
    } else if (routers[0] !== e.from) {
      f.add('LM-VAL-010', `edges.${e.id}`, `from is "${e.from}" but the node routing into the edge is "${routers[0]}"`)
    }

    // LM-VAL-025 budget cap.
    const cap = doc.budget?.maxIterations
    if (cap !== undefined && e.maxIterations > cap) {
      f.add('LM-VAL-025', `edges.${e.id}`, `maxIterations ${e.maxIterations} exceeds budget.maxIterations cap ${cap}`)
    }
  }

  // LM-VAL-014 every input reference must come from a node that dominates this one.
  if (entry) {
    const dom = computeDominators(ids, entry, succ)
    for (const [id, n] of Object.entries(nodes)) {
      for (const [local, spec] of Object.entries(n.inputs ?? {})) {
        const ref = typeof spec === 'string' ? spec : spec.from
        if (!ref.startsWith('nodes.')) continue
        const target = ref.slice('nodes.'.length).split('.')[0]
        if (!nodes[target] || target === id) continue
        if (!dom.get(id)?.has(target)) {
          f.add('LM-VAL-014', `nodes.${id}.inputs.${local}`, `"${target}" does not run on every path from the entry node to "${id}"`)
        }
      }
    }

    // LM-VAL-023 external effects need a human gate on every path.
    const policy = doc.approval?.policy ?? 'gated'
    const exempt = new Set(doc.approval?.nodes ?? (policy === 'auto' ? ids : []))
    for (const [id, n] of Object.entries(nodes)) {
      if (n.effects !== 'external') continue
      if (policy === 'auto' && exempt.has(id)) continue
      const gated = [...(dom.get(id) ?? [])].some((d) => nodes[d]?.kind === 'human')
      if (!gated) {
        f.add('LM-VAL-023', `nodes.${id}`, 'effects: external but no human node runs on every path from the entry node to it (and it is not exempted by approval.policy: auto)')
      }
    }
  }

  // LM-VAL-026 the schedule must not fire more often than budget.minInterval.
  if (doc.trigger?.kind === 'schedule' && doc.budget?.minInterval) {
    const min = parseDuration(doc.budget.minInterval)
    const every = cronMinSpacingSeconds(doc.trigger.cron)
    if (every !== null && every < min) {
      f.add('LM-VAL-026', 'trigger.cron', `schedule can fire every ${every}s but budget.minInterval is ${min}s`)
    }
  }
}

function parseDuration (s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(s)
  if (!m) return 0
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0))
}

function cronMinSpacingSeconds (cron) {
  // Coarse but honest: only decides how often the minute and hour fields allow a
  // firing. Anything more precise belongs in the engine, not in a spec check.
  const [minute, hour] = cron.trim().split(/\s+/)
  const countField = (field, size) => {
    if (field === '*') return size
    if (/^\*\/(\d+)$/.test(field)) return Math.ceil(size / Number(RegExp.$1))
    return field.split(',').length
  }
  const perHour = countField(minute, 60)
  const hours = countField(hour, 24)
  if (perHour > 1) return Math.floor(3600 / perHour)
  if (hours > 1) return Math.floor(86400 / hours)
  return 86400
}

// ------------------------------------------------------------------------ main

function collectFiles (args) {
  if (args.length) return args.map((a) => path.resolve(a))
  const out = []
  for (const dir of [path.join(REPO, 'examples'), path.join(HERE, 'examples')]) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.loop.yaml')) out.push(path.join(dir, name))
    }
  }
  return out
}

async function main () {
  const argv = process.argv.slice(2)
  let modulesDir = null
  const files = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--modules') { modulesDir = argv[++i]; continue }
    if (argv[i].startsWith('--modules=')) { modulesDir = argv[i].slice(10); continue }
    files.push(argv[i])
  }

  const dirs = moduleSearchDirs(modulesDir)
  const AjvMod = (await loadDep('ajv/dist/2020', dirs)) ?? (await loadDep('ajv', dirs))
  const formatsMod = await loadDep('ajv-formats', dirs)
  const yamlMod = await loadDep('yaml', dirs)
  if (!AjvMod || !formatsMod || !yamlMod) {
    const missing = [!AjvMod && 'ajv', !formatsMod && 'ajv-formats', !yamlMod && 'yaml'].filter(Boolean)
    console.error(`error: cannot load ${missing.join(', ')}.`)
    console.error('These are not vendored in this repository. Install them outside it and point the')
    console.error('script at the install prefix:')
    console.error('')
    console.error('  npm install --prefix <dir> ajv ajv-formats yaml')
    console.error('  node docs/spec/validate-examples.mjs --modules <dir>')
    console.error('')
    console.error(`Searched: ${dirs.join(', ')}`)
    process.exit(2)
  }
  const Ajv = interop(AjvMod)
  const addFormats = interop(formatsMod)
  const YAML = yamlMod.default ?? yamlMod

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  const validate = ajv.compile(schema)

  const targets = collectFiles(files)
  if (targets.length === 0) {
    console.error('error: no *.loop.yaml files found')
    process.exit(2)
  }

  let failures = 0
  const lines = []
  for (const file of targets) {
    const rel = path.relative(REPO, file)
    const text = readFileSync(file, 'utf8')
    const expectMatch = /^#\s*expect:\s*(LM-VAL-\d{3})\s*$/m.exec(text.split('\n').slice(0, 3).join('\n'))
    const expected = expectMatch ? expectMatch[1] : null
    const f = new Findings()

    const parsed = YAML.parseDocument(text, { uniqueKeys: true })
    for (const err of parsed.errors) {
      const code = /duplicate/i.test(err.message) ? 'LM-VAL-003' : 'LM-VAL-001'
      f.add(code, rel, err.message)
    }
    let doc = null
    if (parsed.errors.length === 0) {
      doc = parsed.toJS()
      shadowRules(doc, f)
      if (!validate(doc)) {
        for (const e of validate.errors) {
          f.add('LM-VAL-001', `$${e.instancePath || ''}`, `${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`)
        }
      } else {
        semanticRules(doc, file, f)
      }
    }

    const codes = f.codes
    if (expected) {
      const hit = codes.includes(expected)
      const clean = codes.length === 1 && hit
      if (clean) {
        lines.push(`  ok    ${rel}  invalid as expected: ${expected}`)
      } else if (hit) {
        failures++
        lines.push(`  FAIL  ${rel}  expected only ${expected}, also got ${codes.filter((c) => c !== expected).join(', ')}`)
      } else {
        failures++
        lines.push(`  FAIL  ${rel}  expected ${expected}, got ${codes.join(', ') || 'no findings'}`)
      }
    } else if (f.ok) {
      const n = Object.keys(doc?.nodes ?? {}).length
      const e = (doc?.edges ?? []).length
      lines.push(`  ok    ${rel}  ${n} nodes, ${e} retry edge(s)`)
    } else {
      failures++
      lines.push(`  FAIL  ${rel}`)
    }
    for (const finding of f.list) {
      const marker = expected && finding.code === expected ? '        -' : '        !'
      lines.push(`${marker} ${finding.code} ${finding.where}: ${finding.message}`)
    }
  }

  console.log(`loop-file schema: ${schema.$id}`)
  console.log(`checked ${targets.length} file(s)`)
  console.log(lines.join('\n'))
  console.log(failures === 0 ? 'RESULT: pass' : `RESULT: fail (${failures} file(s))`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(2) })
