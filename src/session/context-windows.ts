/**
 * Context window sizes for known LLM models.
 * Used by compact trigger to determine when session is too large.
 *
 * Data sourced from OpenRouter API (https://openrouter.ai/api/v1/models)
 * and provider documentation. Last updated: 2026-02-26.
 *
 * Model IDs are stored WITHOUT provider prefix (e.g. "gpt-4o" not "openai/gpt-4o")
 * to match what LanguageModel.modelId typically contains.
 */

const CONTEXT_WINDOWS: Record<string, number> = {
  // ── OpenAI ──

  // GPT-4.1 family (1M context)
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,

  // GPT-5 family (400k context)
  "gpt-5": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-5-nano": 400_000,
  "gpt-5-pro": 400_000,
  "gpt-5-chat": 128_000,
  "gpt-5-codex": 400_000,
  "gpt-5-image": 400_000,
  "gpt-5-image-mini": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5.1-chat": 128_000,
  "gpt-5.1-codex": 400_000,
  "gpt-5.1-codex-max": 400_000,
  "gpt-5.1-codex-mini": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.2-chat": 128_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.2-pro": 400_000,
  "gpt-5.3-codex": 400_000,

  // GPT-4o family (128k context)
  "gpt-4o": 128_000,
  "gpt-4o-2024-05-13": 128_000,
  "gpt-4o-2024-08-06": 128_000,
  "gpt-4o-2024-11-20": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4o-mini-2024-07-18": 128_000,

  // GPT-4 Turbo / GPT-4
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_191,
  "gpt-3.5-turbo": 16_385,
  "gpt-3.5-turbo-16k": 16_385,

  // o-series reasoning models
  "o1": 200_000,
  "o1-pro": 200_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o3-mini-high": 200_000,
  "o3-pro": 200_000,
  "o3-deep-research": 200_000,
  "o4-mini": 200_000,
  "o4-mini-high": 200_000,
  "o4-mini-deep-research": 200_000,

  // ── Anthropic ──

  // Claude 4.6 (1M context)
  "claude-sonnet-4.6": 1_000_000,
  "claude-opus-4.6": 1_000_000,

  // Claude 4.5
  "claude-sonnet-4.5": 1_000_000,
  "claude-opus-4.5": 200_000,
  "claude-haiku-4.5": 200_000,

  // Claude 4.x
  "claude-opus-4": 200_000,
  "claude-opus-4.1": 200_000,
  "claude-sonnet-4": 1_000_000,

  // Claude 3.x
  "claude-3.7-sonnet": 200_000,
  "claude-3.5-sonnet": 200_000,
  "claude-3.5-haiku": 200_000,
  "claude-3-haiku": 200_000,

  // Date-stamped variants
  "claude-opus-4-20250514": 200_000,
  "claude-sonnet-4-20250514": 1_000_000,
  "claude-3-7-sonnet-20250219": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,

  // ── Google Gemini ──

  // Gemini 3.x
  "gemini-3.1-pro-preview": 1_048_576,
  "gemini-3-pro-preview": 1_048_576,
  "gemini-3-flash-preview": 1_048_576,

  // Gemini 2.5
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-pro-preview": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.5-flash-lite": 1_048_576,

  // Gemini 2.0
  "gemini-2.0-flash-001": 1_048_576,

  // Gemini 1.5
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,

  // ── Meta Llama ──

  // Llama 4
  "llama-4-maverick": 1_048_576,
  "llama-4-scout": 327_680,

  // Llama 3.3 / 3.1
  "llama-3.3-70b-instruct": 131_072,
  "llama-3.1-405b-instruct": 131_000,
  "llama-3.1-70b-instruct": 131_072,
  "llama-3.1-8b-instruct": 16_384,

  // Llama 3.2
  "llama-3.2-11b-vision-instruct": 131_072,
  "llama-3.2-3b-instruct": 131_072,
  "llama-3.2-1b-instruct": 60_000,

  // ── Mistral ──
  "mistral-large-2512": 262_144,
  "mistral-large-2411": 131_072,
  "mistral-large": 128_000,
  "mistral-medium-3.1": 131_072,
  "mistral-medium-3": 131_072,
  "mistral-small-3.2-24b-instruct": 131_072,
  "mistral-small-3.1-24b-instruct": 128_000,
  "mistral-nemo": 131_072,
  "codestral-2508": 256_000,
  "devstral-2512": 262_144,
  "devstral-medium": 131_072,
  "devstral-small": 131_072,

  // ── xAI Grok ──
  "grok-4": 256_000,
  "grok-4-fast": 2_000_000,
  "grok-4.1-fast": 2_000_000,
  "grok-3": 131_072,
  "grok-3-mini": 131_072,
  "grok-code-fast-1": 256_000,

  // ── DeepSeek ──
  "deepseek-chat": 163_840,
  "deepseek-chat-v3-0324": 163_840,
  "deepseek-chat-v3.1": 32_768,
  "deepseek-r1": 64_000,
  "deepseek-r1-0528": 163_840,
  "deepseek-v3.1-terminus": 163_840,
  "deepseek-v3.2": 163_840,
  "deepseek-v3.2-speciale": 163_840,
  "deepseek-reasoner": 163_840,

  // ── 智谱 GLM (Zhipu / z-ai) ──
  "glm-5": 204_800,
  "glm-4.7": 202_752,
  "glm-4.7-flash": 202_752,
  "glm-4.6": 202_752,
  "glm-4.6v": 131_072,
  "glm-4.5": 131_000,
  "glm-4.5-air": 131_072,
  "glm-4.5v": 65_536,
  "glm-4-32b": 128_000,
  // Legacy GLM-4 (via Zhipu direct API)
  "glm-4-plus": 128_000,
  "glm-4-long": 1_000_000,
  "glm-4-flash": 128_000,
  "glm-4": 128_000,
  "glm-4-air": 128_000,
  "glm-4-airx": 8_192,

  // ── 月之暗面 Kimi (Moonshot) ──
  "kimi-k2.5": 262_144,
  "kimi-k2": 131_072,
  "kimi-k2-0905": 131_072,
  "kimi-k2-thinking": 131_072,
  // Legacy moonshot API
  "moonshot-v1-8k": 8_000,
  "moonshot-v1-32k": 32_000,
  "moonshot-v1-128k": 128_000,

  // ── 阿里 通义千问 (Qwen) ──

  // Qwen 3.5
  "qwen3.5-397b-a17b": 262_144,
  "qwen3.5-122b-a10b": 262_144,
  "qwen3.5-35b-a3b": 262_144,
  "qwen3.5-27b": 262_144,
  "qwen3.5-plus-02-15": 1_000_000,
  "qwen3.5-flash-02-23": 1_000_000,

  // Qwen 3
  "qwen3-max": 262_144,
  "qwen3-max-thinking": 262_144,
  "qwen3-235b-a22b": 131_072,
  "qwen3-235b-a22b-2507": 262_144,
  "qwen3-next-80b-a3b-instruct": 262_144,
  "qwen3-30b-a3b": 40_960,
  "qwen3-30b-a3b-instruct-2507": 262_144,
  "qwen3-32b": 40_960,
  "qwen3-14b": 40_960,
  "qwen3-8b": 32_000,
  "qwen3-4b": 40_960,
  "qwen3-coder": 262_144,
  "qwen3-coder-plus": 1_000_000,
  "qwen3-coder-flash": 1_000_000,
  "qwen3-coder-next": 262_144,
  "qwen3-coder-30b-a3b-instruct": 160_000,

  // Qwen commercial API aliases
  "qwen-max": 32_768,
  "qwen-plus": 1_000_000,
  "qwen-turbo": 131_072,
  "qwen-vl-max": 131_072,
  "qwen-vl-plus": 131_072,
  "qwen-long": 10_000_000,

  // Qwen 2.5
  "qwen-2.5-72b-instruct": 32_768,
  "qwen-2.5-7b-instruct": 32_768,
  "qwen2.5-vl-32b-instruct": 128_000,
  "qwen2.5-coder-32b-instruct": 32_768,
  "qwq-32b": 32_768,

  // ── MiniMax ──
  "minimax-01": 1_000_192,
  "minimax-m1": 1_000_000,
  "minimax-m2.5": 196_608,
  "minimax-m2.1": 196_608,
  "minimax-m2": 196_608,
  "minimax-m2-her": 65_536,

  // ── 字节跳动 豆包 (ByteDance Seed) ──
  "seed-1.6": 262_144,
  "seed-1.6-flash": 262_144,
  // Legacy doubao API
  "doubao-pro-256k": 256_000,
  "doubao-pro-128k": 128_000,
  "doubao-pro-32k": 32_000,
  "doubao-lite-128k": 128_000,
  "doubao-lite-32k": 32_000,

  // ── 阶跃星辰 StepFun ──
  "step-3.5-flash": 256_000,

  // ── 百度 ERNIE (Baidu) ──
  "ernie-4.5-300b-a47b": 123_000,
  "ernie-4.5-21b-a3b": 120_000,
  "ernie-4.5-21b-a3b-thinking": 131_072,

  // ── 腾讯 Hunyuan (Tencent) ──
  "hunyuan-a13b-instruct": 131_072,

  // ── 美团 Meituan ──
  "longcat-flash-chat": 131_072,

  // ── 小米 Xiaomi ──
  "mimo-v2-flash": 262_144,

  // ── 百川 Baichuan ──
  "Baichuan4": 128_000,
  "Baichuan3-Turbo-128k": 128_000,

  // ── 零一万物 Yi (01.AI) ──
  "yi-lightning": 16_384,
  "yi-large": 32_768,
  "yi-medium-200k": 200_000,

  // ── Cohere ──
  "command-a": 256_000,
  "command-r-plus-08-2024": 128_000,

  // ── Amazon Nova ──
  "nova-premier-v1": 1_000_000,
  "nova-2-lite-v1": 1_000_000,
  "nova-pro-v1": 300_000,
  "nova-lite-v1": 300_000,
  "nova-micro-v1": 128_000,

  // ── Perplexity ──
  "sonar-pro": 200_000,
  "sonar": 127_072,

  // ── Writer ──
  "palmyra-x5": 1_040_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Get context window size for a model. Falls back to 128k for unknown models. */
export function getContextWindowSize(modelId: string): number {
  return CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
}
