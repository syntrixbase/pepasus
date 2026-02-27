/** Metadata + body reference for a discovered skill. */
export interface SkillDefinition {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  allowedTools?: string[];
  context: "inline" | "fork";
  agent: string;
  model?: string;
  argumentHint?: string;
  bodyPath: string;
  source: "builtin" | "user";
}

/** Raw parsed frontmatter from SKILL.md. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  "user-invocable"?: boolean;
  "allowed-tools"?: string;
  context?: "inline" | "fork";
  agent?: string;
  model?: string;
  "argument-hint"?: string;
}
