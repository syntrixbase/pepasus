/**
 * Reflector — evaluate results, extract lessons, decide next action.
 *
 * For conversation tasks: returns "complete" verdict.
 * After tool_call execution: returns "continue" to trigger another LLM round.
 * Complex reflection with LLM evaluation will be added in M4.
 */
import type { LanguageModel } from "../infra/llm-types.ts";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import type { TaskContext, Reflection } from "../task/context.ts";

const logger = getLogger("cognitive.reflect");

export class Reflector {
  readonly model: LanguageModel;
  readonly persona: Persona;

  constructor(model: LanguageModel, persona: Persona) {
    this.model = model;
    this.persona = persona;
  }

  async run(context: TaskContext): Promise<Reflection> {
    logger.info({ iteration: context.iteration }, "reflect_start");

    const taskType = (context.perception?.["taskType"] as string) ?? "conversation";
    const allSuccess = context.actionsDone.every((a) => a.success);

    // Check if the CURRENT plan has tool_call steps (not historical actions)
    const currentPlanHasToolCalls = context.plan?.steps.some(
      (s) => s.actionType === "tool_call",
    ) ?? false;

    let reflection: Reflection;

    if (currentPlanHasToolCalls && allSuccess) {
      // Tool calls executed successfully — need another LLM round for summary
      reflection = {
        verdict: "continue",
        assessment: `Tool calls executed in iteration ${context.iteration}, continuing for LLM summary`,
        lessons: [],
      };
    } else if (taskType === "conversation") {
      reflection = {
        verdict: "complete",
        assessment: "Conversation response delivered successfully",
        lessons: [],
      };
    } else {
      reflection = {
        verdict: allSuccess ? "complete" : "continue",
        assessment: `Iteration ${context.iteration}, ${context.actionsDone.length} actions, ${allSuccess ? "all succeeded" : "some failed"}`,
        lessons: [`Completed: ${context.inputText.slice(0, 50)}`],
      };
    }

    logger.info({ verdict: reflection.verdict, taskType }, "reflect_done");
    return reflection;
  }
}
