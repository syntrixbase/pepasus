import { describe, expect, test, afterAll } from "bun:test";
import { Agent } from "@pegasus/agent.ts";
import type { AgentDeps } from "@pegasus/agent.ts";
import { createEvent, EventType } from "@pegasus/events/types.ts";
import { TaskState } from "@pegasus/task/states.ts";
import type { TaskFSM } from "@pegasus/task/fsm.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { LanguageModel } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { rm } from "node:fs/promises";

const testDataDir = "/tmp/pegasus-test-agent-lifecycle";

/** Minimal mock LanguageModel that returns stub text. */
function createMockModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate() {
      return {
        text: "Hello! I am a helpful assistant.",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function testAgentDeps(): AgentDeps {
  return {
    model: createMockModel(),
    persona: testPersona,
    settings: SettingsSchema.parse({
      llm: { maxConcurrentCalls: 3 },
      agent: { maxActiveTasks: 10 },
      logLevel: "warn",
      dataDir: testDataDir,
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Agent lifecycle", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });
  test("single task completes end-to-end", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      await agent.eventBus.emit(
        createEvent(EventType.MESSAGE_RECEIVED, {
          source: "user",
          payload: { text: "Hello world" },
        }),
      );

      await sleep(500);

      const tasks = agent.taskRegistry.listAll();
      expect(tasks.length).toBeGreaterThanOrEqual(1);

      const completed = tasks.filter((t) => t.state === TaskState.COMPLETED);
      expect(completed.length).toBeGreaterThanOrEqual(1);

      const task = completed[0]!;
      expect(task.context.inputText).toBe("Hello world");
      expect(task.context.reasoning).not.toBeNull();
      expect(task.context.plan).not.toBeNull();
      expect(task.context.actionsDone.length).toBeGreaterThan(0);
      expect(task.context.reflections.length).toBeGreaterThan(0);
      expect(task.context.finalResult).not.toBeNull();
      expect(task.context.iteration).toBeGreaterThan(0);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("concurrent tasks (3 simultaneous)", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      for (let i = 0; i < 3; i++) {
        await agent.eventBus.emit(
          createEvent(EventType.MESSAGE_RECEIVED, {
            source: "user",
            payload: { text: `Task ${i}` },
          }),
        );
      }

      await sleep(1500);

      const tasks = agent.taskRegistry.listAll();
      const completed = tasks.filter((t) => t.state === TaskState.COMPLETED);
      expect(completed).toHaveLength(3);

      const inputs = new Set(completed.map((t) => t.context.inputText));
      expect(inputs).toEqual(new Set(["Task 0", "Task 1", "Task 2"]));
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("event history recorded", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      await agent.eventBus.emit(
        createEvent(EventType.MESSAGE_RECEIVED, {
          source: "user",
          payload: { text: "test" },
        }),
      );

      await sleep(500);

      const history = agent.eventBus.history;
      const types = history.map((e) => e.type);

      expect(types).toContain(EventType.SYSTEM_STARTED);
      expect(types).toContain(EventType.MESSAGE_RECEIVED);
      expect(types).toContain(EventType.TASK_CREATED);
      expect(types).toContain(EventType.REASON_DONE);
      expect(types).toContain(EventType.STEP_COMPLETED);
      expect(types).toContain(EventType.REFLECT_DONE);
      expect(types).toContain(EventType.TASK_COMPLETED);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("submit and waitForTask", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const taskId = await agent.submit("do something");
      expect(taskId).toBeTruthy();

      const task = await agent.waitForTask(taskId, 5000);
      expect(task.state).toBe(TaskState.COMPLETED);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("onTaskComplete fires asynchronously", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const taskId = await agent.submit("async callback test");
      expect(taskId).toBeTruthy();

      const completedTask = await new Promise<TaskFSM>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("onTaskComplete timed out")), 5000);
        agent.onTaskComplete(taskId, (task) => {
          clearTimeout(timeout);
          resolve(task);
        });
      });

      expect(completedTask.state).toBe(TaskState.COMPLETED);
      expect(completedTask.taskId).toBe(taskId);
      expect(completedTask.context.inputText).toBe("async callback test");
      expect(completedTask.context.finalResult).not.toBeNull();

      const result = completedTask.context.finalResult as Record<string, unknown>;
      expect(result["taskId"]).toBe(taskId);
    } finally {
      await agent.stop();
    }
  }, 10_000);
});
