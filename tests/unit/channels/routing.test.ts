/**
 * Tests for multi-channel adapter routing in MainAgent.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { MainAgent } from "@pegasus/agents/main-agent.ts";
import type {
  LanguageModel,
  GenerateTextResult,
} from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type {
  OutboundMessage,
  ChannelAdapter,
} from "@pegasus/channels/types.ts";
import { rm } from "node:fs/promises";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";

const testDataDir = "/tmp/pegasus-test-routing";

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function createMockModelRegistry(model: LanguageModel): ModelRegistry {
  const llmConfig: LLMConfig = {
    providers: {
      test: { type: "openai", apiKey: "dummy", baseURL: undefined },
    },
    roles: {
      default: "test/test-model",
      subAgent: undefined,
      compact: undefined,
      reflection: undefined,
    },
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
  };
  const registry = new ModelRegistry(llmConfig);
  (registry as any).cache.set("test/test-model", model);
  return registry;
}

function testSettings() {
  return SettingsSchema.parse({
    dataDir: testDataDir,
    logLevel: "warn",
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
  });
}

/** Create a simple mock adapter that records delivered messages. */
function createMockAdapter(
  adapterType: string,
): { adapter: ChannelAdapter; delivered: OutboundMessage[] } {
  const delivered: OutboundMessage[] = [];
  const adapter: ChannelAdapter = {
    type: adapterType,
    async start() {},
    async deliver(msg: OutboundMessage) {
      delivered.push(msg);
    },
    async stop() {},
  };
  return { adapter, delivered };
}

describe("Multi-channel routing", () => {
  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should route replies to correct adapter by channel.type", async () => {
    // Model replies to the same channel type as inbound
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Hello!", channelId: "tg-123" },
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

    const cliMock = createMockAdapter("cli");
    const telegramMock = createMockAdapter("telegram");

    agent.registerAdapter(cliMock.adapter);
    agent.registerAdapter(telegramMock.adapter);

    await agent.start();

    // Send from telegram channel
    agent.send({
      text: "hello",
      channel: { type: "telegram", channelId: "tg-123" },
    });
    await Bun.sleep(500);

    // Reply should route to telegram adapter (channel.type = "telegram")
    expect(telegramMock.delivered.length).toBeGreaterThanOrEqual(1);
    expect(telegramMock.delivered[0]!.text).toBe("Hello!");

    // CLI should not receive the telegram reply
    expect(cliMock.delivered).toHaveLength(0);

    await agent.stop();
  }, 10_000);

  it("should log warning for unknown channel type", async () => {
    // Model replies to a channel type that has no adapter
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Hello!", channelId: "unknown-123" },
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

    const cliMock = createMockAdapter("cli");
    agent.registerAdapter(cliMock.adapter);

    await agent.start();

    // Send from "sms" which has no adapter registered
    agent.send({
      text: "hello",
      channel: { type: "sms", channelId: "unknown-123" },
    });
    await Bun.sleep(500);

    // CLI should not receive it (channel type mismatch)
    expect(cliMock.delivered).toHaveLength(0);

    // No crash — the warning is logged but no error thrown
    await agent.stop();
  }, 10_000);

  it("should support multiple adapters coexisting (CLI + Telegram)", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          // First message: reply to CLI
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-reply-cli",
                name: "reply",
                arguments: { text: "CLI reply", channelId: "main" },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        // Second message: reply to telegram
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply-tg",
              name: "reply",
              arguments: { text: "TG reply", channelId: "tg-456" },
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

    const cliMock = createMockAdapter("cli");
    const telegramMock = createMockAdapter("telegram");

    agent.registerAdapter(cliMock.adapter);
    agent.registerAdapter(telegramMock.adapter);

    await agent.start();

    // Send from CLI
    agent.send({
      text: "hello from cli",
      channel: { type: "cli", channelId: "main" },
    });
    await Bun.sleep(500);

    // Send from Telegram
    agent.send({
      text: "hello from telegram",
      channel: { type: "telegram", channelId: "tg-456" },
    });
    await Bun.sleep(500);

    // Each adapter should have received its own reply
    expect(cliMock.delivered).toHaveLength(1);
    expect(cliMock.delivered[0]!.text).toBe("CLI reply");

    expect(telegramMock.delivered).toHaveLength(1);
    expect(telegramMock.delivered[0]!.text).toBe("TG reply");

    await agent.stop();
  }, 15_000);

  it("should handle adapter deliver failure gracefully", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Will fail delivery", channelId: "broken-123" },
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

    // Adapter that throws on deliver
    const brokenAdapter: ChannelAdapter = {
      type: "broken",
      async start() {},
      async deliver() {
        throw new Error("Delivery failure");
      },
      async stop() {},
    };

    agent.registerAdapter(brokenAdapter);

    await agent.start();

    // Should not crash
    agent.send({
      text: "hello",
      channel: { type: "broken", channelId: "broken-123" },
    });
    await Bun.sleep(500);

    // No crash occurred
    await agent.stop();
  }, 10_000);

  it("onReply still works when no adapters registered", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Direct callback", channelId: "test" },
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

    // Use onReply directly (legacy mode, no adapters)
    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "hello",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(500);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("Direct callback");

    await agent.stop();
  }, 10_000);
});
