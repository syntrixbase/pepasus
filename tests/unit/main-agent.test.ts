import { describe, it, expect, afterEach } from "bun:test";
import { MainAgent } from "@pegasus/agents/main-agent.ts";
import type {
  LanguageModel,
  GenerateTextResult,
  Message,
} from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { OutboundMessage } from "@pegasus/channels/types.ts";
import { mkdir, rm } from "node:fs/promises";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";

const testDataDir = "/tmp/pegasus-test-main-agent";

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

/**
 * Create a mock ModelRegistry that returns the given model for all roles.
 */
function createMockModelRegistry(model: LanguageModel): ModelRegistry {
  // Create a minimal LLMConfig with a fake provider that won't be used
  // because we override the cache directly
  const llmConfig: LLMConfig = {
    providers: { test: { type: "openai", apiKey: "dummy", baseURL: undefined } },
    roles: { default: "test/test-model", subAgent: undefined, compact: undefined, reflection: undefined },
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
  };
  const registry = new ModelRegistry(llmConfig);
  // Pre-populate cache so get() never calls _create()
  (registry as any).cache.set("test/test-model", model);
  return registry;
}

/**
 * Create a mock model that uses the reply tool to deliver a response.
 *
 * In inner monologue mode, only the `reply` tool call produces user-visible
 * output. Plain text from the LLM is inner monologue (private thinking).
 *
 * After the reply tool call, _think queues another think step — the model
 * must return a stop (no tool calls) on the next invocation to end thinking.
 */
function createReplyModel(
  replyText: string,
  channelId = "test",
): LanguageModel {
  let replied = false;
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      if (!replied) {
        replied = true;
        return {
          text: "Let me respond to the user.", // inner monologue
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc_reply",
              name: "reply",
              arguments: { text: replyText, channelId },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      }
      // After reply, stop the loop (inner monologue, no more tools)
      return {
        text: "",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 0 },
      };
    },
  };
}

/**
 * Create a mock model that only produces inner monologue (no tool calls).
 * This should NOT trigger onReply.
 */
function createMonologueModel(monologueText: string): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      return {
        text: monologueText,
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

function testSettings() {
  return SettingsSchema.parse({
    dataDir: testDataDir,
    logLevel: "warn",
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
  });
}

describe("MainAgent", () => {
  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should reply to a simple message via reply tool", async () => {
    const model = createReplyModel("Hello! How can I help?");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });

    // Wait for async processing
    await Bun.sleep(300);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Hello! How can I help?");
    expect(replies[0]!.channel.type).toBe("cli");

    await agent.stop();
  }, 10_000);

  it("should persist session messages", async () => {
    const model = createReplyModel("Hi there!");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({
      text: "test message",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(300);

    // Verify session was persisted
    const content = await Bun.file(
      `${testDataDir}/main/current.jsonl`,
    ).text();
    expect(content).toContain("test message");
    // The reply text is delivered via tool call, so "Hi there!" appears in
    // tool call arguments, not directly as assistant content.
    // The inner monologue text should be present though.
    expect(content).toContain("Let me respond to the user.");

    await agent.stop();
  }, 10_000);

  it("should handle errors gracefully via onReply", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate() {
        throw new Error("LLM API error");
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "will fail",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(300);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toContain("error");

    await agent.stop();
  }, 10_000);

  it("should queue messages and process sequentially", async () => {
    let callCount = 0;
    // Each send() triggers exactly one _think call.
    // reply tool calls do NOT trigger follow-up thinking, so each _think
    // simply returns a reply and finishes. Two sends → two replies.
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `tc_${callCount}`,
              name: "reply",
              arguments: { text: `Response ${callCount}`, channelId: "test" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    // Send two messages rapidly
    agent.send({
      text: "first",
      channel: { type: "cli", channelId: "test" },
    });
    agent.send({
      text: "second",
      channel: { type: "cli", channelId: "test" },
    });

    await Bun.sleep(500);

    expect(replies).toHaveLength(2);

    await agent.stop();
  }, 10_000);

  it("should expose taskAgent getter", async () => {
    const model = createReplyModel("ok");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    expect(agent.taskAgent).toBeDefined();
    expect(agent.taskAgent.isRunning).toBe(true);

    await agent.stop();
  }, 10_000);

  it("should execute simple tool calls (current_time)", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        messages: Message[];
      }): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          // First call: LLM requests current_time tool
          return {
            text: "Let me check the time first.",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "current_time",
                arguments: {},
              },
            ],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        if (callCount === 2) {
          // Second call: LLM sees tool result, uses reply tool to respond
          const lastMsg = options.messages[options.messages.length - 1];
          if (lastMsg?.role === "tool") {
            return {
              text: "The time has been checked, now I'll tell the user.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-reply",
                  name: "reply",
                  arguments: {
                    text: "The time has been checked!",
                    channelId: "test",
                  },
                },
              ],
              usage: { promptTokens: 20, completionTokens: 10 },
            };
          }
        }
        // Third+ call: stop the loop
        return {
          text: "",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 0 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "what time is it",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(500);

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("The time has been checked!");

    await agent.stop();
  }, 10_000);

  it("should handle spawn_task tool call and task completion", async () => {
    let mainCallCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
        messages?: Message[];
      }): Promise<GenerateTextResult> {
        // Distinguish MainAgent calls (inner monologue) from Task Agent calls
        const isMainAgent = options.system?.includes("INNER MONOLOGUE") ?? false;

        if (isMainAgent) {
          mainCallCount++;
          if (mainCallCount === 1) {
            // First MainAgent call: LLM requests spawn_task
            return {
              text: "I need to spawn a task for this.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-spawn",
                  name: "spawn_task",
                  arguments: {
                    description: "Do a complex search",
                    input: "search for weather",
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          // Subsequent MainAgent calls: reply to the user
          return {
            text: `Thinking about response ${mainCallCount}...`,
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tc-reply-${mainCallCount}`,
                name: "reply",
                arguments: {
                  text: `Response ${mainCallCount}`,
                  channelId: "test",
                },
              },
            ],
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        }

        // Task Agent calls: return plain text (completes via respond step)
        return {
          text: "Task completed: found weather data.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "search for weather",
      channel: { type: "cli", channelId: "test" },
    });

    // Wait for spawn_task to process — the underlying Agent will run the
    // task asynchronously, and when it completes, MainAgent receives
    // the result via _onTaskResult → _handleTaskResult → onReply
    await Bun.sleep(3000);

    // Should get at least one reply (the post-spawn response)
    expect(replies.length).toBeGreaterThanOrEqual(1);
    // Each reply has text starting with "Response"
    expect(replies[0]!.text).toMatch(/^Response/);

    await agent.stop();
  }, 15_000);

  it("should handle LLM returning empty text without error", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        return {
          text: "",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 0 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "hello",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(300);

    // Empty text + no tool calls → no reply sent (not an error)
    expect(replies).toHaveLength(0);

    await agent.stop();
  }, 10_000);

  it("should include persona background in system prompt when present", async () => {
    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
      }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "Just thinking...",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const personaWithBackground: Persona = {
      ...testPersona,
      background: "Built in a secret lab",
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: personaWithBackground,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({
      text: "hi",
      channel: { type: "slack", channelId: "C123" },
    });
    await Bun.sleep(300);

    expect(capturedSystem).toContain("Built in a secret lab");
    expect(capturedSystem).toContain("Slack");

    await agent.stop();
  }, 10_000);

  // ── New tests for inner monologue behavior ──

  it("should NOT deliver inner monologue to user", async () => {
    const monologueText =
      "Hmm, the user just said hi. Let me think about this but not respond.";
    const model = createMonologueModel(monologueText);

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "hello",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(300);

    // Inner monologue should NOT produce a reply
    expect(replies).toHaveLength(0);

    // But the monologue should be persisted in the session
    const content = await Bun.file(
      `${testDataDir}/main/current.jsonl`,
    ).text();
    expect(content).toContain(monologueText);

    await agent.stop();
  }, 10_000);

  it("should route reply tool to correct channelId", async () => {
    const model = createReplyModel("Hey Slack!", "C-slack-123");

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "hello from slack",
      channel: { type: "slack", channelId: "C-slack-123" },
    });
    await Bun.sleep(300);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("Hey Slack!");
    expect(replies[0]!.channel.channelId).toBe("C-slack-123");
    expect(replies[0]!.channel.type).toBe("slack");

    await agent.stop();
  }, 10_000);

  it("should include inner monologue instructions in system prompt", async () => {
    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
      }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "thinking...",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({
      text: "hi",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(300);

    // System prompt should explain inner monologue mode
    expect(capturedSystem).toContain("INNER MONOLOGUE");
    expect(capturedSystem).toContain("reply()");

    await agent.stop();
  }, 10_000);

  it("should handle resume_task tool call on completed task", async () => {
    let mainCallCount = 0;
    let spawnedTaskId: string | null = null;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
        messages?: Message[];
      }): Promise<GenerateTextResult> {
        const isMainAgent = options.system?.includes("INNER MONOLOGUE") ?? false;

        if (isMainAgent) {
          mainCallCount++;
          if (mainCallCount === 1) {
            // First MainAgent call: spawn a task
            return {
              text: "I need to spawn a task.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-spawn",
                  name: "spawn_task",
                  arguments: { description: "Do work", input: "initial work" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          if (mainCallCount === 2) {
            // After task completion notification: resume the task
            // Extract taskId from session messages
            const toolMsgs = (options.messages ?? []).filter(
              (m: Message) => m.role === "tool" && m.content.includes("taskId"),
            );
            if (toolMsgs.length > 0) {
              try {
                const parsed = JSON.parse(toolMsgs[0]!.content);
                spawnedTaskId = parsed.taskId;
              } catch { /* ignore */ }
            }
            if (spawnedTaskId) {
              return {
                text: "Let me resume that task with more instructions.",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "tc-resume",
                    name: "resume_task",
                    arguments: { task_id: spawnedTaskId, input: "now do more" },
                  },
                ],
                usage: { promptTokens: 20, completionTokens: 10 },
              };
            }
            // Fallback: just reply
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-reply-2",
                  name: "reply",
                  arguments: { text: "Task done", channelId: "test" },
                },
              ],
              usage: { promptTokens: 20, completionTokens: 10 },
            };
          }
          // Subsequent calls: reply
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tc-reply-${mainCallCount}`,
                name: "reply",
                arguments: { text: `Response ${mainCallCount}`, channelId: "test" },
              },
            ],
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        }

        // Task Agent calls: return plain text
        return {
          text: "Task work done.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "do complex work",
      channel: { type: "cli", channelId: "test" },
    });

    // Wait for spawn → task complete → resume → task complete again
    await Bun.sleep(5000);

    // Should have received replies
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 20_000);

  it("should handle resume_task error gracefully", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          // Request resume_task with non-existent task
          return {
            text: "Let me resume that task.",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-resume-bad",
                name: "resume_task",
                arguments: { task_id: "nonexistent-task-xyz", input: "continue" },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        // After error, reply to user
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Sorry, task not found", channelId: "test" },
            },
          ],
          usage: { promptTokens: 15, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "resume some old task",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(1000);

    // Should not crash — error is handled gracefully
    // The LLM sees the error in tool result and replies to user
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 15_000);

  it("should include session_archive_read instructions in system prompt", async () => {
    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { system?: string }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "thinking...",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(300);

    expect(capturedSystem).toContain("session_archive_read");
    expect(capturedSystem).toContain("Session History");

    await agent.stop();
  }, 10_000);

  it("should use config contextWindow for compact threshold", async () => {
    // Create a model that returns moderate promptTokens.
    // With default gpt-4o (128k), 80k tokens would NOT trigger compact (threshold 0.8 → 102.4k).
    // But with contextWindow override of 50_000, threshold is 0.8 * 50k = 40k → SHOULD trigger compact.
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "gpt-4o", // Built-in: 128k
      async generate(options: {
        system?: string;
        messages: Message[];
      }): Promise<GenerateTextResult> {
        callCount++;

        // First call: return 80k promptTokens
        if (callCount === 1) {
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-reply-1",
                name: "reply",
                arguments: { text: "Got it!", channelId: "test" },
              },
            ],
            usage: { promptTokens: 80_000, completionTokens: 10 },
          };
        }
        // Summarize call
        if (options.system?.toLowerCase().includes("summarize")) {
          return {
            text: "Summary: user asked a question.",
            finishReason: "stop",
            usage: { promptTokens: 50, completionTokens: 20 },
          };
        }
        // After compact
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `tc-reply-${callCount}`,
              name: "reply",
              arguments: { text: "After compact!", channelId: "test" },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({
      dataDir: testDataDir,
      logLevel: "warn",
      llm: { contextWindow: 50_000 }, // Override: 50k instead of 128k
      session: { compactThreshold: 0.8 },
    });

    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    // First message — sets lastPromptTokens to 80k
    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

    // Second message — should trigger compact (80k > 50k * 0.8 = 40k)
    agent.send({ text: "how are you", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

    // Verify compact happened: archive file should exist
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(`${testDataDir}/main`);
    const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
    expect(archives.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 15_000);

  it("should compact session when tokens exceed threshold", async () => {
    // Create a model that returns large promptTokens to trigger compact
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
        messages: Message[];
      }): Promise<GenerateTextResult> {
        callCount++;

        // First call: return huge promptTokens to trigger compact on next think
        if (callCount === 1) {
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-reply-1",
                name: "reply",
                arguments: { text: "Got it!", channelId: "test" },
              },
            ],
            usage: { promptTokens: 110_000, completionTokens: 10 },
          };
        }
        // Summarize call: detected by system prompt containing "summarize"
        if (options.system?.toLowerCase().includes("summarize")) {
          return {
            text: "Summary: user asked a question and got a reply.",
            finishReason: "stop",
            usage: { promptTokens: 50, completionTokens: 20 },
          };
        }
        // After compact: normal response
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `tc-reply-${callCount}`,
              name: "reply",
              arguments: { text: "After compact!", channelId: "test" },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({
      dataDir: testDataDir,
      logLevel: "warn",
      session: { compactThreshold: 0.8 },
    });

    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    // First message — triggers large promptTokens
    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

    // Second message — should trigger compact before _think
    agent.send({ text: "how are you", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

    // Verify compact happened: archive file should exist
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(`${testDataDir}/main`);
    const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
    expect(archives.length).toBeGreaterThanOrEqual(1);

    // After compact, should still be able to reply
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 15_000);

  // ── Skill system tests ──

  it("should include skill metadata in system prompt when skills exist", async () => {
    const tmpDir = "/tmp/pegasus-test-main-agent-skills";
    const skillDir = `${tmpDir}/skills/test-skill`;
    await mkdir(skillDir, { recursive: true });
    await Bun.write(`${skillDir}/SKILL.md`, [
      "---",
      "name: test-skill",
      "description: A test skill for unit tests",
      "---",
      "",
      "Do the test thing.",
    ].join("\n"));

    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { system?: string }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "hi", channelId: "test" } }],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({
      dataDir: tmpDir,
      logLevel: "warn",
    });

    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();
    agent.onReply(() => {});

    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(300);

    expect(capturedSystem).toContain("Available skills");
    expect(capturedSystem).toContain("test-skill");
    expect(capturedSystem).toContain("A test skill for unit tests");

    await agent.stop();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 10_000);

  it("should handle /skill-name command for inline skill", async () => {
    const tmpDir = "/tmp/pegasus-test-main-agent-skill-cmd";
    const skillDir = `${tmpDir}/skills/greet`;
    await mkdir(skillDir, { recursive: true });
    await Bun.write(`${skillDir}/SKILL.md`, [
      "---",
      "name: greet",
      "description: Greet the user",
      "---",
      "",
      "Always reply with a warm greeting.",
    ].join("\n"));

    let capturedMessages: Message[] = [];
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { messages?: Message[] }): Promise<GenerateTextResult> {
        capturedMessages = options.messages ?? [];
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "Hello!", channelId: "test" } }],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({ dataDir: tmpDir, logLevel: "warn" });
    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "/greet", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(300);

    // Skill content should be in messages as user message
    const skillMsg = capturedMessages.find((m) => m.content?.includes("[Skill: greet invoked]"));
    expect(skillMsg).toBeDefined();
    expect(skillMsg!.content).toContain("Always reply with a warm greeting");

    await agent.stop();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 10_000);

  it("should treat /unknown-command as normal message", async () => {
    const model = createReplyModel("I don't know that command");

    const tmpDir = "/tmp/pegasus-test-main-agent-unknown-cmd";
    const settings = SettingsSchema.parse({ dataDir: tmpDir, logLevel: "warn" });
    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "/nonexistent-skill", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(300);

    // Should have been treated as normal text (no skill found)
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 10_000);

  it("should handle use_skill tool call for inline skill", async () => {
    const tmpDir = "/tmp/pegasus-test-main-agent-use-skill";
    const skillDir = `${tmpDir}/skills/helper`;
    await mkdir(skillDir, { recursive: true });
    await Bun.write(`${skillDir}/SKILL.md`, [
      "---",
      "name: helper",
      "description: A helper skill",
      "---",
      "",
      "You are a helpful assistant. Follow these instructions.",
    ].join("\n"));

    let callCount = 0;
    let capturedMessages: Message[] = [];
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { messages?: Message[] }): Promise<GenerateTextResult> {
        callCount++;
        capturedMessages = options.messages ?? [];
        if (callCount === 1) {
          // First call: LLM calls use_skill
          return {
            text: "I should use the helper skill.",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "tc-use-skill",
              name: "use_skill",
              arguments: { skill: "helper" },
            }],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        if (callCount === 2) {
          // Second call: LLM sees skill body in tool result, replies
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "Following skill!", channelId: "test" } }],
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        }
        return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
      },
    };

    const settings = SettingsSchema.parse({ dataDir: tmpDir, logLevel: "warn" });
    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "help me", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

    // The tool result message should contain the skill body
    const toolResults = capturedMessages.filter((m) => m.role === "tool");
    const skillToolResult = toolResults.find((m) => m.content?.includes("helpful assistant"));
    expect(skillToolResult).toBeDefined();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Following skill!");

    await agent.stop();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 10_000);

  it("should handle use_skill for non-existent skill", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          return {
            text: "Let me use a skill.",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "tc-use-skill",
              name: "use_skill",
              arguments: { skill: "nonexistent" },
            }],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        // After error, reply
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "Skill not found", channelId: "test" } }],
          usage: { promptTokens: 15, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "use skill", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 10_000);

  it("should expose skills getter", async () => {
    const model = createReplyModel("ok");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    expect(agent.skills).toBeDefined();
    expect(agent.skills.listAll()).toBeInstanceOf(Array);

    await agent.stop();
  }, 10_000);
});
