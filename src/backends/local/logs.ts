// Captured-stream log files (docs/design/mvp-design.md §9.1, §13.4). Everything written to disk
// passes through `redact` first, line by line -- buffered across `write` calls so a credential
// split across two stdout/stderr chunks is still caught (a chunk boundary rarely lands on a line
// boundary, and `redact`'s regexes only see whatever is in front of them at match time).

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { redact } from "../../util/redact.ts";

export interface CapturedStreams {
  stdoutPath: string;
  stderrPath: string;
  write(stream: "stdout" | "stderr", chunk: Buffer | string): void;
  /** Flushes any buffered partial line (redacted) and closes both files. Always safe to call more
   * than once. */
  close(): Promise<void>;
}

interface LineRedactor {
  push(text: string): void;
  flush(): void;
}

function makeLineRedactor(target: WriteStream): LineRedactor {
  let buffered = "";
  return {
    push(text: string): void {
      buffered += text;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        target.write(redact(line) + "\n");
      }
    },
    flush(): void {
      if (buffered.length > 0) {
        target.write(redact(buffered));
        buffered = "";
      }
    },
  };
}

/**
 * Opens (append mode, created if absent) `<logsDir>/<runId>/<cycle>-<nodeId>-<attempt>.{stdout,
 * stderr}.log` and returns a small writer over both. `write` accepts raw chunks as they arrive
 * from the child process; redaction and disk I/O happen line by line inside this module, not the
 * caller's.
 */
export function openCapturedStreams(
  logsDir: string,
  runId: string,
  cycle: number,
  nodeId: string,
  attempt: number,
): CapturedStreams {
  const dir = join(logsDir, runId);
  mkdirSync(dir, { recursive: true });
  const base = `${cycle}-${nodeId}-${attempt}`;
  const stdoutPath = join(dir, `${base}.stdout.log`);
  const stderrPath = join(dir, `${base}.stderr.log`);
  const stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(stderrPath, { flags: "a" });
  const stdoutRedactor = makeLineRedactor(stdoutStream);
  const stderrRedactor = makeLineRedactor(stderrStream);
  let closed = false;

  function write(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    if (closed) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    (stream === "stdout" ? stdoutRedactor : stderrRedactor).push(text);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    stdoutRedactor.flush();
    stderrRedactor.flush();
    await Promise.all([
      new Promise<void>((res) => stdoutStream.end(res)),
      new Promise<void>((res) => stderrStream.end(res)),
    ]);
  }

  return { stdoutPath, stderrPath, write, close };
}

/** The last `bytes` UTF-8 bytes of `text`, decoded back to a string (used for a short "what did
 * this node say" summary tail). Never throws on a multi-byte boundary cut: `Buffer#toString`
 * silently replaces a truncated leading sequence with the replacement character. */
export function tail(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  return buf.subarray(buf.length - bytes).toString("utf8");
}
