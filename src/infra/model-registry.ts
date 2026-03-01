/**
 * ModelRegistry — Per-role model resolution with lazy creation and caching.
 *
 * Maps role names (default, subAgent, compact, reflection) to "provider/model"
 * specs, and creates LanguageModel instances on first access. If a role has no
 * explicit spec, it falls back to the "default" role's spec.
 *
 * Role values support two forms:
 * - Shorthand string: "provider/model"
 * - Object: { model: "provider/model", contextWindow?: number, apiType?: "openai" | "anthropic" }
 */
import type { LanguageModel } from "./llm-types.ts";
import type { LLMConfig, RoleValue } from "./config-schema.ts";
import { createOpenAICompatibleModel } from "./openai-client.ts";
import { createAnthropicCompatibleModel } from "./anthropic-client.ts";
import { createCodexModel } from "./codex-client.ts";
import type { CodexCredentials } from "./codex-oauth.ts";
import { getValidCredentials } from "./codex-oauth.ts";
import { getLogger } from "./logger.ts";

const logger = getLogger("model_registry");

export type ModelRole = "default" | "subAgent" | "compact" | "reflection";

/** Normalized role value after resolving string | object union. */
type ResolvedRole = {
  model: string;
  contextWindow?: number;
  apiType?: "openai" | "anthropic";
};

/** Normalize a RoleValue (string | object) into a structured form. */
function resolveRoleValue(value: RoleValue): ResolvedRole {
  if (typeof value === "string") {
    return { model: value };
  }
  return {
    model: value.model,
    contextWindow: value.contextWindow,
    apiType: value.apiType,
  };
}

export class ModelRegistry {
  private providers: LLMConfig["providers"];
  private roles: LLMConfig["roles"];
  private cache = new Map<string, LanguageModel>();
  private codexCredentials: CodexCredentials | null = null;
  private codexBaseURL: string = "https://chatgpt.com/backend-api";
  private codexCredPath: string = "";
  private copilotCredentials: { copilotToken: string; baseURL: string } | null = null;

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

  /** Set Copilot credentials for model creation. credPath is unused here (refresh is external). */
  setCopilotCredentials(token: string, baseURL: string, _credPath: string): void {
    this.copilotCredentials = { copilotToken: token, baseURL };
    // Invalidate cached copilot models so they pick up new tokens
    for (const [key, model] of this.cache.entries()) {
      if (model.provider === "copilot") {
        this.cache.delete(key);
      }
    }
  }

  /** Get model for a role. Lazy-creates on first call. */
  get(role: ModelRole): LanguageModel {
    const resolved = this._resolveRole(role);
    // Cache key includes apiType override to avoid sharing instances
    // when the same model spec uses different API types across roles.
    const cacheKey = resolved.apiType
      ? `${resolved.model}@${resolved.apiType}`
      : resolved.model;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const model = this._create(resolved.model, resolved.apiType);
    this.cache.set(cacheKey, model);
    logger.info({ role, spec: resolved.model, apiType: resolved.apiType }, "model_created");
    return model;
  }

  /** Get modelId for a role (for context window lookup). */
  getModelId(role: ModelRole): string {
    const resolved = this._resolveRole(role);
    const slashIdx = resolved.model.indexOf("/");
    return slashIdx === -1 ? resolved.model : resolved.model.slice(slashIdx + 1);
  }

  /** Get per-role contextWindow override (if configured). */
  getContextWindow(role: ModelRole): number | undefined {
    const resolved = this._resolveRole(role);
    return resolved.contextWindow;
  }

  /** Resolve a role to its normalized form. */
  private _resolveRole(role: ModelRole): ResolvedRole {
    const value = this.roles[role] ?? this.roles.default;
    return resolveRoleValue(value);
  }

  /**
   * Create a LanguageModel from a "provider/model" spec.
   * @param apiTypeOverride — per-role apiType that overrides provider-level type inference.
   */
  private _create(spec: string, apiTypeOverride?: "openai" | "anthropic"): LanguageModel {
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

    // Copilot models use "copilot/model-name" — OpenAI-compatible API with Copilot auth
    if (providerName === "copilot") {
      if (!this.copilotCredentials) {
        throw new Error(
          `Copilot model "${spec}" requires authentication. ` +
          `Set llm.copilot.enabled: true in config to trigger the OAuth flow at startup.`,
        );
      }
      // Create OpenAI-compatible model with current copilot token.
      // Copilot tokens are short-lived (~30 min) but auto-refreshed:
      // when the token expires, setCopilotCredentials() invalidates the cache
      // and the next get() call re-creates the model with the fresh token.
      const model = createOpenAICompatibleModel({
        apiKey: this.copilotCredentials.copilotToken,
        baseURL: `${this.copilotCredentials.baseURL}/v1`,
        model: modelName,
        headers: {
          "Copilot-Integration-Id": "vscode-chat",
          "Editor-Version": "Pegasus/1.0.0",
        },
      });
      // Override provider tag for cache invalidation matching
      return { ...model, provider: "copilot" };
    }

    // Standard providers
    const providerConfig = this.providers[providerName];
    if (!providerConfig) {
      throw new Error(`Provider "${providerName}" not found in llm.providers`);
    }

    // Per-role apiType overrides provider-level type
    const sdkType = apiTypeOverride ?? this._resolveType(providerName, providerConfig.type);

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
