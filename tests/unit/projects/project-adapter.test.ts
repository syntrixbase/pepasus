/**
 * Tests for ProjectAdapter — ChannelAdapter multiplexer for Worker threads.
 *
 * We test the adapter's management logic (type, activeCount, has, error paths)
 * without spawning real Worker threads, since that requires the actual Worker
 * entry point file (Task 5).
 */
import { describe, it, expect } from "bun:test";
import { ProjectAdapter } from "@pegasus/projects/project-adapter.ts";

describe("ProjectAdapter", () => {
  it("should have type 'project'", () => {
    const adapter = new ProjectAdapter();
    expect(adapter.type).toBe("project");
  });

  it("should start with 0 active count", () => {
    const adapter = new ProjectAdapter();
    expect(adapter.activeCount).toBe(0);
  });

  it("has() returns false for unknown project", () => {
    const adapter = new ProjectAdapter();
    expect(adapter.has("nonexistent")).toBe(false);
  });

  it("deliver() should silently handle unknown channelId (no throw)", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Should not throw when delivering to unknown project
    await expect(
      adapter.deliver({
        text: "hello",
        channel: { type: "project", channelId: "unknown-project" },
      }),
    ).resolves.toBeUndefined();
  });

  it("startProject should throw if adapter not started", () => {
    const adapter = new ProjectAdapter();
    // Adapter not started — agentSend is null
    expect(() => adapter.startProject("proj-1", "/tmp/proj-1")).toThrow(
      "ProjectAdapter not started",
    );
  });

  it("stopProject should be no-op for unknown project", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Should not throw when stopping unknown project
    await expect(adapter.stopProject("nonexistent")).resolves.toBeUndefined();
  });

  it("stop() with no workers should work", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Should complete without error
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.activeCount).toBe(0);
  });

  it("should implement ChannelAdapter interface", () => {
    const adapter = new ProjectAdapter();
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.deliver).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(adapter.type).toBe("project");
  });

  it("setModelRegistry should accept a ModelRegistry", () => {
    const adapter = new ProjectAdapter();
    // Just verify it doesn't throw — we pass a mock object
    const mockRegistry = { get: () => ({}) } as any;
    adapter.setModelRegistry(mockRegistry);
    // No assertion needed — if it doesn't throw, it works
  });

  it("_handleLLMRequest should warn and return for unknown project", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Should not throw for unknown project
    await expect(
      adapter._handleLLMRequest("unknown", {
        type: "llm_request",
        requestId: "req-1",
        options: { messages: [] },
      }),
    ).resolves.toBeUndefined();
  });
});
