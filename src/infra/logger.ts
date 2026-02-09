/**
 * Structured logger — thin pino wrapper.
 */
import pino from "pino";
import type { TransportSingleOptions } from "pino";

const level = process.env["PEGASUS_LOG_LEVEL"] ?? "info";

export function resolveTransport(nodeEnv: string | undefined): TransportSingleOptions | undefined {
  if (nodeEnv === "production") return undefined;
  return { target: "pino-pretty", options: { colorize: true } };
}

const rootLogger = pino({
  level,
  transport: resolveTransport(process.env["NODE_ENV"]),
});

export function getLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}

export { rootLogger };
