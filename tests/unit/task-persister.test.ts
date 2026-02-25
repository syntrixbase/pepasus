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

  describe("replay", () => {
    it("should reconstruct TaskContext from JSONL event log", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "replay-task";

      // Write a complete task lifecycle
      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "what is 2+2?",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "REASON_DONE", {
        reasoning: { response: "4", approach: "direct" },
        plan: {
          goal: "respond",
          steps: [
            {
              index: 0,
              description: "reply",
              actionType: "respond",
              actionParams: {},
              completed: false,
            },
          ],
          reasoning: "simple",
        },
        newMessages: [
          { role: "user", content: "what is 2+2?" },
          { role: "assistant", content: "4" },
        ],
      });
      await persister._appendForTest(taskId, createdAt, "REFLECT_DONE", {
        reflection: {
          verdict: "complete",
          assessment: "answered",
          lessons: [],
        },
      });
      await persister._appendForTest(taskId, createdAt, "TASK_COMPLETED", {
        finalResult: { response: "4" },
        iterations: 1,
        newMessages: [],
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.id).toBe(taskId);
      expect(ctx.inputText).toBe("what is 2+2?");
      expect(ctx.source).toBe("user");
      expect(ctx.messages).toHaveLength(2);
      expect(ctx.messages[0]!.content).toBe("what is 2+2?");
      expect(ctx.messages[1]!.content).toBe("4");
      expect(ctx.reasoning).toBeDefined();
      expect(ctx.reasoning!.response).toBe("4");
      expect(ctx.plan).toBeDefined();
      expect(ctx.plan!.goal).toBe("respond");
      expect(ctx.reflections).toHaveLength(1);
      expect(ctx.reflections[0]!.verdict).toBe("complete");
      expect(ctx.finalResult).toEqual({ response: "4" });
      expect(ctx.iteration).toBe(1);
    });

    it("should handle tool call events in replay", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "tool-replay-task";

      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "search for info",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "REASON_DONE", {
        reasoning: { response: "need to search", approach: "tool_use" },
        plan: {
          goal: "search",
          steps: [
            {
              index: 0,
              description: "search",
              actionType: "tool_call",
              actionParams: {},
              completed: false,
            },
          ],
          reasoning: "needs data",
        },
        newMessages: [
          { role: "user", content: "search for info" },
          {
            role: "assistant",
            content: "I will search for that",
            toolCalls: [
              { toolName: "web_search", args: { query: "info" } },
            ],
          },
        ],
      });
      await persister._appendForTest(
        taskId,
        createdAt,
        "TOOL_CALL_COMPLETED",
        {
          action: {
            stepIndex: 0,
            actionType: "tool_call",
            actionInput: { toolName: "web_search", query: "info" },
            result: "found some info",
            success: true,
            startedAt: createdAt,
            completedAt: createdAt + 100,
            durationMs: 100,
          },
          newMessages: [
            { role: "tool", content: "found some info", toolCallId: "tc1" },
          ],
        },
      );
      await persister._appendForTest(taskId, createdAt, "REFLECT_DONE", {
        reflection: {
          verdict: "complete",
          assessment: "found info",
          lessons: ["searching works"],
        },
      });
      await persister._appendForTest(taskId, createdAt, "TASK_COMPLETED", {
        finalResult: { response: "Here is the info" },
        iterations: 1,
        newMessages: [
          { role: "assistant", content: "Here is the info" },
        ],
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.actionsDone).toHaveLength(1);
      expect(ctx.actionsDone[0]!.actionType).toBe("tool_call");
      expect(ctx.actionsDone[0]!.success).toBe(true);
      expect(ctx.actionsDone[0]!.result).toBe("found some info");
      // Messages: 2 from REASON_DONE + 1 from TOOL_CALL_COMPLETED + 1 from TASK_COMPLETED
      expect(ctx.messages).toHaveLength(4);
      expect(ctx.messages[2]!.role).toBe("tool");
      expect(ctx.reflections).toHaveLength(1);
      expect(ctx.finalResult).toEqual({ response: "Here is the info" });
    });

    it("should handle TASK_FAILED event in replay", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "failed-replay-task";

      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "do something impossible",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "TASK_FAILED", {
        error: "Something went wrong",
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.id).toBe(taskId);
      expect(ctx.inputText).toBe("do something impossible");
      expect(ctx.error).toBe("Something went wrong");
      expect(ctx.finalResult).toBeNull();
    });

    it("should handle NEED_MORE_INFO event in replay", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "needinfo-replay-task";

      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "vague request",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "NEED_MORE_INFO", {
        reasoning: { question: "Can you clarify?" },
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.id).toBe(taskId);
      expect(ctx.reasoning).toEqual({ question: "Can you clarify?" });
    });

    it("should handle TOOL_CALL_FAILED event in replay", async () => {
      const createdAt = new Date("2026-02-25T10:00:00Z").getTime();
      const taskId = "toolfail-replay-task";

      await persister._appendForTest(taskId, createdAt, "TASK_CREATED", {
        inputText: "try something",
        source: "user",
        inputMetadata: {},
      });
      await persister._appendForTest(taskId, createdAt, "TOOL_CALL_FAILED", {
        action: {
          stepIndex: 0,
          actionType: "tool_call",
          actionInput: { toolName: "broken_tool" },
          success: false,
          error: "tool not found",
          startedAt: createdAt,
          completedAt: createdAt + 50,
          durationMs: 50,
        },
        newMessages: [
          { role: "tool", content: "Error: tool not found", toolCallId: "tc2" },
        ],
      });

      const filePath = `${testDir}/tasks/2026-02-25/${taskId}.jsonl`;
      const ctx = await TaskPersister.replay(filePath);

      expect(ctx.actionsDone).toHaveLength(1);
      expect(ctx.actionsDone[0]!.success).toBe(false);
      expect(ctx.actionsDone[0]!.error).toBe("tool not found");
      expect(ctx.messages).toHaveLength(1);
      expect(ctx.messages[0]!.role).toBe("tool");
    });
  });

  describe("loadIndex", () => {
    it("should load taskId → date mapping from index.jsonl", async () => {
      // Write index entries
      await persister._appendIndexForTest("task-a", "2026-02-25");
      await persister._appendIndexForTest("task-b", "2026-02-25");
      await persister._appendIndexForTest("task-c", "2026-02-24");

      const map = await TaskPersister.loadIndex(`${testDir}/tasks`);

      expect(map.size).toBe(3);
      expect(map.get("task-a")).toBe("2026-02-25");
      expect(map.get("task-b")).toBe("2026-02-25");
      expect(map.get("task-c")).toBe("2026-02-24");
    });

    it("should return empty map when index doesn't exist", async () => {
      const map = await TaskPersister.loadIndex(
        "/tmp/pegasus-test-persister-nonexistent/tasks",
      );

      expect(map.size).toBe(0);
    });
  });

  describe("resolveTaskPath", () => {
    it("should return file path for known taskId", async () => {
      await persister._appendIndexForTest("task-x", "2026-02-25");

      const result = await TaskPersister.resolveTaskPath(
        `${testDir}/tasks`,
        "task-x",
      );

      expect(result).toBe(`${testDir}/tasks/2026-02-25/task-x.jsonl`);
    });

    it("should return null for unknown taskId", async () => {
      const result = await TaskPersister.resolveTaskPath(
        `${testDir}/tasks`,
        "nonexistent",
      );

      expect(result).toBeNull();
    });
  });
});
