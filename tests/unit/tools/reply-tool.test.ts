import { describe, it, expect } from "bun:test";
import { reply } from "../../../src/tools/builtins/reply-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";

describe("reply tool", () => {
  it("should return reply intent with text and channelId", async () => {
    const result = await reply.execute(
      { text: "Hello!", channelId: "main" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const data = result.result as {
      action: string;
      text: string;
      channelId: string;
    };
    expect(data.action).toBe("reply");
    expect(data.text).toBe("Hello!");
    expect(data.channelId).toBe("main");
  });

  it("should accept optional replyTo parameter", async () => {
    const result = await reply.execute(
      { text: "In thread", channelId: "#general", replyTo: "thread:123" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const data = result.result as { action: string; replyTo: string };
    expect(data.replyTo).toBe("thread:123");
  });

  it("should have correct tool metadata", () => {
    expect(reply.name).toBe("reply");
    expect(reply.description).toContain("ONLY way");
    expect(reply.description).toContain("inner monologue");
  });

  it("should include timing metadata", async () => {
    const before = Date.now();
    const result = await reply.execute(
      { text: "test", channelId: "main" },
      { taskId: "test" },
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should use SYSTEM category", () => {
    expect(reply.category).toBe(ToolCategory.SYSTEM);
  });

  it("should omit replyTo when not provided", async () => {
    const result = await reply.execute(
      { text: "No thread", channelId: "main" },
      { taskId: "test" },
    );
    const data = result.result as { replyTo?: string };
    expect(data.replyTo).toBeUndefined();
  });
});
