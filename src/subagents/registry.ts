/**
 * SubagentRegistry — manage discovered subagent type definitions.
 *
 * Handles priority resolution (user > builtin), metadata listing
 * for system prompt injection, and tool/prompt resolution.
 */
import { getLogger } from "../infra/logger.ts";
import type { SubagentDefinition } from "./types.ts";
import { allTaskTools } from "../tools/builtins/index.ts";

const logger = getLogger("subagent_registry");

export class SubagentRegistry {
  private defs = new Map<string, SubagentDefinition>();

  /** Register subagents with priority resolution. User overrides builtin. */
  registerMany(defs: SubagentDefinition[]): void {
    for (const def of defs) {
      const existing = this.defs.get(def.name);
      if (existing && existing.source === "user" && def.source === "builtin") {
        continue; // keep user version
      }
      this.defs.set(def.name, def);
      if (existing) {
        logger.info({ name: def.name, source: def.source }, "subagent_override");
      }
    }
  }

  /** Get subagent definition by name. Returns null if not found. */
  get(name: string): SubagentDefinition | null {
    return this.defs.get(name) ?? null;
  }

  /** Check if a subagent type exists. */
  has(name: string): boolean {
    return this.defs.has(name);
  }

  /**
   * Get resolved tool names for a subagent type.
   * "*" expands to all task tool names.
   * Falls back to "*" (all tools) for unknown types.
   */
  getToolNames(name: string): string[] {
    const def = this.defs.get(name);
    const tools = def?.tools ?? ["*"];
    if (tools.length === 1 && tools[0] === "*") {
      return allTaskTools.map((t) => t.name);
    }
    return tools;
  }

  /**
   * Get the system prompt body for a subagent type.
   * Returns empty string for unknown types (base persona prompt only).
   */
  getPrompt(name: string): string {
    return this.defs.get(name)?.prompt ?? "";
  }

  /**
   * Get the model field for a subagent type.
   * Returns undefined if the subagent has no model declared or is unknown.
   * Value can be a tier name ("fast") or a model spec ("openai/gpt-4o").
   */
  getModel(name: string): string | undefined {
    return this.defs.get(name)?.model;
  }

  /**
   * Generate subagent metadata for MainAgent system prompt.
   * Lists available subagent types with their descriptions.
   */
  getMetadataForPrompt(): string {
    const lines: string[] = [
      "## Available Subagent Types",
      "",
      "When calling spawn_subagent(), choose the right type:",
      "",
    ];

    for (const def of this.defs.values()) {
      lines.push(`- **${def.name}**: ${def.description}`);
    }

    return lines.join("\n");
  }

  /** List all registered subagent definitions. */
  listAll(): SubagentDefinition[] {
    return [...this.defs.values()];
  }
}
