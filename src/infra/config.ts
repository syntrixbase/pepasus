/**
 * Configuration — Zod-validated settings loaded from env vars.
 */
import { z } from "zod";

// Provider-specific configuration
export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
});

export const LLMConfigSchema = z.object({
  // Active provider
  provider: z.enum(["anthropic", "openai", "openai-compatible"]).default("openai"),

  // Default model (fallback if provider-specific not set)
  model: z.string().default("gpt-4o-mini"),

  // Provider-specific configurations
  openai: ProviderConfigSchema.default({}),
  anthropic: ProviderConfigSchema.default({}),

  // For openai-compatible providers (Ollama, LM Studio, etc.)
  baseURL: z.string().optional(),

  // System-wide settings
  maxConcurrentCalls: z.coerce.number().int().positive().default(3),
  timeout: z.coerce.number().int().positive().default(120),
});

export const MemoryConfigSchema = z.object({
  dbPath: z.string().default("data/memory.db"),
  vectorDbPath: z.string().default("data/vectors"),
});

export const AgentConfigSchema = z.object({
  maxActiveTasks: z.coerce.number().int().positive().default(5),
  maxConcurrentTools: z.coerce.number().int().positive().default(3),
  maxCognitiveIterations: z.coerce.number().int().positive().default(10),
  heartbeatInterval: z.coerce.number().positive().default(60),
});

export const IdentityConfigSchema = z.object({
  personaPath: z.string().default("data/personas/default.json"),
});

export const SettingsSchema = z.object({
  llm: LLMConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  identity: IdentityConfigSchema.default({}),
  logLevel: z.string().default("info"),
  dataDir: z.string().default("data"),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Load settings from environment variables.
 *
 * Env vars:
 *   LLM_PROVIDER - Active provider (openai, anthropic, openai-compatible)
 *   LLM_MODEL - Default model name
 *
 *   # OpenAI provider
 *   OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
 *
 *   # Anthropic provider
 *   ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL
 *
 *   # OpenAI-compatible (Ollama, LM Studio, etc.)
 *   LLM_BASE_URL - Base URL for compatible provider
 *
 *   # Legacy support
 *   LLM_API_KEY - Falls back to provider-specific key
 *
 *   # System settings
 *   LLM_MAX_CONCURRENT_CALLS, LLM_TIMEOUT
 *   MEMORY_DB_PATH, MEMORY_VECTOR_DB_PATH
 *   AGENT_MAX_ACTIVE_TASKS, AGENT_MAX_CONCURRENT_TOOLS, ...
 *   PEGASUS_LOG_LEVEL, PEGASUS_DATA_DIR
 */
function loadFromEnv(): Settings {
  const env = process.env;
  return SettingsSchema.parse({
    llm: {
      provider: env["LLM_PROVIDER"],
      model: env["LLM_MODEL"],
      openai: {
        apiKey: env["OPENAI_API_KEY"] || env["LLM_API_KEY"],
        baseURL: env["OPENAI_BASE_URL"],
        model: env["OPENAI_MODEL"],
      },
      anthropic: {
        apiKey: env["ANTHROPIC_API_KEY"] || env["LLM_API_KEY"],
        baseURL: env["ANTHROPIC_BASE_URL"],
        model: env["ANTHROPIC_MODEL"],
      },
      baseURL: env["LLM_BASE_URL"], // For openai-compatible
      maxConcurrentCalls: env["LLM_MAX_CONCURRENT_CALLS"],
      timeout: env["LLM_TIMEOUT"],
    },
    memory: {
      dbPath: env["MEMORY_DB_PATH"],
      vectorDbPath: env["MEMORY_VECTOR_DB_PATH"],
    },
    agent: {
      maxActiveTasks: env["AGENT_MAX_ACTIVE_TASKS"],
      maxConcurrentTools: env["AGENT_MAX_CONCURRENT_TOOLS"],
      maxCognitiveIterations: env["AGENT_MAX_COGNITIVE_ITERATIONS"],
      heartbeatInterval: env["AGENT_HEARTBEAT_INTERVAL"],
    },
    identity: {
      personaPath: env["IDENTITY_PERSONA_PATH"],
    },
    logLevel: env["PEGASUS_LOG_LEVEL"],
    dataDir: env["PEGASUS_DATA_DIR"],
  });
}

// Singleton
let _settings: Settings | null = null;

export function getSettings(): Settings {
  if (!_settings) {
    _settings = loadFromEnv();
  }
  return _settings;
}

/** Override settings (for testing) */
export function setSettings(s: Settings): void {
  _settings = s;
}

/** Reset settings singleton so next getSettings() reloads from env (for testing) */
export function resetSettings(): void {
  _settings = null;
}

/**
 * Get the active provider's configuration.
 * Returns the provider-specific config merged with defaults.
 */
export function getActiveProviderConfig(settings: Settings): {
  apiKey?: string;
  baseURL?: string;
  model: string;
} {
  const { provider, model: defaultModel, openai, anthropic, baseURL } = settings.llm;

  switch (provider) {
    case "openai":
      return {
        apiKey: openai.apiKey,
        baseURL: openai.baseURL,
        model: openai.model || defaultModel,
      };
    case "anthropic":
      return {
        apiKey: anthropic.apiKey,
        baseURL: anthropic.baseURL,
        model: anthropic.model || defaultModel,
      };
    case "openai-compatible":
      return {
        apiKey: openai.apiKey,
        baseURL: baseURL,
        model: openai.model || defaultModel,
      };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
