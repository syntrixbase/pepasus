/**
 * Network tools - HTTP requests and web search.
 */

import { z } from "zod";
import TurndownService from "turndown";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

// ── http_get ────────────────────────────────────

export const http_get: Tool = {
  name: "http_get",
  description: "Make an HTTP GET request",
  category: "network" as ToolCategory,
  parameters: z.object({
    url: z.string().url().describe("URL to request"),
    headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { url, headers } = params as { url: string; headers?: Record<string, string> };

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: headers || {},
      });

      const headersObj: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersObj[key] = value;
      });

      const body = await response.text();

      return {
        success: true,
        result: {
          url,
          status: response.status,
          statusText: response.statusText,
          headers: headersObj,
          body,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── http_post ──────────────────────────────────

export const http_post: Tool = {
  name: "http_post",
  description: "Make an HTTP POST request",
  category: "network" as ToolCategory,
  parameters: z.object({
    url: z.string().url().describe("URL to request"),
    body: z.string().optional().describe("Request body"),
    headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { url, body, headers } = params as {
      url: string;
      body?: string;
      headers?: Record<string, string>;
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          ...(headers || {}),
        },
      });

      const headersObj: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersObj[key] = value;
      });

      const responseBody = await response.text();

      return {
        success: true,
        result: {
          url,
          status: response.status,
          statusText: response.statusText,
          headers: headersObj,
          body: responseBody,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── http_request ────────────────────────────────

export const http_request: Tool = {
  name: "http_request",
  description: "Make a generic HTTP request with any method",
  category: "network" as ToolCategory,
  parameters: z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]).describe("HTTP method"),
    url: z.string().url().describe("URL to request"),
    body: z.string().optional().describe("Request body"),
    headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { method, url, body, headers } = params as {
      method: string;
      url: string;
      body?: string;
      headers?: Record<string, string>;
    };

    try {
      const response = await fetch(url, {
        method,
        body,
        headers: headers || {},
      });

      const headersObj: Record<string, string> = {};
      response.headers.forEach((_value, key) => {
        headersObj[key] = _value;
      });

      const responseBody = await response.text();

      return {
        success: true,
        result: {
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          headers: headersObj,
          body: responseBody,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── web_search ─────────────────────────────────

export const web_search: Tool = {
  name: "web_search",
  description: "Search the web (requires API key configuration)",
  category: "network" as ToolCategory,
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().positive().optional().default(10).describe("Maximum number of results"),
  }),
  async execute(_params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    // Web search is not yet implemented — return a clear error
    return {
      success: false,
      error: "Web search is not configured. Set WEB_SEARCH_API_KEY and WEB_SEARCH_PROVIDER environment variables, or configure in tools.webSearch section of config.yml",
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};

// ── web_fetch ─────────────────────────────────

// Cache for web_fetch results (15-min TTL)
const WEB_FETCH_CACHE = new Map<string, { result: string; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_CACHE_ENTRIES = 100;

// Singleton TurndownService — reused across all web_fetch calls
const turndownService = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export function clearWebFetchCache(): void {
  WEB_FETCH_CACHE.clear();
}

export const web_fetch: Tool = {
  name: "web_fetch",
  description: "Fetch a web page, convert HTML to Markdown, and extract specific information using AI. "
    + "Returns only the extracted content, not the full page. Includes a 15-minute cache.",
  category: "network" as ToolCategory,
  parameters: z.object({
    url: z.string().describe("The URL to fetch content from"),
    prompt: z.string().describe("What information to extract from the page"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { url: rawUrl, prompt } = params as { url: string; prompt: string };

    try {
      // Cache check
      const cacheKey = rawUrl + "|" + prompt;
      const cached = WEB_FETCH_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          success: true,
          result: { url: rawUrl, content: cached.result, cached: true, contentLength: cached.result.length },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // URL upgrade: auto-upgrade http to https (skip localhost/127.0.0.1)
      let url = rawUrl;
      if (url.startsWith("http://")) {
        const hostname = new URL(url).hostname;
        if (hostname !== "localhost" && hostname !== "127.0.0.1") {
          url = "https://" + url.slice(7);
        }
      }

      // Fetch with redirect detection
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });

      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location) {
          const originalHost = new URL(url).hostname;
          // Location may be relative; resolve against original URL
          const redirectUrl = new URL(location, url).href;
          const redirectHost = new URL(redirectUrl).hostname;

          if (originalHost !== redirectHost) {
            // Cross-domain redirect — return notice
            return {
              success: true,
              result: {
                redirected: true,
                originalUrl: rawUrl,
                redirectUrl,
                notice: "URL redirected to a different host. Make a new web_fetch request with the redirect URL to fetch the content.",
              },
              startedAt,
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            };
          }

          // Same-domain redirect — re-fetch with normal redirect following
          const followedResponse = await fetch(redirectUrl, { signal: AbortSignal.timeout(30_000) });
          return await processResponse(followedResponse, rawUrl, prompt, cacheKey, startedAt, context);
        }
      }

      return await processResponse(response, rawUrl, prompt, cacheKey, startedAt, context);
    } catch (err) {
      // Distinguish timeout from other errors
      const error = (err instanceof DOMException && err.name === "TimeoutError")
        ? `Request timed out after 30s: ${rawUrl}`
        : err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

async function processResponse(
  response: Response,
  rawUrl: string,
  prompt: string,
  cacheKey: string,
  startedAt: number,
  context: ToolContext,
): Promise<ToolResult> {
  const contentType = response.headers.get("content-type") || "";
  const rawBody = await response.text();
  let markdown: string;

  if (contentType.includes("text/html")) {
    // Best-effort strip of non-content tags before Markdown conversion.
    // Regex-based — may mishandle malformed/nested HTML, but sufficient
    // since turndown handles the remaining structure gracefully.
    const cleaned = rawBody
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "");

    markdown = turndownService.turndown(cleaned);
  } else {
    markdown = rawBody;
  }

  // Truncate if over MAX_CONTENT_LENGTH
  if (markdown.length > MAX_CONTENT_LENGTH) {
    markdown = markdown.slice(0, MAX_CONTENT_LENGTH) + "\n\n[Content truncated — original length: " + rawBody.length.toLocaleString() + " chars]";
  }

  // AI extraction (if extractModel available)
  const { extractModel } = context;
  let content: string;

  if (extractModel) {
    const result = await extractModel.generate({
      system: "Extract information from the following web page content. Be concise. Return only the requested information.",
      messages: [{ role: "user", content: prompt + "\n\n---PAGE CONTENT---\n\n" + markdown }],
    });
    content = result.text;
  } else {
    content = markdown;
  }

  // Cache result (evict oldest entries if cache is full)
  if (WEB_FETCH_CACHE.size >= MAX_CACHE_ENTRIES) {
    // Map iterates in insertion order — delete the first (oldest) entry
    const oldestKey = WEB_FETCH_CACHE.keys().next().value;
    if (oldestKey) WEB_FETCH_CACHE.delete(oldestKey);
  }
  WEB_FETCH_CACHE.set(cacheKey, { result: content, expiresAt: Date.now() + CACHE_TTL_MS });

  return {
    success: true,
    result: { url: rawUrl, content, cached: false, contentLength: rawBody.length },
    startedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - startedAt,
  };
}
