/**
 * Generate a short unique identifier.
 *
 * Takes the first 64 bits of a UUID v4 and returns them as a 16-char hex string.
 * Example: "f84c87422db644fd"
 *
 * Collision probability: ~1 in 2^64 ≈ 1.8×10^19 — safe for task/event IDs.
 */
export function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
