/**
 * Structured logger — thin pino wrapper with file-only output.
 *
 * Configuration:
 *   - **Format** (`logFormat`): `json` (structured JSON lines) or `line` (human-readable single lines)
 *   - **Destination**: always file via pino-roll with daily rotation + 10 MB size limit
 *
 * No console output — use `bun logs` or `tail -f` to view logs in real time.
 */
import pino from "pino";
import type { TransportSingleOptions } from "pino";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join, basename } from "path";

export type LogFormat = "json" | "line";

// Mutable log level — bootstrap defaults to "info", reinitLogger() updates from config.
let currentLevel = "info";

/**
 * Pino options — human-readable level label and ISO timestamp.
 *
 * These formatters are safe for single-target mode (file only).
 */
function createLoggerOptions(transport: TransportSingleOptions): pino.LoggerOptions {
  return {
    level: currentLevel,
    transport,
    base: undefined, // Remove pid and hostname from log output
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
 * Removes rotated log files (e.g., pegasus.log.2024-01-15) that are older than the retention period.
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

    // Find all rotated log files (e.g., pegasus.log.*)
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
    // Silently ignore cleanup errors to avoid affecting application startup
    // The logger itself may not be ready yet
  }
}

/**
 * Resolve file transport based on log format.
 *
 * - `json`: pino-roll directly (raw JSON lines, machine-parseable)
 * - `line`: custom line-transport (human-readable single lines via pino-roll)
 *
 * Both formats use pino-roll for daily rotation + 10 MB size limit.
 */
export function resolveTransport(
  logFile: string,
  logFormat?: LogFormat,
): TransportSingleOptions {
  const format: LogFormat = logFormat ?? "json";

  // Ensure log directory exists
  const logDir = dirname(logFile);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Clean up old log files (keep last 30 days)
  cleanupOldLogs(logFile, 30);

  const rollOptions = {
    file: logFile,
    frequency: "daily",
    size: "10m", // Rotate when file exceeds 10MB
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

/**
 * Initialize root logger with hardcoded defaults (json format, data/logs/).
 *
 * Bootstrap phase: config is not yet loaded.
 * This logger will be replaced by reinitLogger() once config is available.
 */
function initRootLogger(): pino.Logger {
  const logFile = join("data", "logs/pegasus.log");
  const transport = resolveTransport(logFile, "json");
  return pino(createLoggerOptions(transport));
}

const rootLogger = initRootLogger();

/**
 * Get a child logger with a module name.
 */
export function getLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}

/**
 * Reinitialize logger with loaded configuration (called by config.ts after settings are ready).
 * All parameters come from config — no env var reads.
 */
export function reinitLogger(
  logFile: string,
  logFormat?: LogFormat,
  logLevel?: string,
): void {
  if (logLevel) {
    currentLevel = logLevel;
  }
  const transport = resolveTransport(logFile, logFormat);
  const newLogger = pino(createLoggerOptions(transport));

  // Replace the root logger's bindings and streams
  Object.assign(rootLogger, newLogger);
}

export { rootLogger };
