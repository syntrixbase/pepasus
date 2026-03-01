/**
 * Tests for ModelRegistry — per-role model resolution with caching.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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

  // ── setCodexCredentials tests ──────────────────────

  test("setCodexCredentials enables codex model creation", () => {
    const registry = new ModelRegistry(baseLLMConfig({
      roles: {
        default: "codex/gpt-5.3-codex",
        subAgent: undefined,
        compact: undefined,
        reflection: undefined,
      },
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
      roles: {
        default: "codex/gpt-5.3-codex",
        subAgent: undefined,
        compact: undefined,
        reflection: undefined,
      },
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
      roles: {
        default: "codex/gpt-5.3-codex",
        subAgent: undefined,
        compact: undefined,
        reflection: undefined,
      },
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
      roles: {
        default: "openai/gpt-4o",
        compact: "codex/gpt-5.3-codex",
        subAgent: undefined,
        reflection: undefined,
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

  // ── codex getAccessToken callback tests ──────────

  describe("codex getAccessToken callback", () => {
    let mockServer: ReturnType<typeof Bun.serve>;
    let mockPort: number;

    beforeAll(() => {
      mockPort = 18940;
      mockServer = Bun.serve({
        port: mockPort,
        fetch() {
          // Return a valid SSE response for codex
          const resp = {
            id: "resp-test",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hello" }],
              },
            ],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          };
          const lines = [
            `event: response.output_item.done`,
            `data: ${JSON.stringify({ item: resp.output[0] })}`,
            "",
            `event: response.completed`,
            `data: ${JSON.stringify({ response: resp })}`,
            "",
            "",
          ];
          return new Response(lines.join("\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
    });

    afterAll(() => {
      mockServer.stop(true);
    });

    test("getAccessToken falls back to current credentials when credPath has no file", async () => {
      const registry = new ModelRegistry(baseLLMConfig({
        roles: {
          default: "codex/gpt-5.3-codex",
          subAgent: undefined,
          compact: undefined,
          reflection: undefined,
        },
      }));

      registry.setCodexCredentials(
        {
          accessToken: "fallback-token",
          refreshToken: "ref",
          expiresAt: Date.now() + 3600000,
          accountId: "acct-test",
        },
        `http://localhost:${mockPort}`,
        "/tmp/nonexistent-codex-cred-path.json",
      );

      const model = registry.get("default");
      // Calling generate() triggers getAccessToken callback (lines 87-94)
      // getValidCredentials("/tmp/nonexistent-...") returns null → fallback path
      const result = await model.generate({
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.text).toBe("hello");
    }, 10000);

    test("getAccessToken uses refreshed credentials when credPath has valid file", async () => {
      const testDir = "/tmp/pegasus-test-registry-codex";
      const testFile = join(testDir, "codex.json");

      // Write valid, non-expired credentials to the file
      mkdirSync(testDir, { recursive: true });
      const fileCreds = {
        accessToken: "file-token",
        refreshToken: "file-ref",
        expiresAt: Date.now() + 3600000,
        accountId: "acct-file",
      };
      writeFileSync(testFile, JSON.stringify(fileCreds));

      try {
        const registry = new ModelRegistry(baseLLMConfig({
          roles: {
            default: "codex/gpt-5.3-codex",
            subAgent: undefined,
            compact: undefined,
            reflection: undefined,
          },
        }));

        registry.setCodexCredentials(
          {
            accessToken: "initial-token",
            refreshToken: "ref",
            expiresAt: Date.now() + 3600000,
            accountId: "acct-init",
          },
          `http://localhost:${mockPort}`,
          testFile,
        );

        const model = registry.get("default");
        // getValidCredentials(testFile) returns fresh creds from file → lines 90-92
        const result = await model.generate({
          messages: [{ role: "user", content: "hi" }],
        });
        expect(result.text).toBe("hello");
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    }, 10000);
  });
});
