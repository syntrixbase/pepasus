/**
 * Token counting utilities for different LLM providers.
 *
 * - TiktokenCounter: local token counting via tiktoken (OpenAI models)
 * - AnthropicAPICounter: remote token counting via Anthropic count_tokens API
 * - EstimateCounter: rough character-based fallback
 */
import { encoding_for_model, get_encoding } from "tiktoken";
import { getLogger } from "./logger.ts";

const log = getLogger("token_counter");

// ── Interface ────────────────────────────────────

export interface TokenCounter {
  count(text: string): Promise<number>;
}

// ── TiktokenCounter ──────────────────────────────

export class TiktokenCounter implements TokenCounter {
  private encoder;

  constructor(model?: string) {
    try {
      this.encoder = encoding_for_model((model as any) ?? "gpt-4o");
      log.debug({ model }, "tiktoken encoder created for model");
    } catch {
      this.encoder = get_encoding("cl100k_base");
      log.debug({ model }, "tiktoken model not found, falling back to cl100k_base");
    }
  }

  async count(text: string): Promise<number> {
    return this.encoder.encode(text).length;
  }
}

// ── AnthropicAPICounter ──────────────────────────

export class AnthropicAPICounter implements TokenCounter {
  constructor(
    private apiKey: string,
    private model: string = "claude-sonnet-4-20250514",
    private baseURL: string = "https://api.anthropic.com",
  ) {}

  async count(text: string): Promise<number> {
    const response = await fetch(`${this.baseURL}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic count_tokens failed: ${response.status}`);
    }

    const data = (await response.json()) as { input_tokens: number };
    return data.input_tokens;
  }
}

// ── EstimateCounter ──────────────────────────────

export class EstimateCounter implements TokenCounter {
  async count(text: string): Promise<number> {
    return Math.ceil(text.length / 3.5);
  }
}

// ── Factory ──────────────────────────────────────

export function createTokenCounter(
  provider: string,
  options?: { model?: string; apiKey?: string; baseURL?: string },
): TokenCounter {
  switch (provider) {
    case "openai":
    case "openai-compatible":
      return new TiktokenCounter(options?.model);
    case "anthropic":
      return new AnthropicAPICounter(
        options?.apiKey ?? "",
        options?.model,
        options?.baseURL,
      );
    default:
      log.info({ provider }, "unknown provider, using EstimateCounter");
      return new EstimateCounter();
  }
}
