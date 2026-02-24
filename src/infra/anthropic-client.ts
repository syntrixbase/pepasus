/**
 * Anthropic LLM client using official Anthropic SDK.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LanguageModel, Message } from "./llm-types.ts";

export interface AnthropicClientConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  headers?: Record<string, string>;
}

/** Convert internal Message[] to Anthropic MessageParam[]. Exported for testing. */
export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: msg.toolCallId!,
            content: msg.content,
          },
        ],
      };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const content: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] = [];
      if (msg.content) {
        content.push({ type: "text" as const, text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      return { role: "assistant" as const, content };
    }
    return {
      role: msg.role as "user" | "assistant",
      content: msg.content,
    };
  });
}

/**
 * Create a LanguageModel from Anthropic SDK client.
 */
export function createAnthropicCompatibleModel(config: AnthropicClientConfig): LanguageModel {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.headers,
  });

  return {
    provider: "anthropic",
    modelId: config.model,

    async generate(options) {
      const messages = toAnthropicMessages(options.messages);

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: config.model,
        system: options.system,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens || 4096,
        top_p: options.topP,
      };

      if (options.tools?.length) {
        params.tools = options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }));
      }

      const response = await client.messages.create(params);

      const textContent = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("");

      const toolUseBlocks = response.content.filter(
        (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
      );
      const toolCalls = toolUseBlocks.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.input as Record<string, unknown>,
      }));

      return {
        text: textContent,
        finishReason: response.stop_reason || "stop",
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
        },
      };
    },
  };
}
