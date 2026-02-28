/**
 * Time formatting utilities for passive time perception.
 *
 * Provides consistent timestamp formatting for embedding in LLM messages,
 * giving the model awareness of when events occurred and how long they took.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Format epoch milliseconds to "YYYY-MM-DD HH:MM:SS" (UTC).
 */
export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Format a bracketed timestamp for tool results, optionally with duration.
 *
 * Examples:
 *   [2026-02-28 14:30:05 | took 2.3s]
 *   [2026-02-28 14:30:05]
 */
export function formatToolTimestamp(
  epochMs: number,
  durationMs?: number,
): string {
  const ts = formatTimestamp(epochMs);
  if (durationMs != null) {
    const secs = (durationMs / 1000).toFixed(1);
    return `[${ts} | took ${secs}s]`;
  }
  return `[${ts}]`;
}
