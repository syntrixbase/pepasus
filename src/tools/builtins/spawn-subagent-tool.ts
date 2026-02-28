/**
 * spawn_subagent tool — signals intent to launch a background subagent.
 *
 * The MainAgent intercepts the result and spawns the actual subagent
 * via the existing Task System (Agent).
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const spawn_subagent: Tool = {
  name: "spawn_subagent",
  description:
    "Launch a background subagent for complex operations requiring file I/O, shell commands, web search, or multi-step work",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    description: z.string().describe(
      "Short label for this task (for your own reference when reviewing task list later)"
    ),
    input: z
      .string()
      .describe("Detailed instructions for the subagent — include all necessary context, requirements, and constraints"),
    type: z
      .enum(["general", "explore", "plan"])
      .default("general")
      .describe(
        "Subagent type: 'explore' for research (read-only), 'plan' for analysis/planning, 'general' for full capabilities",
      ),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { description, input, type = "general" } = params as {
      description: string;
      input: string;
      type?: string;
    };

    // spawn_subagent doesn't execute — it signals intent.
    // The MainAgent intercepts this tool result and spawns the actual subagent.
    return {
      success: true,
      result: {
        action: "spawn_subagent",
        description,
        input,
        type,
        taskId: context.taskId, // placeholder, MainAgent replaces with real taskId
      },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
