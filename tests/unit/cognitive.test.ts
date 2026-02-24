import { describe, expect, test } from "bun:test";
import type { LanguageModel, Message } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { createTaskContext } from "@pegasus/task/context.ts";
import type { PlanStep, ActionResult } from "@pegasus/task/context.ts";
import { Perceiver } from "@pegasus/cognitive/perceive.ts";
import { Thinker } from "@pegasus/cognitive/think.ts";
import { Planner } from "@pegasus/cognitive/plan.ts";
import { Actor } from "@pegasus/cognitive/act.ts";
import { Reflector } from "@pegasus/cognitive/reflect.ts";
import { ToolRegistry } from "@pegasus/tools/registry.ts";
import { z } from "zod";
import type { ToolCall } from "@pegasus/models/tool.ts";

// ── Helpers ────────────────────────────────────────

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function createMockModel(responseText: string): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate() {
      return {
        text: responseText,
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

function createToolCallMockModel(toolCalls: ToolCall[]): LanguageModel & { lastOptions?: unknown } {
  const model: LanguageModel & { lastOptions?: unknown } = {
    provider: "test",
    modelId: "test-model",
    lastOptions: undefined,
    async generate(options) {
      model.lastOptions = options;
      return {
        text: "",
        finishReason: "tool_calls",
        toolCalls,
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
  return model;
}

function makeActionResult(overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    stepIndex: 0,
    actionType: "respond",
    actionInput: {},
    result: "done",
    success: true,
    startedAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  };
}

function makePlanStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    index: 0,
    description: "Test step",
    actionType: "respond",
    actionParams: {},
    completed: false,
    ...overrides,
  };
}

// ── Perceiver ───────────────────────────────────────

describe("Perceiver", () => {
  test("parses valid JSON response from model", async () => {
    const jsonResponse = JSON.stringify({
      taskType: "conversation",
      intent: "greeting",
      urgency: "low",
      keyEntities: ["user"],
    });
    const model = createMockModel(jsonResponse);
    const perceiver = new Perceiver(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello there!" });
    const result = await perceiver.run(ctx);

    expect(result).toEqual({
      taskType: "conversation",
      intent: "greeting",
      urgency: "low",
      keyEntities: ["user"],
    });
  });

  test("falls back to default perception when model returns invalid JSON", async () => {
    const invalidJson = "This is not valid JSON at all";
    const model = createMockModel(invalidJson);
    const perceiver = new Perceiver(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello there!" });
    const result = await perceiver.run(ctx);

    expect(result).toEqual({
      taskType: "conversation",
      intent: invalidJson,
      urgency: "normal",
      keyEntities: [],
    });
  });

  test("handles empty string response as invalid JSON", async () => {
    const model = createMockModel("");
    const perceiver = new Perceiver(model, testPersona);

    const ctx = createTaskContext({ inputText: "test" });
    const result = await perceiver.run(ctx);

    // Empty string is invalid JSON → fallback
    expect(result.taskType).toBe("conversation");
    expect(result.intent).toBe("");
    expect(result.urgency).toBe("normal");
    expect(result.keyEntities).toEqual([]);
  });

  test("parses non-conversation task type", async () => {
    const jsonResponse = JSON.stringify({
      taskType: "code_generation",
      intent: "write a function",
      urgency: "high",
      keyEntities: ["function", "typescript"],
    });
    const model = createMockModel(jsonResponse);
    const perceiver = new Perceiver(model, testPersona);

    const ctx = createTaskContext({ inputText: "Write a sort function" });
    const result = await perceiver.run(ctx);

    expect(result.taskType).toBe("code_generation");
    expect(result.urgency).toBe("high");
    expect(result.keyEntities).toEqual(["function", "typescript"]);
  });
});

// ── Thinker ─────────────────────────────────────────

describe("Thinker", () => {
  test("generates reasoning with empty messages (adds current input)", async () => {
    const model = createMockModel("Here is my helpful response");
    const thinker = new Thinker(model, testPersona);

    const ctx = createTaskContext({ inputText: "What is 2+2?" });
    const result = await thinker.run(ctx);

    expect(result).toEqual({
      response: "Here is my helpful response",
      approach: "direct",
      needsClarification: false,
    });
  });

  test("maps existing messages and adds current input when last message differs", async () => {
    const model = createMockModel("Follow-up response");
    const thinker = new Thinker(model, testPersona);

    const ctx = createTaskContext({ inputText: "And what about 3+3?" });
    ctx.messages = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ];

    const result = await thinker.run(ctx);

    // Lines 28-30 are covered: context.messages.map() processes existing messages
    expect(result.response).toBe("Follow-up response");
    expect(result.approach).toBe("direct");
    expect(result.needsClarification).toBe(false);
  });

  test("does NOT duplicate current input when last message matches inputText", async () => {
    const model = createMockModel("Response without duplication");
    const thinker = new Thinker(model, testPersona);

    const ctx = createTaskContext({ inputText: "What is 2+2?" });
    // Last message content equals inputText → should NOT add it again
    ctx.messages = [
      { role: "user", content: "What is 2+2?" },
    ];

    const result = await thinker.run(ctx);

    expect(result.response).toBe("Response without duplication");
    expect(result.approach).toBe("direct");
  });

  test("handles messages with null/undefined content via String()", async () => {
    const model = createMockModel("Handled gracefully");
    const thinker = new Thinker(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.messages = [
      { role: "user", content: null },
      { role: "assistant" }, // content is undefined
    ] as unknown as Message[];

    const result = await thinker.run(ctx);

    // String(null) → "null", String(undefined) → "" (via ?? "")
    // Last message content is "" which !== "Hello", so input is appended
    expect(result.response).toBe("Handled gracefully");
  });

  test("handles multiple messages in conversation history", async () => {
    const model = createMockModel("Multi-turn response");
    const thinker = new Thinker(model, testPersona);

    const ctx = createTaskContext({ inputText: "Thanks!" });
    ctx.messages = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "I'm good!" },
    ];
    ctx.iteration = 2;

    const result = await thinker.run(ctx);

    expect(result.response).toBe("Multi-turn response");
  });

  test("passes tools to LLM when toolRegistry is provided", async () => {
    const toolCalls: ToolCall[] = [{ id: "c1", name: "current_time", arguments: {} }];
    const model = createToolCallMockModel(toolCalls);

    const registry = new ToolRegistry();
    registry.register({
      name: "current_time",
      description: "Get current time",
      category: "system" as any,
      parameters: z.object({}),
      execute: async () => ({ success: true, startedAt: Date.now(), result: "2026-02-24" }),
    });

    const thinker = new Thinker(model, testPersona, registry);
    const ctx = createTaskContext({ inputText: "What time is it?" });
    const reasoning = await thinker.run(ctx);

    expect((model.lastOptions as any).tools).toHaveLength(1);
    expect((model.lastOptions as any).tools[0].name).toBe("current_time");
    expect(reasoning.toolCalls).toEqual(toolCalls);
    expect(reasoning.approach).toBe("tool_use");
  });

  test("does not pass tools when no toolRegistry", async () => {
    const model = createMockModel("plain response");
    const thinker = new Thinker(model, testPersona);
    const ctx = createTaskContext({ inputText: "Hello" });
    const reasoning = await thinker.run(ctx);

    expect(reasoning.toolCalls).toBeUndefined();
    expect(reasoning.approach).toBe("direct");
  });
});

// ── Planner ─────────────────────────────────────────

describe("Planner", () => {
  test("creates single 'respond' step for conversation task", async () => {
    const model = createMockModel("");
    const planner = new Planner(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.perception = { taskType: "conversation" };

    const plan = await planner.run(ctx);

    expect(plan.goal).toBe("Respond to the user");
    expect(plan.reasoning).toContain("Conversation task");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.actionType).toBe("respond");
    expect(plan.steps[0]!.index).toBe(0);
    expect(plan.steps[0]!.completed).toBe(false);
    expect(plan.steps[0]!.actionParams).toEqual({});
  });

  test("creates single 'generate' step for non-conversation task", async () => {
    const model = createMockModel("");
    const planner = new Planner(model, testPersona);

    const ctx = createTaskContext({ inputText: "Write a sort function" });
    ctx.perception = { taskType: "code_generation" };

    const plan = await planner.run(ctx);

    expect(plan.goal).toBe("Write a sort function");
    expect(plan.reasoning).toContain("code_generation");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.actionType).toBe("generate");
    expect(plan.steps[0]!.index).toBe(0);
    expect(plan.steps[0]!.completed).toBe(false);
    expect(plan.steps[0]!.actionParams).toEqual({ prompt: "Write a sort function" });
    expect(plan.steps[0]!.description).toContain("Write a sort function");
  });

  test("defaults to conversation when perception is null", async () => {
    const model = createMockModel("");
    const planner = new Planner(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    // perception is null by default

    const plan = await planner.run(ctx);

    expect(plan.steps[0]!.actionType).toBe("respond");
  });

  test("defaults to conversation when perception has no taskType", async () => {
    const model = createMockModel("");
    const planner = new Planner(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.perception = { intent: "greeting" }; // no taskType key

    const plan = await planner.run(ctx);

    expect(plan.steps[0]!.actionType).toBe("respond");
  });

  test("generates tool_call steps when reasoning has toolCalls", async () => {
    const model = createMockModel("");
    const planner = new Planner(model, testPersona);

    const ctx = createTaskContext({ inputText: "What time is it?" });
    ctx.perception = { taskType: "conversation" };
    ctx.reasoning = {
      response: "",
      approach: "tool_use",
      toolCalls: [
        { id: "c1", name: "current_time", arguments: {} },
        { id: "c2", name: "get_date", arguments: { format: "iso" } },
      ],
    };

    const plan = await planner.run(ctx);

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.actionType).toBe("tool_call");
    expect(plan.steps[0]!.actionParams).toEqual({
      toolCallId: "c1",
      toolName: "current_time",
      toolParams: {},
    });
    expect(plan.steps[1]!.actionType).toBe("tool_call");
    expect(plan.steps[1]!.actionParams).toEqual({
      toolCallId: "c2",
      toolName: "get_date",
      toolParams: { format: "iso" },
    });
  });

  test("generates respond step when reasoning has no toolCalls", async () => {
    const model = createMockModel("");
    const planner = new Planner(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.perception = { taskType: "conversation" };
    ctx.reasoning = { response: "Hi", approach: "direct" };

    const plan = await planner.run(ctx);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.actionType).toBe("respond");
  });
});

// ── Actor ───────────────────────────────────────────

describe("Actor", () => {
  test("extracts response from reasoning for 'respond' action", async () => {
    const model = createMockModel("");
    const actor = new Actor(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.reasoning = { response: "Hello! How can I help you?" };

    const step = makePlanStep({ actionType: "respond" });
    const result = await actor.run(ctx, step);

    expect(result.success).toBe(true);
    expect(result.result).toBe("Hello! How can I help you?");
    expect(result.actionType).toBe("respond");
    expect(result.stepIndex).toBe(0);
    expect(result.actionInput).toEqual({});
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThan(0);
  });

  test("returns empty string when reasoning has no response for 'respond' action", async () => {
    const model = createMockModel("");
    const actor = new Actor(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.reasoning = {}; // no "response" key

    const step = makePlanStep({ actionType: "respond" });
    const result = await actor.run(ctx, step);

    expect(result.success).toBe(true);
    expect(result.result).toBe("");
  });

  test("returns empty string when reasoning is null for 'respond' action", async () => {
    const model = createMockModel("");
    const actor = new Actor(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    // reasoning is null by default

    const step = makePlanStep({ actionType: "respond" });
    const result = await actor.run(ctx, step);

    expect(result.success).toBe(true);
    expect(result.result).toBe("");
  });

  test("returns stub result for non-respond action type", async () => {
    const model = createMockModel("");
    const actor = new Actor(model, testPersona);

    const ctx = createTaskContext({ inputText: "Generate code" });

    const step = makePlanStep({
      index: 1,
      actionType: "generate",
      description: "Generate code output",
      actionParams: { prompt: "Generate code" },
    });
    const result = await actor.run(ctx, step);

    expect(result.success).toBe(true);
    expect(result.result).toBe("[Stub] Completed step 1: Generate code output");
    expect(result.actionType).toBe("generate");
    expect(result.stepIndex).toBe(1);
    expect(result.actionInput).toEqual({ prompt: "Generate code" });
  });

  test("prepares tool_call intent and pushes assistant message", async () => {
    const model = createMockModel("");
    const actor = new Actor(model, testPersona);

    const ctx = createTaskContext({ inputText: "What time?" });
    ctx.reasoning = {
      toolCalls: [{ id: "c1", name: "current_time", arguments: {} }],
    };

    const step = makePlanStep({
      actionType: "tool_call",
      actionParams: { toolCallId: "c1", toolName: "current_time", toolParams: {} },
    });

    const result = await actor.run(ctx, step);

    // Returns pending result — no tool execution
    expect(result.success).toBe(true);
    expect(result.actionType).toBe("tool_call");
    expect(result.result).toBeUndefined();
    expect(result.completedAt).toBeUndefined();

    // Only assistant message pushed (no tool result message)
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("assistant");
    expect(ctx.messages[0]!.toolCalls).toHaveLength(1);
  });

  test("tool_call without toolExecutor returns pending result", async () => {
    const model = createMockModel("");
    const actor = new Actor(model, testPersona);

    const ctx = createTaskContext({ inputText: "Read missing file" });
    ctx.reasoning = {
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "nope" } }],
    };

    const step = makePlanStep({
      actionType: "tool_call",
      actionParams: { toolCallId: "c1", toolName: "read_file", toolParams: { path: "nope" } },
    });

    const result = await actor.run(ctx, step);

    // Actor no longer does tool execution — returns pending
    expect(result.success).toBe(true);
    expect(result.result).toBeUndefined();
    expect(result.completedAt).toBeUndefined();
    expect(result.error).toBeUndefined();

    // Only assistant message, no tool result message
    const toolMsg = ctx.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeUndefined();
  });

  test("respond action works with Actor (no toolExecutor)", async () => {
    const model = createMockModel("");
    const actor = new Actor(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.reasoning = { response: "Hi there!" };

    const step = makePlanStep({ actionType: "respond" });
    const result = await actor.run(ctx, step);

    expect(result.success).toBe(true);
    expect(result.result).toBe("Hi there!");
  });
});

// ── Reflector ───────────────────────────────────────

describe("Reflector", () => {
  test("returns 'complete' verdict for conversation task", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.perception = { taskType: "conversation" };
    ctx.actionsDone = [makeActionResult({ success: true })];

    const reflection = await reflector.run(ctx);

    expect(reflection.verdict).toBe("complete");
    expect(reflection.assessment).toContain("Conversation response delivered");
    expect(reflection.lessons).toEqual([]);
  });

  test("returns 'complete' for conversation even when actions failed", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    ctx.perception = { taskType: "conversation" };
    ctx.actionsDone = [makeActionResult({ success: false })];

    const reflection = await reflector.run(ctx);

    // Conversation tasks always return "complete" regardless of action success
    expect(reflection.verdict).toBe("complete");
  });

  test("returns 'complete' for non-conversation task when all actions succeed", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "Write a sort function" });
    ctx.perception = { taskType: "code_generation" };
    ctx.actionsDone = [
      makeActionResult({ success: true }),
      makeActionResult({ stepIndex: 1, success: true }),
    ];
    ctx.iteration = 1;

    const reflection = await reflector.run(ctx);

    expect(reflection.verdict).toBe("complete");
    expect(reflection.assessment).toContain("all succeeded");
    expect(reflection.assessment).toContain("Iteration 1");
    expect(reflection.assessment).toContain("2 actions");
    expect(reflection.lessons).toHaveLength(1);
    expect(reflection.lessons[0]).toContain("Write a sort function");
  });

  test("returns 'continue' for non-conversation task when some actions failed", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "Deploy the app" });
    ctx.perception = { taskType: "deployment" };
    ctx.actionsDone = [
      makeActionResult({ success: true }),
      makeActionResult({ stepIndex: 1, success: false }),
    ];
    ctx.iteration = 0;

    const reflection = await reflector.run(ctx);

    expect(reflection.verdict).toBe("continue");
    expect(reflection.assessment).toContain("some failed");
    expect(reflection.assessment).toContain("Iteration 0");
    expect(reflection.assessment).toContain("2 actions");
  });

  test("defaults to conversation when perception is null", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "Hello" });
    // perception is null by default

    const reflection = await reflector.run(ctx);

    expect(reflection.verdict).toBe("complete");
  });

  test("returns 'complete' for non-conversation with empty actionsDone", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "Do something" });
    ctx.perception = { taskType: "task" };
    // actionsDone is empty → every() returns true for empty arrays

    const reflection = await reflector.run(ctx);

    expect(reflection.verdict).toBe("complete");
    expect(reflection.assessment).toContain("all succeeded");
    expect(reflection.assessment).toContain("0 actions");
  });

  test("returns 'continue' when current plan has tool_call steps and all succeeded", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "What time?" });
    ctx.perception = { taskType: "conversation" };
    ctx.plan = {
      goal: "Execute tool calls",
      reasoning: "1 tool call",
      steps: [{ index: 0, description: "Call current_time", actionType: "tool_call", actionParams: {}, completed: true }],
    };
    ctx.actionsDone = [makeActionResult({ actionType: "tool_call", success: true })];

    const reflection = await reflector.run(ctx);
    expect(reflection.verdict).toBe("continue");
  });

  test("returns 'complete' on round 2 when plan has respond steps (no tool_calls)", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "What time?" });
    ctx.perception = { taskType: "conversation" };
    ctx.plan = {
      goal: "Respond",
      reasoning: "deliver response",
      steps: [{ index: 0, description: "Deliver response", actionType: "respond", actionParams: {}, completed: true }],
    };
    ctx.actionsDone = [
      makeActionResult({ actionType: "tool_call", success: true }),
      makeActionResult({ stepIndex: 1, actionType: "respond", success: true }),
    ];
    ctx.reflections = [{ verdict: "continue", assessment: "tool calls executed", lessons: [] }];

    const reflection = await reflector.run(ctx);
    expect(reflection.verdict).toBe("complete");
  });

  test("returns 'complete' when tool_call step failed", async () => {
    const model = createMockModel("");
    const reflector = new Reflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "Read file" });
    ctx.perception = { taskType: "conversation" };
    ctx.plan = {
      goal: "Execute tool calls",
      reasoning: "1 tool call",
      steps: [{ index: 0, description: "Call read_file", actionType: "tool_call", actionParams: {}, completed: true }],
    };
    ctx.actionsDone = [makeActionResult({ actionType: "tool_call", success: false })];

    const reflection = await reflector.run(ctx);
    expect(reflection.verdict).toBe("complete");
  });
});
