/**
 * Reflector — evaluate results, extract lessons, decide next action.
 *
 * Stateless pure processor: Input TaskContext → Output Reflection.
 */
import { getLogger } from "../infra/logger.ts";
import type { TaskContext, Reflection } from "../task/context.ts";

const logger = getLogger("cognitive.reflect");

export class Reflector {
  async run(context: TaskContext): Promise<Reflection> {
    logger.info({ iteration: context.iteration }, "reflect_start");

    const allSuccess = context.actionsDone.every((a) => a.success);

    const reflection: Reflection = {
      verdict: allSuccess ? "complete" : "continue",
      assessment: `Iteration ${context.iteration}, ${context.actionsDone.length} actions, ${allSuccess ? "all succeeded" : "some failed"}`,
      lessons: [`Completed: ${context.inputText.slice(0, 50)}`],
    };

    logger.info({ verdict: reflection.verdict }, "reflect_done");
    return reflection;
  }
}
