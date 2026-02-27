/**
 * Unit tests for SkillLoader — SKILL.md parsing and directory scanning.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "node:path";
import {
  splitFrontmatter,
  extractFirstParagraph,
  parseSkillFile,
  scanSkillDir,
  loadAllSkills,
} from "../../../src/skills/loader.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = `/tmp/pegasus-test-skill-loader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function writeSkillFile(dir: string, skillName: string, content: string): string {
  const skillDir = path.join(dir, skillName);
  mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── splitFrontmatter ──────────────────────────────────────────

describe("splitFrontmatter", () => {
  it("should split valid frontmatter from body", () => {
    const content = `---
name: my-skill
description: A test skill
---
# Body

Some instructions here.`;

    const result = splitFrontmatter(content);
    expect(result.frontmatter).toBe("name: my-skill\ndescription: A test skill");
    expect(result.body).toBe("# Body\n\nSome instructions here.");
  });

  it("should return null frontmatter when no --- markers", () => {
    const content = "Just plain markdown content.\n\nNo frontmatter here.";
    const result = splitFrontmatter(content);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe("Just plain markdown content.\n\nNo frontmatter here.");
  });

  it("should handle empty content", () => {
    const result = splitFrontmatter("");
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe("");
  });

  it("should handle frontmatter with empty body", () => {
    const content = `---
name: empty-body
---
`;
    const result = splitFrontmatter(content);
    expect(result.frontmatter).toBe("name: empty-body");
    expect(result.body).toBe("");
  });
});

// ── extractFirstParagraph ─────────────────────────────────────

describe("extractFirstParagraph", () => {
  it("should return first non-heading line", () => {
    const body = "# Heading\nThis is the first paragraph.\nMore text.";
    expect(extractFirstParagraph(body)).toBe("This is the first paragraph.");
  });

  it("should skip heading lines starting with #", () => {
    const body = "# Title\n## Subtitle\n### Section\nActual content here.";
    expect(extractFirstParagraph(body)).toBe("Actual content here.");
  });

  it("should return empty string for empty body", () => {
    expect(extractFirstParagraph("")).toBe("");
  });

  it("should return empty string for body with only headings", () => {
    expect(extractFirstParagraph("# Heading\n## Another")).toBe("");
  });

  it("should truncate to 200 chars", () => {
    const longLine = "A".repeat(300);
    expect(extractFirstParagraph(longLine)).toBe("A".repeat(200));
  });

  it("should skip empty lines", () => {
    const body = "\n\n\nFirst real line.";
    expect(extractFirstParagraph(body)).toBe("First real line.");
  });
});

// ── parseSkillFile ────────────────────────────────────────────

describe("parseSkillFile", () => {
  it("should parse valid SKILL.md with all frontmatter fields", () => {
    const dir = makeTmpDir();
    const content = `---
name: code-review
description: Review code changes
disable-model-invocation: true
user-invocable: false
allowed-tools: read_file, write_file
context: fork
agent: reviewer
model: gpt-4o
argument-hint: <pr-url>
---
# Code Review

Analyze the PR and provide feedback.`;

    const filePath = writeSkillFile(dir, "code-review", content);
    const skill = parseSkillFile(filePath, "code-review", "builtin");

    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("code-review");
    expect(skill!.description).toBe("Review code changes");
    expect(skill!.disableModelInvocation).toBe(true);
    expect(skill!.userInvocable).toBe(false);
    expect(skill!.allowedTools).toEqual(["read_file", "write_file"]);
    expect(skill!.context).toBe("fork");
    expect(skill!.agent).toBe("reviewer");
    expect(skill!.model).toBe("gpt-4o");
    expect(skill!.argumentHint).toBe("<pr-url>");
    expect(skill!.bodyPath).toBe(filePath);
    expect(skill!.source).toBe("builtin");
  });

  it("should use defaults when frontmatter is missing", () => {
    const dir = makeTmpDir();
    const content = "Just a plain skill with no frontmatter.\n\nSome instructions.";
    const filePath = writeSkillFile(dir, "simple-skill", content);
    const skill = parseSkillFile(filePath, "simple-skill", "user");

    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("simple-skill");
    expect(skill!.description).toBe("Just a plain skill with no frontmatter.");
    expect(skill!.disableModelInvocation).toBe(false);
    expect(skill!.userInvocable).toBe(true);
    expect(skill!.allowedTools).toBeUndefined();
    expect(skill!.context).toBe("inline");
    expect(skill!.agent).toBe("general");
    expect(skill!.model).toBeUndefined();
    expect(skill!.source).toBe("user");
  });

  it("should use directory name when name not in frontmatter", () => {
    const dir = makeTmpDir();
    const content = `---
description: No name field here
---
Body content.`;

    const filePath = writeSkillFile(dir, "my-tool", content);
    const skill = parseSkillFile(filePath, "my-tool", "builtin");

    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("my-tool");
  });

  it("should return null for invalid skill name with uppercase", () => {
    const dir = makeTmpDir();
    const content = `---
name: InvalidName
---
Body.`;

    const filePath = writeSkillFile(dir, "InvalidName", content);
    const skill = parseSkillFile(filePath, "InvalidName", "builtin");

    expect(skill).toBeNull();
  });

  it("should return null for invalid skill name with spaces", () => {
    const dir = makeTmpDir();
    const content = `---
name: has spaces
---
Body.`;

    const filePath = writeSkillFile(dir, "has-spaces", content);
    const skill = parseSkillFile(filePath, "has-spaces", "builtin");

    expect(skill).toBeNull();
  });

  it("should return null for name starting with hyphen", () => {
    const dir = makeTmpDir();
    const content = `---
name: -starts-with-hyphen
---
Body.`;

    const filePath = writeSkillFile(dir, "bad-name", content);
    const skill = parseSkillFile(filePath, "bad-name", "builtin");

    expect(skill).toBeNull();
  });

  it("should extract first paragraph as fallback description", () => {
    const dir = makeTmpDir();
    const content = `---
context: inline
---
# My Skill

This is the fallback description from the body.

More details here.`;

    const filePath = writeSkillFile(dir, "fallback-desc", content);
    const skill = parseSkillFile(filePath, "fallback-desc", "builtin");

    expect(skill).not.toBeNull();
    expect(skill!.description).toBe("This is the fallback description from the body.");
  });

  it("should return null for non-existent file", () => {
    const skill = parseSkillFile("/tmp/does-not-exist/SKILL.md", "ghost", "builtin");
    expect(skill).toBeNull();
  });
});

// ── scanSkillDir ──────────────────────────────────────────────

describe("scanSkillDir", () => {
  it("should discover multiple skills in a directory", () => {
    const dir = makeTmpDir();
    writeSkillFile(dir, "skill-a", `---
name: skill-a
description: First skill
---
Body A.`);
    writeSkillFile(dir, "skill-b", `---
name: skill-b
description: Second skill
---
Body B.`);

    const skills = scanSkillDir(dir, "builtin");
    expect(skills.length).toBe(2);

    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["skill-a", "skill-b"]);
  });

  it("should return empty array for non-existent directory", () => {
    const skills = scanSkillDir("/tmp/pegasus-nonexistent-dir-xyz", "builtin");
    expect(skills).toEqual([]);
  });

  it("should skip non-directory entries", () => {
    const dir = makeTmpDir();
    // Create a valid skill
    writeSkillFile(dir, "valid-skill", `---
name: valid-skill
---
Content.`);
    // Create a plain file (not a directory) in the scan root
    writeFileSync(path.join(dir, "not-a-dir.txt"), "just a file");

    const skills = scanSkillDir(dir, "builtin");
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("valid-skill");
  });

  it("should skip directories without SKILL.md", () => {
    const dir = makeTmpDir();
    // Directory with SKILL.md
    writeSkillFile(dir, "with-skill", `---
name: with-skill
---
Has a SKILL.md.`);
    // Directory without SKILL.md
    mkdirSync(path.join(dir, "empty-dir"), { recursive: true });

    const skills = scanSkillDir(dir, "user");
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("with-skill");
  });

  it("should skip skills with invalid names", () => {
    const dir = makeTmpDir();
    writeSkillFile(dir, "good-skill", `---
name: good-skill
---
Valid.`);
    writeSkillFile(dir, "BadSkill", `---
name: BadSkill
---
Invalid uppercase name.`);

    const skills = scanSkillDir(dir, "builtin");
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("good-skill");
  });
});

// ── loadAllSkills ─────────────────────────────────────────────

describe("loadAllSkills", () => {
  it("should combine skills from both directories", () => {
    const builtinDir = makeTmpDir();
    const userDir = makeTmpDir();

    writeSkillFile(builtinDir, "builtin-skill", `---
name: builtin-skill
description: A builtin skill
---
Builtin body.`);

    writeSkillFile(userDir, "user-skill", `---
name: user-skill
description: A user skill
---
User body.`);

    const skills = loadAllSkills(builtinDir, userDir);
    expect(skills.length).toBe(2);

    const builtin = skills.find((s) => s.name === "builtin-skill");
    const user = skills.find((s) => s.name === "user-skill");

    expect(builtin).toBeDefined();
    expect(builtin!.source).toBe("builtin");

    expect(user).toBeDefined();
    expect(user!.source).toBe("user");
  });

  it("should return empty array when both directories do not exist", () => {
    const skills = loadAllSkills(
      "/tmp/pegasus-no-builtin-xyz",
      "/tmp/pegasus-no-user-xyz",
    );
    expect(skills).toEqual([]);
  });

  it("should work when only one directory exists", () => {
    const builtinDir = makeTmpDir();
    writeSkillFile(builtinDir, "only-builtin", `---
name: only-builtin
---
Content.`);

    const skills = loadAllSkills(builtinDir, "/tmp/pegasus-no-user-xyz");
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("only-builtin");
    expect(skills[0]!.source).toBe("builtin");
  });
});
