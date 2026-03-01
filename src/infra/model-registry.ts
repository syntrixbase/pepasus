/**
 * ModelRegistry — Per-role model resolution with lazy creation and caching.
 *
 * Maps role names (default, subAgent, compact, reflection) to "provider/model"
 * specs, and creates LanguageModel instances on first access. If a role has no
 * explicit spec, it falls back to the "default" role's spec.
 *
 * All LLM models are now created via the pi-ai adapter, which handles
 * provider-specific protocol differences internally.
 *
 * Role values support two forms:
 * - Shorthand string: "provider/model"
 * - Object: { model: "provider/model", contextWindow?: number, apiType?: "openai" | "anthropic" }
 */
import type { LanguageModel } from "./llm-types.ts";
import type { LLMConfig, RoleValue } from "./config-schema.ts";
import { createPiAiLanguageModel } from "./pi-ai-adapter.ts";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { getLogger } from "./logger.ts";

const logger = getLogger("model_registry");

export type ModelRole = "default" | "fast" | "balanced" | "powerful"
  // Legacy role names — fall back to default when not in tiers
  | "subAgent" | "compact" | "reflection" | "extract";

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

/** Stored OAuth credentials for a provider. */
interface OAuthProviderState {
  credentials: OAuthCredentials;
  credPath: string;
  baseURL?: string;
  /** Extra state for Codex: accountId */
  accountId?: string;
}

/** Legacy roles object built from new config shape for backward compatibility. */
type LegacyRoles = { default: RoleValue; [key: string]: RoleValue | undefined };

export class ModelRegistry {
  private providers: LLMConfig["providers"];
  private roles: LegacyRoles;
  private cache = new Map<string, LanguageModel>();
  private oauthState = new Map<string, OAuthProviderState>();

  constructor(llmConfig: LLMConfig) {
    this.providers = llmConfig.providers;
    // Build legacy roles from new default + tiers config
    // TODO(tier-models): Replace with tier-based API in Task 2
    this.roles = {
      default: llmConfig.default,
      ...(llmConfig.tiers as Record<string, RoleValue | undefined>),
    };
  }

  /** Set Codex OAuth credentials, base URL, and credential path for auto-refresh. */
  setCodexCredentials(
    creds: { accessToken: string; refreshToken: string; expiresAt: number; accountId: string },
    baseURL?: string,
    credPath?: string,
  ): void {
    this.oauthState.set("codex", {
      credentials: {
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
        accountId: creds.accountId,
      },
      credPath: credPath ?? "",
      baseURL,
      accountId: creds.accountId,
    });
    // Invalidate cached codex models so they pick up new tokens
    for (const [key, model] of this.cache.entries()) {
      if (model.provider === "openai-codex" || model.provider === "codex") {
        this.cache.delete(key);
      }
    }
  }

  /** Set Copilot credentials for model creation. credPath is unused here (refresh is external). */
  setCopilotCredentials(token: string, baseURL: string, _credPath: string): void {
    this.oauthState.set("copilot", {
      credentials: {
        access: token,
        refresh: "",
        expires: Date.now() + 3600000, // Copilot tokens are short-lived, refresh is external
      },
      credPath: _credPath,
      baseURL,
    });
    // Invalidate cached copilot models so they pick up new tokens
    for (const [key, model] of this.cache.entries()) {
      if (model.provider === "copilot" || model.provider === "github-copilot") {
        this.cache.delete(key);
      }
    }
  }

  /** Set OAuth credentials for any provider. */
  setOAuthCredentials(provider: string, credentials: OAuthCredentials, credPath: string, baseURL?: string): void {
    this.oauthState.set(provider, { credentials, credPath, baseURL });
    // Invalidate cached models for this provider
    for (const [key, model] of this.cache.entries()) {
      if (model.provider === provider) {
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
   * All models are created via the pi-ai adapter.
   * @param apiTypeOverride — per-role apiType that overrides provider-level type inference.
   */
  private _create(spec: string, _apiTypeOverride?: "openai" | "anthropic"): LanguageModel {
    const slashIdx = spec.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(`Invalid model spec "${spec}": expected "provider/model"`);
    }

    const providerName = spec.slice(0, slashIdx);
    const modelName = spec.slice(slashIdx + 1);

    // Codex models use "codex/model-name" — requires OAuth credentials
    if (providerName === "codex") {
      const state = this.oauthState.get("codex");
      if (!state) {
        throw new Error(
          `Codex model "${spec}" requires OAuth authentication. ` +
          `Set codex.enabled: true in config to trigger the OAuth flow at startup.`,
        );
      }
      // Use openai-codex provider in pi-ai
      return createPiAiLanguageModel({
        provider: "openai-codex",
        model: modelName,
        apiKey: state.credentials.access,
        baseURL: state.baseURL,
      });
    }

    // Copilot models use "copilot/model-name" — requires OAuth credentials
    if (providerName === "copilot") {
      const state = this.oauthState.get("copilot");
      if (!state) {
        throw new Error(
          `Copilot model "${spec}" requires authentication. ` +
          `Set llm.copilot.enabled: true in config to trigger the OAuth flow at startup.`,
        );
      }
      const model = createPiAiLanguageModel({
        provider: "github-copilot",
        model: modelName,
        apiKey: state.credentials.access,
        baseURL: state.baseURL ? `${state.baseURL}/v1` : undefined,
        headers: {
          "Copilot-Integration-Id": "vscode-chat",
          "Editor-Version": "Pegasus/1.0.0",
        },
      });
      // Override provider tag for cache invalidation matching
      return { ...model, provider: "copilot" };
    }

    // Standard providers from config
    const providerConfig = this.providers[providerName];
    if (!providerConfig) {
      throw new Error(`Provider "${providerName}" not found in llm.providers`);
    }

    // Resolve the provider name for pi-ai.
    // For well-known names (openai, anthropic), use them directly.
    // For custom providers with explicit type, the type hint guides pi-ai's
    // protocol selection via the baseURL fallback in pi-ai adapter.
    const piProvider = _apiTypeOverride ?? providerConfig.type ?? providerName;

    return createPiAiLanguageModel({
      provider: piProvider,
      model: modelName,
      apiKey: providerConfig.apiKey,
      baseURL: providerConfig.baseURL,
    });
  }
}
