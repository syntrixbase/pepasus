import { describe, it, expect } from "bun:test";
import { toResponsesInput, toResponsesTools } from "../../src/infra/codex-client.ts";
import type { Message } from "../../src/infra/llm-types.ts";
import type { ToolDefinition } from "../../src/models/tool.ts";

describe("Codex client", () => {
  describe("toResponsesInput", () => {
    it("should convert user message", () => {
      const messages: Message[] = [
        { role: "user", content: "hello" },
      ];
      const items = toResponsesInput(messages);
      expect(items).toEqual([
        { type: "message", role: "user", content: "hello" },
      ]);
    });

    it("should convert assistant text message", () => {
      const messages: Message[] = [
        { role: "assistant", content: "hi there" },
      ];
      const items = toResponsesInput(messages);
      expect(items).toEqual([
        { type: "message", role: "assistant", content: "hi there" },
      ]);
    });

    it("should convert assistant with tool calls to function_call items", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "web_search", arguments: { query: "weather" } },
          ],
        },
      ];
      const items = toResponsesInput(messages);
      expect(items).toEqual([
        {
          type: "function_call",
          call_id: "call_1",
          name: "web_search",
          arguments: '{"query":"weather"}',
        },
      ]);
    });

    it("should convert assistant with text + tool calls", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "Let me search",
          toolCalls: [
            { id: "call_1", name: "web_search", arguments: { query: "test" } },
          ],
        },
      ];
      const items = toResponsesInput(messages);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ type: "message", role: "assistant", content: "Let me search" });
      expect(items[1]!.type).toBe("function_call");
    });

    it("should convert tool result to function_call_output", () => {
      const messages: Message[] = [
        { role: "tool", content: "search results here", toolCallId: "call_1" },
      ];
      const items = toResponsesInput(messages);
      expect(items).toEqual([
        { type: "function_call_output", call_id: "call_1", output: "search results here" },
      ]);
    });

    it("should skip system messages (handled by instructions field)", () => {
      const messages: Message[] = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
      ];
      const items = toResponsesInput(messages);
      expect(items).toHaveLength(1);
      expect(items[0]!.type).toBe("message");
    });

    it("should handle full conversation round-trip", () => {
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
      const items = toResponsesInput(messages);
      expect(items).toHaveLength(4);
      expect(items[0]!.type).toBe("message");
      expect(items[1]!.type).toBe("function_call");
      expect(items[2]!.type).toBe("function_call_output");
      expect(items[3]!.type).toBe("message");
    });

    it("should handle string arguments in tool calls", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "test", arguments: '{"key":"value"}' as unknown as Record<string, unknown> }],
        },
      ];
      const items = toResponsesInput(messages);
      const fc = items[0] as { arguments: string };
      expect(fc.arguments).toBe('{"key":"value"}');
    });
  });

  describe("toResponsesTools", () => {
    it("should convert tool definitions to Responses format", () => {
      const tools: ToolDefinition[] = [
        {
          name: "web_search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ];
      const result = toResponsesTools(tools);
      expect(result).toEqual([
        {
          type: "function",
          name: "web_search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ]);
    });

    it("should handle multiple tools", () => {
      const tools: ToolDefinition[] = [
        { name: "a", description: "Tool A", parameters: {} },
        { name: "b", description: "Tool B", parameters: {} },
      ];
      const result = toResponsesTools(tools);
      expect(result).toHaveLength(2);
      expect(result[0]!.type).toBe("function");
      expect(result[1]!.type).toBe("function");
    });
  });
});
