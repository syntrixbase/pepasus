import { describe, it, expect } from "bun:test";
import { spawn_subagent } from "../../../src/tools/builtins/spawn-subagent-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";

describe("spawn_subagent tool", () => {
  it("should return subagent intent with description and input", async () => {
    const result = await spawn_subagent.execute(
      { description: "search the web", input: "find weather in Beijing" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const data = result.result as {
      action: string;
      description: string;
      input: string;
    };
    expect(data.action).toBe("spawn_subagent");
    expect(data.description).toBe("search the web");
    expect(data.input).toBe("find weather in Beijing");
  });

  it("should have correct tool metadata", () => {
    expect(spawn_subagent.name).toBe("spawn_subagent");
    expect(spawn_subagent.description).toContain("background subagent");
  });

  it("should include taskId from context", async () => {
    const result = await spawn_subagent.execute(
      { description: "test task", input: "test input" },
      { taskId: "ctx-123" },
    );
    const data = result.result as { taskId: string };
    expect(data.taskId).toBe("ctx-123");
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await spawn_subagent.execute(
      { description: "timed", input: "test" },
      { taskId: "test" },
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should use SYSTEM category", () => {
    expect(spawn_subagent.category).toBe(ToolCategory.SYSTEM);
  });

  it("should default type to general when not specified", async () => {
    const result = await spawn_subagent.execute(
      { description: "test", input: "test" },
      { taskId: "test" },
    );
    const data = result.result as { type: string };
    expect(data.type).toBe("general");
  });

  it("should pass through explicit type", async () => {
    const result = await spawn_subagent.execute(
      { description: "research", input: "find papers", type: "explore" },
      { taskId: "test" },
    );
    const data = result.result as { type: string };
    expect(data.type).toBe("explore");
  });

  it("should accept plan type", async () => {
    const result = await spawn_subagent.execute(
      { description: "plan", input: "analyze codebase", type: "plan" },
      { taskId: "test" },
    );
    const data = result.result as { type: string };
    expect(data.type).toBe("plan");
  });
});
