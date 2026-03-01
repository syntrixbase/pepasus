/**
 * Tests for ModelRegistry — per-role model resolution with caching.
 * Tests for TiersConfigSchema — tier value union type validation.
 *
 * Updated for pi-ai adapter: all models are now created via createPiAiLanguageModel.
 */
import { describe, expect, test } from "bun:test";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { TiersConfigSchema } from "@pegasus/infra/config-schema.ts";

function baseLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    providers: {
      openai: { apiKey: "sk-test", baseURL: undefined, type: undefined },
      anthropic: { apiKey: "sk-ant-test", baseURL: undefined, type: undefined },
    },
    default: "openai/gpt-4o",
    tiers: {},
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
    codex: { enabled: false, baseURL: "https://chatgpt.com/backend-api", model: "gpt-5.3-codex" },
    copilot: { enabled: false },
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

  test('get("fast") falls back to default when not configured', () => {
    const registry = new ModelRegistry(baseLLMConfig());
    const fastModel = registry.get("fast");
    const defaultModel = registry.get("default");
    // Same spec → same cached instance
    expect(fastModel).toBe(defaultModel);
  });

  test('get("fast") returns tier-specific model when configured', () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "openai/gpt-4o-mini",
      },
    }));
    const fastModel = registry.get("fast");
    const defaultModel = registry.get("default");
    expect(fastModel.modelId).toBe("gpt-4o-mini");
    expect(defaultModel.modelId).toBe("gpt-4o");
    expect(fastModel).not.toBe(defaultModel);
  });

  test("same spec returns same cached instance", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        balanced: "openai/gpt-4o", // same as default
      },
    }));
    const defaultModel = registry.get("default");
    const balancedModel = registry.get("balanced");
    expect(defaultModel).toBe(balancedModel);
  });

  test('getModelId() extracts model name from "provider/model"', () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "anthropic/claude-haiku-3.5",
      },
    }));
    expect(registry.getModelId("default")).toBe("gpt-4o");
    expect(registry.getModelId("fast")).toBe("claude-haiku-3.5");
    // Unconfigured tier falls back to default
    expect(registry.getModelId("balanced")).toBe("gpt-4o");
  });

  test("invalid spec (no slash) throws", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "gpt-4o", // no provider prefix
    }));
    expect(() => registry.get("default")).toThrow('Invalid model spec "gpt-4o"');
  });

  test("unknown provider throws", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "unknown-provider/gpt-4o",
    }));
    expect(() => registry.get("default")).toThrow('Provider "unknown-provider" not found');
  });

  test("custom provider with explicit type works", () => {
    const registry = new ModelRegistry({
      ...baseLLMConfig(),
      providers: {
        ...baseLLMConfig().providers,
        myhost: { apiKey: "key", baseURL: "http://localhost:8080/v1", type: "openai" },
      },
      default: "myhost/my-model",
    });
    const model = registry.get("default");
    expect(model.modelId).toBe("my-model");
    // pi-ai adapter uses the resolved provider name
    expect(model.provider).toBe("openai");
  });

  test("anthropic provider creates model with correct provider", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "anthropic/claude-sonnet-4",
    }));
    const model = registry.get("default");
    expect(model.modelId).toBe("claude-sonnet-4");
    expect(model.provider).toBe("anthropic");
  });

  // ── setCodexCredentials tests ──────────────────────

  test("setCodexCredentials enables codex model creation", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "codex/gpt-5.3-codex",
    }));

    // Without credentials, codex model throws
    expect(() => registry.get("default")).toThrow("requires OAuth authentication");

    // Set credentials
    registry.setCodexCredentials({
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 3600000,
      accountId: "acct-123",
    });

    // Now it works
    const model = registry.get("default");
    expect(model.provider).toBe("openai-codex");
    expect(model.modelId).toBe("gpt-5.3-codex");
  });

  test("setCodexCredentials with custom baseURL", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "codex/gpt-5.3-codex",
    }));

    registry.setCodexCredentials(
      {
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: Date.now() + 3600000,
        accountId: "acct",
      },
      "https://custom-codex.example.com/api",
    );

    const model = registry.get("default");
    expect(model.provider).toBe("openai-codex");
  });

  test("setCodexCredentials invalidates cached codex models", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "codex/gpt-5.3-codex",
    }));

    // Set initial credentials and create model
    registry.setCodexCredentials({
      accessToken: "token-v1",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      accountId: "acct",
    });
    const model1 = registry.get("default");

    // Update credentials — should invalidate cache
    registry.setCodexCredentials({
      accessToken: "token-v2",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      accountId: "acct",
    });
    const model2 = registry.get("default");

    // Should be a different instance (re-created with new token)
    expect(model1).not.toBe(model2);
  });

  test("setCodexCredentials does not invalidate non-codex cached models", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "codex/gpt-5.3-codex",
      },
    }));

    // Create and cache the openai model
    const openaiModel1 = registry.get("default");

    // Set codex credentials
    registry.setCodexCredentials({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      accountId: "acct",
    });

    // OpenAI model should still be the same cached instance
    const openaiModel2 = registry.get("default");
    expect(openaiModel1).toBe(openaiModel2);
  });

  test("all tiers can be configured independently", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "openai/gpt-4o-mini",
        balanced: "openai/gpt-4o-mini",
        powerful: "anthropic/claude-haiku-3.5",
      },
    }));
    expect(registry.get("default").modelId).toBe("gpt-4o");
    expect(registry.get("fast").modelId).toBe("gpt-4o-mini");
    expect(registry.get("balanced").modelId).toBe("gpt-4o-mini");
    expect(registry.get("powerful").modelId).toBe("claude-haiku-3.5");
    // fast and balanced share same spec → same instance
    expect(registry.get("fast")).toBe(registry.get("balanced"));
  });

  // ── Per-role context window tests ────────────────

  test("getContextWindow returns undefined for string tier values", () => {
    const registry = new ModelRegistry(baseLLMConfig());
    expect(registry.getContextWindow("default")).toBeUndefined();
    expect(registry.getContextWindow("fast")).toBeUndefined();
    expect(registry.getContextWindow("balanced")).toBeUndefined();
    expect(registry.getContextWindow("powerful")).toBeUndefined();
  });

  test("getContextWindow returns configured value for object tier values", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "openai/gpt-4o-mini",
        balanced: { model: "openai/gpt-4o-mini", contextWindow: 32_000 },
        powerful: { model: "anthropic/claude-haiku-3.5", contextWindow: 16_000 },
      },
    }));
    expect(registry.getContextWindow("default")).toBeUndefined();
    expect(registry.getContextWindow("balanced")).toBe(32_000);
    expect(registry.getContextWindow("fast")).toBeUndefined();
    expect(registry.getContextWindow("powerful")).toBe(16_000);
  });

  test("object tier values work correctly with get() and getModelId()", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: { model: "openai/gpt-4o", contextWindow: 128_000 },
      tiers: {
        fast: "openai/gpt-4o-mini",
        balanced: { model: "openai/gpt-4o-mini", contextWindow: 32_000 },
      },
    }));

    // get() should resolve models correctly
    expect(registry.get("default").modelId).toBe("gpt-4o");
    expect(registry.get("balanced").modelId).toBe("gpt-4o-mini");
    expect(registry.get("fast").modelId).toBe("gpt-4o-mini");

    // getModelId() should extract model name
    expect(registry.getModelId("default")).toBe("gpt-4o");
    expect(registry.getModelId("balanced")).toBe("gpt-4o-mini");

    // balanced (object) and fast (string) with same model spec → same cached instance
    expect(registry.get("balanced")).toBe(registry.get("fast"));

    // getContextWindow should return per-tier values
    expect(registry.getContextWindow("default")).toBe(128_000);
    expect(registry.getContextWindow("balanced")).toBe(32_000);
    expect(registry.getContextWindow("fast")).toBeUndefined();
    // powerful falls back to default
    expect(registry.getContextWindow("powerful")).toBe(128_000);
  });

  test("object tier without contextWindow returns undefined for getContextWindow", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: { model: "openai/gpt-4o" },
    }));
    expect(registry.getContextWindow("default")).toBeUndefined();
    expect(registry.get("default").modelId).toBe("gpt-4o");
  });

  // ── setCopilotCredentials tests ──────────────────────

  test("setCopilotCredentials enables copilot model creation", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "copilot/gpt-4o",
    }));

    // Without credentials, copilot model throws
    expect(() => registry.get("default")).toThrow("requires authentication");

    // Set credentials
    registry.setCopilotCredentials(
      "tid=test;exp=999",
      "https://api.individual.githubcopilot.com",
      "/tmp/test-copilot.json",
    );

    // Now it works
    const model = registry.get("default");
    expect(model.provider).toBe("copilot");
    expect(model.modelId).toBe("gpt-4o");
  });

  test("setCopilotCredentials invalidates cached copilot models", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      default: "copilot/gpt-4o",
    }));

    // Set initial credentials and create model
    registry.setCopilotCredentials(
      "tid=v1;exp=999",
      "https://api.individual.githubcopilot.com",
      "/tmp/test-copilot.json",
    );
    const model1 = registry.get("default");

    // Update credentials — should invalidate cache
    registry.setCopilotCredentials(
      "tid=v2;exp=999",
      "https://api.individual.githubcopilot.com",
      "/tmp/test-copilot.json",
    );
    const model2 = registry.get("default");

    // Should be a different instance (re-created with new token)
    expect(model1).not.toBe(model2);
  });

  test("setCopilotCredentials does not invalidate non-copilot cached models", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      tiers: {
        fast: "copilot/gpt-4o",
      },
    }));

    // Create and cache the openai model
    const openaiModel1 = registry.get("default");

    // Set copilot credentials
    registry.setCopilotCredentials(
      "tid=tok;exp=999",
      "https://api.individual.githubcopilot.com",
      "/tmp/test-copilot.json",
    );

    // OpenAI model should still be the same cached instance
    const openaiModel2 = registry.get("default");
    expect(openaiModel1).toBe(openaiModel2);
  });

  // ── setOAuthCredentials tests ──────────────────────

  test("setOAuthCredentials stores credentials for a provider", () => {
    const registry = new ModelRegistry(baseLLMConfig());

    // Should not throw
    registry.setOAuthCredentials(
      "custom-oauth",
      { access: "tok", refresh: "ref", expires: Date.now() + 3600000 },
      "/tmp/cred.json",
      "https://custom.example.com/v1",
    );
  });

  test("setOAuthCredentials invalidates cached models for the provider", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      providers: {
        openai: { apiKey: "sk-test", baseURL: undefined, type: undefined },
        myoauth: { apiKey: "tok1", baseURL: "https://custom.example.com/v1", type: "openai" },
      },
      tiers: {
        fast: "myoauth/my-model",
      },
    }));

    // Create and cache both models
    const openaiModel1 = registry.get("default");
    const oauthModel1 = registry.get("fast");

    // Set OAuth credentials for myoauth provider — should invalidate its cache
    registry.setOAuthCredentials(
      "openai", // match the piProvider resolved name, since myoauth type: "openai" → piProvider = "openai"
      { access: "new-tok", refresh: "ref", expires: Date.now() + 3600000 },
      "/tmp/cred.json",
    );

    // openai model was invalidated (provider matches "openai")
    const openaiModel2 = registry.get("default");
    expect(openaiModel1).not.toBe(openaiModel2);

    // myoauth model cache key uses the resolved provider "openai",
    // so it was also invalidated
    const oauthModel2 = registry.get("fast");
    expect(oauthModel1).not.toBe(oauthModel2);
  });

  test("setOAuthCredentials does not invalidate models for other providers", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      providers: {
        openai: { apiKey: "sk-test", baseURL: undefined, type: undefined },
        anthropic: { apiKey: "sk-ant-test", baseURL: undefined, type: undefined },
      },
      tiers: {
        fast: "anthropic/claude-haiku-3.5",
      },
    }));

    // Create and cache both models
    const openaiModel1 = registry.get("default");
    const anthropicModel1 = registry.get("fast");

    // Set OAuth credentials for "some-other" — should not invalidate any existing caches
    registry.setOAuthCredentials(
      "some-other",
      { access: "tok", refresh: "ref", expires: Date.now() + 3600000 },
      "/tmp/cred.json",
    );

    // Both should be same cached instances
    const openaiModel2 = registry.get("default");
    const anthropicModel2 = registry.get("fast");
    expect(openaiModel1).toBe(openaiModel2);
    expect(anthropicModel1).toBe(anthropicModel2);
  });
});

// ── TiersConfigSchema + RoleValueSchema validation tests ─────────────

describe("TiersConfigSchema", () => {
  test("accepts all string tier values", () => {
    const result = TiersConfigSchema.parse({
      fast: "openai/gpt-4o-mini",
      balanced: "openai/gpt-4o",
      powerful: "anthropic/claude-haiku-3.5",
    });
    expect(result.fast).toBe("openai/gpt-4o-mini");
    expect(result.balanced).toBe("openai/gpt-4o");
  });

  test("accepts object tier values with contextWindow", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o-mini", contextWindow: 32_000 },
      powerful: { model: "openai/gpt-4o", contextWindow: 128_000 },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o-mini", contextWindow: 32_000 });
    expect(result.powerful).toEqual({ model: "openai/gpt-4o", contextWindow: 128_000 });
  });

  test("accepts object tier values without contextWindow", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o" },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o" });
  });

  test("accepts mixed string and object tier values", () => {
    const result = TiersConfigSchema.parse({
      fast: "openai/gpt-4o-mini",
      balanced: { model: "openai/gpt-4o", contextWindow: 128_000 },
      powerful: { model: "anthropic/claude-haiku-3.5", contextWindow: 16_000 },
    });
    expect(typeof result.fast).toBe("string");
    expect(typeof result.balanced).toBe("object");
    expect(typeof result.powerful).toBe("object");
  });

  test("coerces contextWindow string to number", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o", contextWindow: "128000" },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o", contextWindow: 128_000 });
  });

  test("rejects object tier value without model field", () => {
    expect(() => TiersConfigSchema.parse({
      fast: { contextWindow: 128_000 },
    })).toThrow();
  });

  test("rejects negative contextWindow", () => {
    expect(() => TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o", contextWindow: -1 },
    })).toThrow();
  });

  test("accepts object tier values with apiType", () => {
    const result = TiersConfigSchema.parse({
      powerful: { model: "myhost/claude-sonnet-4", apiType: "anthropic" },
    });
    expect(result.powerful).toEqual({ model: "myhost/claude-sonnet-4", apiType: "anthropic" });
  });

  test("accepts object tier values with apiType and contextWindow", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o", contextWindow: 128_000, apiType: "openai" },
      powerful: { model: "myhost/claude-sonnet-4", contextWindow: 200_000, apiType: "anthropic" },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o", contextWindow: 128_000, apiType: "openai" });
    expect(result.powerful).toEqual({ model: "myhost/claude-sonnet-4", contextWindow: 200_000, apiType: "anthropic" });
  });

  test("rejects invalid apiType value", () => {
    expect(() => TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o", apiType: "invalid" },
    })).toThrow();
  });

  test("defaults to empty object", () => {
    const result = TiersConfigSchema.parse(undefined);
    expect(result).toEqual({});
  });

  test("all tier fields are optional", () => {
    const result = TiersConfigSchema.parse({
      fast: "openai/gpt-4o-mini",
    });
    expect(result.fast).toBe("openai/gpt-4o-mini");
    expect(result.balanced).toBeUndefined();
    expect(result.powerful).toBeUndefined();
  });
});
