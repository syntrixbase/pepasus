/**
 * notify tool — Task Agent → MainAgent communication channel.
 *
 * Allows a running task to send messages back to the MainAgent:
 * progress updates, interim results, clarification requests, warnings, etc.
 *
 * Signal tool: Agent intercepts the result, emits TASK_NOTIFY event,
 * and calls notifyCallback so MainAgent receives the message.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const notify: Tool = {
  name: "notify",
  description:
    "Send a message to the main agent. Use for progress updates, interim results, or clarification requests during long-running tasks.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    message: z
      .string()
      .describe("Message to send to the main agent"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { message } = params as { message: string };

    // Signal tool: Agent intercepts this result and routes to MainAgent
    return {
      success: true,
      result: { action: "notify", message, taskId: context.taskId },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
