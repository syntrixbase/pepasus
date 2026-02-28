/**
 * Tests for ModelRegistry — per-role model resolution with caching.
 */
import { describe, expect, test } from "bun:test";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";

function baseLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    providers: {
      openai: { apiKey: "sk-test", baseURL: undefined, type: undefined },
      anthropic: { apiKey: "sk-ant-test", baseURL: undefined, type: undefined },
    },
    roles: {
      default: "openai/gpt-4o",
      subAgent: undefined,
      compact: undefined,
      reflection: undefined,
    },
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
    codex: { enabled: false, baseURL: "https://chatgpt.com/backend-api", model: "gpt-5.3-codex" },
    ...overrides,
  };
}

describe("ModelRegistry", () => {
  test('get("default") returns model with correct modelId', () => {
    const registry = new ModelRegistry(baseLLMConfig());
    const model = registry.get("default");
    expect(model.modelId).toBe("gpt-4o");
    expect(model.provider).toBe("openai");
  });

  test('get("compact") falls back to default when not configured', () => {
    const registry = new ModelRegistry(baseLLMConfig());
    const compactModel = registry.get("compact");
    const defaultModel = registry.get("default");
    // Same spec → same cached instance
    expect(compactModel).toBe(defaultModel);
  });

  test('get("compact") returns role-specific model when configured', () => {
    const registry = new ModelRegistry(baseLLMConfig({
      roles: {
        default: "openai/gpt-4o",
        compact: "openai/gpt-4o-mini",
        subAgent: undefined,
        reflection: undefined,
      },
    }));
    const compactModel = registry.get("compact");
    const defaultModel = registry.get("default");
    expect(compactModel.modelId).toBe("gpt-4o-mini");
    expect(defaultModel.modelId).toBe("gpt-4o");
    expect(compactModel).not.toBe(defaultModel);
  });

  test("same spec returns same cached instance", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      roles: {
        default: "openai/gpt-4o",
        subAgent: "openai/gpt-4o", // same as default
        compact: undefined,
        reflection: undefined,
      },
    }));
    const defaultModel = registry.get("default");
    const subAgentModel = registry.get("subAgent");
    expect(defaultModel).toBe(subAgentModel);
  });

  test('getModelId() extracts model name from "provider/model"', () => {
    const registry = new ModelRegistry(baseLLMConfig({
      roles: {
        default: "openai/gpt-4o",
        compact: "anthropic/claude-haiku-3.5",
        subAgent: undefined,
        reflection: undefined,
      },
    }));
    expect(registry.getModelId("default")).toBe("gpt-4o");
    expect(registry.getModelId("compact")).toBe("claude-haiku-3.5");
    // Unconfigured role falls back to default
    expect(registry.getModelId("subAgent")).toBe("gpt-4o");
  });

  test("invalid spec (no slash) throws", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      roles: {
        default: "gpt-4o", // no provider prefix
        subAgent: undefined,
        compact: undefined,
        reflection: undefined,
      },
    }));
    expect(() => registry.get("default")).toThrow('Invalid model spec "gpt-4o"');
  });

  test("unknown provider throws", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      roles: {
        default: "unknown-provider/gpt-4o",
        subAgent: undefined,
        compact: undefined,
        reflection: undefined,
      },
    }));
    expect(() => registry.get("default")).toThrow('Provider "unknown-provider" not found');
  });

  test("custom provider without type throws", () => {
    const registry = new ModelRegistry({
      ...baseLLMConfig(),
      providers: {
        ...baseLLMConfig().providers,
        myhost: { apiKey: "key", baseURL: "http://localhost:8080/v1", type: undefined },
      },
      roles: {
        default: "myhost/my-model",
        subAgent: undefined,
        compact: undefined,
        reflection: undefined,
      },
    });
    expect(() => registry.get("default")).toThrow('Provider "myhost" requires explicit "type"');
  });

  test("custom provider with explicit type works", () => {
    const registry = new ModelRegistry({
      ...baseLLMConfig(),
      providers: {
        ...baseLLMConfig().providers,
        myhost: { apiKey: "key", baseURL: "http://localhost:8080/v1", type: "openai" },
      },
      roles: {
        default: "myhost/my-model",
        subAgent: undefined,
        compact: undefined,
        reflection: undefined,
      },
    });
    const model = registry.get("default");
    expect(model.modelId).toBe("my-model");
    expect(model.provider).toBe("openai");
  });

  test("anthropic provider creates anthropic model", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      roles: {
        default: "anthropic/claude-sonnet-4",
        subAgent: undefined,
        compact: undefined,
        reflection: undefined,
      },
    }));
    const model = registry.get("default");
    expect(model.modelId).toBe("claude-sonnet-4");
    expect(model.provider).toBe("anthropic");
  });

  test("all roles can be configured independently", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      roles: {
        default: "openai/gpt-4o",
        subAgent: "openai/gpt-4o-mini",
        compact: "openai/gpt-4o-mini",
        reflection: "anthropic/claude-haiku-3.5",
      },
    }));
    expect(registry.get("default").modelId).toBe("gpt-4o");
    expect(registry.get("subAgent").modelId).toBe("gpt-4o-mini");
    expect(registry.get("compact").modelId).toBe("gpt-4o-mini");
    expect(registry.get("reflection").modelId).toBe("claude-haiku-3.5");
    // subAgent and compact share same spec → same instance
    expect(registry.get("subAgent")).toBe(registry.get("compact"));
  });
});
