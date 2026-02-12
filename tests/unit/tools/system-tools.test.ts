/**
 * Unit tests for system tools.
 */

import { describe, it, expect } from "bun:test";
import { current_time, sleep, get_env, set_env } from "../../../src/tools/builtins/system-tools.ts";

describe("current_time tool", () => {
  it("should return current time", async () => {
    const context = { taskId: "test-task-id" };
    const result = await current_time.execute({}, context);

    expect(result.success).toBe(true);
    expect(result.result).toHaveProperty("timestamp");
    expect(result.result).toHaveProperty("iso");
    expect(result.result).toHaveProperty("timezone");
  });

  it("should handle timezone parameter", async () => {
    const context = { taskId: "test-task-id" };
    const result = await current_time.execute({ timezone: "UTC" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { timezone: string }).timezone).toBe("UTC");
  });
});

describe("sleep tool", () => {
  it("should sleep for specified duration", async () => {
    const context = { taskId: "test-task-id" };
    const start = Date.now();
    const result = await sleep.execute({ duration: 0.1 }, context);
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ slept: 0.1 });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(300);
  });
});

describe("get_env tool", () => {
  it("should get environment variable", async () => {
    process.env.TEST_VAR = "test_value";
    const context = { taskId: "test-task-id" };
    const result = await get_env.execute({ key: "TEST_VAR" }, context);

    expect(result.success).toBe(true);
    expect(result.result as { key: string; value: string | null }).toEqual({ key: "TEST_VAR", value: "test_value" });
  });

  it("should return null for unset variable", async () => {
    delete process.env.UNSET_VAR;
    const context = { taskId: "test-task-id" };
    const result = await get_env.execute({ key: "UNSET_VAR" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { value: string | null }).value).toBeNull();
  });
});

describe("set_env tool", () => {
  it("should set environment variable", async () => {
    delete process.env.NEW_VAR;
    const context = { taskId: "test-task-id" };
    const result = await set_env.execute({ key: "NEW_VAR", value: "new_value" }, context);

    expect(result.success).toBe(true);
    expect(result.result as { key: string; previous: string | null; current: string }).toEqual({ key: "NEW_VAR", previous: null, current: "new_value" });
    expect((process.env.NEW_VAR as string | undefined) ?? "UNDEFINED").toBe("new_value");
  });

  it("should return previous value when overwriting", async () => {
    process.env.EXISTING_VAR = "old_value";
    const context = { taskId: "test-task-id" };
    const result = await set_env.execute({ key: "EXISTING_VAR", value: "new_value" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { previous: string | null }).previous).toBe("old_value");
    expect((process.env.EXISTING_VAR as string | undefined) ?? "UNDEFINED").toBe("new_value");
  });
});
