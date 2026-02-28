import { describe, expect, test } from "bun:test";
import { TaskType, DEFAULT_TASK_TYPE } from "@pegasus/task/task-type.ts";
import { createTaskContext } from "@pegasus/task/context.ts";
import { SubagentRegistry } from "@pegasus/subagents/registry.ts";
import { parseSubagentFile, scanSubagentDir, loadAllSubagents } from "@pegasus/subagents/loader.ts";
import type { SubagentDefinition } from "@pegasus/subagents/types.ts";
import { allTaskTools } from "@pegasus/tools/builtins/index.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("TaskType enum", () => {
  test("has correct string values", () => {
    expect(TaskType.GENERAL).toBe("general" as TaskType);
    expect(TaskType.EXPLORE).toBe("explore" as TaskType);
    expect(TaskType.PLAN).toBe("plan" as TaskType);
  });

  test("DEFAULT_TASK_TYPE is general", () => {
    expect(DEFAULT_TASK_TYPE).toBe(TaskType.GENERAL);
  });
});

describe("TaskContext taskType", () => {
  test("createTaskContext defaults taskType to general", () => {
    const ctx = createTaskContext();
    expect(ctx.taskType).toBe("general");
  });

  test("createTaskContext accepts custom taskType", () => {
    const ctx = createTaskContext({ taskType: "explore" });
    expect(ctx.taskType).toBe("explore");
  });

  test("createTaskContext defaults description to empty string", () => {
    const ctx = createTaskContext();
    expect(ctx.description).toBe("");
  });

  test("createTaskContext accepts custom description", () => {
    const ctx = createTaskContext({ description: "Search for weather data" });
    expect(ctx.description).toBe("Search for weather data");
  });
});

// ── SubagentLoader tests ──

const testDir = "/tmp/pegasus-test-subagents";

function cleanup() {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe("SubagentLoader", () => {
  test("parseSubagentFile parses valid SUBAGENT.md", () => {
    cleanup();
    const dir = join(testDir, "explore");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      "name: explore",
      'description: "Research agent"',
      "tools: \"read_file, web_search, notify\"",
      "---",
      "",
      "## Your Role",
      "You are a research assistant.",
    ].join("\n"));

    const def = parseSubagentFile(join(dir, "SUBAGENT.md"), "explore", "builtin");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("explore");
    expect(def!.description).toBe("Research agent");
    expect(def!.tools).toEqual(["read_file", "web_search", "notify"]);
    expect(def!.prompt).toContain("research assistant");
    expect(def!.source).toBe("builtin");
    cleanup();
  });

  test("parseSubagentFile handles tools: * for all tools", () => {
    cleanup();
    const dir = join(testDir, "general");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      "name: general",
      'description: "Full access"',
      'tools: "*"',
      "---",
      "General agent.",
    ].join("\n"));

    const def = parseSubagentFile(join(dir, "SUBAGENT.md"), "general", "builtin");
    expect(def!.tools).toEqual(["*"]);
    cleanup();
  });

  test("parseSubagentFile uses dir name when name not in frontmatter", () => {
    cleanup();
    const dir = join(testDir, "myagent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      'description: "Custom agent"',
      'tools: "*"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseSubagentFile(join(dir, "SUBAGENT.md"), "myagent", "user");
    expect(def!.name).toBe("myagent");
    expect(def!.source).toBe("user");
    cleanup();
  });

  test("parseSubagentFile rejects invalid name", () => {
    cleanup();
    const dir = join(testDir, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      "name: Invalid Name!",
      'description: "Bad"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseSubagentFile(join(dir, "SUBAGENT.md"), "bad", "builtin");
    expect(def).toBeNull();
    cleanup();
  });

  test("parseSubagentFile handles missing frontmatter", () => {
    cleanup();
    const dir = join(testDir, "nofm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), "Just a body without frontmatter.");

    const def = parseSubagentFile(join(dir, "SUBAGENT.md"), "nofm", "builtin");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("nofm");
    expect(def!.prompt).toBe("Just a body without frontmatter.");
    expect(def!.tools).toEqual(["*"]);
    cleanup();
  });

  test("parseSubagentFile warns on missing description", () => {
    cleanup();
    const dir = join(testDir, "nodesc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SUBAGENT.md"), [
      "---",
      "name: nodesc",
      'tools: "*"',
      "---",
      "Body.",
    ].join("\n"));

    const def = parseSubagentFile(join(dir, "SUBAGENT.md"), "nodesc", "builtin");
    expect(def).not.toBeNull();
    expect(def!.description).toBe("");
    cleanup();
  });

  test("parseSubagentFile returns null for unreadable file", () => {
    const def = parseSubagentFile("/tmp/nonexistent-file.md", "ghost", "builtin");
    expect(def).toBeNull();
  });

  test("scanSubagentDir discovers all subagent directories", () => {
    cleanup();
    for (const name of ["alpha", "beta"]) {
      const dir = join(testDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SUBAGENT.md"), [
        "---",
        `name: ${name}`,
        `description: "${name} agent"`,
        'tools: "*"',
        "---",
        `${name} body.`,
      ].join("\n"));
    }

    const defs = scanSubagentDir(testDir, "builtin");
    expect(defs.length).toBe(2);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    cleanup();
  });

  test("scanSubagentDir returns empty for non-existent directory", () => {
    const defs = scanSubagentDir("/tmp/nonexistent-subagent-dir", "builtin");
    expect(defs).toEqual([]);
  });

  test("loadAllSubagents merges builtin and user", () => {
    cleanup();
    const builtinDir = join(testDir, "builtin");
    const userDir = join(testDir, "user");
    mkdirSync(join(builtinDir, "explore"), { recursive: true });
    mkdirSync(join(userDir, "custom"), { recursive: true });
    writeFileSync(join(builtinDir, "explore", "SUBAGENT.md"), "---\nname: explore\ndescription: builtin\ntools: \"*\"\n---\nBody.");
    writeFileSync(join(userDir, "custom", "SUBAGENT.md"), "---\nname: custom\ndescription: user\ntools: \"*\"\n---\nBody.");

    const defs = loadAllSubagents(builtinDir, userDir);
    expect(defs.length).toBe(2);
    cleanup();
  });

  test("loads builtin subagent files from project", () => {
    const defs = scanSubagentDir(join(process.cwd(), "subagents"), "builtin");
    expect(defs.length).toBeGreaterThanOrEqual(3);
    const names = defs.map((d) => d.name).sort();
    expect(names).toContain("general");
    expect(names).toContain("explore");
    expect(names).toContain("plan");
  });
});

// ── SubagentRegistry tests ──

describe("SubagentRegistry", () => {
  function makeDef(name: string, tools: string[] = ["*"], source: "builtin" | "user" = "builtin"): SubagentDefinition {
    return { name, description: `${name} agent`, tools, prompt: `${name} prompt`, source };
  }

  test("registerMany and get", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore", ["read_file", "notify"])]);
    expect(reg.get("general")).not.toBeNull();
    expect(reg.get("explore")).not.toBeNull();
    expect(reg.get("unknown")).toBeNull();
  });

  test("user overrides builtin", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file"], "builtin"),
      makeDef("explore", ["read_file", "web_search"], "user"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("builtin does not override user", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file", "web_search"], "user"),
      makeDef("explore", ["read_file"], "builtin"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("later builtin overrides earlier builtin", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([
      makeDef("explore", ["read_file"], "builtin"),
    ]);
    reg.registerMany([
      makeDef("explore", ["read_file", "web_search"], "builtin"),
    ]);
    expect(reg.get("explore")!.tools).toEqual(["read_file", "web_search"]);
  });

  test("getToolNames resolves * to all task tools", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([makeDef("general")]);
    const names = reg.getToolNames("general");
    expect(names.length).toBe(allTaskTools.length);
    expect(names).toContain("read_file");
    expect(names).toContain("notify");
  });

  test("getToolNames returns explicit tool list", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([makeDef("explore", ["read_file", "web_search", "notify"])]);
    expect(reg.getToolNames("explore")).toEqual(["read_file", "web_search", "notify"]);
  });

  test("getToolNames falls back to * for unknown type", () => {
    const reg = new SubagentRegistry();
    const names = reg.getToolNames("unknown");
    expect(names.length).toBe(allTaskTools.length);
  });

  test("getPrompt returns prompt body", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([makeDef("explore")]);
    expect(reg.getPrompt("explore")).toBe("explore prompt");
  });

  test("getPrompt returns empty string for unknown type", () => {
    const reg = new SubagentRegistry();
    expect(reg.getPrompt("unknown")).toBe("");
  });

  test("getMetadataForPrompt generates subagent listing", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore")]);
    const metadata = reg.getMetadataForPrompt();
    expect(metadata).toContain("general");
    expect(metadata).toContain("explore");
    expect(metadata).toContain("spawn_subagent");
  });

  test("has returns true for registered types", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([makeDef("explore")]);
    expect(reg.has("explore")).toBe(true);
    expect(reg.has("unknown")).toBe(false);
  });

  test("listAll returns all definitions", () => {
    const reg = new SubagentRegistry();
    reg.registerMany([makeDef("general"), makeDef("explore"), makeDef("plan")]);
    expect(reg.listAll().length).toBe(3);
  });
});
