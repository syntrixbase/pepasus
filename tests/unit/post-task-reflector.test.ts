import { describe, expect, test } from "bun:test";
import { PostTaskReflector, shouldReflect } from "@pegasus/cognitive/reflect.ts";
import { createTaskContext } from "@pegasus/task/context.ts";
import type { LanguageModel } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function createMockReflectionModel(response: string): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate() {
      return {
        text: response,
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

describe("shouldReflect", () => {
  test("returns false for trivial single-iteration task with short response", () => {
    const ctx = createTaskContext({ inputText: "what time?" });
    ctx.iteration = 1;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "respond", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "It's 3pm" };
    expect(shouldReflect(ctx)).toBe(false);
  });

  test("returns true for multi-iteration task", () => {
    const ctx = createTaskContext({ inputText: "search for info" });
    ctx.iteration = 2;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "tool_call", actionInput: {}, success: true, startedAt: Date.now() },
      { stepIndex: 1, actionType: "respond", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "Here's what I found..." };
    expect(shouldReflect(ctx)).toBe(true);
  });

  test("returns true for single-iteration task with long response", () => {
    const ctx = createTaskContext({ inputText: "explain X" });
    ctx.iteration = 1;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "respond", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "A".repeat(300) };
    expect(shouldReflect(ctx)).toBe(true);
  });

  test("returns true when multiple actions done", () => {
    const ctx = createTaskContext({ inputText: "complex task" });
    ctx.iteration = 1;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "tool_call", actionInput: {}, success: true, startedAt: Date.now() },
      { stepIndex: 1, actionType: "tool_call", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "done" };
    expect(shouldReflect(ctx)).toBe(true);
  });
});

describe("PostTaskReflector", () => {
  test("returns structured PostTaskReflection from LLM response", async () => {
    const jsonResponse = JSON.stringify({
      facts: [{ path: "facts/test.md", content: "# Test\n> Summary: test fact\n\n- Learned something" }],
      episode: {
        title: "Tested reflection",
        summary: "tested post-task reflection",
        details: "Ran a test to verify reflection works.",
        lesson: "Structured output works well.",
      },
      assessment: "Task completed successfully with useful output.",
    });

    const model = createMockReflectionModel(jsonResponse);
    const reflector = new PostTaskReflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "do something" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    const result = await reflector.run(ctx);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.path).toBe("facts/test.md");
    expect(result.episode).not.toBeNull();
    expect(result.episode!.title).toBe("Tested reflection");
    expect(result.assessment).toContain("successfully");
  });

  test("returns empty reflection when LLM returns invalid JSON", async () => {
    const model = createMockReflectionModel("not valid json at all");
    const reflector = new PostTaskReflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "do something" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    const result = await reflector.run(ctx);

    expect(result.facts).toHaveLength(0);
    expect(result.episode).toBeNull();
    expect(result.assessment).toBeDefined();
  });

  test("returns empty reflection when LLM throws", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate() {
        throw new Error("LLM API error");
      },
    };

    const reflector = new PostTaskReflector(model, testPersona);
    const ctx = createTaskContext({ inputText: "do something" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    const result = await reflector.run(ctx);

    expect(result.facts).toHaveLength(0);
    expect(result.episode).toBeNull();
    expect(result.assessment).toBeDefined();
  });

  test("handles LLM returning partial JSON (missing fields)", async () => {
    const jsonResponse = JSON.stringify({
      assessment: "simple task, nothing notable",
    });

    const model = createMockReflectionModel(jsonResponse);
    const reflector = new PostTaskReflector(model, testPersona);

    const ctx = createTaskContext({ inputText: "simple query" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    const result = await reflector.run(ctx);

    expect(result.facts).toHaveLength(0);
    expect(result.episode).toBeNull();
    expect(result.assessment).toBe("simple task, nothing notable");
  });
});
