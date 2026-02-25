import { afterAll, describe, expect, test } from "bun:test";
import { Agent } from "@pegasus/agents/agent.ts";
import type { AgentDeps, TaskNotification } from "@pegasus/agents/agent.ts";
import { EventType, createEvent } from "@pegasus/events/types.ts";
import { TaskState } from "@pegasus/task/states.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { LanguageModel } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { rm } from "node:fs/promises";

const testDataDir = "/tmp/pegasus-test-agent-api";

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

describe("Agent.onNotify", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test("callback fires with completed notification when task completes", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const notifications: TaskNotification[] = [];

      agent.onNotify((notification) => {
        notifications.push(notification);
      });

      const taskId = await agent.submit("Hello");
      expect(taskId).toBeTruthy();

      // Wait for task to finish
      const task = await agent.waitForTask(taskId, 5000);
      expect(task.state).toBe(TaskState.COMPLETED);

      // Verify notification was received
      const completedNotif = notifications.find(
        (n) => n.taskId === taskId && n.type === "completed",
      );
      expect(completedNotif).toBeDefined();
      expect(completedNotif!.type).toBe("completed");
      expect(completedNotif!.taskId).toBe(taskId);
      expect((completedNotif as { type: "completed"; result: unknown }).result).not.toBeNull();
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("callback fires with failed notification on task failure", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const notifications: TaskNotification[] = [];

      agent.onNotify((notification) => {
        notifications.push(notification);
      });

      const taskId = await agent.submit("Hello");
      expect(taskId).toBeTruthy();

      // Emit TASK_FAILED to force failure
      await agent.eventBus.emit(
        createEvent(EventType.TASK_FAILED, {
          source: "test",
          taskId,
          payload: { error: "forced failure" },
        }),
      );

      // Wait for task to reach terminal state
      const task = await agent.waitForTask(taskId, 5000);
      expect(task.isTerminal).toBe(true);

      // Verify at least one notification was received for this task
      const taskNotifs = notifications.filter((n) => n.taskId === taskId);
      expect(taskNotifs.length).toBeGreaterThanOrEqual(1);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("multiple tasks each produce notifications", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const notifications: TaskNotification[] = [];

      agent.onNotify((notification) => {
        notifications.push(notification);
      });

      const taskId1 = await agent.submit("Task A");
      const taskId2 = await agent.submit("Task B");

      await agent.waitForTask(taskId1, 5000);
      await agent.waitForTask(taskId2, 5000);

      const ids = new Set(notifications.map((n) => n.taskId));
      expect(ids.has(taskId1)).toBe(true);
      expect(ids.has(taskId2)).toBe(true);
    } finally {
      await agent.stop();
    }
  }, 10_000);
});
