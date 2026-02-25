import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskPersister } from "../../src/task/persister.ts";
import { EventBus } from "../../src/events/bus.ts";
import { TaskRegistry } from "../../src/task/registry.ts";
import { rm, mkdir } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-persister";

describe("TaskPersister", () => {
  let persister: TaskPersister;
  let bus: EventBus;
  let registry: TaskRegistry;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    bus = new EventBus();
    registry = new TaskRegistry();
    persister = new TaskPersister(bus, registry, testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("_append", () => {
    it("should create date folder and write JSONL line", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      await persister._appendForTest("task1", createdAt, "TASK_CREATED", {
        inputText: "hello",
      });

      const content = await Bun.file(
        `${testDir}/tasks/2026-02-25/task1.jsonl`,
      ).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("TASK_CREATED");
      expect(line.taskId).toBe("task1");
      expect(line.data.inputText).toBe("hello");
      expect(line.ts).toBeGreaterThan(0);
    });

    it("should append multiple lines to same file", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      await persister._appendForTest("task1", createdAt, "TASK_CREATED", {
        inputText: "hello",
      });
      await persister._appendForTest("task1", createdAt, "REASON_DONE", {
        reasoning: {},
      });

      const content = await Bun.file(
        `${testDir}/tasks/2026-02-25/task1.jsonl`,
      ).text();
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).event).toBe("TASK_CREATED");
      expect(JSON.parse(lines[1]!).event).toBe("REASON_DONE");
    });
  });

  describe("_appendIndex", () => {
    it("should append taskId → date mapping to index.jsonl", async () => {
      await persister._appendIndexForTest("task1", "2026-02-25");

      const content = await Bun.file(`${testDir}/tasks/index.jsonl`).text();
      const line = JSON.parse(content.trim());
      expect(line.taskId).toBe("task1");
      expect(line.date).toBe("2026-02-25");
    });
  });

  describe("_updatePending", () => {
    it("should add task to pending.json", async () => {
      await persister._updatePendingForTest("add", "task1", 1740000000);

      const content = await Bun.file(`${testDir}/tasks/pending.json`).text();
      const arr = JSON.parse(content);
      expect(arr).toHaveLength(1);
      expect(arr[0].taskId).toBe("task1");
    });

    it("should remove task from pending.json", async () => {
      await persister._updatePendingForTest("add", "task1", 1740000000);
      await persister._updatePendingForTest("add", "task2", 1740000001);
      await persister._updatePendingForTest("remove", "task1");

      const content = await Bun.file(`${testDir}/tasks/pending.json`).text();
      const arr = JSON.parse(content);
      expect(arr).toHaveLength(1);
      expect(arr[0].taskId).toBe("task2");
    });
  });
});
