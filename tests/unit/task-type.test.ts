import { describe, expect, test } from "bun:test";
import { TaskType, DEFAULT_TASK_TYPE } from "@pegasus/task/task-type.ts";
import { getToolsForType, exploreTools, planTools, allTaskTools } from "@pegasus/tools/builtins/index.ts";
import { createTaskContext } from "@pegasus/task/context.ts";

describe("TaskType enum", () => {
  test("has correct string values", () => {
    expect(TaskType.GENERAL).toBe("general" as TaskType);
    expect(TaskType.EXPLORE).toBe("explore" as TaskType);
    expect(TaskType.PLAN).toBe("plan" as TaskType);
  });

  test("DEFAULT_TASK_TYPE is general", () => {
    expect(DEFAULT_TASK_TYPE).toBe(TaskType.GENERAL);
  });
});

describe("getToolsForType", () => {
  test("general returns all task tools", () => {
    const tools = getToolsForType("general");
    expect(tools).toBe(allTaskTools);
    expect(tools.length).toBeGreaterThan(20);
  });

  test("explore returns read-only subset", () => {
    const tools = getToolsForType("explore");
    expect(tools).toBe(exploreTools);
    const names = tools.map((t) => t.name);

    // Should include read-only tools
    expect(names).toContain("read_file");
    expect(names).toContain("list_files");
    expect(names).toContain("grep_files");
    expect(names).toContain("http_get");
    expect(names).toContain("web_search");
    expect(names).toContain("memory_read");
    expect(names).toContain("notify");

    // Should NOT include write/mutate tools
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("delete_file");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("move_file");
    expect(names).not.toContain("http_post");
    expect(names).not.toContain("http_request");
    expect(names).not.toContain("memory_write");
    expect(names).not.toContain("memory_patch");
    expect(names).not.toContain("memory_append");
    expect(names).not.toContain("set_env");
    expect(names).not.toContain("sleep");
  });

  test("plan returns read-only + memory write", () => {
    const tools = getToolsForType("plan");
    expect(tools).toBe(planTools);
    const names = tools.map((t) => t.name);

    // Should include read-only tools
    expect(names).toContain("read_file");
    expect(names).toContain("grep_files");
    expect(names).toContain("web_search");

    // Should include memory write tools
    expect(names).toContain("memory_write");
    expect(names).toContain("memory_append");

    // Should NOT include file write or other mutate tools
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("delete_file");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("http_post");
    expect(names).not.toContain("http_request");
    expect(names).not.toContain("memory_patch");
  });

  test("unknown type defaults to general", () => {
    const tools = getToolsForType("unknown_type");
    expect(tools).toBe(allTaskTools);
  });

  test("all types include notify", () => {
    for (const type of ["general", "explore", "plan"]) {
      const names = getToolsForType(type).map((t) => t.name);
      expect(names).toContain("notify");
    }
  });

  test("explore is strict subset of general", () => {
    const generalNames = new Set(getToolsForType("general").map((t) => t.name));
    const exploreNames = getToolsForType("explore").map((t) => t.name);
    for (const name of exploreNames) {
      expect(generalNames.has(name)).toBe(true);
    }
    expect(exploreNames.length).toBeLessThan(generalNames.size);
  });

  test("plan is strict subset of general", () => {
    const generalNames = new Set(getToolsForType("general").map((t) => t.name));
    const planNames = getToolsForType("plan").map((t) => t.name);
    for (const name of planNames) {
      expect(generalNames.has(name)).toBe(true);
    }
    expect(planNames.length).toBeLessThan(generalNames.size);
  });
});

describe("TaskContext taskType", () => {
  test("createTaskContext defaults taskType to general", () => {
    const ctx = createTaskContext();
    expect(ctx.taskType).toBe("general");
  });

  test("createTaskContext accepts custom taskType", () => {
    const ctx = createTaskContext({ taskType: "explore" });
    expect(ctx.taskType).toBe("explore");
  });
});
