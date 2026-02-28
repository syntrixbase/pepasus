/**
 * Subagent system — file-based subagent type definitions.
 */
export { SubagentRegistry } from "./registry.ts";
export { loadAllSubagents, parseSubagentFile, scanSubagentDir } from "./loader.ts";
export type { SubagentDefinition, SubagentFrontmatter } from "./types.ts";
