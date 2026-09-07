// The engine's single error class. Every error that crosses a module boundary carries a
// stable, machine-readable `code` and the exit code `loopmill` maps it to at the CLI
// boundary (docs/spec/state-machine.md §12.1-12.2). A class is used here (rather than the
// plain functions/interfaces convention of docs/design/m1-plan.md §3) because this is the
// one resource-shaped thing in `util`: it needs to extend the platform `Error` type.

export interface LoopmillErrorOptions {
  exitCode?: number;
  details?: unknown;
  cause?: unknown;
}

export class LoopmillError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, options: LoopmillErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LoopmillError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    Object.setPrototypeOf(this, LoopmillError.prototype);
  }
}

export function isLoopmillError(value: unknown): value is LoopmillError {
  return value instanceof LoopmillError;
}
