import { describe, expect, test } from "bun:test";
import {
  TiktokenCounter,
  AnthropicAPICounter,
  EstimateCounter,
  createTokenCounter,
} from "@pegasus/infra/token-counter.ts";

// ── TiktokenCounter ──────────────────────────────

describe("TiktokenCounter", () => {
  test("counts tokens for English text", async () => {
    const counter = new TiktokenCounter("gpt-4o");
    const tokens = await counter.count("Hello, world!");
    expect(tokens).toBeGreaterThan(0);
    expect(typeof tokens).toBe("number");
  }, 5_000);

  test("counts tokens for Chinese text", async () => {
    const counter = new TiktokenCounter("gpt-4o");
    const tokens = await counter.count("你好，世界！");
    expect(tokens).toBeGreaterThan(0);
    expect(typeof tokens).toBe("number");
  }, 5_000);

  test("counts tokens for mixed English and Chinese text", async () => {
    const counter = new TiktokenCounter("gpt-4o");
    const tokens = await counter.count("Hello 你好 World 世界");
    expect(tokens).toBeGreaterThan(0);
    expect(typeof tokens).toBe("number");
  }, 5_000);

  test("falls back to cl100k_base for unknown model", async () => {
    const counter = new TiktokenCounter("unknown-model-xyz");
    const tokens = await counter.count("test text");
    expect(tokens).toBeGreaterThan(0);
  }, 5_000);

  test("returns 0 for empty string", async () => {
    const counter = new TiktokenCounter("gpt-4o");
    const tokens = await counter.count("");
    expect(tokens).toBe(0);
  }, 5_000);
});

// ── EstimateCounter ──────────────────────────────

describe("EstimateCounter", () => {
  test("returns rough estimate based on character length", async () => {
    const counter = new EstimateCounter();
    const text = "Hello, world!"; // 13 chars → ceil(13/3.5) = 4
    const tokens = await counter.count(text);
    expect(tokens).toBe(Math.ceil(text.length / 3.5));
  }, 5_000);

  test("returns 0 for empty string", async () => {
    const counter = new EstimateCounter();
    const tokens = await counter.count("");
    expect(tokens).toBe(0);
  }, 5_000);
});

// ── AnthropicAPICounter ──────────────────────────

describe("AnthropicAPICounter", () => {
  test("should call Anthropic count_tokens API", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/messages/count_tokens");
      const body = JSON.parse(init.body);
      expect(body.messages[0].content).toBe("hello world");
      return new Response(JSON.stringify({ input_tokens: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const counter = new AnthropicAPICounter("fake-key", "claude-sonnet-4");
      const tokens = await counter.count("hello world");
      expect(tokens).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 5_000);

  test("should throw on non-ok response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const counter = new AnthropicAPICounter("bad-key");
      await expect(counter.count("hello")).rejects.toThrow(
        "Anthropic count_tokens failed: 401",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 5_000);

  test("should send correct headers", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      expect(init.headers["x-api-key"]).toBe("test-key");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");
      expect(init.headers["content-type"]).toBe("application/json");
      return new Response(JSON.stringify({ input_tokens: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const counter = new AnthropicAPICounter("test-key");
      await counter.count("test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 5_000);

  test("should use custom baseURL", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      expect(String(url)).toContain("https://custom.example.com/v1/messages/count_tokens");
      return new Response(JSON.stringify({ input_tokens: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const counter = new AnthropicAPICounter("key", "claude-sonnet-4", "https://custom.example.com");
      const tokens = await counter.count("hi");
      expect(tokens).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 5_000);
});

// ── Factory ──────────────────────────────────────

describe("createTokenCounter", () => {
  test("returns TiktokenCounter for 'openai'", () => {
    const counter = createTokenCounter("openai", { model: "gpt-4o" });
    expect(counter).toBeInstanceOf(TiktokenCounter);
  }, 5_000);

  test("returns TiktokenCounter for 'openai-compatible'", () => {
    const counter = createTokenCounter("openai-compatible", { model: "gpt-4o" });
    expect(counter).toBeInstanceOf(TiktokenCounter);
  }, 5_000);

  test("returns AnthropicAPICounter for 'anthropic'", () => {
    const counter = createTokenCounter("anthropic", {
      apiKey: "test-key",
      model: "claude-sonnet-4",
    });
    expect(counter).toBeInstanceOf(AnthropicAPICounter);
  }, 5_000);

  test("returns EstimateCounter for unknown provider", () => {
    const counter = createTokenCounter("ollama");
    expect(counter).toBeInstanceOf(EstimateCounter);
  }, 5_000);
});
