/**
 * Unit tests for network tools.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { http_get, http_post, http_request, web_search } from "../../../src/tools/builtins/network-tools.ts";

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
