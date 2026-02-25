/**
 * Structured logger — thin pino wrapper with lazy initialization.
 *
 * Initialization strategy:
 *   1. getLogger() returns proxy loggers — safe to call at module load time
 *   2. Before config is loaded: warn+ goes to console, below warn is ignored
 *   3. After initLogger() is called with config: file transport is set up
 *   4. All proxy loggers automatically use the new rootLogger after init
 *
 * Configuration:
 *   - **Format** (`logFormat`): `json` (structured JSON lines) or `line` (human-readable)
 *   - **Destination**: file via pino-roll with daily rotation + 10 MB size limit
 */
import pino from "pino";
import type { TransportSingleOptions } from "pino";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join, basename } from "path";

export type LogFormat = "json" | "line";

// ── State ────────────────────────────────────────

let initialized = false;

/**
 * Root logger — starts as console-only fallback (warn+).
 * Replaced by a real pino file logger once initLogger() is called.
 */
let rootLogger: pino.Logger = pino({ level: "warn" });

// ── Public API ───────────────────────────────────

/**
 * Get a named logger. Safe to call at module load time.
 *
 * Returns a Proxy that delegates every call to rootLogger.child({ module: name })
 * at invocation time — so it always uses the current rootLogger, even if
 * initLogger() hasn't been called yet or replaces it later.
 */
export function getLogger(name: string): pino.Logger {
  return new Proxy({} as pino.Logger, {
    get(_target, prop) {
      const child = rootLogger.child({ module: name });
      return (child as any)[prop];
    },
  });
}

/**
 * Initialize logger with real configuration. Called once by config.ts
 * after settings are loaded.
 *
 * Before this is called, warn+ logs go to console (pino default stderr).
 * After this is called, all logs go to the file transport.
 */
export function initLogger(
  logFile: string,
  logFormat?: LogFormat,
  logLevel?: string,
): void {
  if (logLevel === "silent") {
    rootLogger = pino({ level: "silent" });
    initialized = true;
    return;
  }

  const level = logLevel ?? "info";
  const transport = resolveTransport(logFile, logFormat);
  rootLogger = pino(createLoggerOptions(transport, level));
  initialized = true;
}

/** Whether initLogger() has been called. */
export function isLoggerInitialized(): boolean {
  return initialized;
}

// ── Internal ─────────────────────────────────────

function createLoggerOptions(transport: TransportSingleOptions, level: string): pino.LoggerOptions {
  return {
    level,
    transport,
    base: undefined,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/**
 * Clean up old log files older than specified days.
 */
function cleanupOldLogs(logFile: string, retentionDays = 30): void {
  try {
    const logDir = dirname(logFile);
    const logFileName = basename(logFile);

    if (!existsSync(logDir)) {
      return;
    }

    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    const files = readdirSync(logDir);
    const rotatedLogPattern = new RegExp(`^${logFileName}\\.`);

    for (const file of files) {
      if (!rotatedLogPattern.test(file)) {
        continue;
      }

      const filePath = join(logDir, file);
      const stats = statSync(filePath);
      const fileAge = now - stats.mtimeMs;

      if (fileAge > retentionMs) {
        unlinkSync(filePath);
      }
    }
  } catch (_err) {
    // Silently ignore cleanup errors
  }
}

/**
 * Resolve file transport based on log format.
 */
export function resolveTransport(
  logFile: string,
  logFormat?: LogFormat,
): TransportSingleOptions {
  const format: LogFormat = logFormat ?? "json";

  const logDir = dirname(logFile);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  cleanupOldLogs(logFile, 30);

  const rollOptions = {
    file: logFile,
    frequency: "daily",
    size: "10m",
    mkdir: true,
  };

  if (format === "line") {
    return {
      target: join(__dirname, "line-transport.js"),
      options: rollOptions,
    };
  }

  return {
    target: "pino-roll",
    options: rollOptions,
  };
}

export { rootLogger };
