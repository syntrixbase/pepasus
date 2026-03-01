/**
 * Error hierarchy for Pegasus.
 *
 * PegasusError (base)
 * ├── ConfigError
 * ├── LLMError
 * │   ├── LLMRateLimitError
 * │   └── LLMTimeoutError
 * ├── TaskError
 * │   ├── InvalidStateTransition
 * │   └── TaskNotFoundError
 * ├── MemoryError
 * └── ToolError
 */

export class PegasusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PegasusError";
  }
}

export class ConfigError extends PegasusError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ── LLM ──────────────────────────────────────────

export class LLMError extends PegasusError {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "LLMRateLimitError";
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "LLMTimeoutError";
  }
}

// ── Task ─────────────────────────────────────────

export class TaskError extends PegasusError {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

export class InvalidStateTransition extends TaskError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateTransition";
  }
}

export class TaskNotFoundError extends TaskError {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

// ── Memory & Tool ────────────────────────────────

export class MemoryError extends PegasusError {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export class ToolError extends PegasusError {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

// ── Utilities ───────────────────────────────────

/**
 * Extract a loggable string from an unknown caught value.
 *
 * Error objects have non-enumerable `message` and `stack` properties,
 * so `JSON.stringify(err)` returns `"{}"`. pino serializes log fields
 * via JSON before sending them to the transport worker thread, which
 * means `logger.warn({ error: err })` loses all error information.
 *
 * Use this helper everywhere an error is passed to logger fields:
 *   `logger.warn({ error: errorToString(err) }, "something_failed")`
 */
export function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
