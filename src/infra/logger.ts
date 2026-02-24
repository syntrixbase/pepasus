/**
 * Structured logger — thin pino wrapper with file output support.
 *
 * Log format: JSON with human-readable `level` (label) and `time` (ISO 8601).
 * This applies to ALL outputs (file, console, any transport) so logs are
 * always grep-friendly and human-scannable without extra tooling.
 */
import pino from "pino";
import type { TransportSingleOptions, TransportMultiOptions } from "pino";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join, basename } from "path";

// Bootstrap phase: read log level from env before config is available.
// Will be overridden when reinitLogger() is called with loaded config.
const level = process.env["PEGASUS_LOG_LEVEL"] ?? "info";

/**
 * Shared pino options for human-readable level and timestamp.
 * - `formatters.level`: outputs `"level":"info"` instead of `"level":30`
 * - `timestamp`: outputs `"time":"2026-02-24T10:00:00.000Z"` instead of epoch ms
 *
 * NOTE: pino disallows `formatters` with multi-target transports.
 * We conditionally apply them only for single-target (file-only) mode.
 * For multi-target mode (file + console), pino-pretty handles console rendering,
 * and we use `formatters.level` is skipped (pino-pretty handles it on its own).
 */
function createLoggerOptions(
  transport: TransportSingleOptions | TransportMultiOptions,
  isMultiTarget: boolean,
): pino.LoggerOptions {
  const opts: pino.LoggerOptions = {
    level,
    transport,
    base: undefined, // Remove pid and hostname from log output
  };

  if (!isMultiTarget) {
    // Single target: we can use formatters and custom timestamp
    opts.formatters = {
      level(label) {
        return { level: label };
      },
    };
    opts.timestamp = pino.stdTimeFunctions.isoTime;
  } else {
    // Multi target: formatters not allowed, but pino-pretty handles console.
    // For the file transport, use timestamp (string serializer is allowed in multi mode).
    opts.timestamp = pino.stdTimeFunctions.isoTime;
  }

  return opts;
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
  } catch (err) {
    // Silently ignore cleanup errors to avoid affecting application startup
    // The logger itself may not be ready yet
  }
}

/**
 * Resolve transports based on environment and configuration.
 * File logging is always enabled. Console output is optional.
 *
 * Returns the transport config and whether it's multi-target.
 */
export function resolveTransports(
  nodeEnv: string | undefined,
  logFile: string,
  logConsoleEnabled?: boolean,
): { transport: TransportSingleOptions | TransportMultiOptions; isMultiTarget: boolean } {
  const transports: TransportSingleOptions[] = [];

  // Console transport (only if explicitly enabled)
  if (logConsoleEnabled) {
    if (nodeEnv !== "production") {
      transports.push({
        target: "pino-pretty",
        options: { colorize: true },
      });
    } else {
      // Production: JSON format to stdout
      transports.push({
        target: "pino/file",
        options: { destination: 1 }, // stdout
      });
    }
  }

  // File transport (always enabled)
  // Ensure log directory exists
  const logDir = dirname(logFile);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Clean up old log files (keep last 30 days)
  cleanupOldLogs(logFile, 30);

  // Use pino-roll for log rotation
  transports.push({
    target: "pino-roll",
    options: {
      file: logFile,
      frequency: "daily",
      size: "10m", // Rotate when file exceeds 10MB
      mkdir: true,
    },
  });

  // Return single transport or multi transport
  if (transports.length === 1) {
    return {
      transport: transports[0]!, // Non-null assertion: we know length is 1
      isMultiTarget: false,
    };
  }

  return {
    transport: { targets: transports },
    isMultiTarget: true,
  };
}

/**
 * Initialize root logger with file output.
 *
 * Bootstrap phase: config is not yet loaded, so we read env vars directly.
 * This logger will be replaced by reinitLogger() once config is available.
 */
function initRootLogger(): pino.Logger {
  const dataDir = process.env["PEGASUS_DATA_DIR"] || "data";
  const logFile = join(dataDir, "logs/pegasus.log");
  const logConsoleEnabled = process.env["PEGASUS_LOG_CONSOLE_ENABLED"] === "true";

  const { transport, isMultiTarget } = resolveTransports(
    process.env["NODE_ENV"],
    logFile,
    logConsoleEnabled,
  );
  return pino(createLoggerOptions(transport, isMultiTarget));
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
 * All parameters come from config — no direct env var reads.
 */
export function reinitLogger(logFile: string, logConsoleEnabled?: boolean, nodeEnv?: string): void {
  const { transport, isMultiTarget } = resolveTransports(
    nodeEnv,
    logFile,
    logConsoleEnabled,
  );
  const newLogger = pino(createLoggerOptions(transport, isMultiTarget));

  // Replace the root logger's bindings and streams
  Object.assign(rootLogger, newLogger);
}

export { rootLogger };
