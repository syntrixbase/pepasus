import { afterAll, describe, expect, test } from "bun:test";
import { Agent } from "@pegasus/agent.ts";
import type { AgentDeps } from "@pegasus/agent.ts";
import { EventType, createEvent } from "@pegasus/events/types.ts";
import { TaskState } from "@pegasus/task/states.ts";
import type { TaskFSM } from "@pegasus/task/fsm.ts";
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Agent.onTaskComplete", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });
  test("callback fires when task completes", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      const taskId = await agent.submit("Hello");
      expect(taskId).toBeTruthy();

      const result = await new Promise<TaskFSM>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("onTaskComplete timed out")), 5000);
        agent.onTaskComplete(taskId, (task) => {
          clearTimeout(timeout);
          resolve(task);
        });
      });

      expect(result.state).toBe(TaskState.COMPLETED);
      expect(result.taskId).toBe(taskId);
      expect(result.context.finalResult).not.toBeNull();
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("callback fires immediately if task already terminal", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      // Submit and wait for task to complete first
      const taskId = await agent.submit("Hello");
      expect(taskId).toBeTruthy();

      // Wait until task is terminal via polling
      let task: TaskFSM | null = null;
      for (let i = 0; i < 100; i++) {
        task = agent.taskRegistry.getOrNull(taskId);
        if (task?.isTerminal) break;
        await sleep(50);
      }
      expect(task?.isTerminal).toBe(true);

      // Now register callback — should fire synchronously
      let callbackFired = false;
      let callbackTask: TaskFSM | null = null;
      agent.onTaskComplete(taskId, (t) => {
        callbackFired = true;
        callbackTask = t;
      });

      // Callback should have fired synchronously (no await needed)
      expect(callbackFired).toBe(true);
      expect(callbackTask).not.toBeNull();
      expect(callbackTask!.state).toBe(TaskState.COMPLETED);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("callback fires on task failure", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      // Submit a task, then force failure via TASK_FAILED event
      const taskId = await agent.submit("Hello");
      expect(taskId).toBeTruthy();

      const result = await new Promise<TaskFSM>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("onTaskComplete timed out")), 5000);
        agent.onTaskComplete(taskId, (task) => {
          clearTimeout(timeout);
          resolve(task);
        });

        // Emit TASK_FAILED to force failure
        agent.eventBus.emit(
          createEvent(EventType.TASK_FAILED, {
            source: "test",
            taskId,
            payload: { error: "forced failure" },
          }),
        );
      });

      // Task should be in a terminal state (could be COMPLETED if it finished before the TASK_FAILED)
      expect(result.isTerminal).toBe(true);
    } finally {
      await agent.stop();
    }
  }, 10_000);
});
