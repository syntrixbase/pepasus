/**
 * Thinker — deep understanding, reasoning with memory and identity.
 *
 * Stateless pure processor: Input TaskContext → Output reasoning dict.
 */
import { getLogger } from "../infra/logger.ts";
import type { TaskContext } from "../task/context.ts";

const logger = getLogger("cognitive.think");

export class Thinker {
  async run(context: TaskContext): Promise<Record<string, unknown>> {
    logger.info({ iteration: context.iteration }, "think_start");

    const reasoning = {
      understanding: `User wants: ${context.inputText}`,
      relevantMemories: [],
      approach: "direct",
      confidence: 0.8,
      needsClarification: false,
    };

    logger.info({ approach: reasoning.approach }, "think_done");
    return reasoning;
  }
}
