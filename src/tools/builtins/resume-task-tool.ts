/**
 * resume_task tool — signals intent to resume a completed task with new instructions.
 *
 * The MainAgent intercepts the result and calls Agent.resume()
 * to continue the task with its full conversation history.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const resume_task: Tool = {
  name: "resume_task",
  description:
    "Resume a previously completed task with new instructions. " +
    "The task continues with its full conversation history.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    task_id: z.string().describe("ID of the completed task to resume"),
    input: z.string().describe("New instructions for the task"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { task_id, input } = params as {
      task_id: string;
      input: string;
    };

    // resume_task doesn't execute the resume — it signals intent.
    // The MainAgent intercepts this tool result and calls Agent.resume().
    return {
      success: true,
      result: {
        action: "resume_task",
        task_id,
        input,
      },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
