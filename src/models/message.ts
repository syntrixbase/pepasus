/** Message model for LLM conversations. */

export const Role = {
  SYSTEM: "system",
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export interface Message {
  role: Role;
  content: string;
  name?: string;
  toolCalls?: Record<string, unknown>[];
  toolCallId?: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

export function createMessage(
  role: Role,
  content: string,
  opts?: {
    name?: string;
    toolCalls?: Record<string, unknown>[];
    toolCallId?: string;
    metadata?: Record<string, unknown>;
  },
): Message {
  return {
    role,
    content,
    name: opts?.name,
    toolCalls: opts?.toolCalls,
    toolCallId: opts?.toolCallId,
    timestamp: Date.now(),
    metadata: opts?.metadata ?? {},
  };
}
