/**
 * spawn_task tool — signals intent to launch a background task.
 *
 * The MainAgent intercepts the result and spawns the actual task
 * via the existing Task System (Agent).
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const spawn_task: Tool = {
  name: "spawn_task",
  description:
    "Launch a background task for complex operations requiring file I/O, shell commands, web search, or multi-step work",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    description: z.string().describe("What the task should accomplish"),
    input: z
      .string()
      .describe("The user's original request or detailed instructions"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { description, input } = params as {
      description: string;
      input: string;
    };

    // spawn_task doesn't execute the task — it signals intent.
    // The MainAgent intercepts this tool result and spawns the actual task.
    return {
      success: true,
      result: {
        action: "spawn_task",
        description,
        input,
        taskId: context.taskId, // placeholder, MainAgent replaces with real taskId
      },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
