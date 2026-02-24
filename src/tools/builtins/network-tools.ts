/**
 * Network tools - HTTP requests and web search.
 */

import { z } from "zod";
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
