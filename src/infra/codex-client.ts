/**
 * Codex LLM client — OpenAI Responses API implementation.
 *
 * Implements the LanguageModel interface using the Codex Responses API
 * (POST /codex/responses) instead of the standard Chat Completions API.
 *
 * Key differences from Chat Completions:
 * - Messages use `input` items (not `messages` array)
 * - System prompt goes into `instructions` field
 * - Tool calls use `function_call` / `function_call_output` items
 * - Always sends `store: false`
 */
import type { LanguageModel, Message, GenerateTextResult } from "./llm-types.ts";
import type { ToolDefinition } from "../models/tool.ts";
import type { ToolCall } from "../models/tool.ts";
import { getLogger } from "./logger.ts";

const logger = getLogger("llm.codex");

export interface CodexClientConfig {
  baseURL: string;          // e.g. "https://chatgpt.com/backend-api"
  model: string;            // e.g. "gpt-5.3-codex"
  accessToken: string;      // OAuth access token
  accountId: string;        // ChatGPT account ID
}

// ── Input item types for Responses API ──

interface MessageItem {
  type: "message";
  role: "user" | "assistant";
  content: string;
}

interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type InputItem = MessageItem | FunctionCallItem | FunctionCallOutputItem;

// ── Response types ──

interface ResponseOutputMessage {
  type: "message";
  role: "assistant";
  content: Array<{ type: "output_text"; text: string }>;
}

interface ResponseOutputFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

type ResponseOutputItem = ResponseOutputMessage | ResponseOutputFunctionCall;

interface CodexResponse {
  id: string;
  status: "completed" | "failed" | "in_progress";
  output: ResponseOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: { message: string };
}

// ── Message conversion ──

/** Convert Pegasus Message[] to Responses API input items. */
export function toResponsesInput(messages: Message[]): InputItem[] {
  const items: InputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "user" || (msg.role === "assistant" && !msg.toolCalls?.length)) {
      items.push({
        type: "message",
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    } else if (msg.role === "assistant" && msg.toolCalls?.length) {
      // Assistant message with tool calls → function_call items
      // If there's also text content, emit a message item first
      if (msg.content) {
        items.push({
          type: "message",
          role: "assistant",
          content: msg.content,
        });
      }
      for (const tc of msg.toolCalls) {
        items.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: typeof tc.arguments === "string"
            ? tc.arguments
            : JSON.stringify(tc.arguments),
        });
      }
    } else if (msg.role === "tool") {
      // Tool result → function_call_output
      items.push({
        type: "function_call_output",
        call_id: msg.toolCallId ?? "",
        output: msg.content,
      });
    }
    // system messages are handled via `instructions` field, not input items
  }

  return items;
}

/** Convert Pegasus ToolDefinition[] to Responses API tool format. */
export function toResponsesTools(tools: ToolDefinition[]): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
  }));
}

/** Parse Codex response output into GenerateTextResult. */
function parseCodexResponse(resp: CodexResponse): GenerateTextResult {
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const item of resp.output) {
    if (item.type === "message") {
      // Collect text from content parts
      for (const part of item.content) {
        if (part.type === "output_text") {
          text += part.text;
        }
      }
    } else if (item.type === "function_call") {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(item.arguments);
      } catch {
        parsedArgs = { raw: item.arguments };
      }
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: parsedArgs,
      });
    }
  }

  return {
    text,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      promptTokens: resp.usage?.input_tokens ?? 0,
      completionTokens: resp.usage?.output_tokens ?? 0,
    },
  };
}

// ── Client factory ──

/**
 * Create a LanguageModel that uses the Codex Responses API.
 *
 * Uses non-streaming mode (stream: false) matching Pegasus's current pattern.
 */
export function createCodexModel(config: CodexClientConfig): LanguageModel {
  return {
    provider: "openai-codex",
    modelId: config.model,

    async generate(options) {
      // Build input items from messages
      const input = toResponsesInput(options.messages);

      // Build request body
      const body: Record<string, unknown> = {
        model: config.model,
        input,
        stream: false,
        store: false,
      };

      // System prompt → instructions field
      if (options.system) {
        body.instructions = options.system;
      }

      // Tools
      if (options.tools?.length) {
        body.tools = toResponsesTools(options.tools);
        if (options.toolChoice) {
          body.tool_choice = options.toolChoice;
        }
      }

      // Temperature / max tokens
      if (options.temperature !== undefined) {
        body.temperature = options.temperature;
      }
      if (options.maxTokens !== undefined) {
        body.max_output_tokens = options.maxTokens;
      }

      // Build headers
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
        "chatgpt-account-id": config.accountId,
      };

      const url = `${config.baseURL}/codex/responses`;

      const startTime = Date.now();
      logger.info(
        {
          model: config.model,
          inputItems: input.length,
          hasTools: !!options.tools?.length,
          toolCount: options.tools?.length ?? 0,
        },
        "codex_request_start",
      );

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (error) {
        const durationMs = Date.now() - startTime;
        logger.error(
          {
            model: config.model,
            durationMs,
            error: error instanceof Error ? error.message : String(error),
          },
          "codex_request_error",
        );
        throw error;
      }

      if (!response.ok) {
        const durationMs = Date.now() - startTime;
        const errorText = await response.text();
        logger.error(
          {
            model: config.model,
            status: response.status,
            durationMs,
            error: errorText,
          },
          "codex_request_error",
        );
        throw new Error(`Codex API error: ${response.status} ${errorText}`);
      }

      const durationMs = Date.now() - startTime;
      const codexResp = await response.json() as CodexResponse;

      if (codexResp.status === "failed") {
        throw new Error(`Codex response failed: ${codexResp.error?.message ?? "unknown error"}`);
      }

      const result = parseCodexResponse(codexResp);

      logger.info(
        {
          model: config.model,
          durationMs,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          hasToolCalls: !!result.toolCalls?.length,
        },
        "codex_request_done",
      );

      return result;
    },
  };
}
