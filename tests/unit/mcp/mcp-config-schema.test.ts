/**
 * Unit tests for MCP config schema validation.
 *
 * Tests Zod refinements, transport defaults, and edge cases for the
 * mcpServers configuration in ToolsConfigSchema.
 */

import { describe, it, expect } from "bun:test";
import { ToolsConfigSchema } from "../../../src/infra/config-schema.ts";

describe("mcpServers config schema", () => {
  // ── Defaults ──

  it("should default to empty array", () => {
    const result = ToolsConfigSchema.parse({});
    expect(result.mcpServers).toEqual([]);
  });

  it("should coerce string '[]' to empty array", () => {
    const result = ToolsConfigSchema.parse({ mcpServers: "[]" });
    expect(result.mcpServers).toEqual([]);
  });

  it("should coerce empty string to empty array", () => {
    const result = ToolsConfigSchema.parse({ mcpServers: "" });
    expect(result.mcpServers).toEqual([]);
  });

  it("should default transport to 'stdio'", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{ name: "test", command: "echo" }],
    });
    expect(result.mcpServers[0]!.transport).toBe("stdio");
  });

  it("should default enabled to true", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{ name: "test", command: "echo" }],
    });
    expect(result.mcpServers[0]!.enabled).toBe(true);
  });

  // ── stdio transport ──

  it("should accept valid stdio config", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [
        {
          name: "filesystem",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { NODE_ENV: "production" },
          cwd: "/workspace",
          enabled: true,
        },
      ],
    });

    const server = result.mcpServers[0]!;
    expect(server.name).toBe("filesystem");
    expect(server.transport).toBe("stdio");
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(server.env).toEqual({ NODE_ENV: "production" });
    expect(server.cwd).toBe("/workspace");
    expect(server.enabled).toBe(true);
  });

  it("should reject stdio config without command", () => {
    expect(() =>
      ToolsConfigSchema.parse({
        mcpServers: [
          { name: "bad", transport: "stdio" },
        ],
      }),
    ).toThrow();
  });

  it("should accept stdio config with command only (minimal)", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{ name: "minimal", transport: "stdio", command: "echo" }],
    });
    expect(result.mcpServers[0]!.command).toBe("echo");
    expect(result.mcpServers[0]!.args).toBeUndefined();
    expect(result.mcpServers[0]!.env).toBeUndefined();
    expect(result.mcpServers[0]!.cwd).toBeUndefined();
  });

  it("should accept stdio config with empty args array", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{ name: "test", transport: "stdio", command: "echo", args: [] }],
    });
    expect(result.mcpServers[0]!.args).toEqual([]);
  });

  it("should accept stdio config with empty env object", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{ name: "test", transport: "stdio", command: "echo", env: {} }],
    });
    expect(result.mcpServers[0]!.env).toEqual({});
  });

  // ── sse transport ──

  it("should accept valid sse config", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [
        {
          name: "remote",
          transport: "sse",
          url: "http://localhost:3000/sse",
          enabled: true,
        },
      ],
    });

    const server = result.mcpServers[0]!;
    expect(server.name).toBe("remote");
    expect(server.transport).toBe("sse");
    expect(server.url).toBe("http://localhost:3000/sse");
  });

  it("should reject sse config without url", () => {
    expect(() =>
      ToolsConfigSchema.parse({
        mcpServers: [
          { name: "bad", transport: "sse" },
        ],
      }),
    ).toThrow();
  });

  it("should reject sse config with invalid url", () => {
    expect(() =>
      ToolsConfigSchema.parse({
        mcpServers: [
          { name: "bad", transport: "sse", url: "not-a-url" },
        ],
      }),
    ).toThrow();
  });

  it("should accept sse config with https url", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [
        { name: "secure", transport: "sse", url: "https://api.example.com/mcp" },
      ],
    });
    expect(result.mcpServers[0]!.url).toBe("https://api.example.com/mcp");
  });

  // ── enabled flag ──

  it("should allow disabling a server explicitly", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [
        { name: "disabled", transport: "stdio", command: "echo", enabled: false },
      ],
    });
    expect(result.mcpServers[0]!.enabled).toBe(false);
  });

  // ── Multiple servers ──

  it("should accept multiple servers with different transports", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [
        { name: "local", transport: "stdio", command: "npx", args: ["server"] },
        { name: "remote", transport: "sse", url: "http://localhost:3000" },
      ],
    });
    expect(result.mcpServers).toHaveLength(2);
    expect(result.mcpServers[0]!.transport).toBe("stdio");
    expect(result.mcpServers[1]!.transport).toBe("sse");
  });

  it("should validate each server independently (one valid, one invalid)", () => {
    // The invalid one should cause the whole parse to fail
    expect(() =>
      ToolsConfigSchema.parse({
        mcpServers: [
          { name: "good", transport: "stdio", command: "echo" },
          { name: "bad", transport: "sse" }, // missing url
        ],
      }),
    ).toThrow();
  });

  // ── Edge cases ──

  it("should reject config without name", () => {
    expect(() =>
      ToolsConfigSchema.parse({
        mcpServers: [{ transport: "stdio", command: "echo" }],
      }),
    ).toThrow();
  });

  it("should reject unknown transport value", () => {
    expect(() =>
      ToolsConfigSchema.parse({
        mcpServers: [{ name: "test", transport: "websocket", command: "echo" }],
      }),
    ).toThrow();
  });

  it("should accept JSON-parsed array via coercion", () => {
    // Simulates what happens when env var produces a JSON string
    const jsonString = JSON.stringify([
      { name: "from-env", transport: "stdio", command: "echo" },
    ]);
    const result = ToolsConfigSchema.parse({ mcpServers: jsonString });
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]!.name).toBe("from-env");
  });

  it("refinement error message is descriptive", () => {
    try {
      ToolsConfigSchema.parse({
        mcpServers: [{ name: "bad", transport: "stdio" }],
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      const message = JSON.stringify(err.issues ?? err.message);
      expect(message).toContain("stdio transport requires 'command'");
    }
  });

  // ── auth field ──

  it("should accept sse config with client_credentials auth", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{
        name: "authed",
        transport: "sse",
        url: "https://api.example.com/sse",
        auth: {
          type: "client_credentials",
          clientId: "id",
          clientSecret: "secret",
        },
      }],
    });
    expect(result.mcpServers[0]!.auth).toBeDefined();
    expect(result.mcpServers[0]!.auth!.type).toBe("client_credentials");
  });

  it("should accept sse config with device_code auth", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{
        name: "dc",
        transport: "sse",
        url: "https://api.example.com/sse",
        auth: {
          type: "device_code",
          clientId: "id",
          deviceAuthorizationUrl: "https://example.com/device",
          tokenUrl: "https://example.com/token",
        },
      }],
    });
    expect(result.mcpServers[0]!.auth!.type).toBe("device_code");
  });

  it("should accept config without auth (backward compatible)", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{
        name: "no-auth",
        transport: "sse",
        url: "https://api.example.com/sse",
      }],
    });
    expect(result.mcpServers[0]!.auth).toBeUndefined();
  });

  it("should accept auth on stdio transport (ignored at runtime)", () => {
    const result = ToolsConfigSchema.parse({
      mcpServers: [{
        name: "stdio-auth",
        transport: "stdio",
        command: "echo",
        auth: {
          type: "client_credentials",
          clientId: "id",
          clientSecret: "secret",
        },
      }],
    });
    expect(result.mcpServers[0]!.auth).toBeDefined();
  });

  it("should reject invalid auth type", () => {
    expect(() =>
      ToolsConfigSchema.parse({
        mcpServers: [{
          name: "bad-auth",
          transport: "sse",
          url: "https://api.example.com/sse",
          auth: { type: "authorization_code", clientId: "id" },
        }],
      }),
    ).toThrow();
  });
});
