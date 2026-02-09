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
