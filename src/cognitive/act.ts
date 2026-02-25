/**
 * Actor — cognitive decision layer for concrete actions.
 *
 * Actor is a pure decision-maker — it does NOT execute I/O:
 *   - "respond": extracts the LLM-generated response from context.reasoning.
 *   - "tool_call": pushes assistant message (intent) to context.messages,
 *     returns a pending ActionResult. Actual tool execution is handled by
 *     the Agent layer via ToolExecutor.
 *   - other: returns a stub result.
 *
 * Actor does NOT emit events or update actionsDone / plan.
 * Those responsibilities belong to the Agent layer.
 */
import type { LanguageModel } from "../infra/llm-types.ts";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import type { TaskContext, PlanStep, ActionResult } from "../task/context.ts";
import type { ToolCall } from "../models/tool.ts";

const logger = getLogger("cognitive.act");

export class Actor {
  readonly model: LanguageModel;
  readonly persona: Persona;

  constructor(model: LanguageModel, persona: Persona) {
    this.model = model;
    this.persona = persona;
  }

  async run(context: TaskContext, step: PlanStep): Promise<ActionResult> {
    logger.info({ stepIndex: step.index, actionType: step.actionType }, "act_step_start");

    const startedAt = Date.now();

    if (step.actionType === "respond") {
      const resultValue = (context.reasoning?.["response"] as string) ?? "";
      const result: ActionResult = {
        stepIndex: step.index,
        actionType: step.actionType,
        actionInput: step.actionParams,
        result: resultValue,
        success: true,
        startedAt,
        completedAt: Date.now(),
      };
      logger.info({ stepIndex: step.index, success: true }, "act_step_done");
      return result;
    }

    if (step.actionType === "tool_call") {
      // Push assistant message with tool calls for this step
      const pendingToolCalls = context.reasoning?.["toolCalls"] as ToolCall[] | undefined;
      if (pendingToolCalls?.length) {
        context.messages.push({
          role: "assistant",
          content: (context.reasoning?.["response"] as string) ?? "",
          toolCalls: pendingToolCalls,
        });
      }

      // Return pending result — actual execution handled by Agent layer
      const result: ActionResult = {
        stepIndex: step.index,
        actionType: step.actionType,
        actionInput: step.actionParams,
        result: undefined,
        success: true,
        startedAt,
        completedAt: undefined,
      };
      logger.info({ stepIndex: step.index, success: true }, "act_step_pending");
      return result;
    }

    // Fallback stub for other action types
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
