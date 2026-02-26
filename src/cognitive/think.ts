/**
 * Thinker — deep understanding, reasoning, and response generation.
 *
 * For conversation tasks: calls the LLM to generate a direct response.
 * When tools are available: passes tool definitions to LLM for function calling.
 * The response text is stored in `reasoning.response` for the Actor to extract.
 */
import type { LanguageModel, Message } from "../infra/llm-types.ts";
import { generateText } from "../infra/llm-utils.ts";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import { buildSystemPrompt, formatSize } from "../identity/prompt.ts";
import type { MemoryIndexEntry } from "../identity/prompt.ts";
import type { TaskContext } from "../task/context.ts";
import type { ToolRegistry } from "../tools/registry.ts";

const logger = getLogger("cognitive.think");

export class Thinker {
  constructor(
    private model: LanguageModel,
    private persona: Persona,
    private toolRegistry?: ToolRegistry,
  ) {}

  async run(context: TaskContext, memoryIndex?: MemoryIndexEntry[]): Promise<Record<string, unknown>> {
    logger.info({ iteration: context.iteration }, "think_start");

    const system = buildSystemPrompt(this.persona, "reason");

    // Build conversation history for multi-turn support
    const messages: Message[] = context.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCallId: m.toolCallId,
      toolCalls: m.toolCalls,
    }));

    // Inject memory index as first user message (only when provided, i.e., iteration=1)
    if (memoryIndex && memoryIndex.length > 0) {
      const memoryContent = [
        "[Available memory]",
        ...memoryIndex.map((e) => `- ${e.path} (${formatSize(e.size)}): ${e.summary}`),
        "",
        "Use memory_read to load relevant files before responding.",
      ].join("\n");
      messages.unshift({ role: "user" as const, content: memoryContent });
    }

    // Add the current input if not already in messages
    if (messages.length === 0 || messages[messages.length - 1]?.content !== context.inputText) {
      messages.push({ role: "user" as const, content: context.inputText });
    }

    // Pass tools to LLM if registry is available
    const tools = this.toolRegistry?.toLLMTools();

    const { text, toolCalls } = await generateText({
      model: this.model,
      system,
      messages,
      tools: tools?.length ? tools : undefined,
      toolChoice: tools?.length ? "auto" : undefined,
    });

    const reasoning: Record<string, unknown> = {
      response: text,
      approach: toolCalls?.length ? "tool_use" : "direct",
      needsClarification: false,
    };

    if (toolCalls?.length) {
      reasoning.toolCalls = toolCalls;
    }

    logger.info({ approach: reasoning.approach }, "think_done");
    return reasoning;
  }
}
