/**
 * Tests for config-loader.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadSettings } from "../../src/infra/config-loader.ts";
import { resetSettings } from "../../src/infra/config.ts";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("config-loader", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: string;
  let testDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalCwd = process.cwd();

    // Create a temporary directory for test config files
    testDir = mkdtempSync(join(tmpdir(), "pegasus-test-"));
    process.chdir(testDir);

    resetSettings();
  });

  afterEach(async () => {
    // Give logger time to flush before cleanup
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Restore original directory
    process.chdir(originalCwd);

    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }

    process.env = originalEnv;
    resetSettings();
  });

  describe("DEFAULT_CONFIG (no config file)", () => {
    test("uses hardcoded defaults when no config file exists", () => {
      // dataDir is required — provide a minimal config so loadSettings() succeeds
      writeFileSync("config.yml", "system:\n  dataDir: data\n");

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai");
      expect(settings.llm.model).toBe("gpt-4o-mini");
      expect(settings.llm.maxConcurrentCalls).toBe(3);
      expect(settings.llm.timeout).toBe(120);
      expect(settings.agent.maxActiveTasks).toBe(5);
      expect(settings.agent.maxConcurrentTools).toBe(3);
      expect(settings.agent.maxCognitiveIterations).toBe(10);
      expect(settings.agent.heartbeatInterval).toBe(60);
      expect(settings.agent.taskTimeout).toBe(120);
      expect(settings.identity.personaPath).toBe("data/personas/default.json");
      expect(settings.logLevel).toBe("info");
      expect(settings.dataDir).toBe("data");
      expect(settings.logFormat).toBe("json");
      expect(settings.nodeEnv).toBe("development");
    });

    test("defaults are overridden by config file values", () => {
      const yamlContent = `
llm:
  provider: anthropic
  model: claude-sonnet-4
  maxConcurrentCalls: 10
system:
  dataDir: data
`;
      writeFileSync("config.yml", yamlContent);

      const settings = loadSettings();

      // Overridden by config file
      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.model).toBe("claude-sonnet-4");
      expect(settings.llm.maxConcurrentCalls).toBe(10);

      // Retained from defaults
      expect(settings.llm.timeout).toBe(120);
      expect(settings.agent.maxActiveTasks).toBe(5);
      expect(settings.logLevel).toBe("info");
    });
  });

  describe("loadSettings", () => {
    test("loads from config.yaml when no local config exists", () => {
      resetSettings();

      const yamlContent = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o
      apiKey: yaml-key
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai");
      expect(settings.llm.openai.model).toBe("gpt-4o");
      expect(settings.llm.openai.apiKey).toBe("yaml-key");
    });

    test("config file values override defaults via deep merge", () => {
      const baseConfig = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: config-key
      model: gpt-4o-mini
system:
  dataDir: /tmp/test
`;
      const localConfig = `
llm:
  providers:
    openai:
      model: gpt-4o
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);

      const settings = loadSettings();

      // local overrides base
      expect(settings.llm.openai.model).toBe("gpt-4o");
      // base value preserved
      expect(settings.llm.openai.apiKey).toBe("config-key");
    });

    test("loads from config.local.yaml with env var interpolation", () => {
      resetSettings();

      const yamlContent = `
llm:
  provider: anthropic
  providers:
    anthropic:
      apiKey: \${ANTHROPIC_API_KEY}
      model: claude-sonnet-4
system:
  dataDir: /tmp/test
`;

      process.env.ANTHROPIC_API_KEY = "test-yaml-key";
      writeFileSync("config.local.yaml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.anthropic.apiKey).toBe("test-yaml-key");
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
    });

    test("config.local.yaml merges with and overrides config.yaml", () => {
      resetSettings();

      // Base config
      const baseConfig = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o-mini
      apiKey: base-key
  maxConcurrentCalls: 3
  timeout: 120
agent:
  maxActiveTasks: 5
system:
  dataDir: /tmp/test
`;

      // Local config overrides some fields
      const localConfig = `
llm:
  provider: anthropic
  providers:
    anthropic:
      model: claude-sonnet-4
      apiKey: local-key
  maxConcurrentCalls: 10
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);

      const settings = loadSettings();

      // Overridden by local
      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.maxConcurrentCalls).toBe(10);
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
      expect(settings.llm.anthropic.apiKey).toBe("local-key");

      // Inherited from base (not overridden)
      expect(settings.llm.timeout).toBe(120);
      expect(settings.agent.maxActiveTasks).toBe(5);
    });

    test("deep merge preserves nested fields from both configs", () => {
      resetSettings();

      const baseConfig = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o-mini
      apiKey: base-openai-key
      baseURL: https://api.openai.com/v1
    anthropic:
      model: claude-base
      apiKey: base-anthropic-key
system:
  dataDir: /tmp/test
`;

      const localConfig = `
llm:
  providers:
    openai:
      apiKey: local-openai-key
    anthropic:
      model: claude-sonnet-4
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);

      const settings = loadSettings();

      // OpenAI: apiKey overridden, model and baseURL inherited
      expect(settings.llm.openai.apiKey).toBe("local-openai-key");
      expect(settings.llm.openai.model).toBe("gpt-4o-mini");
      expect(settings.llm.openai.baseURL).toBe("https://api.openai.com/v1");

      // Anthropic: model overridden, apiKey inherited
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
      expect(settings.llm.anthropic.apiKey).toBe("base-anthropic-key");
    });

    test("handles ollama provider alias to openai-compatible", () => {
      resetSettings();

      const config = `
llm:
  provider: ollama
  providers:
    ollama:
      apiKey: dummy
      model: llama3.2
      baseURL: http://localhost:11434/v1
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai-compatible");
      expect(settings.llm.baseURL).toBe("http://localhost:11434/v1");
    });

    test("handles lmstudio provider alias to openai-compatible", () => {
      resetSettings();

      const config = `
llm:
  provider: lmstudio
  providers:
    lmstudio:
      model: llama3
      baseURL: http://localhost:1234/v1
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai-compatible");
      expect(settings.llm.baseURL).toBe("http://localhost:1234/v1");
    });

    test("handles missing ${ENV_VAR} by replacing with empty string", () => {
      // Clear any existing env vars that might interfere
      delete process.env.MISSING_KEY;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${MISSING_KEY}
      model: gpt-4o-mini
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      // Empty string is treated as undefined by Zod optional fields
      expect(settings.llm.openai.apiKey).toBeUndefined();
    });

    test("supports ${VAR:-default} syntax for default values", () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY:-sk-default-key}
      model: \${OPENAI_MODEL:-gpt-4o-mini}
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("sk-default-key");
      expect(settings.llm.openai.model).toBe("gpt-4o-mini");
    });

    test("${VAR:-default} uses env var when set", () => {
      process.env.OPENAI_API_KEY = "env-key";
      process.env.OPENAI_MODEL = "gpt-4o";

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY:-sk-default-key}
      model: \${OPENAI_MODEL:-gpt-4o-mini}
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("env-key");
      expect(settings.llm.openai.model).toBe("gpt-4o");
    });

    test("supports ${VAR:=default} syntax to assign default", () => {
      resetSettings();
      delete process.env.TEST_VAR;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${TEST_VAR:=assigned-default}
      model: gpt-4o-mini
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("assigned-default");
      // Verify it was assigned to env
      expect(process.env.TEST_VAR).toBeDefined();
      expect(process.env.TEST_VAR!).toBe("assigned-default");
    });

    test("supports ${VAR:?error} syntax to throw error when missing", () => {
      resetSettings();
      delete process.env.REQUIRED_KEY;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${REQUIRED_KEY:?API key is required}
      model: gpt-4o-mini
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      expect(() => loadSettings()).toThrow(/REQUIRED_KEY.*required/);
    });

    test("${VAR:?error} does not throw when var is set", () => {
      resetSettings();
      process.env.REQUIRED_KEY = "valid-key";

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${REQUIRED_KEY:?API key is required}
      model: gpt-4o-mini
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("valid-key");
    });

    test("supports ${VAR:+alternate} syntax to use alternate when set", () => {
      resetSettings();
      process.env.USE_PROXY = "yes";

      const config = `
llm:
  provider: openai
  providers:
    openai:
      baseURL: \${USE_PROXY:+https://proxy.example.com/v1}
      model: gpt-4o-mini
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.baseURL).toBe("https://proxy.example.com/v1");
    });

    test("${VAR:+alternate} returns empty when var is unset", () => {
      resetSettings();
      delete process.env.USE_PROXY;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      baseURL: \${USE_PROXY:+https://proxy.example.com/v1}
      model: gpt-4o-mini
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      // Empty string becomes undefined
      expect(settings.llm.openai.baseURL).toBeUndefined();
    });

    test("loads all config sections from yaml file", () => {
      resetSettings();

      const config = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o
  maxConcurrentCalls: 10
  timeout: 180
agent:
  maxActiveTasks: 20
  maxConcurrentTools: 5
  maxCognitiveIterations: 15
  heartbeatInterval: 30
identity:
  personaPath: custom/persona.json
system:
  logLevel: warn
  dataDir: custom-data
  logFormat: line
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.maxConcurrentCalls).toBe(10);
      expect(settings.llm.timeout).toBe(180);
      expect(settings.agent.maxActiveTasks).toBe(20);
      expect(settings.agent.maxConcurrentTools).toBe(5);
      expect(settings.agent.maxCognitiveIterations).toBe(15);
      expect(settings.agent.heartbeatInterval).toBe(30);
      expect(settings.identity.personaPath).toBe("custom/persona.json");
      expect(settings.logLevel).toBe("warn");
      expect(settings.dataDir).toBe("custom-data");
      expect(settings.logFormat).toBe("line");
    });

    test("throws error when both config.yaml and config.yml exist", () => {
      writeFileSync("config.yaml", "llm:\n  provider: openai\n");
      writeFileSync("config.yml", "llm:\n  provider: anthropic\n");

      expect(() => loadSettings()).toThrow(/Multiple base config files found.*config\.yaml.*config\.yml/);
    });

    test("throws error when both config.local.yaml and config.local.yml exist", () => {
      writeFileSync("config.yaml", "llm:\n  provider: openai\n");
      writeFileSync("config.local.yaml", "llm:\n  provider: anthropic\n");
      writeFileSync("config.local.yml", "llm:\n  provider: ollama\n");

      expect(() => loadSettings()).toThrow(/Multiple local config files found.*config\.local\.yaml.*config\.local\.yml/);
    });

    test("loads config.yml when config.yaml does not exist", () => {
      resetSettings();

      const yamlContent = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o
      apiKey: yml-key
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai");
      expect(settings.llm.openai.model).toBe("gpt-4o");
      expect(settings.llm.openai.apiKey).toBe("yml-key");
    });

    test("loads config.local.yml when config.local.yaml does not exist", () => {
      resetSettings();

      writeFileSync("config.yaml", "llm:\n  provider: openai\nsystem:\n  dataDir: /tmp/test\n");

      const localContent = `
llm:
  provider: anthropic
  providers:
    anthropic:
      apiKey: local-yml-key
      model: claude-sonnet-4
`;

      writeFileSync("config.local.yml", localContent);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
      expect(settings.llm.anthropic.apiKey).toBe("local-yml-key");
    });

    test("handles logFormat from YAML env var interpolation", () => {
      resetSettings();
      delete process.env.PEGASUS_LOG_FORMAT;

      const config = `
llm:
  provider: openai
system:
  dataDir: /tmp/test
  logFormat: \${PEGASUS_LOG_FORMAT:-json}
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.logFormat).toBe("json");
    });

    test("handles logFormat override from env var", () => {
      resetSettings();
      process.env.PEGASUS_LOG_FORMAT = "line";

      const config = `
llm:
  provider: openai
system:
  dataDir: /tmp/test
  logFormat: \${PEGASUS_LOG_FORMAT:-json}
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.logFormat).toBe("line");

      delete process.env.PEGASUS_LOG_FORMAT;
    });

    test("${VAR:=default} uses env var when already set", () => {
      resetSettings();
      process.env.TEST_ASSIGN_VAR = "already-set";

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${TEST_ASSIGN_VAR:=fallback-value}
      model: gpt-4o-mini
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("already-set");
      // Env var should remain unchanged
      expect(process.env.TEST_ASSIGN_VAR).toBe("already-set");
    });

    test("interpolates env vars inside arrays", () => {
      resetSettings();
      process.env.ALLOWED_PATH = "/tmp/allowed";

      const config = `
llm:
  provider: openai
tools:
  allowedPaths:
    - \${ALLOWED_PATH}
    - /static/path
system:
  dataDir: /tmp/test
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.tools.allowedPaths).toContain("/tmp/allowed");
      expect(settings.tools.allowedPaths).toContain("/static/path");

      delete process.env.ALLOWED_PATH;
    });

    test("loads config from PEGASUS_CONFIG custom path", () => {
      resetSettings();

      const customConfigPath = join(testDir, "custom-config.yml");
      const config = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o
      apiKey: custom-key
system:
  dataDir: /tmp/test
`;

      writeFileSync(customConfigPath, config);
      process.env.PEGASUS_CONFIG = customConfigPath;

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai");
      expect(settings.llm.openai.model).toBe("gpt-4o");
      expect(settings.llm.openai.apiKey).toBe("custom-key");
    });

    test("falls back to standard config when PEGASUS_CONFIG path does not exist", () => {
      resetSettings();

      process.env.PEGASUS_CONFIG = join(testDir, "nonexistent-config.yml");

      // Provide a standard config file to fall back to
      writeFileSync("config.yml", "system:\n  dataDir: /tmp/fallback\n");

      const settings = loadSettings();

      expect(settings.dataDir).toBe("/tmp/fallback");
    });
  });
});
