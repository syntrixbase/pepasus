/**
 * Configuration schemas and types.
 * Separated to avoid circular dependencies between config.ts and config-loader.ts.
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
  taskTimeout: z.coerce.number().int().positive().default(120), // seconds, default 2 minutes
});

export const IdentityConfigSchema = z.object({
  personaPath: z.string().default("data/personas/default.json"),
});

/**
 * Preprocess stringified arrays from env var interpolation.
 * YAML ${VAR:-[]} produces string "[]" instead of an actual array.
 * This preprocessor parses JSON-like string arrays back to real arrays.
 */
function coerceStringArray(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "[]" || trimmed === "") return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not valid JSON, return as-is for Zod to validate
    }
  }
  return val;
}

export const ToolsConfigSchema = z.object({
  timeout: z.coerce.number().int().positive().default(30), // seconds, tool execution timeout
  allowedPaths: z.preprocess(coerceStringArray, z.array(z.string()).default([])),
  webSearch: z
    .object({
      provider: z
        .enum(["tavily", "google", "bing", "duckduckgo"])
        .optional(),
      apiKey: z.string().optional(),
      maxResults: z.coerce.number().int().positive().default(10),
    })
    .optional(),
  mcpServers: z.preprocess(
    coerceStringArray,
    z.array(
      z.object({
        name: z.string(),
        url: z.string().url(),
        enabled: z.boolean().default(true),
      })
    ).default([]),
  ),
});

export const SettingsSchema = z.object({
  llm: LLMConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  identity: IdentityConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  logLevel: z.string().default("info"),
  dataDir: z.string().default("data"),
  // Log output destination
  // Log output format (file only, no console output)
  // json — structured JSON lines, machine-parseable (default)
  // line — human-readable single lines: TIME LEVEL [module] message key=value
  logFormat: z.enum(["json", "line"]).default("json"),
  nodeEnv: z.string().default("development"), // NODE_ENV: development | production | test
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
