import { describe, it, expect } from "bun:test";
import { spawn_task } from "../../../src/tools/builtins/spawn-task-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";

describe("spawn_task tool", () => {
  it("should return task intent with description and input", async () => {
    const result = await spawn_task.execute(
      { description: "search the web", input: "find weather in Beijing" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const data = result.result as {
      action: string;
      description: string;
      input: string;
    };
    expect(data.action).toBe("spawn_task");
    expect(data.description).toBe("search the web");
    expect(data.input).toBe("find weather in Beijing");
  });

  it("should have correct tool metadata", () => {
    expect(spawn_task.name).toBe("spawn_task");
    expect(spawn_task.description).toContain("background task");
  });

  it("should include taskId from context", async () => {
    const result = await spawn_task.execute(
      { description: "test task", input: "test input" },
      { taskId: "ctx-123" },
    );
    const data = result.result as { taskId: string };
    expect(data.taskId).toBe("ctx-123");
  });

  it("should include timing information", async () => {
    const before = Date.now();
    const result = await spawn_task.execute(
      { description: "timed", input: "test" },
      { taskId: "test" },
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should use SYSTEM category", () => {
    expect(spawn_task.category).toBe(ToolCategory.SYSTEM);
  });
});
