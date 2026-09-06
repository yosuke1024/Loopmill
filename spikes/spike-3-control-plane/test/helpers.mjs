/** Shared helpers for the SPIKE-3 tests. Node built-ins only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STEP = fileURLToPath(new URL('../step.mjs', import.meta.url));

export function mkTmp(prefix = 'loopmill-spike3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

export function gitSoft(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/** Creates a bare repository that plays the role of the "remote" state repo. */
export function makeBareRemote(root, name = 'remote.git') {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  git(p, ['init', '--bare', '-q']);
  return p;
}

export function remoteSha(bare, branch) {
  const r = gitSoft(bare, ['rev-parse', `refs/heads/${branch}`]);
  return r.code === 0 ? r.stdout : null;
}

export function remoteFile(bare, branch, relPath) {
  const r = gitSoft(bare, ['show', `refs/heads/${branch}:${relPath}`]);
  return r.code === 0 ? r.stdout : null;
}

export function remoteSubjects(bare, branch) {
  const r = gitSoft(bare, ['log', '--format=%s', `refs/heads/${branch}`]);
  return r.code === 0 && r.stdout ? r.stdout.split('\n') : [];
}

export function remoteCommitCount(bare, branch) {
  const r = gitSoft(bare, ['rev-list', '--count', `refs/heads/${branch}`]);
  return r.code === 0 ? Number(r.stdout) : 0;
}

function parseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

/** Synchronous CLI invocation. */
export function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [STEP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: parseJson(r.stdout || '') };
}

/** Asynchronous CLI invocation, for genuine process-level concurrency. */
export function cliAsync(args, env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [STEP, ...args], { env: { ...process.env, ...env } });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, stdout: out, stderr: err, json: parseJson(out) }));
  });
}

export function localArgs(dir) {
  return ['--store', 'local', '--dir', dir];
}

export function gitArgs(remote, branch, workdir) {
  return ['--store', 'git', '--remote', remote, '--branch', branch, '--workdir', workdir];
}

export function startedEvent(runId, schedule, env = {}) {
  const r = cli(['started-event', '--run-id', runId, '--schedule', schedule], env);
  if (r.code !== 0) throw new Error(`started-event failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Runs one step and returns the parsed result plus the exit code. */
export function step(storeArgs, envelope, extra = [], env = {}) {
  return cli(['step', ...storeArgs, '--event', JSON.stringify(envelope), ...extra], env);
}

/** Drives a run one step at a time, returning every step result. */
export function driveStepwise(storeArgs, firstEvent, maxSteps = 12, env = {}) {
  const results = [];
  let ev = firstEvent;
  for (let i = 0; i < maxSteps && ev; i++) {
    const r = step(storeArgs, ev, [], env);
    results.push(r);
    if (!r.json || r.json.terminal || !r.json.nextEvent) break;
    ev = r.json.nextEvent;
  }
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lists the paths stored on the state branch of a bare remote. */
export function remoteTree(bare, branch) {
  const r = gitSoft(bare, ['ls-tree', '-r', '--name-only', `refs/heads/${branch}`]);
  return r.code === 0 && r.stdout ? r.stdout.split('\n') : [];
}

/** Polls until `fn()` is truthy, or throws. */
export async function waitFor(fn, timeoutMs = 10000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}
