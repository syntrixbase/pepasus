/**
 * Unit tests for ToolRegistry.
 */

import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import type { Tool, ToolCategory } from "../../../src/tools/types.ts";

describe("ToolRegistry", () => {
  it("should register a tool", () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "test_tool",
      description: "Test tool",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({
        success: true,
        startedAt: Date.now(),
      }),
    };

    registry.register(tool);
    expect(registry.has("test_tool")).toBe(true);
    expect(registry.get("test_tool")).toBe(tool);
  });

  it("should throw on duplicate registration", () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "test_tool",
      description: "Test tool",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({
        success: true,
        startedAt: Date.now(),
      }),
    };

    registry.register(tool);
    expect(() => registry.register(tool)).toThrow();
  });

  it("should list all tools", () => {
    const registry = new ToolRegistry();
    const tool1: Tool = {
      name: "tool1",
      description: "Tool 1",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };
    const tool2: Tool = {
      name: "tool2",
      description: "Tool 2",
      category: "file" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };

    registry.registerMany([tool1, tool2]);
    const tools = registry.list();
    expect(tools).toHaveLength(2);
    expect(tools).toContain(tool1);
    expect(tools).toContain(tool2);
  });

  it("should filter tools by category", () => {
    const registry = new ToolRegistry();
    const systemTool: Tool = {
      name: "system_tool",
      description: "System tool",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };
    const fileTool: Tool = {
      name: "file_tool",
      description: "File tool",
      category: "file" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };

    registry.registerMany([systemTool, fileTool]);
    const systemTools = registry.listByCategory("system" as ToolCategory);
    expect(systemTools).toHaveLength(1);
    expect(systemTools[0]?.name).toBe("system_tool");
  });

  it("should track call statistics", () => {
    const registry = new ToolRegistry();

    registry.updateCallStats("test_tool", 100, true);
    registry.updateCallStats("test_tool", 200, true);
    registry.updateCallStats("test_tool", 50, false);

    const stats = registry.getStats();
    expect(stats.callStats["test_tool"]).toEqual({
      count: 3,
      failures: 1,
      avgDuration: 116.66666666666667,
    });
  });

  it("should convert tools to LLM format", () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "test_tool",
      description: "Test tool description",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };

    registry.register(tool);
    const llmTools = registry.toLLMTools();

    expect(llmTools).toHaveLength(1);
    expect(llmTools[0]).toEqual({
      name: "test_tool",
      description: "Test tool description",
      parameters: expect.any(Object),
    });
  });
});
