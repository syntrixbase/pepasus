/**
 * Unit tests for pi-ai adapter — message conversion, tool conversion,
 * result mapping, and model creation.
 */
import { describe, it, expect } from "bun:test";
import {
  toPiAiContext,
  toPiAiTool,
  fromPiAiResult,
} from "@pegasus/infra/pi-ai-adapter.ts";
import type { Message } from "@pegasus/infra/llm-types.ts";
import type { ToolDefinition } from "@pegasus/models/tool.ts";
import type { AssistantMessage, StopReason, Api } from "@mariozechner/pi-ai";

// ── Helper to create a pi-ai AssistantMessage ──

function makeAssistantMessage(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    api: "openai-completions" as Api,
    provider: "openai",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as StopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── toPiAiContext tests ──

describe("toPiAiContext", () => {
  it("converts user messages", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("user");
    expect((ctx.messages[0] as any).content).toBe("hello");
    expect(ctx.systemPrompt).toBeUndefined();
  });

  it("extracts system messages to systemPrompt", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hello" },
    ];
    const ctx = toPiAiContext(messages);

    // System messages should not appear in messages array
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("user");
    // System content goes to systemPrompt
    expect(ctx.systemPrompt).toBe("You are helpful");
  });

  it("combines explicit system param with system role messages", () => {
    const messages: Message[] = [
      { role: "system", content: "Rule 1" },
      { role: "user", content: "hello" },
    ];
    const ctx = toPiAiContext(messages, "Base instructions");

    expect(ctx.systemPrompt).toBe("Base instructions\n\nRule 1");
    expect(ctx.messages).toHaveLength(1);
  });

  it("converts assistant messages without tool calls", () => {
    const messages: Message[] = [{ role: "assistant", content: "hi there" }];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("assistant");
    const content = (ctx.messages[0] as any).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("hi there");
  });

  it("converts assistant messages with tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "Let me check",
        toolCalls: [{ id: "tc1", name: "get_weather", arguments: { city: "London" } }],
      },
    ];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    const content = (ctx.messages[0] as any).content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("Let me check");
    expect(content[1].type).toBe("toolCall");
    expect(content[1].id).toBe("tc1");
    expect(content[1].name).toBe("get_weather");
    expect(content[1].arguments).toEqual({ city: "London" });
  });

  it("converts assistant messages with tool calls but no text", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }],
      },
    ];
    const ctx = toPiAiContext(messages);

    const content = (ctx.messages[0] as any).content;
    // Empty content should not produce a text block, just the toolCall
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("toolCall");
  });

  it("converts tool result messages", () => {
    const messages: Message[] = [
      { role: "tool", content: "result data", toolCallId: "tc1" },
    ];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("toolResult");
    const toolResult = ctx.messages[0] as any;
    expect(toolResult.toolCallId).toBe("tc1");
    expect(toolResult.content).toEqual([{ type: "text", text: "result data" }]);
    expect(toolResult.isError).toBe(false);
  });

  it("converts tool result with missing toolCallId", () => {
    const messages: Message[] = [{ role: "tool", content: "output" }];
    const ctx = toPiAiContext(messages);

    const toolResult = ctx.messages[0] as any;
    expect(toolResult.toolCallId).toBe("");
  });

  it("includes tools in context when provided", () => {
    const tools: ToolDefinition[] = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ];
    const ctx = toPiAiContext([{ role: "user", content: "hi" }], undefined, tools);

    expect(ctx.tools).toHaveLength(1);
    expect(ctx.tools![0]!.name).toBe("get_weather");
  });

  it("handles full conversation round-trip", () => {
    const messages: Message[] = [
      { role: "user", content: "What is 2+2?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "calculator", arguments: { expr: "2+2" } }],
      },
      { role: "tool", content: "4", toolCallId: "c1" },
      { role: "assistant", content: "The answer is 4." },
    ];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(4);
    expect(ctx.messages[0]!.role).toBe("user");
    expect(ctx.messages[1]!.role).toBe("assistant");
    expect(ctx.messages[2]!.role).toBe("toolResult");
    expect(ctx.messages[3]!.role).toBe("assistant");
  });

  it("does not include tools when none provided", () => {
    const ctx = toPiAiContext([{ role: "user", content: "hi" }]);
    expect(ctx.tools).toBeUndefined();
  });
});

// ── toPiAiTool tests ──

describe("toPiAiTool", () => {
  it("converts tool definition with JSON Schema parameters", () => {
    const tool: ToolDefinition = {
      name: "search",
      description: "Search the web",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    const result = toPiAiTool(tool);

    expect(result.name).toBe("search");
    expect(result.description).toBe("Search the web");
    // Type.Unsafe wraps the schema — it should be accessible
    expect(result.parameters).toBeDefined();
  });

  it("converts tool definition with empty parameters", () => {
    const tool: ToolDefinition = {
      name: "ping",
      description: "Ping the server",
      parameters: {},
    };
    const result = toPiAiTool(tool);

    expect(result.name).toBe("ping");
    expect(result.description).toBe("Ping the server");
    expect(result.parameters).toBeDefined();
  });
});

// ── fromPiAiResult tests ──

describe("fromPiAiResult", () => {
  it("extracts text from text content blocks", () => {
    const msg = makeAssistantMessage({
      content: [{ type: "text", text: "Hello world!" }],
    });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("Hello world!");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
  });

  it("concatenates multiple text blocks", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "text", text: "First part. " },
        { type: "text", text: "Second part." },
      ],
    });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("First part. Second part.");
  });

  it("extracts tool calls", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "get_weather",
          arguments: { city: "London" },
        },
      ],
      stopReason: "toolUse",
    });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.id).toBe("call_1");
    expect(result.toolCalls![0]!.name).toBe("get_weather");
    expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
  });

  it("handles mixed text and tool calls", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "text", text: "Let me check." },
        {
          type: "toolCall",
          id: "call_2",
          name: "search",
          arguments: { q: "test" },
        },
      ],
      stopReason: "toolUse",
    });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("Let me check.");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("handles multiple tool calls", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "get_weather",
          arguments: { city: "London" },
        },
        {
          type: "toolCall",
          id: "call_2",
          name: "get_weather",
          arguments: { city: "Paris" },
        },
      ],
      stopReason: "toolUse",
    });
    const result = fromPiAiResult(msg);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
    expect(result.toolCalls![1]!.arguments).toEqual({ city: "Paris" });
  });

  it("maps stopReason correctly", () => {
    expect(fromPiAiResult(makeAssistantMessage({ stopReason: "stop" })).finishReason).toBe("stop");
    expect(fromPiAiResult(makeAssistantMessage({ stopReason: "length" })).finishReason).toBe("length");
    expect(fromPiAiResult(makeAssistantMessage({ stopReason: "toolUse" })).finishReason).toBe("tool_calls");
    expect(fromPiAiResult(makeAssistantMessage({ stopReason: "error" })).finishReason).toBe("error");
  });

  it("maps usage correctly", () => {
    const msg = makeAssistantMessage({
      usage: {
        input: 42,
        output: 17,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 59,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const result = fromPiAiResult(msg);

    expect(result.usage.promptTokens).toBe(42);
    expect(result.usage.completionTokens).toBe(17);
  });

  it("skips thinking content blocks", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "thinking", thinking: "internal reasoning..." } as any,
        { type: "text", text: "Final answer." },
      ],
    });
    const result = fromPiAiResult(msg);

    // thinking blocks should be filtered out by the text filter
    expect(result.text).toBe("Final answer.");
    expect(result.toolCalls).toBeUndefined();
  });

  it("handles empty content array", () => {
    const msg = makeAssistantMessage({ content: [] });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });
});
