/**
 * PostTaskReflector — async post-task reflection for memory learning.
 *
 * NOT part of the cognitive loop. Runs after COMPLETED state,
 * fire-and-forget. Extracts facts and episode summaries via LLM call.
 */
import type { LanguageModel } from "../infra/llm-types.ts";
import { generateText } from "../infra/llm-utils.ts";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import type { TaskContext, PostTaskReflection } from "../task/context.ts";

const logger = getLogger("cognitive.reflect");

/** Determine if a completed task is worth reflecting on. */
export function shouldReflect(context: TaskContext): boolean {
  if (context.iteration <= 1 && context.actionsDone.length <= 1) {
    const responseLen =
      typeof context.finalResult === "object" && context.finalResult !== null
        ? JSON.stringify(context.finalResult).length
        : 0;
    if (responseLen < 200) return false;
  }
  return true;
}

export class PostTaskReflector {
  constructor(
    private model: LanguageModel,
    private persona: Persona,
  ) {}

  async run(context: TaskContext): Promise<PostTaskReflection> {
    logger.info({ taskId: context.id, iteration: context.iteration }, "post_task_reflect_start");

    const emptyResult: PostTaskReflection = {
      facts: [],
      episode: null,
      assessment: "",
    };

    try {
      const prompt = this._buildPrompt(context);
      const { text } = await generateText({
        model: this.model,
        system: `You are ${this.persona.name}. Reflect on a completed task and extract learnings. Respond in JSON only.`,
        messages: [{ role: "user", content: prompt }],
      });

      const parsed = JSON.parse(text);
      const result: PostTaskReflection = {
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        episode: parsed.episode ?? null,
        assessment: typeof parsed.assessment === "string" ? parsed.assessment : "",
      };

      logger.info(
        { taskId: context.id, factsCount: result.facts.length, hasEpisode: !!result.episode },
        "post_task_reflect_done",
      );
      return result;
    } catch (err) {
      const message = err instanceof SyntaxError
        ? `Failed to parse LLM reflection output`
        : `Reflection error: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn({ taskId: context.id, error: message }, "post_task_reflect_failed");
      return { ...emptyResult, assessment: message };
    }
  }

  private _buildPrompt(context: TaskContext): string {
    const actions = context.actionsDone
      .map((a) => `- ${a.actionType}: ${a.success ? "success" : "failed"}${a.error ? ` (${a.error})` : ""}`)
      .join("\n");

    const result = typeof context.finalResult === "object" && context.finalResult !== null
      ? JSON.stringify(context.finalResult).slice(0, 500)
      : String(context.finalResult ?? "");

    return [
      `Task: ${context.inputText}`,
      `Iterations: ${context.iteration}`,
      `Actions:\n${actions || "(none)"}`,
      `Result: ${result}`,
      "",
      "Respond in JSON with this schema:",
      "{",
      '  "facts": [{"path": "facts/<name>.md", "content": "markdown content"}],',
      '  "episode": {"title": "...", "summary": "< 10 words", "details": "2-3 sentences", "lesson": "..."} | null,',
      '  "assessment": "brief assessment string"',
      "}",
      "",
      "Rules:",
      "- Only add facts if genuinely new/useful information was discovered",
      "- Episode summary must be under 10 words",
      "- Return empty facts array and null episode if nothing worth recording",
    ].join("\n");
  }
}
