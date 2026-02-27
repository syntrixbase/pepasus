/**
 * Unit tests for MCPManager.
 *
 * Tests real SDK error paths for connection failures, plus mock-injected
 * clients for listTools/callTool/disconnect paths that require a connected client.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { MCPManager } from "../../../src/mcp/manager.ts";
import type { MCPServerConfig } from "../../../src/mcp/manager.ts";

// We need access to the private clients map for mock-injection tests.
// This helper injects a fake client into the manager.
function injectMockClient(
  manager: MCPManager,
  name: string,
  client: Record<string, unknown>,
): void {
  // Access the private Map via casting
  (manager as unknown as { clients: Map<string, unknown> }).clients.set(name, client);
}

describe("MCPManager", () => {
  let manager: MCPManager;

  beforeEach(() => {
    manager = new MCPManager();
  });

  // ═══════════════════════════════════════════════════
  // connectAll
  // ═══════════════════════════════════════════════════

  describe("connectAll", () => {
    it("should be a no-op with empty configs", async () => {
      await manager.connectAll([]);
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should skip disabled servers", async () => {
      const configs: MCPServerConfig[] = [
        {
          name: "disabled-server",
          transport: "stdio",
          command: "echo",
          args: ["hello"],
          enabled: false,
        },
      ];
      await manager.connectAll(configs);
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should gracefully handle connection failure (bad command)", async () => {
      const configs: MCPServerConfig[] = [
        {
          name: "bad-server",
          transport: "stdio",
          command: "/nonexistent/command/path/fake",
          args: [],
          enabled: true,
        },
      ];
      // Should not throw — graceful degradation
      await manager.connectAll(configs);
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should validate stdio transport requires command", async () => {
      const configs: MCPServerConfig[] = [
        {
          name: "no-command",
          transport: "stdio",
          // no command
          enabled: true,
        },
      ];
      await manager.connectAll(configs);
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should validate sse transport requires url", async () => {
      const configs: MCPServerConfig[] = [
        {
          name: "no-url",
          transport: "sse",
          // no url
          enabled: true,
        },
      ];
      await manager.connectAll(configs);
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should continue with remaining servers when one fails (partial success)", async () => {
      const configs: MCPServerConfig[] = [
        {
          name: "bad-server",
          transport: "stdio",
          command: "/nonexistent/fake/bin",
          enabled: true,
        },
        {
          name: "also-bad",
          transport: "sse",
          // missing url
          enabled: true,
        },
      ];
      // Neither should connect, but it should not throw
      await manager.connectAll(configs);
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should handle sse transport with unreachable URL gracefully", async () => {
      const configs: MCPServerConfig[] = [
        {
          name: "unreachable",
          transport: "sse",
          url: "http://127.0.0.1:1/nonexistent",
          enabled: true,
        },
      ];
      await manager.connectAll(configs);
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should skip all when all disabled", async () => {
      const configs: MCPServerConfig[] = [
        { name: "a", transport: "stdio", command: "echo", enabled: false },
        { name: "b", transport: "sse", url: "http://localhost:9999", enabled: false },
      ];
      await manager.connectAll(configs);
      expect(manager.getConnectedServers()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════
  // disconnect (with mock-injected client)
  // ═══════════════════════════════════════════════════

  describe("disconnect", () => {
    it("should be a no-op for unknown server", async () => {
      await manager.disconnect("nonexistent");
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should close and remove a connected client", async () => {
      const closeFn = mock(() => Promise.resolve());
      injectMockClient(manager, "test-server", { close: closeFn });

      expect(manager.getConnectedServers()).toEqual(["test-server"]);
      await manager.disconnect("test-server");
      expect(manager.getConnectedServers()).toEqual([]);
      expect(closeFn).toHaveBeenCalledTimes(1);
    });

    it("should still remove client if close() throws", async () => {
      const closeFn = mock(() => Promise.reject(new Error("close failed")));
      injectMockClient(manager, "err-server", { close: closeFn });

      await manager.disconnect("err-server");
      // Client should be removed despite close error
      expect(manager.getConnectedServers()).toEqual([]);
      expect(closeFn).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════
  // disconnectAll (with mock-injected clients)
  // ═══════════════════════════════════════════════════

  describe("disconnectAll", () => {
    it("should be a no-op when no servers connected", async () => {
      await manager.disconnectAll();
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should disconnect multiple injected clients concurrently", async () => {
      const close1 = mock(() => Promise.resolve());
      const close2 = mock(() => Promise.resolve());
      injectMockClient(manager, "srv1", { close: close1 });
      injectMockClient(manager, "srv2", { close: close2 });

      expect(manager.getConnectedServers()).toHaveLength(2);
      await manager.disconnectAll();
      expect(manager.getConnectedServers()).toEqual([]);
      expect(close1).toHaveBeenCalledTimes(1);
      expect(close2).toHaveBeenCalledTimes(1);
    });

    it("should handle mixed close success and failure", async () => {
      const close1 = mock(() => Promise.resolve());
      const close2 = mock(() => Promise.reject(new Error("boom")));
      const close3 = mock(() => Promise.resolve());
      injectMockClient(manager, "ok1", { close: close1 });
      injectMockClient(manager, "fail", { close: close2 });
      injectMockClient(manager, "ok2", { close: close3 });

      await manager.disconnectAll();
      // All should be removed, even the one that failed
      expect(manager.getConnectedServers()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════
  // listTools (with mock-injected client)
  // ═══════════════════════════════════════════════════

  describe("listTools", () => {
    it("should throw for unconnected server", async () => {
      await expect(manager.listTools("nonexistent")).rejects.toThrow(
        'MCP server "nonexistent" is not connected',
      );
    });

    it("should return tools from injected mock client", async () => {
      const mockTools = [
        { name: "tool_a", inputSchema: { type: "object" } },
        { name: "tool_b", inputSchema: { type: "object" } },
      ];
      const listToolsFn = mock(() => Promise.resolve({ tools: mockTools }));
      injectMockClient(manager, "srv", { listTools: listToolsFn });

      const tools = await manager.listTools("srv");
      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe("tool_a");
      expect(tools[1]!.name).toBe("tool_b");
      expect(listToolsFn).toHaveBeenCalledTimes(1);
    });

    it("should return empty array when server has no tools", async () => {
      const listToolsFn = mock(() => Promise.resolve({ tools: [] }));
      injectMockClient(manager, "empty-srv", { listTools: listToolsFn });

      const tools = await manager.listTools("empty-srv");
      expect(tools).toEqual([]);
    });

    it("should propagate errors from client.listTools()", async () => {
      const listToolsFn = mock(() => Promise.reject(new Error("list failed")));
      injectMockClient(manager, "err-srv", { listTools: listToolsFn });

      await expect(manager.listTools("err-srv")).rejects.toThrow("list failed");
    });
  });

  // ═══════════════════════════════════════════════════
  // callTool (with mock-injected client)
  // ═══════════════════════════════════════════════════

  describe("callTool", () => {
    it("should throw for unconnected server", async () => {
      await expect(
        manager.callTool("nonexistent", "some_tool", {}),
      ).rejects.toThrow('MCP server "nonexistent" is not connected');
    });

    it("should delegate to correct injected client", async () => {
      const mockResult = {
        content: [{ type: "text" as const, text: "hello" }],
      };
      const callToolFn = mock(() => Promise.resolve(mockResult));
      injectMockClient(manager, "srv", { callTool: callToolFn });

      const result = await manager.callTool("srv", "my_tool", { key: "val" });
      expect(result).toEqual(mockResult);
      expect(callToolFn).toHaveBeenCalledWith({ name: "my_tool", arguments: { key: "val" } });
    });

    it("should pass empty args correctly", async () => {
      const callToolFn = mock(() => Promise.resolve({ content: [] }));
      injectMockClient(manager, "srv", { callTool: callToolFn });

      await manager.callTool("srv", "no_args_tool", {});
      expect(callToolFn).toHaveBeenCalledWith({ name: "no_args_tool", arguments: {} });
    });

    it("should propagate errors from client.callTool()", async () => {
      const callToolFn = mock(() => Promise.reject(new Error("call failed")));
      injectMockClient(manager, "err-srv", { callTool: callToolFn });

      await expect(
        manager.callTool("err-srv", "bad_tool", {}),
      ).rejects.toThrow("call failed");
    });
  });

  // ═══════════════════════════════════════════════════
  // getClient
  // ═══════════════════════════════════════════════════

  describe("getClient", () => {
    it("should return undefined for unconnected server", () => {
      expect(manager.getClient("nonexistent")).toBeUndefined();
    });

    it("should return injected client", () => {
      const fakeClient = { close: () => {} };
      injectMockClient(manager, "srv", fakeClient);
      // getClient returns the injected object (type-cast in test)
      expect(manager.getClient("srv")).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════
  // getConnectedServers
  // ═══════════════════════════════════════════════════

  describe("getConnectedServers", () => {
    it("should return empty array when none connected", () => {
      expect(manager.getConnectedServers()).toEqual([]);
    });

    it("should reflect injected clients", () => {
      injectMockClient(manager, "a", {});
      injectMockClient(manager, "b", {});
      const servers = manager.getConnectedServers();
      expect(servers).toContain("a");
      expect(servers).toContain("b");
      expect(servers).toHaveLength(2);
    });
  });
});
