/**
 * Configuration singleton.
 *
 * Settings must be initialized by the main entry point (cli.ts) via setSettings()
 * BEFORE any other code calls getSettings(). Internal modules must never load
 * config files themselves — they receive settings through dependency injection
 * or the singleton that was already initialized by the entry point.
 */
export * from "./config-schema.ts";
import type { Settings } from "./config-schema.ts";

// Singleton — must be initialized by entry point before use
let _settings: Settings | null = null;

export function getSettings(): Settings {
  if (!_settings) {
    throw new Error(
      "Settings not initialized. Call setSettings() from the main entry point before using getSettings()."
    );
  }
  return _settings;
}

/** Initialize the settings singleton. Must be called once from the main entry point. */
export function setSettings(s: Settings): void {
  _settings = s;
}

/** Reset settings singleton (for testing only). */
export function resetSettings(): void {
  _settings = null;
}
