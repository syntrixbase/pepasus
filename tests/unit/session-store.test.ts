import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../../src/session/store.ts";
import { rm } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-session";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    store = new SessionStore(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should append and load messages", async () => {
    await store.append({ role: "user", content: "hello" });
    await store.append({ role: "assistant", content: "hi there" });

    const messages = await store.load();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("hello");
    expect(messages[1]!.role).toBe("assistant");
  });

  it("should return empty array when no session exists", async () => {
    const messages = await store.load();
    expect(messages).toEqual([]);
  });

  it("should preserve tool call fields", async () => {
    await store.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc1", name: "current_time", arguments: {} }],
    });
    await store.append({
      role: "tool",
      content: "2026-02-25",
      toolCallId: "tc1",
    });

    const messages = await store.load();
    expect(messages[0]!.toolCalls).toHaveLength(1);
    expect(messages[1]!.toolCallId).toBe("tc1");
  });

  it("should compact current session to archive", async () => {
    await store.append({ role: "user", content: "old message" });
    await store.append({ role: "assistant", content: "old reply" });

    const archiveName = await store.compact("Summary of previous session");

    // Archive exists
    expect(archiveName).toMatch(/\.jsonl$/);
    const archives = await store.listArchives();
    expect(archives).toContain(archiveName);

    // New current has compact summary
    const messages = await store.load();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBe("Summary of previous session");
  });

  it("should handle compact when no current session exists", async () => {
    await store.compact("Empty summary");
    const messages = await store.load();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Empty summary");
  });

  it("should list no archives when directory is empty", async () => {
    const archives = await store.listArchives();
    expect(archives).toEqual([]);
  });

  it("should support metadata on append", async () => {
    await store.append(
      { role: "user", content: "with meta" },
      { channel: { type: "cli" } },
    );

    // Verify round-trip — load only restores Message fields
    const messages = await store.load();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("with meta");
  });

  describe("unclosed tool call repair", () => {
    it("should repair unclosed tool calls on load", async () => {
      // Write session with unclosed tool call
      await store.append({ role: "user", content: "hello" });
      await store.append({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", name: "current_time", arguments: {} }],
      });
      // NO tool result — process "crashed"

      const messages = await store.load();
      // Should have 3 messages: user, assistant, injected tool cancellation
      expect(messages).toHaveLength(3);
      expect(messages[2]!.role).toBe("tool");
      expect(messages[2]!.toolCallId).toBe("tc1");
      const content = JSON.parse(messages[2]!.content);
      expect(content.cancelled).toBe(true);
      expect(content.reason).toContain("process restarted");
    });

    it("should not repair when all tool calls have results", async () => {
      await store.append({ role: "user", content: "hello" });
      await store.append({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", name: "current_time", arguments: {} }],
      });
      await store.append({ role: "tool", content: "result", toolCallId: "tc1" });

      const messages = await store.load();
      expect(messages).toHaveLength(3); // No extra message injected
    });

    it("should repair only unclosed tool calls when some are closed", async () => {
      await store.append({ role: "user", content: "hello" });
      await store.append({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", name: "current_time", arguments: {} },
          { id: "tc2", name: "reply", arguments: { text: "hi", channelId: "main" } },
        ],
      });
      await store.append({ role: "tool", content: "time result", toolCallId: "tc1" });
      // tc2 has no result

      const messages = await store.load();
      expect(messages).toHaveLength(4); // user + assistant + tc1 result + tc2 cancelled
      expect(messages[3]!.toolCallId).toBe("tc2");
      expect(JSON.parse(messages[3]!.content).cancelled).toBe(true);
    });

    it("should not modify session with no tool calls", async () => {
      await store.append({ role: "user", content: "hello" });
      await store.append({ role: "assistant", content: "hi" });

      const messages = await store.load();
      expect(messages).toHaveLength(2);
    });
  });
});
