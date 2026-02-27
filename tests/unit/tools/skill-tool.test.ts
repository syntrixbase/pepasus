import { describe, expect, test } from "bun:test";
import { use_skill } from "@pegasus/tools/builtins/skill-tool.ts";
import { ToolCategory } from "@pegasus/tools/types.ts";

describe("use_skill tool", () => {
  test("returns signal with action, skill name, and args", async () => {
    const result = await use_skill.execute(
      { skill: "code-review", args: "PR #42" },
      { taskId: "test" },
    );

    expect(result.success).toBe(true);
    const data = result.result as { action: string; skill: string; args: string };
    expect(data.action).toBe("use_skill");
    expect(data.skill).toBe("code-review");
    expect(data.args).toBe("PR #42");
  });

  test("returns signal without args when not provided", async () => {
    const result = await use_skill.execute(
      { skill: "commit" },
      { taskId: "test" },
    );

    expect(result.success).toBe(true);
    const data = result.result as { action: string; skill: string; args?: string };
    expect(data.action).toBe("use_skill");
    expect(data.skill).toBe("commit");
    expect(data.args).toBeUndefined();
  });

  test("includes timing metadata", async () => {
    const result = await use_skill.execute(
      { skill: "test-skill" },
      { taskId: "test" },
    );

    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("has correct tool metadata", () => {
    expect(use_skill.name).toBe("use_skill");
    expect(use_skill.description).toContain("skill");
    expect(use_skill.category).toBe(ToolCategory.SYSTEM);
  });
});
