/**
 * Actor — execute concrete actions (tool calls, content generation).
 *
 * Stateless pure processor: Input (TaskContext, PlanStep) → Output ActionResult.
 */
import { getLogger } from "../infra/logger.ts";
import type { TaskContext, PlanStep, ActionResult } from "../task/context.ts";

const logger = getLogger("cognitive.act");

export class Actor {
  async run(_context: TaskContext, step: PlanStep): Promise<ActionResult> {
    logger.info({ stepIndex: step.index, actionType: step.actionType }, "act_step_start");

    const startedAt = Date.now();

    const result: ActionResult = {
      stepIndex: step.index,
      actionType: step.actionType,
      actionInput: step.actionParams,
      result: `[Stub] Completed step ${step.index}: ${step.description}`,
      success: true,
      startedAt,
      completedAt: Date.now(),
    };

    logger.info({ stepIndex: step.index, success: result.success }, "act_step_done");
    return result;
  }
}
