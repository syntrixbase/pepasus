import { describe, expect, test, beforeEach } from "bun:test";
import {
  SettingsSchema,
  LLMConfigSchema,
  MemoryConfigSchema,
  AgentConfigSchema,
  getSettings,
  setSettings,
  resetSettings,
  getActiveProviderConfig,
} from "@pegasus/infra/config.ts";
import type { Settings } from "@pegasus/infra/config.ts";
import {
  PegasusError,
  ConfigError,
  LLMError,
  LLMRateLimitError,
  LLMTimeoutError,
  TaskError,
  InvalidStateTransition,
  TaskNotFoundError,
  MemoryError,
  ToolError,
} from "@pegasus/infra/errors.ts";
import { getLogger, rootLogger, resolveTransport } from "@pegasus/infra/logger.ts";
import type { Message, GenerateTextResult } from "@pegasus/infra/llm-types.ts";
import { toOpenAIMessages } from "@pegasus/infra/openai-client.ts";
import { toAnthropicMessages } from "@pegasus/infra/anthropic-client.ts";

// ── Config ──────────────────────────────────────

describe("Config schemas", () => {
  test("LLMConfigSchema applies defaults", () => {
    const config = LLMConfigSchema.parse({});
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.maxConcurrentCalls).toBe(3);
    expect(config.timeout).toBe(120);
  });

  test("LLMConfigSchema accepts custom values", () => {
    const config = LLMConfigSchema.parse({
      provider: "openai",
      model: "gpt-4",
      maxConcurrentCalls: "5",
      timeout: "60",
    });
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4");
    expect(config.maxConcurrentCalls).toBe(5);
    expect(config.timeout).toBe(60);
  });

  test("MemoryConfigSchema applies defaults", () => {
    const config = MemoryConfigSchema.parse({});
    expect(config.dbPath).toBe("data/memory.db");
    expect(config.vectorDbPath).toBe("data/vectors");
  });

  test("AgentConfigSchema applies defaults", () => {
    const config = AgentConfigSchema.parse({});
    expect(config.maxActiveTasks).toBe(5);
    expect(config.maxConcurrentTools).toBe(3);
    expect(config.maxCognitiveIterations).toBe(10);
    expect(config.heartbeatInterval).toBe(60);
    expect(config.taskTimeout).toBe(120);
  });

  test("SettingsSchema applies nested defaults", () => {
    const settings = SettingsSchema.parse({});
    expect(settings.llm.provider).toBe("openai");
    expect(settings.memory.dbPath).toBe("data/memory.db");
    expect(settings.agent.maxActiveTasks).toBe(5);
    expect(settings.logLevel).toBe("info");
    expect(settings.dataDir).toBe("data");
    expect(settings.logFormat).toBe("json");
    expect(settings.logFormat).toBe("json");
  });

  test("SettingsSchema accepts custom logFormat", () => {
    const settings = SettingsSchema.parse({ logFormat: "line" });
    expect(settings.logFormat).toBe("line");
  });

  test("SettingsSchema rejects invalid logFormat", () => {
    expect(() => SettingsSchema.parse({ logFormat: "xml" })).toThrow();
  });
});

describe("getSettings / setSettings", () => {
  beforeEach(() => {
    // Reset singleton so each test starts fresh
    resetSettings();
  });

  test("getSettings loads from env and returns valid Settings", () => {
    const settings = getSettings();
    expect(settings.llm).toBeDefined();
    expect(settings.memory).toBeDefined();
    expect(settings.agent).toBeDefined();
    expect(settings.logLevel).toBeDefined();
    expect(settings.dataDir).toBeDefined();
  });

  test("getSettings returns same reference on repeated calls (singleton)", () => {
    const a = getSettings();
    const b = getSettings();
    expect(a).toBe(b);
  });

  test("setSettings overrides and getSettings returns overridden", () => {
    const custom: Settings = SettingsSchema.parse({
      logLevel: "debug",
      dataDir: "/tmp/test",
    });
    setSettings(custom);
    const result = getSettings();
    expect(result.logLevel).toBe("debug");
    expect(result.dataDir).toBe("/tmp/test");
  });

  test("resetSettings forces reload from env on next getSettings call", () => {
    // First load
    const first = getSettings();
    expect(first).toBeDefined();

    // Override with custom
    const custom = SettingsSchema.parse({ logLevel: "error" });
    setSettings(custom);
    expect(getSettings().logLevel).toBe("error");

    // Reset — next call should reload from env (defaults)
    resetSettings();
    const reloaded = getSettings();
    // Should have reloaded (not the custom override)
    expect(reloaded).not.toBe(custom);
    expect(reloaded.llm.provider).toBe("openai"); // default from env/schema
  });

  test("loads default settings from schema defaults", () => {
    // Reset and let it load from defaults (no config file, Zod defaults apply)
    resetSettings();
    const s = getSettings();
    // Verify the full structure is populated
    expect(s.llm.provider).toBe("openai");
    expect(s.llm.model).toBe("gpt-4o-mini");
    expect(s.llm.maxConcurrentCalls).toBe(3);
    expect(s.llm.timeout).toBe(120);
    expect(s.memory.dbPath).toBe("data/memory.db");
    expect(s.memory.vectorDbPath).toBe("data/vectors");
    expect(s.agent.maxActiveTasks).toBe(5);
    expect(s.agent.maxConcurrentTools).toBe(3);
    expect(s.agent.maxCognitiveIterations).toBe(10);
    expect(s.agent.heartbeatInterval).toBe(60);
  });
});

// ── Errors ──────────────────────────────────────

describe("Error hierarchy", () => {
  test("PegasusError is an Error with correct name", () => {
    const err = new PegasusError("base error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("PegasusError");
    expect(err.message).toBe("base error");
  });

  test("ConfigError extends PegasusError", () => {
    const err = new ConfigError("bad config");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.name).toBe("ConfigError");
    expect(err.message).toBe("bad config");
  });

  test("LLMError extends PegasusError", () => {
    const err = new LLMError("llm failed");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("LLMError");
  });

  test("LLMRateLimitError extends LLMError", () => {
    const err = new LLMRateLimitError("rate limited");
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("LLMRateLimitError");
    expect(err.message).toBe("rate limited");
  });

  test("LLMTimeoutError extends LLMError", () => {
    const err = new LLMTimeoutError("timed out");
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("LLMTimeoutError");
    expect(err.message).toBe("timed out");
  });

  test("TaskError extends PegasusError", () => {
    const err = new TaskError("task failed");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("TaskError");
  });

  test("InvalidStateTransition extends TaskError", () => {
    const err = new InvalidStateTransition("invalid transition");
    expect(err).toBeInstanceOf(TaskError);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("InvalidStateTransition");
    expect(err.message).toBe("invalid transition");
  });

  test("TaskNotFoundError extends TaskError", () => {
    const err = new TaskNotFoundError("not found");
    expect(err).toBeInstanceOf(TaskError);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("TaskNotFoundError");
    expect(err.message).toBe("not found");
  });

  test("MemoryError extends PegasusError", () => {
    const err = new MemoryError("memory failed");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("MemoryError");
    expect(err.message).toBe("memory failed");
  });

  test("ToolError extends PegasusError", () => {
    const err = new ToolError("tool failed");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("ToolError");
    expect(err.message).toBe("tool failed");
  });
});

// ── Logger ──────────────────────────────────────

describe("Logger", () => {
  test("getLogger returns a pino child logger", () => {
    const logger = getLogger("test-module");
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.warn).toBe("function");
  });

  test("getLogger returns different instances for different names", () => {
    const a = getLogger("module-a");
    const b = getLogger("module-b");
    expect(a).not.toBe(b);
  });

  test("rootLogger is exported and is a pino logger", () => {
    expect(rootLogger).toBeDefined();
    expect(typeof rootLogger.info).toBe("function");
    expect(typeof rootLogger.child).toBe("function");
  });

  test("rootLogger has a valid log level", () => {
    const validLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
    expect(validLevels).toContain(rootLogger.level);
  });
});

describe("resolveTransport", () => {
  test("returns file transport for json format", () => {
    const transport = resolveTransport("test.log", "json");
    expect(transport).toBeDefined();
    expect((transport as any).target).toBe("pino-roll");
  });

  test("returns line-transport for line format", () => {
    const transport = resolveTransport("test.log", "line");
    expect(transport).toBeDefined();
    expect((transport as any).target).toContain("line-transport");
  });

  test("always uses file transport (no console)", () => {
    const transport = resolveTransport("test.log", "json");
    expect(transport).toBeDefined();
    // Single transport object, not multi-target
    expect((transport as any).targets).toBeUndefined();
  });
});

// ── Provider Config ─────────────────────────────────

describe("getActiveProviderConfig", () => {
  test("returns OpenAI config when provider is openai", () => {
    const settings = SettingsSchema.parse({
      llm: {
        provider: "openai",
        model: "gpt-4",
        openai: {
          apiKey: "sk-test",
          model: "gpt-4o",
          baseURL: "https://custom.com",
        },
      },
    });

    const config = getActiveProviderConfig(settings);
    expect(config.apiKey).toBe("sk-test");
    expect(config.model).toBe("gpt-4o"); // Provider-specific overrides global
    expect(config.baseURL).toBe("https://custom.com");
  });

  test("returns Anthropic config when provider is anthropic", () => {
    const settings = SettingsSchema.parse({
      llm: {
        provider: "anthropic",
        model: "default-model",
        anthropic: {
          apiKey: "sk-ant-test",
          model: "claude-4",
        },
      },
    });

    const config = getActiveProviderConfig(settings);
    expect(config.apiKey).toBe("sk-ant-test");
    expect(config.model).toBe("claude-4");
    expect(config.baseURL).toBeUndefined();
  });

  test("falls back to global model if provider-specific not set", () => {
    const settings = SettingsSchema.parse({
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        openai: {
          apiKey: "sk-test",
        },
      },
    });

    const config = getActiveProviderConfig(settings);
    expect(config.model).toBe("gpt-4o-mini"); // Fallback to global
  });

  test("returns compatible config with LLM_BASE_URL", () => {
    const settings = SettingsSchema.parse({
      llm: {
        provider: "openai-compatible",
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
        openai: {
          apiKey: "dummy",
          model: "llama3.2",
        },
      },
    });

    const config = getActiveProviderConfig(settings);
    expect(config.apiKey).toBe("dummy");
    expect(config.baseURL).toBe("http://localhost:11434/v1");
    expect(config.model).toBe("llama3.2");
  });

  test("throws for unknown provider", () => {
    const settings = {
      llm: {
        provider: "unknown" as any,
        model: "test",
        openai: {},
        anthropic: {},
      },
    } as Settings;

    expect(() => getActiveProviderConfig(settings)).toThrow("Unknown provider");
  });
});

// ── LLM Types ──────────────────────────────────────

describe("LLM Types - Tool support", () => {
  test("Message type supports tool role and toolCalls", () => {
    const toolMsg: Message = {
      role: "tool",
      content: '{"result":"ok"}',
      toolCallId: "call_123",
    };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.toolCallId).toBe("call_123");

    const assistantMsg: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "x" } }],
    };
    expect(assistantMsg.toolCalls).toHaveLength(1);
  });

  test("GenerateTextResult supports toolCalls", () => {
    const result: GenerateTextResult = {
      text: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "c1", name: "get_time", arguments: {} }],
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    expect(result.toolCalls).toHaveLength(1);
  });
});

// ── OpenAI Client Tool Support ──────────────────────────────────────

describe("OpenAI client tool support", () => {
  test("toOpenAIMessages converts tool messages", () => {
    const messages: Message[] = [
      { role: "user", content: "read config" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "config.yml" } }],
      },
      { role: "tool", content: '{"data":"hello"}', toolCallId: "c1" },
    ];
    const result = toOpenAIMessages(messages);

    expect(result[2]).toMatchObject({
      role: "tool",
      content: '{"data":"hello"}',
      tool_call_id: "c1",
    });

    expect(result[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"config.yml"}' },
        },
      ],
    });
  });

  test("toOpenAIMessages passes through regular messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = toOpenAIMessages(messages);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });
});

// ── Anthropic Client Tool Support ──────────────────────────────────────

describe("Anthropic client tool support", () => {
  test("toAnthropicMessages converts tool result to user message with tool_result block", () => {
    const messages: Message[] = [
      { role: "user", content: "get time" },
      {
        role: "assistant",
        content: "Let me check.",
        toolCalls: [{ id: "tu_1", name: "current_time", arguments: {} }],
      },
      { role: "tool", content: "2026-02-24T10:00:00Z", toolCallId: "tu_1" },
    ];
    const result = toAnthropicMessages(messages);

    // Assistant with tool_use content blocks
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_1", name: "current_time", input: {} },
    ]);

    // Tool result as user message with tool_result block
    expect(result[2]!.role).toBe("user");
    expect(result[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "2026-02-24T10:00:00Z" },
    ]);
  });

  test("toAnthropicMessages passes through regular messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = toAnthropicMessages(messages);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("toAnthropicMessages handles assistant with toolCalls but no text", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tu_2", name: "read_file", arguments: { path: "x" } }],
      },
    ];
    const result = toAnthropicMessages(messages);
    expect(result[0]!.content).toEqual([
      { type: "tool_use", id: "tu_2", name: "read_file", input: { path: "x" } },
    ]);
  });
});
