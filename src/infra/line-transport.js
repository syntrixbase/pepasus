/**
 * Custom pino transport that formats JSON log lines into human-readable single lines,
 * then pipes to pino-roll for file rotation.
 *
 * Output format:
 *   2026-02-24T10:00:00.000Z [INFO ] [module] message key1:val1, key2:val2
 *
 * This avoids pino-pretty (which leaks to stdout in pipeline mode)
 * while providing a readable file format with full pino-roll rotation support.
 *
 * NOTE: This is a .js file because pino loads transports in a worker thread
 * via `real-require`, which does not support .ts files in Bun.
 */
"use strict";

const build = require("pino-abstract-transport");
const pinoRoll = require("pino-roll");

/** Fields already represented in the line prefix — skip in extras. */
const SKIP_FIELDS = new Set(["level", "time", "msg", "module"]);

/** Serialize a value for log output. Handles Error objects specially. */
function formatValue(value) {
  if (value instanceof Error) {
    // Error properties (message, stack) are non-enumerable — JSON.stringify returns "{}"
    return value.stack || value.message || String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value, (_, v) =>
      v instanceof Error ? (v.stack || v.message || String(v)) : v
    );
  }
  return String(value);
}

/** Format a single JSON log object into a human-readable line. */
function formatLine(obj) {
  const time = obj.time || new Date().toISOString();
  const level = String(obj.level || "INFO").toUpperCase();
  const prefix = obj.module ? `[${level}][${obj.module}]` : `[${level}]`;
  const msg = obj.msg || "";

  const extras = [];
  for (const [key, value] of Object.entries(obj)) {
    if (SKIP_FIELDS.has(key)) continue;
    if (value === undefined || value === null) continue;
    extras.push(`${key}:${formatValue(value)}`);
  }

  const parts = [time, prefix, msg].filter(Boolean);
  if (extras.length > 0) {
    parts.push(extras.join(", "));
  }

  return parts.join(" ");
}

/**
 * Build the line-format transport.
 * Accepts the same options as pino-roll (file, frequency, size, mkdir, etc.).
 */
async function lineTransport(opts) {
  const rollStream = await pinoRoll(opts);

  return build(
    async function (source) {
      for await (const obj of source) {
        const line = formatLine(obj) + "\n";
        rollStream.write(line);
      }
    },
    {
      close: async () => {
        rollStream.end();
      },
    }
  );
}

// Expose internals for testing
lineTransport.formatLine = formatLine;
lineTransport.formatValue = formatValue;

module.exports = lineTransport;
