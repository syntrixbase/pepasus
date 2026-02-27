/** Metadata + prompt for a discovered subagent type. */
export interface SubagentDefinition {
  name: string;           // "explore", "plan", "general"
  description: string;    // injected into MainAgent system prompt
  tools: string[];        // tool name list, ["*"] means all task tools
  prompt: string;         // system prompt body (markdown)
  source: "builtin" | "user";
}

/** Raw parsed frontmatter from SUBAGENT.md. */
export interface SubagentFrontmatter {
  name?: string;
  description?: string;
  tools?: string;
}
