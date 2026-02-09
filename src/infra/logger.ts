/**
 * Structured logger — thin pino wrapper.
 */
import pino from "pino";

const level = process.env["PEGASUS_LOG_LEVEL"] ?? "info";

const rootLogger = pino({
  level,
  transport:
    process.env["NODE_ENV"] !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export function getLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}

export { rootLogger };
