/**
 * Context window sizes for known LLM models.
 * Used by compact trigger to determine when session is too large.
 */

const CONTEXT_WINDOWS: Record<string, number> = {
  // ── OpenAI ──

  // GPT-4.1 family (1M context)
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,

  // GPT-5 family
  "gpt-5": 272_000,
  "gpt-5-mini": 272_000,
  "gpt-5-nano": 272_000,
  "gpt-5.1": 272_000,
  "gpt-5.1-codex": 272_000,
  "gpt-5.1-codex-mini": 272_000,
  "gpt-5.2": 272_000,

  // GPT-4o family (128k context)
  "gpt-4o": 128_000,
  "gpt-4o-2024-08-06": 128_000,
  "gpt-4o-2024-11-20": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4o-mini-2024-07-18": 128_000,

  // GPT-4 Turbo
  "gpt-4-turbo": 128_000,
  "gpt-4-turbo-2024-04-09": 128_000,

  // GPT-4 (original)
  "gpt-4": 8_192,
  "gpt-4-0613": 8_192,
  "gpt-4-32k": 32_768,

  // GPT-3.5 Turbo
  "gpt-3.5-turbo": 16_385,
  "gpt-3.5-turbo-0125": 16_385,
  "gpt-3.5-turbo-16k": 16_385,

  // o-series reasoning models
  "o1": 200_000,
  "o1-2024-12-17": 200_000,
  "o1-mini": 128_000,
  "o1-mini-2024-09-12": 128_000,
  "o1-preview": 128_000,
  "o1-preview-2024-09-12": 128_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o3-mini-2025-01-31": 200_000,
  "o4-mini": 200_000,

  // ── Anthropic ──

  // Claude 4.x family
  "claude-opus-4-20250514": 200_000,
  "claude-opus-4-1-20250805": 200_000,
  "claude-opus-4-5-20251101": 200_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-sonnet-4-6": 200_000,

  // Claude 3.7
  "claude-3-7-sonnet-20250219": 200_000,

  // Claude 3.5
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-sonnet-20240620": 200_000,
  "claude-3-5-haiku-20241022": 200_000,

  // Claude 3
  "claude-3-opus-20240229": 200_000,
  "claude-3-sonnet-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,

  // ── Google Gemini ──

  // Gemini 2.5
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,

  // Gemini 2.0
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.0-flash-lite": 1_000_000,

  // Gemini 1.5
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,

  // ── Meta Llama ──

  // Llama 4
  "llama-4-scout": 10_000_000,
  "llama-4-maverick": 1_000_000,

  // Llama 3.3 / 3.1
  "llama-3.3-70b": 128_000,
  "llama-3.1-405b": 128_000,
  "llama-3.1-70b": 128_000,
  "llama-3.1-8b": 128_000,

  // Llama 3.2
  "llama-3.2-90b": 128_000,
  "llama-3.2-11b": 128_000,
  "llama-3.2-3b": 128_000,
  "llama-3.2-1b": 128_000,

  // ── Mistral ──
  "mistral-large-latest": 128_000,
  "mistral-medium-latest": 128_000,
  "mistral-small-latest": 128_000,

  // ── xAI ──
  "grok-3": 128_000,
  "grok-4": 256_000,

  // ── DeepSeek ──
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,

  // ── 智谱 GLM (Zhipu) ──
  "glm-4-plus": 128_000,
  "glm-4-long": 1_000_000,
  "glm-4-flash": 128_000,
  "glm-4": 128_000,
  "glm-4-air": 128_000,
  "glm-4-airx": 8_192,
  "glm-4-flashx": 128_000,
  "glm-3-turbo": 128_000,

  // ── 月之暗面 Kimi (Moonshot) ──
  "moonshot-v1-8k": 8_000,
  "moonshot-v1-32k": 32_000,
  "moonshot-v1-128k": 128_000,
  "kimi-latest": 128_000,

  // ── 阿里 通义千问 (Qwen) ──
  "qwen3-max": 262_144,
  "qwen3-plus": 131_072,
  "qwen3-turbo": 131_072,
  "qwen-max": 32_768,
  "qwen-max-latest": 131_072,
  "qwen-plus": 131_072,
  "qwen-plus-latest": 1_000_000,
  "qwen-turbo": 131_072,
  "qwen-turbo-latest": 1_000_000,
  "qwen-long": 10_000_000,
  "qwen2.5-72b-instruct": 131_072,
  "qwen2.5-32b-instruct": 131_072,
  "qwen2.5-14b-instruct": 131_072,
  "qwen2.5-7b-instruct": 131_072,

  // ── MiniMax ──
  "abab7-chat-preview": 245_760,
  "abab6.5s-chat": 245_760,
  "abab6.5-chat": 8_192,
  "abab5.5-chat": 16_384,

  // ── 百川 (Baichuan) ──
  "Baichuan4": 128_000,
  "Baichuan3-Turbo": 32_000,
  "Baichuan3-Turbo-128k": 128_000,
  "Baichuan2-Turbo": 32_000,

  // ── 零一万物 Yi (01.AI) ──
  "yi-lightning": 16_384,
  "yi-large": 32_768,
  "yi-large-turbo": 16_384,
  "yi-medium": 16_384,
  "yi-medium-200k": 200_000,
  "yi-spark": 16_384,

  // ── 字节跳动 豆包 (Doubao / Volcengine) ──
  "doubao-pro-256k": 256_000,
  "doubao-pro-128k": 128_000,
  "doubao-pro-32k": 32_000,
  "doubao-pro-4k": 4_000,
  "doubao-lite-128k": 128_000,
  "doubao-lite-32k": 32_000,
  "doubao-lite-4k": 4_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Get context window size for a model. Falls back to 128k for unknown models. */
export function getContextWindowSize(modelId: string): number {
  return CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
}
