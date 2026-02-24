/**
 * OpenAI LLM client using official OpenAI SDK.
 * Works with OpenAI, LiteLLM, and other OpenAI-compatible services.
 */
import OpenAI from "openai";
import type { LanguageModel, Message } from "./llm-types.ts";

export interface OpenAIClientConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  headers?: Record<string, string>;
}

/** Convert internal Message[] to OpenAI ChatCompletionMessageParam[]. Exported for testing. */
export function toOpenAIMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool" as const,
        content: msg.content,
        tool_call_id: msg.toolCallId!,
      };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    return {
      role: msg.role as "user" | "assistant" | "system",
      content: msg.content,
    };
  });
}

/**
 * Create a LanguageModel from OpenAI SDK client.
 */
export function createOpenAICompatibleModel(config: OpenAIClientConfig): LanguageModel {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.headers,
  });

  return {
    provider: "openai",
    modelId: config.model,

    async generate(options) {
      const messages = toOpenAIMessages(options.messages);
      if (options.system) {
        messages.unshift({ role: "system", content: options.system });
      }

      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: config.model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        top_p: options.topP,
        stream: false,
      };

      if (options.tools?.length) {
        params.tools = options.tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters as Record<string, unknown>,
          },
        }));
        if (options.toolChoice) {
          params.tool_choice = options.toolChoice;
        }
      }

      const response = await client.chat.completions.create(params);
      const choice = response.choices[0];
      if (!choice) {
        throw new Error("No response from OpenAI model");
      }

      const toolCalls = choice.message.tool_calls
        ?.filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === "function")
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        }));

      return {
        text: choice.message.content || "",
        finishReason: choice.finish_reason,
        toolCalls: toolCalls?.length ? toolCalls : undefined,
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
        },
      };
    },
  };
}
