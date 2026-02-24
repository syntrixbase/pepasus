/**
 * Unit tests for OpenAI and Anthropic LLM client generate() methods.
 *
 * Uses local Bun.serve mock servers so the SDK clients make real HTTP calls
 * to localhost, avoiding issues with SDK-internal fetch wrappers.
 * The toOpenAIMessages / toAnthropicMessages converters are already tested in infra.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createOpenAICompatibleModel } from "@pegasus/infra/openai-client.ts";
import { createAnthropicCompatibleModel } from "@pegasus/infra/anthropic-client.ts";
import type { Message } from "@pegasus/infra/llm-types.ts";
import type { ToolDefinition } from "@pegasus/models/tool.ts";

// ── Mock Server Helpers ──────────────────────────────

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
      // Capture request body for assertions
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

/** JSON response helper. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── Response Builders ────────────────────────────────

function openAIChatResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

function anthropicMessageResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text: "Hello!" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 },
    ...overrides,
  };
}

// ── Fixtures ─────────────────────────────────────────

const simpleMessages: Message[] = [{ role: "user", content: "Hi" }];

const toolDefs: ToolDefinition[] = [
  {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

// ── OpenAI Client ────────────────────────────────────

describe("createOpenAICompatibleModel.generate", () => {
  let mock: MockServer;

  beforeAll(() => {
    mock = createMockServer(18921);
  });

  afterAll(() => {
    mock.server.stop(true);
  });

  function createModel(overrides: Record<string, unknown> = {}) {
    return createOpenAICompatibleModel({
      apiKey: "sk-test",
      baseURL: `${mock.baseURL}/v1`,
      model: "test-model",
      ...overrides,
    });
  }

  it("returns provider and modelId correctly", () => {
    const model = createModel();
    expect(model.provider).toBe("openai");
    expect(model.modelId).toBe("test-model");
  });

  it("generates text successfully (no tools)", async () => {
    mock.setHandler(() => json(openAIChatResponse()));

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages });

    expect(result.text).toBe("Hello!");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
  });

  it("prepends system message when provided", async () => {
    mock.setHandler(() => json(openAIChatResponse()));

    const model = createModel();
    await model.generate({
      messages: simpleMessages,
      system: "You are a helpful assistant.",
      temperature: 0.5,
      maxTokens: 200,
      topP: 0.9,
    });

    const body = mock.lastRequestBody();
    expect(body).toBeDefined();
    const msgs = body!["messages"] as Array<{ role: string; content: string }>;
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toBe("You are a helpful assistant.");
    expect(body!["temperature"]).toBe(0.5);
    expect(body!["max_tokens"]).toBe(200);
    expect(body!["top_p"]).toBe(0.9);
  });

  it("generates with tool calls", async () => {
    mock.setHandler(() =>
      json(
        openAIChatResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"London"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ),
    );

    const model = createModel();
    const result = await model.generate({
      messages: simpleMessages,
      tools: toolDefs,
      toolChoice: "auto",
    });

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.id).toBe("call_abc");
    expect(result.toolCalls![0]!.name).toBe("get_weather");
    expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
  });

  it("sends tool definitions and toolChoice in request body", async () => {
    mock.setHandler(() => json(openAIChatResponse()));

    const model = createModel();
    await model.generate({
      messages: simpleMessages,
      tools: toolDefs,
      toolChoice: "auto",
    });

    const body = mock.lastRequestBody();
    expect(body).toBeDefined();
    const tools = body!["tools"] as Array<{ type: string; function: { name: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.function.name).toBe("get_weather");
    expect(body!["tool_choice"]).toBe("auto");
  });

  it("does not send tool_choice when toolChoice is not provided", async () => {
    mock.setHandler(() => json(openAIChatResponse()));

    const model = createModel();
    await model.generate({
      messages: simpleMessages,
      tools: toolDefs,
    });

    const body = mock.lastRequestBody();
    expect(body).toBeDefined();
    expect(body!["tool_choice"]).toBeUndefined();
  });

  it("throws on API error (401)", async () => {
    mock.setHandler(() =>
      json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401),
    );

    const model = createModel();
    await expect(model.generate({ messages: simpleMessages })).rejects.toThrow();
  });

  it("throws when response has empty choices", async () => {
    mock.setHandler(() => json(openAIChatResponse({ choices: [] })));

    const model = createModel();
    await expect(model.generate({ messages: simpleMessages })).rejects.toThrow(
      "No response from OpenAI model",
    );
  });

  it("handles response with no usage data gracefully", async () => {
    const noUsage = openAIChatResponse();
    delete (noUsage as Record<string, unknown>)["usage"];

    mock.setHandler(() => json(noUsage));

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages });
    expect(result.usage.promptTokens).toBe(0);
    expect(result.usage.completionTokens).toBe(0);
  });

  it("handles response with no tool_calls in message", async () => {
    mock.setHandler(() =>
      json(
        openAIChatResponse({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "No tools needed" },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages });
    expect(result.text).toBe("No tools needed");
    expect(result.toolCalls).toBeUndefined();
  });

  it("handles multiple tool calls in one response", async () => {
    mock.setHandler(() =>
      json(
        openAIChatResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"London"}' },
                  },
                  {
                    id: "call_2",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ),
    );

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages, tools: toolDefs });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
    expect(result.toolCalls![1]!.arguments).toEqual({ city: "Paris" });
  });

  it("passes custom headers to the SDK", async () => {
    let capturedHeaders: Headers | undefined;
    mock.setHandler((req) => {
      capturedHeaders = req.headers;
      return json(openAIChatResponse());
    });

    const model = createOpenAICompatibleModel({
      apiKey: "sk-test",
      baseURL: `${mock.baseURL}/v1`,
      model: "test-model",
      headers: { "X-Custom": "value" },
    });

    await model.generate({ messages: simpleMessages });
    expect(capturedHeaders?.get("x-custom")).toBe("value");
  });

  it("sends stream: false in request body", async () => {
    mock.setHandler(() => json(openAIChatResponse()));

    const model = createModel();
    await model.generate({ messages: simpleMessages });

    const body = mock.lastRequestBody();
    expect(body!["stream"]).toBe(false);
  });
});

// ── Anthropic Client ─────────────────────────────────

describe("createAnthropicCompatibleModel.generate", () => {
  let mock: MockServer;

  beforeAll(() => {
    mock = createMockServer(18922);
  });

  afterAll(() => {
    mock.server.stop(true);
  });

  function createModel(overrides: Record<string, unknown> = {}) {
    return createAnthropicCompatibleModel({
      apiKey: "sk-ant-test",
      baseURL: mock.baseURL,
      model: "test-model",
      ...overrides,
    });
  }

  it("returns provider and modelId correctly", () => {
    const model = createModel();
    expect(model.provider).toBe("anthropic");
    expect(model.modelId).toBe("test-model");
  });

  it("generates text successfully (no tools)", async () => {
    mock.setHandler(() => json(anthropicMessageResponse()));

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages });

    expect(result.text).toBe("Hello!");
    expect(result.finishReason).toBe("end_turn");
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage.promptTokens).toBe(12);
    expect(result.usage.completionTokens).toBe(7);
  });

  it("sends system, temperature, maxTokens, topP in request body", async () => {
    mock.setHandler(() => json(anthropicMessageResponse()));

    const model = createModel();
    await model.generate({
      messages: simpleMessages,
      system: "Be concise",
      temperature: 0.3,
      maxTokens: 1024,
      topP: 0.8,
    });

    const body = mock.lastRequestBody();
    expect(body).toBeDefined();
    expect(body!["system"]).toBe("Be concise");
    expect(body!["temperature"]).toBe(0.3);
    expect(body!["max_tokens"]).toBe(1024);
    expect(body!["top_p"]).toBe(0.8);
  });

  it("defaults maxTokens to 4096 when not provided", async () => {
    mock.setHandler(() => json(anthropicMessageResponse()));

    const model = createModel();
    await model.generate({ messages: simpleMessages });

    const body = mock.lastRequestBody();
    expect(body).toBeDefined();
    expect(body!["max_tokens"]).toBe(4096);
  });

  it("generates with tool use blocks", async () => {
    mock.setHandler(() =>
      json(
        anthropicMessageResponse({
          content: [
            { type: "text", text: "Let me check the weather." },
            {
              type: "tool_use",
              id: "toolu_abc",
              name: "get_weather",
              input: { city: "Tokyo" },
            },
          ],
          stop_reason: "tool_use",
        }),
      ),
    );

    const model = createModel();
    const result = await model.generate({
      messages: simpleMessages,
      tools: toolDefs,
    });

    expect(result.text).toBe("Let me check the weather.");
    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.id).toBe("toolu_abc");
    expect(result.toolCalls![0]!.name).toBe("get_weather");
    expect(result.toolCalls![0]!.arguments).toEqual({ city: "Tokyo" });
  });

  it("sends tool definitions in request body", async () => {
    mock.setHandler(() => json(anthropicMessageResponse()));

    const model = createModel();
    await model.generate({
      messages: simpleMessages,
      tools: toolDefs,
    });

    const body = mock.lastRequestBody();
    expect(body).toBeDefined();
    const tools = body!["tools"] as Array<{ name: string; description: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("get_weather");
    expect(tools[0]!.description).toBe("Get the weather for a city");
  });

  it("throws on API error (401)", async () => {
    mock.setHandler(() =>
      json(
        {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        },
        401,
      ),
    );

    const model = createModel();
    await expect(model.generate({ messages: simpleMessages })).rejects.toThrow();
  });

  it("handles response with only tool_use blocks (no text)", async () => {
    mock.setHandler(() =>
      json(
        anthropicMessageResponse({
          content: [
            {
              type: "tool_use",
              id: "toolu_xyz",
              name: "get_weather",
              input: { city: "Berlin" },
            },
          ],
          stop_reason: "tool_use",
        }),
      ),
    );

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages, tools: toolDefs });
    expect(result.text).toBe("");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("handles null stop_reason by defaulting to 'stop'", async () => {
    mock.setHandler(() => json(anthropicMessageResponse({ stop_reason: null })));

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages });
    expect(result.finishReason).toBe("stop");
  });

  it("passes custom headers to the SDK", async () => {
    let capturedHeaders: Headers | undefined;
    mock.setHandler((req) => {
      capturedHeaders = req.headers;
      return json(anthropicMessageResponse());
    });

    const model = createAnthropicCompatibleModel({
      apiKey: "sk-ant-test",
      baseURL: mock.baseURL,
      model: "test-model",
      headers: { "X-Custom-Anthropic": "value2" },
    });

    await model.generate({ messages: simpleMessages });
    expect(capturedHeaders?.get("x-custom-anthropic")).toBe("value2");
  });

  it("handles multiple tool_use blocks", async () => {
    mock.setHandler(() =>
      json(
        anthropicMessageResponse({
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { city: "London" },
            },
            {
              type: "tool_use",
              id: "toolu_2",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
          stop_reason: "tool_use",
        }),
      ),
    );

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages, tools: toolDefs });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
    expect(result.toolCalls![1]!.arguments).toEqual({ city: "Paris" });
  });

  it("concatenates multiple text blocks", async () => {
    mock.setHandler(() =>
      json(
        anthropicMessageResponse({
          content: [
            { type: "text", text: "First part. " },
            { type: "text", text: "Second part." },
          ],
        }),
      ),
    );

    const model = createModel();
    const result = await model.generate({ messages: simpleMessages });
    expect(result.text).toBe("First part. Second part.");
  });

  it("does not include tools in request when none provided", async () => {
    mock.setHandler(() => json(anthropicMessageResponse()));

    const model = createModel();
    await model.generate({ messages: simpleMessages });

    const body = mock.lastRequestBody();
    expect(body!["tools"]).toBeUndefined();
  });
});
