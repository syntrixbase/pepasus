/**
 * PostTaskReflector — async post-task reflection for memory learning.
 *
 * NOT part of the cognitive loop. Runs after COMPLETED state,
 * fire-and-forget. Uses a tool-use loop with memory tools to let the LLM
 * decide what to remember and write it directly.
 */
import type { LanguageModel, Message } from "../infra/llm-types.ts";
import { generateText } from "../infra/llm-utils.ts";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import type { TaskContext, PostTaskReflection } from "../task/context.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolExecutor } from "../tools/executor.ts";

const logger = getLogger("cognitive.reflect");

const MAX_REFLECTION_ROUNDS = 5;

/** Determine if a completed task is worth reflecting on. */
export function shouldReflect(context: TaskContext): boolean {
  // Skip: zero tool calls with single iteration (pure conversation, no work done)
  if (context.iteration <= 1 && context.actionsDone.length === 0) {
    return false;
  }

  // Skip: trivial tasks (single iteration, few actions, short result)
  if (context.iteration <= 1 && context.actionsDone.length <= 1) {
    const responseLen =
      typeof context.finalResult === "object" && context.finalResult !== null
        ? JSON.stringify(context.finalResult).length
        : 0;
    if (responseLen < 500) return false;
  }

  return true;
}

export interface ReflectionDeps {
  model: LanguageModel;
  persona: Persona;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  memoryDir: string;
  contextWindowSize: number;
}

export class PostTaskReflector {
  constructor(private deps: ReflectionDeps) {}

  async run(
    context: TaskContext,
    existingFacts: Array<{ path: string; content: string }>,
    episodeIndex: Array<{ path: string; summary: string }>,
  ): Promise<PostTaskReflection> {
    logger.info({ taskId: context.id, iteration: context.iteration }, "post_task_reflect_start");

    const system = this._buildSystemPrompt(existingFacts, episodeIndex);
    const messages = this._buildMessages(context);

    // Truncate messages to fit within 60% of context window
    // Rough estimate: 1 token ≈ 4 chars
    const maxChars = Math.floor(this.deps.contextWindowSize * 0.6 * 4);
    const systemChars = system.length;
    let messagesChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    while (messagesChars + systemChars > maxChars && messages.length > 1) {
      messages.shift();
      messagesChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    }

    const tools = this.deps.toolRegistry.toLLMTools();
    let totalToolCalls = 0;

    for (let round = 0; round < MAX_REFLECTION_ROUNDS; round++) {
      const { text, toolCalls } = await generateText({
        model: this.deps.model,
        system,
        messages,
        tools: tools.length ? tools : undefined,
        toolChoice: tools.length ? "auto" : undefined,
      });

      if (!toolCalls?.length) {
        logger.info({ taskId: context.id, toolCalls: totalToolCalls }, "post_task_reflect_done");
        return { assessment: text, toolCallsCount: totalToolCalls };
      }

      messages.push({ role: "assistant", content: text, toolCalls });

      for (const tc of toolCalls) {
        totalToolCalls++;
        const result = await this.deps.toolExecutor.execute(
          tc.name,
          tc.arguments,
          { taskId: context.id, memoryDir: this.deps.memoryDir },
        );
        messages.push({
          role: "tool",
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
          toolCallId: tc.id,
        });
      }
    }

    logger.warn({ taskId: context.id }, "post_task_reflect_max_rounds");
    return { assessment: "Max reflection rounds reached", toolCallsCount: totalToolCalls };
  }

  private _buildSystemPrompt(
    existingFacts: Array<{ path: string; content: string }>,
    episodeIndex: Array<{ path: string; summary: string }>,
  ): string {
    const { persona } = this.deps;
    const sections: string[] = [
      // Persona identity — aligns reflector judgment with agent character
      `You are ${persona.name}, ${persona.role}.`,
      `Personality: ${persona.personality.join(", ")}.`,
      `Values: ${persona.values.join(", ")}.`,
      "",
      "You are reviewing a completed task to decide what to remember long-term.",
      "You have memory tools: memory_read, memory_write, memory_patch, memory_append.",
      "",
      "## Goal",
      "",
      "Decide what is worth remembering. If nothing, just respond with a brief",
      "assessment — do NOT force writes.",
      "",
      "## Fact Files (facts/) — only two allowed files",
      "",
      "You may ONLY write to these two fact files:",
      "- facts/user.md — About the user: identity, preferences, social relationships,",
      "  important dates (birthdays, anniversaries), recurring habits (weekly meetings)",
      "- facts/memory.md — About experience: insights learned from interactions,",
      "  patterns discovered, non-obvious knowledge accumulated over time",
      "",
      "Do NOT create any other fact files. Only user.md and memory.md are allowed.",
      "",
      "Use memory_write to create or update fact files.",
      "Fact files are REPLACED entirely on write. To update an existing file:",
      "read it first with memory_read, merge your additions, write back COMPLETE content.",
      "Use memory_patch for small changes to existing files.",
      "",
      "Total facts budget: 15KB across all fact files. Be concise.",
      "",
      "File format:",
      "  # <Title>",
      "  > Summary: <ultra-concise, under 10 words>",
      "  - Key: value",
      "",
      "## Episodes (episodes/YYYY-MM.md) — experience summaries",
      "",
      "Use memory_append to add entries. Pass updated summary parameter to keep",
      "the file-level > Summary: line current.",
      "",
      "Entry format:",
      "  ## <Title>",
      "  - Summary: <under 10 words>",
      "  - Date: YYYY-MM-DD",
      "  - Details: <2-3 sentences>",
      "  - Lesson: <what was learned>",
      "",
      "## Worth Recording",
      "- User-stated personal information (name, preferences, work patterns)",
      "- User's social relationships (colleagues, family, teams)",
      "- Important dates and recurring events (birthdays, meetings, deadlines)",
      "- Lessons learned from completing tasks (what worked, what didn't)",
      "- User-specific preferences discovered through interaction",
      "- Non-obvious patterns (e.g., user always asks for options before deciding)",
      "",
      "## NOT Worth Recording",
      "- Information that can be re-retrieved (web results, API responses)",
      "- Generic knowledge the LLM already has",
      "- Routine operations with no new insight",
      "- Trivial Q&A with no lasting value",
      "- Duplicates of information already in existing facts",
    ];

    if (existingFacts.length > 0) {
      sections.push("", "## Existing Facts (full content)");
      for (const fact of existingFacts) {
        sections.push("", `### ${fact.path}`, fact.content);
      }
    }

    if (episodeIndex.length > 0) {
      sections.push("", "## Recent Episodes (summaries only)");
      for (const ep of episodeIndex) {
        sections.push(`- ${ep.path}: ${ep.summary}`);
      }
    }

    return sections.join("\n");
  }

  private _buildMessages(context: TaskContext): Message[] {
    const taskDescription = `[Task completed]\nInput: ${context.inputText}\nIterations: ${context.iteration}`;
    const messages: Message[] = [
      { role: "user" as const, content: taskDescription },
    ];

    for (const m of context.messages) {
      messages.push({
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId,
        toolCalls: m.toolCalls,
      });
    }

    return messages;
  }
}
