/**
 * Actor — execute concrete actions (tool calls, content generation).
 *
 * For "respond" action: extracts the LLM-generated response from context.reasoning.
 * For "tool_call" action: executes tool via ToolExecutor, writes results to context.messages.
 */
import type { LanguageModel } from "../infra/llm-types.ts";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import type { TaskContext, PlanStep, ActionResult } from "../task/context.ts";
import type { ToolCall } from "../models/tool.ts";
import type { ToolExecutor } from "../tools/executor.ts";
import type { ToolContext } from "../tools/types.ts";

const logger = getLogger("cognitive.act");

export class Actor {
  readonly model: LanguageModel;
  readonly persona: Persona;

  constructor(
    model: LanguageModel,
    persona: Persona,
    private toolExecutor?: ToolExecutor,
  ) {
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

    if (step.actionType === "tool_call" && this.toolExecutor) {
      const { toolCallId, toolName, toolParams } = step.actionParams as {
        toolCallId: string;
        toolName: string;
        toolParams: Record<string, unknown>;
      };

      const toolContext: ToolContext = { taskId: context.id };
      const toolResult = await this.toolExecutor.execute(toolName, toolParams, toolContext);

      // Push assistant message with tool calls (once per round)
      const alreadyPushedAssistant = context.messages.some(
        (m) => m.role === "assistant" && !!m.toolCalls?.length,
      );
      if (!alreadyPushedAssistant) {
        const pendingToolCalls = context.reasoning?.["toolCalls"] as ToolCall[] | undefined;
        if (pendingToolCalls?.length) {
          context.messages.push({
            role: "assistant",
            content: (context.reasoning?.["response"] as string) ?? "",
            toolCalls: pendingToolCalls,
          });
        }
      }

      // Push tool result message
      context.messages.push({
        role: "tool",
        content: toolResult.success
          ? JSON.stringify(toolResult.result)
          : `Error: ${toolResult.error}`,
        toolCallId,
      });

      const result: ActionResult = {
        stepIndex: step.index,
        actionType: step.actionType,
        actionInput: step.actionParams,
        result: toolResult.result,
        success: toolResult.success,
        error: toolResult.error,
        startedAt,
        completedAt: Date.now(),
        durationMs: toolResult.durationMs,
      };
      logger.info({ stepIndex: step.index, success: result.success }, "act_step_done");
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
