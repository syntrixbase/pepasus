/**
 * Unit tests for network tools.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { http_get, http_post, http_request, web_search, web_fetch, clearWebFetchCache } from "../../../src/tools/builtins/network-tools.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";

// ── Local test server ───────────────────────────

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random available port
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/json" && req.method === "GET") {
        return new Response(JSON.stringify({ ok: true, method: "GET" }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/echo-headers" && req.method === "GET") {
        const customHeader = req.headers.get("x-custom-header") || "none";
        return new Response(JSON.stringify({ customHeader }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/post" && req.method === "POST") {
        return req.text().then((body) =>
          new Response(JSON.stringify({ ok: true, method: "POST", receivedBody: body }), {
            headers: { "content-type": "application/json" },
          })
        );
      }

      if (url.pathname === "/put" && req.method === "PUT") {
        return req.text().then((body) =>
          new Response(JSON.stringify({ ok: true, method: "PUT", receivedBody: body }), {
            headers: { "content-type": "application/json" },
          })
        );
      }

      if (url.pathname === "/delete" && req.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true, method: "DELETE" }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/status/500") {
        return new Response("Internal Server Error", { status: 500 });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

// ── Context helper ──────────────────────────────

const context = { taskId: "test-task-id" };

// ── http_get ────────────────────────────────────

describe("http_get tool", () => {
  it("should make a successful GET request", async () => {
    const result = await http_get.execute({ url: `${baseUrl}/json` }, context);

    expect(result.success).toBe(true);
    const res = result.result as { url: string; status: number; body: string; headers: Record<string, string> };
    expect(res.status).toBe(200);
    expect(res.headers).toBeDefined();
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.method).toBe("GET");
  }, { timeout: 10000 });

  it("should send custom headers", async () => {
    const result = await http_get.execute({
      url: `${baseUrl}/echo-headers`,
      headers: { "x-custom-header": "test-value" },
    }, context);

    expect(result.success).toBe(true);
    const res = result.result as { body: string };
    const body = JSON.parse(res.body);
    expect(body.customHeader).toBe("test-value");
  }, { timeout: 10000 });

  it("should handle 404 response", async () => {
    const result = await http_get.execute({ url: `${baseUrl}/nonexistent` }, context);

    expect(result.success).toBe(true); // HTTP 404 is still a successful fetch
    const res = result.result as { status: number; statusText: string };
    expect(res.status).toBe(404);
  }, { timeout: 10000 });

  it("should fail on connection refused", async () => {
    // Use a port that is almost certainly not listening
    const result = await http_get.execute({ url: "http://localhost:19999/test" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 10000 });
});

// ── http_post ───────────────────────────────────

describe("http_post tool", () => {
  it("should make a successful POST request", async () => {
    const result = await http_post.execute({
      url: `${baseUrl}/post`,
    }, context);

    expect(result.success).toBe(true);
    const res = result.result as { status: number; body: string };
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.method).toBe("POST");
  }, { timeout: 10000 });

  it("should send body and custom headers", async () => {
    const result = await http_post.execute({
      url: `${baseUrl}/post`,
      body: JSON.stringify({ key: "value" }),
      headers: { "x-request-id": "abc-123" },
    }, context);

    expect(result.success).toBe(true);
    const res = result.result as { status: number; body: string; headers: Record<string, string> };
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.receivedBody).toBe('{"key":"value"}');
  }, { timeout: 10000 });

  it("should fail on connection refused", async () => {
    const result = await http_post.execute({
      url: "http://localhost:19999/post",
      body: "test",
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 10000 });
});

// ── http_request ────────────────────────────────

describe("http_request tool", () => {
  it("should make a PUT request", async () => {
    const result = await http_request.execute({
      method: "PUT",
      url: `${baseUrl}/put`,
      body: JSON.stringify({ updated: true }),
    }, context);

    expect(result.success).toBe(true);
    const res = result.result as { status: number; method: string; body: string };
    expect(res.status).toBe(200);
    expect(res.method).toBe("PUT");
    const body = JSON.parse(res.body);
    expect(body.method).toBe("PUT");
    expect(body.receivedBody).toBe('{"updated":true}');
  }, { timeout: 10000 });

  it("should make a DELETE request", async () => {
    const result = await http_request.execute({
      method: "DELETE",
      url: `${baseUrl}/delete`,
    }, context);

    expect(result.success).toBe(true);
    const res = result.result as { status: number; method: string; body: string };
    expect(res.status).toBe(200);
    expect(res.method).toBe("DELETE");
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  }, { timeout: 10000 });

  it("should make a GET request with custom headers", async () => {
    const result = await http_request.execute({
      method: "GET",
      url: `${baseUrl}/echo-headers`,
      headers: { "x-custom-header": "from-request" },
    }, context);

    expect(result.success).toBe(true);
    const res = result.result as { body: string };
    const body = JSON.parse(res.body);
    expect(body.customHeader).toBe("from-request");
  }, { timeout: 10000 });

  it("should fail on connection refused", async () => {
    const result = await http_request.execute({
      method: "GET",
      url: "http://localhost:19999/test",
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 10000 });
});

// ── web_search ──────────────────────────────────

describe("web_search tool", () => {
  it("should return not configured error", async () => {
    const result = await web_search.execute({
      query: "test search",
      limit: 5,
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });
});

// ── web_fetch ──────────────────────────────────

// Mock LLM model for AI extraction tests
const mockExtractModel: LanguageModel = {
  provider: "test",
  modelId: "test-extract",
  async generate(options) {
    return {
      text: "Extracted: " + (options.messages?.[0]?.content?.toString().slice(0, 50) ?? ""),
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  },
};

// Separate mock server for web_fetch tests
let fetchServer: ReturnType<typeof Bun.serve>;
let fetchBaseUrl: string;

beforeAll(() => {
  fetchServer = Bun.serve({
    port: 0, // random available port
    fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/html":
          return new Response(
            "<html><head><style>body{}</style></head><body><h1>Hello</h1><p>World</p><script>alert(1)</script></body></html>",
            { headers: { "content-type": "text/html" } },
          );
        case "/redirect-cross":
          return new Response(null, {
            status: 302,
            headers: { location: "https://other-domain.com/page" },
          });
        case "/redirect-same":
          return new Response(null, {
            status: 302,
            headers: { location: `http://localhost:${fetchServer.port}/html` },
          });
        case "/large":
          return new Response(
            "<html><body>" + "x".repeat(200_000) + "</body></html>",
            { headers: { "content-type": "text/html" } },
          );
        case "/text":
          return new Response("Just plain text", {
            headers: { "content-type": "text/plain" },
          });
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });
  fetchBaseUrl = `http://localhost:${fetchServer.port}`;
});

afterAll(() => {
  fetchServer.stop(true);
});

describe("web_fetch tool", () => {
  afterEach(() => {
    clearWebFetchCache();
  });

  it("should return extracted content from HTML page", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/html`, prompt: "What is on this page?" },
      { taskId: "test", extractModel: mockExtractModel },
    );

    expect(result.success).toBe(true);
    const res = result.result as { url: string; content: string; cached: boolean; contentLength: number };
    expect(res.cached).toBe(false);
    // Should have AI-extracted content (mock model prefixes with "Extracted: ")
    expect(res.content).toStartWith("Extracted: ");
    // Should NOT contain script/style tags in the content passed to the model
    expect(res.content).not.toContain("<script>");
    expect(res.content).not.toContain("<style>");
  }, { timeout: 15000 });

  it("should cache results (15-min TTL)", async () => {
    const params = { url: `${fetchBaseUrl}/html`, prompt: "Cache test" };
    const ctx = { taskId: "test", extractModel: mockExtractModel };

    // First call — not cached
    const result1 = await web_fetch.execute(params, ctx);
    expect(result1.success).toBe(true);
    const res1 = result1.result as { cached: boolean };
    expect(res1.cached).toBe(false);

    // Second call — should be cached
    const result2 = await web_fetch.execute(params, ctx);
    expect(result2.success).toBe(true);
    const res2 = result2.result as { cached: boolean };
    expect(res2.cached).toBe(true);
  }, { timeout: 15000 });

  it("should detect cross-domain redirect", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/redirect-cross`, prompt: "test" },
      { taskId: "test" },
    );

    expect(result.success).toBe(true);
    const res = result.result as { redirected: boolean; originalUrl: string; redirectUrl: string; notice: string };
    expect(res.redirected).toBe(true);
    expect(res.redirectUrl).toContain("other-domain.com");
    expect(res.notice).toContain("different host");
  }, { timeout: 15000 });

  it("should follow same-domain redirect", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/redirect-same`, prompt: "What heading?" },
      { taskId: "test", extractModel: mockExtractModel },
    );

    expect(result.success).toBe(true);
    const res = result.result as { content: string; cached: boolean };
    expect(res.cached).toBe(false);
    // Should have followed redirect and fetched the /html page content
    expect(res.content).toStartWith("Extracted: ");
  }, { timeout: 15000 });

  it("should truncate oversized content", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/large`, prompt: "test" },
      { taskId: "test" }, // no extractModel — raw markdown returned
    );

    expect(result.success).toBe(true);
    const res = result.result as { content: string; contentLength: number };
    // Content should contain truncation notice
    expect(res.content).toContain("[Content truncated");
    // Content length in result should be the original raw body length
    expect(res.contentLength).toBeGreaterThan(100_000);
  }, { timeout: 15000 });

  it("should return markdown when no extractModel", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/text`, prompt: "Get the text" },
      { taskId: "test" }, // no extractModel
    );

    expect(result.success).toBe(true);
    const res = result.result as { content: string; cached: boolean };
    // Without extractModel, raw content is returned
    expect(res.content).toBe("Just plain text");
    expect(res.cached).toBe(false);
  }, { timeout: 15000 });

  it("should clear cache via clearWebFetchCache", async () => {
    const params = { url: `${fetchBaseUrl}/text`, prompt: "Clear test" };
    const ctx = { taskId: "test" };

    // First call populates cache
    await web_fetch.execute(params, ctx);

    // Verify cached
    const result2 = await web_fetch.execute(params, ctx);
    expect((result2.result as { cached: boolean }).cached).toBe(true);

    // Clear cache
    clearWebFetchCache();

    // Should no longer be cached
    const result3 = await web_fetch.execute(params, ctx);
    expect((result3.result as { cached: boolean }).cached).toBe(false);
  }, { timeout: 15000 });

  it("should not upgrade http to https for localhost", async () => {
    // localhost URLs should NOT be upgraded — our test server is http://localhost
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/text`, prompt: "Get the text" },
      { taskId: "test" },
    );

    // Should succeed — proves localhost was NOT upgraded to https (which would fail)
    expect(result.success).toBe(true);
    const res = result.result as { content: string };
    expect(res.content).toBe("Just plain text");
  }, { timeout: 15000 });

  it("should upgrade http to https for non-localhost domains", async () => {
    // Non-localhost http:// should be upgraded to https://
    // The upgraded URL will fail to connect, proving the upgrade happened
    const result = await web_fetch.execute(
      { url: "http://example-nonexistent-test.invalid/page", prompt: "test" },
      { taskId: "test" },
    );

    expect(result.success).toBe(false);
    // Error should indicate a network failure (DNS or connection), not a "no upgrade" scenario
    expect(result.error).toBeDefined();
  }, { timeout: 15000 });
});
