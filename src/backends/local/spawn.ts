// Subprocess spawn with a hard deadline and an escalating cancel sequence (docs/design/
// mvp-design.md §7.2, §13.1; docs/spikes/README.md §3/§6 measured signal contracts). Modelled on
// the polling deadline pattern in `spikes/spike-4-codex-cli/run.sh`'s `run_codex`/
// `run_codex_signal`, translated to Node's event-driven `child_process.spawn` instead of a
// polling loop. `stdio: ["ignore", "pipe", "pipe"]`: stdin is never inherited and never a TTY --
// on Unix, Node maps an `"ignore"` stdio slot to `/dev/null`, which is the measured requirement
// for both runtimes (SPIKE-1 C7, SPIKE-4 D1: "stdin must be /dev/null or closed").

import { spawn } from "node:child_process";
import { LoopmillError } from "../../util/errors.ts";

export interface CancelStep {
  signal: NodeJS.Signals;
  /** Milliseconds after the PREVIOUS step (or after the deadline/abort fires, for the first
   * step) before this signal is sent, unless the process has already exited. */
  afterMs: number;
}

export interface RunProcessInput {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** `null` means no deadline (only an external `signal` can end the process early). */
  timeoutMs: number | null;
  /** Escalation sent once the deadline fires or `signal` aborts, e.g. claude-code:
   * `[{signal: "SIGINT", afterMs: 0}, {signal: "SIGKILL", afterMs: 10_000}]`. A later step is
   * skipped once the process has already exited. */
  cancelSequence: CancelStep[];
  /** External cancellation (the driver asking to cancel this Attempt), independent of the node's
   * own timeout. Runs the same `cancelSequence`. */
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  /** True iff `timeoutMs` elapsed before the process exited on its own. */
  timedOut: boolean;
  /** True iff `signal` (the caller's `AbortSignal`) fired before the process exited on its own. */
  cancelled: boolean;
  durationMs: number;
}

/**
 * Spawns `argv[0]` with `argv.slice(1)` as arguments, no shell, `cwd`/`env` exactly as given
 * (never merged with the current process's own environment -- the caller, `local/env.ts`'s
 * `buildChildEnv`, already decided the complete set). Resolves once the child exits, whatever the
 * outcome (never rejects for the child's own exit/signal/timeout/cancellation); rejects only when
 * the child could not be spawned at all (`ENOENT`, `EACCES`, ...), with `LoopmillError`
 * `code: "dispatch_failed"`, matching `Dispatcher.dispatch`'s own contract for the same failure
 * mode one layer up.
 */
export function runProcess(input: RunProcessInput): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const [cmd, ...args] = input.argv;
    if (!cmd) {
      reject(new LoopmillError("dispatch_failed", "runProcess: argv must have at least one element"));
      return;
    }

    const child = spawn(cmd, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const timers: NodeJS.Timeout[] = [];

    const clearTimers = (): void => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    };

    const scheduleCancelSequence = (): void => {
      let elapsed = 0;
      for (const step of input.cancelSequence) {
        elapsed += step.afterMs;
        const delay = elapsed;
        const t = setTimeout(() => {
          if (settled) return;
          try {
            child.kill(step.signal);
          } catch {
            // Already exited between the deadline check and this tick -- nothing to do.
          }
        }, delay);
        timers.push(t);
      }
    };

    if (input.timeoutMs !== null) {
      const deadline = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        scheduleCancelSequence();
      }, input.timeoutMs);
      timers.push(deadline);
    }

    const onAbort = (): void => {
      if (settled) return;
      cancelled = true;
      scheduleCancelSequence();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: RunProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    if (input.onStdout) child.stdout?.on("data", input.onStdout);
    if (input.onStderr) child.stderr?.on("data", input.onStderr);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      input.signal?.removeEventListener("abort", onAbort);
      reject(
        new LoopmillError("dispatch_failed", `failed to spawn ${cmd}: ${err.message}`, { cause: err }),
      );
    });

    child.on("exit", (code, signal) => {
      finish({ exitCode: code, signal, timedOut, cancelled, durationMs: Date.now() - start });
    });
  });
}
