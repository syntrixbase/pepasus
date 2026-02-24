/**
 * Planner — decompose task into executable steps.
 *
 * For conversation tasks: generates a single "respond" step (no LLM call needed).
 * When toolCalls present in reasoning: generates "tool_call" steps.
 * Complex multi-step planning will be added in M4.
 */
import type { LanguageModel } from "../infra/llm-types.ts";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import type { TaskContext, Plan, PlanStep } from "../task/context.ts";
import type { ToolCall } from "../models/tool.ts";

const logger = getLogger("cognitive.plan");

export class Planner {
  readonly model: LanguageModel;
  readonly persona: Persona;

  constructor(model: LanguageModel, persona: Persona) {
    this.model = model;
    this.persona = persona;
  }

  async run(context: TaskContext): Promise<Plan> {
    logger.info("plan_start");

    const taskType = (context.perception?.["taskType"] as string) ?? "conversation";
    const toolCalls = context.reasoning?.["toolCalls"] as ToolCall[] | undefined;

    let plan: Plan;

    // If LLM requested tool calls, generate tool_call steps
    if (toolCalls?.length) {
      const steps: PlanStep[] = toolCalls.map((tc, i) => ({
        index: i,
        description: `Call tool: ${tc.name}`,
        actionType: "tool_call",
        actionParams: {
          toolCallId: tc.id,
          toolName: tc.name,
          toolParams: tc.arguments,
        },
        completed: false,
      }));

      plan = {
        goal: "Execute tool calls requested by LLM",
        reasoning: `LLM requested ${toolCalls.length} tool call(s)`,
        steps,
      };
    } else if (taskType === "conversation") {
      plan = {
        goal: "Respond to the user",
        reasoning: "Conversation task: deliver the LLM-generated response",
        steps: [
          {
            index: 0,
            description: "Deliver response to user",
            actionType: "respond",
            actionParams: {},
            completed: false,
          },
        ],
      };
    } else {
      plan = {
        goal: context.inputText,
        reasoning: `Task type "${taskType}": single-step plan`,
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
    }

    logger.info({ stepsCount: plan.steps.length, taskType }, "plan_done");
    return plan;
  }
}
