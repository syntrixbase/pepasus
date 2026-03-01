/**
 * SkillLoader — scan directories and parse SKILL.md files.
 *
 * Discovers skills from:
 *   skills/       (builtin, git tracked)
 *   data/skills/  (user/LLM created, runtime)
 *
 * Each skill is a directory containing SKILL.md with YAML frontmatter + markdown body.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "node:path";
import yaml from "js-yaml";
import { getLogger } from "../infra/logger.ts";
import { errorToString } from "../infra/errors.ts";
import type { SkillDefinition, SkillFrontmatter } from "./types.ts";

const logger = getLogger("skill_loader");

const SKILL_FILE = "SKILL.md";

/** Split YAML frontmatter from markdown body. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    return { frontmatter: match[1]!, body: match[2]!.trim() };
  }
  return { frontmatter: null, body: content.trim() };
}

/** Extract first non-empty, non-heading paragraph as fallback description. */
export function extractFirstParagraph(body: string): string {
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed.slice(0, 200);
    }
  }
  return "";
}

/** Parse a SKILL.md file into a SkillDefinition. */
export function parseSkillFile(
  filePath: string,
  dirName: string,
  source: "builtin" | "user",
): SkillDefinition | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = splitFrontmatter(content);

    const fm = (frontmatter ? yaml.load(frontmatter) : {}) as SkillFrontmatter;

    const name = fm.name ?? dirName;

    // Validate name: lowercase letters, numbers, hyphens, max 64 chars
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      logger.warn({ name, filePath }, "invalid_skill_name");
      return null;
    }

    return {
      name,
      description: fm.description ?? extractFirstParagraph(body),
      disableModelInvocation: fm["disable-model-invocation"] ?? false,
      userInvocable: fm["user-invocable"] ?? true,
      allowedTools: fm["allowed-tools"]
        ? fm["allowed-tools"].split(",").map((t) => t.trim())
        : undefined,
      context: fm.context ?? "inline",
      agent: fm.agent ?? "general",
      model: fm.model,
      argumentHint: fm["argument-hint"],
      bodyPath: filePath,
      source,
    };
  } catch (err) {
    logger.warn({ filePath, error: errorToString(err) }, "skill_parse_error");
    return null;
  }
}

/** Scan a directory for skill subdirectories containing SKILL.md. */
export function scanSkillDir(
  dir: string,
  source: "builtin" | "user",
): SkillDefinition[] {
  if (!existsSync(dir)) return [];

  const skills: SkillDefinition[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, SKILL_FILE);
      if (existsSync(skillFile)) {
        const skill = parseSkillFile(skillFile, entry.name, source);
        if (skill) {
          skills.push(skill);
          logger.info({ name: skill.name, source }, "skill_discovered");
        }
      }
    }
  } catch (err) {
    logger.warn({ dir, error: errorToString(err) }, "skill_dir_scan_error");
  }
  return skills;
}

/** Load all skills from builtin and user directories. */
export function loadAllSkills(builtinDir: string, userDir: string): SkillDefinition[] {
  const builtin = scanSkillDir(builtinDir, "builtin");
  const user = scanSkillDir(userDir, "user");
  return [...builtin, ...user];
}
