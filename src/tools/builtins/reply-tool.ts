/**
 * reply tool — signals intent to send a message to the user.
 *
 * The MainAgent intercepts the result and delivers it to the
 * appropriate channel. This is the ONLY way for the agent to
 * produce user-visible output; all other text is inner monologue.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

export const reply: Tool = {
  name: "reply",
  description:
    "Speak to the user. This is the ONLY way to produce user-visible output. Your text output is inner monologue — use this tool when you want the user to hear you.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    text: z.string().describe("What to say to the user"),
    channelId: z
      .string()
      .describe("Which channel to send to (e.g. 'main' for CLI)"),
    replyTo: z
      .string()
      .optional()
      .describe("Thread/conversation ID within the channel"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { text, channelId, replyTo } = params as {
      text: string;
      channelId: string;
      replyTo?: string;
    };

    // reply doesn't deliver the message — it signals intent.
    // The MainAgent intercepts this tool result and routes to the channel.
    return {
      success: true,
      result: { action: "reply", text, channelId, replyTo },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  },
};
