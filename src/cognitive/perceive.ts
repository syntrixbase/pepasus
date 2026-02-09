/**
 * Perceiver — parse input, extract key info, identify task type.
 *
 * Stateless pure processor: Input TaskContext → Output perception dict.
 * Currently a stub; will connect to LLM for intent detection.
 */
import { getLogger } from "../infra/logger.ts";
import type { TaskContext } from "../task/context.ts";

const logger = getLogger("cognitive.perceive");

export class Perceiver {
  async run(context: TaskContext): Promise<Record<string, unknown>> {
    logger.info({ inputText: context.inputText.slice(0, 100) }, "perceive_start");

    const perception = {
      rawInput: context.inputText,
      source: context.source,
      inputType: "text",
      taskType: "general",
      keyEntities: [],
      urgency: "normal",
    };

    logger.info({ taskType: perception.taskType }, "perceive_done");
    return perception;
  }
}
