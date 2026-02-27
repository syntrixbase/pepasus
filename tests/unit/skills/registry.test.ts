/**
 * Unit tests for SkillRegistry — priority resolution, metadata, body loading.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "node:path";
import { SkillRegistry } from "../../../src/skills/registry.ts";
import type { SkillDefinition } from "../../../src/skills/types.ts";

const TEST_DIR = "/tmp/pegasus-test-skill-registry";

/** Create a minimal SkillDefinition for testing (no file system needed). */
function makeSkill(overrides: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    description: `${overrides.name} description`,
    disableModelInvocation: false,
    userInvocable: true,
    context: "inline",
    agent: "general",
    bodyPath: `/tmp/nonexistent/${overrides.name}/SKILL.md`,
    source: "builtin",
    ...overrides,
  };
}

/** Write a SKILL.md file into a temp directory and return its path. */
function writeSkillFile(name: string, content: string): string {
  const dir = path.join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── registerMany ──────────────────────────────────────────────

describe("registerMany", () => {
  it("should register skills successfully", () => {
    const registry = new SkillRegistry();
    const skills = [makeSkill({ name: "alpha" }), makeSkill({ name: "beta" })];

    registry.registerMany(skills);

    expect(registry.has("alpha")).toBe(true);
    expect(registry.has("beta")).toBe(true);
    expect(registry.listAll().length).toBe(2);
  });

  it("should allow user skill to override builtin with same name", () => {
    const registry = new SkillRegistry();
    const builtin = makeSkill({ name: "deploy", source: "builtin", description: "builtin deploy" });
    const user = makeSkill({ name: "deploy", source: "user", description: "user deploy" });

    registry.registerMany([builtin]);
    registry.registerMany([user]);

    const skill = registry.get("deploy");
    expect(skill).not.toBeNull();
    expect(skill!.source).toBe("user");
    expect(skill!.description).toBe("user deploy");
  });

  it("should NOT let builtin override user with same name (user wins)", () => {
    const registry = new SkillRegistry();
    const user = makeSkill({ name: "deploy", source: "user", description: "user deploy" });
    const builtin = makeSkill({ name: "deploy", source: "builtin", description: "builtin deploy" });

    // Register user first, then builtin
    registry.registerMany([user]);
    registry.registerMany([builtin]);

    const skill = registry.get("deploy");
    expect(skill).not.toBeNull();
    expect(skill!.source).toBe("user");
    expect(skill!.description).toBe("user deploy");
  });

  it("should allow builtin to override builtin (last wins)", () => {
    const registry = new SkillRegistry();
    const first = makeSkill({ name: "tool", source: "builtin", description: "first" });
    const second = makeSkill({ name: "tool", source: "builtin", description: "second" });

    registry.registerMany([first]);
    registry.registerMany([second]);

    expect(registry.get("tool")!.description).toBe("second");
  });

  it("should register multiple skills in a single call including overrides", () => {
    const registry = new SkillRegistry();
    const builtin = makeSkill({ name: "shared", source: "builtin", description: "builtin" });
    const user = makeSkill({ name: "shared", source: "user", description: "user" });

    // Within a single registerMany, user comes after builtin → user wins
    registry.registerMany([builtin, user]);

    expect(registry.get("shared")!.source).toBe("user");
    expect(registry.get("shared")!.description).toBe("user");
  });
});

// ── get / has ─────────────────────────────────────────────────

describe("get / has", () => {
  it("should return skill when found", () => {
    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "finder" })]);

    const skill = registry.get("finder");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("finder");
  });

  it("should return null for unknown skill", () => {
    const registry = new SkillRegistry();
    expect(registry.get("nonexistent")).toBeNull();
  });

  it("should return true for existing skill", () => {
    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "exists" })]);
    expect(registry.has("exists")).toBe(true);
  });

  it("should return false for unknown skill", () => {
    const registry = new SkillRegistry();
    expect(registry.has("nope")).toBe(false);
  });
});

// ── getMetadataForPrompt ──────────────────────────────────────

describe("getMetadataForPrompt", () => {
  it("should format skills as list with descriptions", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "commit", description: "Create a git commit" }),
      makeSkill({ name: "review", description: "Review a PR" }),
    ]);

    const result = registry.getMetadataForPrompt(5000);

    expect(result).toContain("Available skills:");
    expect(result).toContain("- commit: Create a git commit");
    expect(result).toContain("- review: Review a PR");
  });

  it("should exclude skills with disableModelInvocation: true", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "visible", description: "I am visible" }),
      makeSkill({ name: "hidden", description: "I am hidden", disableModelInvocation: true }),
    ]);

    const result = registry.getMetadataForPrompt(5000);

    expect(result).toContain("- visible: I am visible");
    expect(result).not.toContain("hidden");
  });

  it("should respect budget and truncate when over", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "short", description: "A short skill" }),
      makeSkill({ name: "another-skill", description: "Another skill with a longer description that takes space" }),
    ]);

    // Budget just large enough for the header + first skill line
    // "Available skills:" = 17 chars
    // "- short: A short skill" = 22 chars
    // Total = 17 + 1 + 22 = 40
    const result = registry.getMetadataForPrompt(40);

    expect(result).toContain("- short: A short skill");
    expect(result).not.toContain("another-skill");
  });

  it("should return empty string when no skills to show", () => {
    const registry = new SkillRegistry();
    const result = registry.getMetadataForPrompt(5000);
    expect(result).toBe("");
  });

  it("should return empty string when all skills have disableModelInvocation", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "hidden1", disableModelInvocation: true }),
      makeSkill({ name: "hidden2", disableModelInvocation: true }),
    ]);

    const result = registry.getMetadataForPrompt(5000);
    expect(result).toBe("");
  });

  it("should include use_skill tool footer", () => {
    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "test-skill" })]);

    const result = registry.getMetadataForPrompt(5000);

    expect(result).toContain("Use the use_skill tool to invoke a skill when relevant.");
  });
});

// ── loadBody ──────────────────────────────────────────────────

describe("loadBody", () => {
  it("should load body from SKILL.md file", () => {
    const bodyPath = writeSkillFile("simple", `---
name: simple
description: Simple skill
---
# Simple Skill

Do the simple thing.`);

    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "simple", bodyPath })]);

    const body = registry.loadBody("simple");
    expect(body).toBe("# Simple Skill\n\nDo the simple thing.");
  });

  it("should apply $ARGUMENTS substitution", () => {
    const bodyPath = writeSkillFile("greet", `---
name: greet
---
Say hello to $ARGUMENTS.`);

    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "greet", bodyPath })]);

    const body = registry.loadBody("greet", "world");
    expect(body).toBe("Say hello to world.");
  });

  it("should apply $ARGUMENTS[0] and $ARGUMENTS[1] indexed substitution", () => {
    const bodyPath = writeSkillFile("indexed", `---
name: indexed
---
First: $ARGUMENTS[0], Second: $ARGUMENTS[1].`);

    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "indexed", bodyPath })]);

    const body = registry.loadBody("indexed", "foo bar");
    // After $ARGUMENTS[N] substitution, no bare $ARGUMENTS remains → args appended
    expect(body).toBe("First: foo, Second: bar.\n\nARGUMENTS: foo bar");
  });

  it("should apply $0, $1 shorthand substitution", () => {
    const bodyPath = writeSkillFile("shorthand", `---
name: shorthand
---
Source: $0, Target: $1.`);

    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "shorthand", bodyPath })]);

    const body = registry.loadBody("shorthand", "src dest");
    // After $N substitution, no bare $ARGUMENTS remains → args appended
    expect(body).toBe("Source: src, Target: dest.\n\nARGUMENTS: src dest");
  });

  it("should append ARGUMENTS when no $ARGUMENTS placeholder in body", () => {
    const bodyPath = writeSkillFile("no-placeholder", `---
name: no-placeholder
---
Do something useful.`);

    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "no-placeholder", bodyPath })]);

    const body = registry.loadBody("no-placeholder", "extra context");
    expect(body).toBe("Do something useful.\n\nARGUMENTS: extra context");
  });

  it("should return body without modification when no args provided", () => {
    const bodyPath = writeSkillFile("no-args", `---
name: no-args
---
Static body content with $ARGUMENTS placeholder.`);

    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "no-args", bodyPath })]);

    const body = registry.loadBody("no-args");
    expect(body).toBe("Static body content with $ARGUMENTS placeholder.");
  });

  it("should return null for unknown skill", () => {
    const registry = new SkillRegistry();
    expect(registry.loadBody("ghost")).toBeNull();
  });

  it("should return null when file cannot be read", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "broken", bodyPath: "/tmp/pegasus-nonexistent-file/SKILL.md" }),
    ]);

    const body = registry.loadBody("broken");
    expect(body).toBeNull();
  });

  it("should handle multiple $ARGUMENTS occurrences in body", () => {
    const bodyPath = writeSkillFile("multi-args", `---
name: multi-args
---
First use: $ARGUMENTS. Second use: $ARGUMENTS.`);

    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "multi-args", bodyPath })]);

    const body = registry.loadBody("multi-args", "hello");
    expect(body).toBe("First use: hello. Second use: hello.");
  });

  it("should not confuse $1 with $10", () => {
    const bodyPath = writeSkillFile("no-confuse", `---
name: no-confuse
---
Value: $1, Not ten: $10.`);

    const registry = new SkillRegistry();
    registry.registerMany([makeSkill({ name: "no-confuse", bodyPath })]);

    // Only 2 args: $0=a, $1=b — $10 should not be matched by $1
    const body = registry.loadBody("no-confuse", "a b");
    expect(body).toBe("Value: b, Not ten: $10.\n\nARGUMENTS: a b");
  });
});

// ── listUserInvocable ─────────────────────────────────────────

describe("listUserInvocable", () => {
  it("should return only user-invocable skills", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "invocable", userInvocable: true }),
      makeSkill({ name: "internal", userInvocable: false }),
      makeSkill({ name: "also-invocable", userInvocable: true }),
    ]);

    const result = registry.listUserInvocable();
    const names = result.map((s) => s.name).sort();

    expect(names).toEqual(["also-invocable", "invocable"]);
  });

  it("should return empty array when no user-invocable skills", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "hidden1", userInvocable: false }),
      makeSkill({ name: "hidden2", userInvocable: false }),
    ]);

    expect(registry.listUserInvocable()).toEqual([]);
  });

  it("should return empty array for empty registry", () => {
    const registry = new SkillRegistry();
    expect(registry.listUserInvocable()).toEqual([]);
  });
});

// ── listAll ───────────────────────────────────────────────────

describe("listAll", () => {
  it("should return all registered skills", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "one" }),
      makeSkill({ name: "two" }),
      makeSkill({ name: "three" }),
    ]);

    const all = registry.listAll();
    expect(all.length).toBe(3);

    const names = all.map((s) => s.name).sort();
    expect(names).toEqual(["one", "three", "two"]);
  });

  it("should return empty array for empty registry", () => {
    const registry = new SkillRegistry();
    expect(registry.listAll()).toEqual([]);
  });

  it("should include both user-invocable and non-invocable skills", () => {
    const registry = new SkillRegistry();
    registry.registerMany([
      makeSkill({ name: "invocable", userInvocable: true }),
      makeSkill({ name: "internal", userInvocable: false }),
    ]);

    const all = registry.listAll();
    expect(all.length).toBe(2);
  });
});
