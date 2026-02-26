/**
 * Context window sizes for known LLM models.
 * Used by compact trigger to determine when session is too large.
 */

const CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,

  // Anthropic
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-haiku-3-20250307": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Get context window size for a model. Falls back to 128k for unknown models. */
export function getContextWindowSize(modelId: string): number {
  return CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
}
