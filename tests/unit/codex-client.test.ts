/**
 * Unit tests for Codex client — message conversion + generate() via mock server.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { toResponsesInput, toResponsesTools, createCodexModel } from "../../src/infra/codex-client.ts";
import type { Message } from "../../src/infra/llm-types.ts";
import type { ToolDefinition } from "../../src/models/tool.ts";

// ── Mock Server ─────────────────────────────────────

type RequestHandler = (req: Request) => Response | Promise<Response>;

interface MockServer {
  server: ReturnType<typeof Bun.serve>;
  baseURL: string;
  setHandler: (handler: RequestHandler) => void;
  lastRequestBody: () => Record<string, unknown> | undefined;
}

function createMockServer(port: number): MockServer {
  let handler: RequestHandler = () => new Response("not configured", { status: 500 });
  let _lastBody: Record<string, unknown> | undefined;

  const server = Bun.serve({
    port,
    async fetch(req) {
      try {
        const clone = req.clone();
        _lastBody = (await clone.json()) as Record<string, unknown>;
      } catch {
        _lastBody = undefined;
      }
      return handler(req);
    },
  });

  return {
    server,
    baseURL: `http://localhost:${port}`,
    setHandler(h: RequestHandler) {
      handler = h;
      _lastBody = undefined;
    },
    lastRequestBody() {
      return _lastBody;
    },
  };
}

/**
 * Build an SSE response from a CodexResponse-like object.
 * Emits response.output_item.done for each output item,
 * then response.completed with the full response.
 */
function sseResponse(resp: Record<string, unknown>): Response {
  const output = (resp.output as Array<Record<string, unknown>>) ?? [];
  const lines: string[] = [];

  // Emit each output item
  for (const item of output) {
    lines.push(`event: response.output_item.done`);
    lines.push(`data: ${JSON.stringify({ item })}`);
    lines.push("");
  }

  // Emit response.completed
  lines.push(`event: response.completed`);
  lines.push(`data: ${JSON.stringify({ response: resp })}`);
  lines.push("");
  lines.push(""); // Trailing double-newline to terminate last SSE event

  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ── Codex Response Builders ─────────────────────────

function codexResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp-test",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello from Codex!" }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

// ── Fixtures ────────────────────────────────────────

const simpleMessages: Message[] = [{ role: "user", content: "Hi" }];

const toolDefs: ToolDefinition[] = [
  {
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
];

// ── toResponsesInput tests ──────────────────────────

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

    it("should handle tool result without toolCallId", () => {
      const messages: Message[] = [
        { role: "tool", content: "output" },
      ];
      const items = toResponsesInput(messages);
      expect(items).toEqual([
        { type: "function_call_output", call_id: "", output: "output" },
      ]);
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

  // ── createCodexModel.generate tests ─────────────────

  describe("createCodexModel.generate", () => {
    let mock: MockServer;

    beforeAll(() => {
      mock = createMockServer(18930);
    });

    afterAll(() => {
      mock.server.stop(true);
    });

    function createModel() {
      return createCodexModel({
        baseURL: mock.baseURL,
        model: "gpt-5.3-codex",
        getAccessToken: async () => "test-token",
        accountId: "acct-123",
      });
    }

    it("returns provider and modelId correctly", () => {
      const model = createModel();
      expect(model.provider).toBe("openai-codex");
      expect(model.modelId).toBe("gpt-5.3-codex");
    });

    it("generates text successfully (no tools)", async () => {
      mock.setHandler(() => sseResponse(codexResponse()));

      const model = createModel();
      const result = await model.generate({ messages: simpleMessages });

      expect(result.text).toBe("Hello from Codex!");
      expect(result.finishReason).toBe("stop");
      expect(result.toolCalls).toBeUndefined();
      expect(result.usage.promptTokens).toBe(10);
      expect(result.usage.completionTokens).toBe(5);
    });

    it("sends correct request body structure", async () => {
      mock.setHandler(() => sseResponse(codexResponse()));

      const model = createModel();
      await model.generate({ messages: simpleMessages });

      const body = mock.lastRequestBody();
      expect(body).toBeDefined();
      expect(body!["model"]).toBe("gpt-5.3-codex");
      expect(body!["stream"]).toBe(true);
      expect(body!["store"]).toBe(false);
      expect(body!["input"]).toBeDefined();
    });

    it("sends system prompt as instructions field", async () => {
      mock.setHandler(() => sseResponse(codexResponse()));

      const model = createModel();
      await model.generate({
        messages: simpleMessages,
        system: "You are a helpful assistant.",
      });

      const body = mock.lastRequestBody();
      expect(body!["instructions"]).toBe("You are a helpful assistant.");
    });

    it("does not include instructions when no system prompt", async () => {
      mock.setHandler(() => sseResponse(codexResponse()));

      const model = createModel();
      await model.generate({ messages: simpleMessages });

      const body = mock.lastRequestBody();
      expect(body!["instructions"]).toBeUndefined();
    });

    it("sends tools in request body", async () => {
      mock.setHandler(() => sseResponse(codexResponse()));

      const model = createModel();
      await model.generate({
        messages: simpleMessages,
        tools: toolDefs,
        toolChoice: "auto",
      });

      const body = mock.lastRequestBody();
      const tools = body!["tools"] as Array<{ type: string; name: string }>;
      expect(tools).toHaveLength(1);
      expect(tools[0]!.type).toBe("function");
      expect(tools[0]!.name).toBe("get_weather");
      expect(body!["tool_choice"]).toBe("auto");
    });

    it("does not send tools/tool_choice when not provided", async () => {
      mock.setHandler(() => sseResponse(codexResponse()));

      const model = createModel();
      await model.generate({ messages: simpleMessages });

      const body = mock.lastRequestBody();
      expect(body!["tools"]).toBeUndefined();
      expect(body!["tool_choice"]).toBeUndefined();
    });

    it("sends temperature and maxTokens", async () => {
      mock.setHandler(() => sseResponse(codexResponse()));

      const model = createModel();
      await model.generate({
        messages: simpleMessages,
        temperature: 0.7,
        maxTokens: 512,
      });

      const body = mock.lastRequestBody();
      expect(body!["temperature"]).toBe(0.7);
      expect(body!["max_output_tokens"]).toBe(512);
    });

    it("does not send temperature/maxTokens when not provided", async () => {
      mock.setHandler(() => sseResponse(codexResponse()));

      const model = createModel();
      await model.generate({ messages: simpleMessages });

      const body = mock.lastRequestBody();
      expect(body!["temperature"]).toBeUndefined();
      expect(body!["max_output_tokens"]).toBeUndefined();
    });

    it("sends correct headers", async () => {
      let capturedHeaders: Headers | undefined;
      mock.setHandler((req) => {
        capturedHeaders = req.headers;
        return sseResponse(codexResponse());
      });

      const model = createModel();
      await model.generate({ messages: simpleMessages });

      expect(capturedHeaders?.get("authorization")).toBe("Bearer test-token");
      expect(capturedHeaders?.get("content-type")).toBe("application/json");
      expect(capturedHeaders?.get("chatgpt-account-id")).toBe("acct-123");
    });

    it("sends request to /codex/responses endpoint", async () => {
      let capturedUrl: string | undefined;
      mock.setHandler((req) => {
        capturedUrl = new URL(req.url).pathname;
        return sseResponse(codexResponse());
      });

      const model = createModel();
      await model.generate({ messages: simpleMessages });

      expect(capturedUrl).toBe("/codex/responses");
    });

    it("generates with tool calls in response", async () => {
      mock.setHandler(() =>
        sseResponse(
          codexResponse({
            output: [
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_abc",
                name: "get_weather",
                arguments: '{"city":"London"}',
              },
            ],
          }),
        ),
      );

      const model = createModel();
      const result = await model.generate({
        messages: simpleMessages,
        tools: toolDefs,
      });

      expect(result.text).toBe("");
      expect(result.finishReason).toBe("tool_calls");
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.id).toBe("call_abc");
      expect(result.toolCalls![0]!.name).toBe("get_weather");
      expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
    });

    it("handles mixed text and tool calls in response", async () => {
      mock.setHandler(() =>
        sseResponse(
          codexResponse({
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Let me check." }],
              },
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Tokyo"}',
              },
            ],
          }),
        ),
      );

      const model = createModel();
      const result = await model.generate({ messages: simpleMessages, tools: toolDefs });

      expect(result.text).toBe("Let me check.");
      expect(result.finishReason).toBe("tool_calls");
      expect(result.toolCalls).toHaveLength(1);
    });

    it("handles invalid JSON in function_call arguments", async () => {
      mock.setHandler(() =>
        sseResponse(
          codexResponse({
            output: [
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_bad",
                name: "test_tool",
                arguments: "not valid json {{{",
              },
            ],
          }),
        ),
      );

      const model = createModel();
      const result = await model.generate({ messages: simpleMessages });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.arguments).toEqual({ raw: "not valid json {{{" });
    });

    it("handles multiple tool calls in response", async () => {
      mock.setHandler(() =>
        sseResponse(
          codexResponse({
            output: [
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "get_weather",
                arguments: '{"city":"London"}',
              },
              {
                type: "function_call",
                id: "fc_2",
                call_id: "call_2",
                name: "get_weather",
                arguments: '{"city":"Paris"}',
              },
            ],
          }),
        ),
      );

      const model = createModel();
      const result = await model.generate({ messages: simpleMessages });

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
      expect(result.toolCalls![1]!.arguments).toEqual({ city: "Paris" });
    });

    it("handles response with no usage data", async () => {
      mock.setHandler(() =>
        sseResponse(codexResponse({ usage: undefined })),
      );

      const model = createModel();
      const result = await model.generate({ messages: simpleMessages });

      expect(result.usage.promptTokens).toBe(0);
      expect(result.usage.completionTokens).toBe(0);
    });

    it("throws on HTTP error", async () => {
      mock.setHandler(() =>
        new Response("Unauthorized", { status: 401 }),
      );

      const model = createModel();
      await expect(model.generate({ messages: simpleMessages })).rejects.toThrow(
        "Codex API error: 401",
      );
    });

    it("throws on failed response status", async () => {
      mock.setHandler(() => {
        const lines = [
          `event: response.failed`,
          `data: ${JSON.stringify({ response: { id: "resp-fail", status: "failed", error: { message: "Model overloaded" } } })}`,
          "",
          "",
        ];
        return new Response(lines.join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const model = createModel();
      await expect(model.generate({ messages: simpleMessages })).rejects.toThrow(
        "Codex response failed: Model overloaded",
      );
    });

    it("throws on failed response with no error message", async () => {
      mock.setHandler(() => {
        const lines = [
          `event: response.failed`,
          `data: ${JSON.stringify({ response: { id: "resp-fail", status: "failed" } })}`,
          "",
          "",
        ];
        return new Response(lines.join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const model = createModel();
      await expect(model.generate({ messages: simpleMessages })).rejects.toThrow(
        "Codex response failed: unknown error",
      );
    });

    it("throws on network error", async () => {
      const model = createCodexModel({
        baseURL: "http://localhost:19999", // nothing listening
        model: "test",
        getAccessToken: async () => "tok",
        accountId: "acct",
      });

      await expect(model.generate({ messages: simpleMessages })).rejects.toThrow();
    });

    it("handles empty output array", async () => {
      mock.setHandler(() => sseResponse(codexResponse({ output: [] })));

      const model = createModel();
      const result = await model.generate({ messages: simpleMessages });

      expect(result.text).toBe("");
      expect(result.finishReason).toBe("stop");
      expect(result.toolCalls).toBeUndefined();
    });
  });
});
