/**
 * Configuration — Zod-validated settings loaded from config files + hardcoded defaults.
 *
 * Loading flow:
 * 1. Hardcoded defaults (in config-loader.ts)
 * 2. config.yml deep-merge override (with ${ENV_VAR} interpolation)
 * 3. config.local.yml deep-merge override (with ${ENV_VAR} interpolation)
 * 4. Zod schema validation
 *
 * Env var names are user-defined in config YAML via ${VAR:-default} syntax.
 * No hardcoded env var names in the loader (except PEGASUS_CONFIG for custom path).
 */
export * from "./config-schema.ts";
import type { Settings } from "./config-schema.ts";

// Singleton
let _settings: Settings | null = null;

export function getSettings(): Settings {
  if (!_settings) {
    const { loadSettings } = require("./config-loader.ts") as typeof import("./config-loader.ts");
    _settings = loadSettings();
  }
  return _settings;
}

/** Override settings (for testing) */
export function setSettings(s: Settings): void {
  _settings = s;
}

/** Reset settings singleton so next getSettings() reloads from config (for testing) */
export function resetSettings(): void {
  _settings = null;
}
