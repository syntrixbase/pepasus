/** LLM Provider — abstract base class for all LLM adapters. */
import type { Message } from "../models/message.ts";

export interface ChatOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export abstract class LLMProvider {
  abstract readonly name: string;
  abstract readonly model: string;

  abstract chat(messages: Message[], options?: ChatOptions): Promise<Message>;

  abstract chatWithTools(
    messages: Message[],
    tools: Record<string, unknown>[],
    options?: ChatOptions,
  ): Promise<Message>;
}
