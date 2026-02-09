/**
 * Planner — decompose task into executable steps.
 *
 * Stateless pure processor: Input TaskContext → Output Plan.
 */
import { getLogger } from "../infra/logger.ts";
import type { TaskContext } from "../task/context.ts";
import type { Plan } from "../task/context.ts";

const logger = getLogger("cognitive.plan");

export class Planner {
  async run(context: TaskContext): Promise<Plan> {
    logger.info("plan_start");

    const plan: Plan = {
      goal: context.inputText,
      reasoning: "Stub planner: single-step plan",
      steps: [
        {
          index: 0,
          description: `Process task: ${context.inputText}`,
          actionType: "generate",
          actionParams: { prompt: context.inputText },
          completed: false,
        },
      ],
    };

    logger.info({ stepsCount: plan.steps.length }, "plan_done");
    return plan;
  }
}
