/**
 * ModelRegistry — Per-role model resolution with lazy creation and caching.
 *
 * Maps role names (default, subAgent, compact, reflection) to "provider/model"
 * specs, and creates LanguageModel instances on first access. If a role has no
 * explicit spec, it falls back to the "default" role's spec.
 */
import type { LanguageModel } from "./llm-types.ts";
import type { LLMConfig } from "./config-schema.ts";
import { createOpenAICompatibleModel } from "./openai-client.ts";
import { createAnthropicCompatibleModel } from "./anthropic-client.ts";
import { createCodexModel } from "./codex-client.ts";
import type { CodexCredentials } from "./codex-oauth.ts";
import { getValidCredentials } from "./codex-oauth.ts";
import { getLogger } from "./logger.ts";

const logger = getLogger("model_registry");

export type ModelRole = "default" | "subAgent" | "compact" | "reflection";

export class ModelRegistry {
  private providers: LLMConfig["providers"];
  private roles: LLMConfig["roles"];
  private cache = new Map<string, LanguageModel>();
  private codexCredentials: CodexCredentials | null = null;
  private codexBaseURL: string = "https://chatgpt.com/backend-api";
  private codexCredPath: string = "";

  constructor(llmConfig: LLMConfig) {
    this.providers = llmConfig.providers;
    this.roles = llmConfig.roles;
  }

  /** Set Codex OAuth credentials, base URL, and credential path for auto-refresh. */
  setCodexCredentials(creds: CodexCredentials, baseURL?: string, credPath?: string): void {
    this.codexCredentials = creds;
    if (baseURL) this.codexBaseURL = baseURL;
    if (credPath) this.codexCredPath = credPath;
    // Invalidate cached codex models so they pick up new tokens
    for (const [key, model] of this.cache.entries()) {
      if (model.provider === "openai-codex") {
        this.cache.delete(key);
      }
    }
  }

  /** Get model for a role. Lazy-creates on first call. */
  get(role: ModelRole): LanguageModel {
    const spec = this.roles[role] ?? this.roles.default;
    const cached = this.cache.get(spec);
    if (cached) return cached;

    const model = this._create(spec);
    this.cache.set(spec, model);
    logger.info({ role, spec }, "model_created");
    return model;
  }

  /** Get modelId for a role (for context window lookup). */
  getModelId(role: ModelRole): string {
    const spec = this.roles[role] ?? this.roles.default;
    const slashIdx = spec.indexOf("/");
    return slashIdx === -1 ? spec : spec.slice(slashIdx + 1);
  }

  private _create(spec: string): LanguageModel {
    const slashIdx = spec.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(`Invalid model spec "${spec}": expected "provider/model"`);
    }

    const providerName = spec.slice(0, slashIdx);
    const modelName = spec.slice(slashIdx + 1);

    // Codex models use "codex/model-name" — no provider config needed
    if (providerName === "codex") {
      if (!this.codexCredentials) {
        throw new Error(
          `Codex model "${spec}" requires OAuth authentication. ` +
          `Set codex.enabled: true in config to trigger the OAuth flow at startup.`,
        );
      }
      return createCodexModel({
        baseURL: this.codexBaseURL,
        model: modelName,
        accountId: this.codexCredentials.accountId,
        getAccessToken: async () => {
          // Refresh token if expired, update stored credentials
          const fresh = await getValidCredentials(this.codexCredPath);
          if (fresh) {
            this.codexCredentials = fresh;
            return fresh.accessToken;
          }
          // Fallback to current (possibly expired) token
          return this.codexCredentials!.accessToken;
        },
      });
    }

    // Standard providers
    const providerConfig = this.providers[providerName];
    if (!providerConfig) {
      throw new Error(`Provider "${providerName}" not found in llm.providers`);
    }

    const sdkType = this._resolveType(providerName, providerConfig.type);

    switch (sdkType) {
      case "openai":
        return createOpenAICompatibleModel({
          apiKey: providerConfig.apiKey || "dummy",
          baseURL: providerConfig.baseURL,
          model: modelName,
        });
      case "anthropic":
        return createAnthropicCompatibleModel({
          apiKey: providerConfig.apiKey || "",
          baseURL: providerConfig.baseURL,
          model: modelName,
        });
    }
  }

  private _resolveType(
    name: string,
    explicitType?: "openai" | "anthropic",
  ): "openai" | "anthropic" {
    if (explicitType) return explicitType;
    if (name === "openai") return "openai";
    if (name === "anthropic") return "anthropic";
    throw new Error(
      `Provider "${name}" requires explicit "type" field (openai or anthropic)`,
    );
  }
}
