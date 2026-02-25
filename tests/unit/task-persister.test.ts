import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskPersister } from "../../src/task/persister.ts";
import { EventBus } from "../../src/events/bus.ts";
import { TaskRegistry } from "../../src/task/registry.ts";
import { EventType, createEvent } from "../../src/events/types.ts";
import { TaskFSM } from "../../src/task/fsm.ts";
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

  describe("event-driven persistence", () => {
    beforeEach(async () => {
      await bus.start();
    });

    afterEach(async () => {
      await bus.stop();
    });

    it("should persist TASK_CREATED with input and update index+pending", async () => {
      const task = new TaskFSM({ taskId: "evt-task" });
      task.context.inputText = "hello world";
      task.context.source = "user";
      registry.register(task);

      // Manually set createdAt for deterministic date folder
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();

      await bus.emit(
        createEvent(EventType.TASK_CREATED, {
          source: "agent",
          taskId: "evt-task",
        }),
      );

      // Allow async handler to complete
      await Bun.sleep(100);

      // Check event log
      const logContent = await Bun.file(
        `${testDir}/tasks/2026-02-25/evt-task.jsonl`,
      ).text();
      const line = JSON.parse(logContent.trim());
      expect(line.event).toBe("TASK_CREATED");
      expect(line.data.inputText).toBe("hello world");

      // Check index
      const indexContent = await Bun.file(
        `${testDir}/tasks/index.jsonl`,
      ).text();
      const indexLine = JSON.parse(indexContent.trim());
      expect(indexLine.taskId).toBe("evt-task");
      expect(indexLine.date).toBe("2026-02-25");

      // Check pending
      const pendingContent = await Bun.file(
        `${testDir}/tasks/pending.json`,
      ).text();
      const pending = JSON.parse(pendingContent);
      expect(pending).toHaveLength(1);
      expect(pending[0].taskId).toBe("evt-task");
    });

    it("should persist REASON_DONE with reasoning and new messages", async () => {
      const task = new TaskFSM({ taskId: "reason-task" });
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      task.context.reasoning = { response: "thinking...", approach: "direct" };
      task.context.plan = { goal: "respond", steps: [], reasoning: "simple" };
      task.context.messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      registry.register(task);

      await bus.emit(
        createEvent(EventType.REASON_DONE, {
          source: "cognitive.reason",
          taskId: "reason-task",
        }),
      );
      await Bun.sleep(100);

      const content = await Bun.file(
        `${testDir}/tasks/2026-02-25/reason-task.jsonl`,
      ).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("REASON_DONE");
      expect(line.data.reasoning).toBeDefined();
      expect(line.data.plan).toBeDefined();
      expect(line.data.newMessages).toHaveLength(2);
    });

    it("should persist TASK_COMPLETED and remove from pending", async () => {
      const task = new TaskFSM({ taskId: "done-task" });
      (task as any).createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      task.context.finalResult = { response: "done" };
      task.context.iteration = 1;
      registry.register(task);

      // Pre-populate pending
      await persister._updatePendingForTest("add", "done-task", Date.now());

      await bus.emit(
        createEvent(EventType.TASK_COMPLETED, {
          source: "agent",
          taskId: "done-task",
        }),
      );
      await Bun.sleep(100);

      // Check event log
      const content = await Bun.file(
        `${testDir}/tasks/2026-02-25/done-task.jsonl`,
      ).text();
      const line = JSON.parse(content.trim());
      expect(line.event).toBe("TASK_COMPLETED");
      expect(line.data.finalResult).toEqual({ response: "done" });
      expect(line.data.iterations).toBe(1);

      // Check pending is empty
      const pendingContent = await Bun.file(
        `${testDir}/tasks/pending.json`,
      ).text();
      expect(JSON.parse(pendingContent)).toHaveLength(0);
    });
  });
});
