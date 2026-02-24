/**
 * TaskContext — accumulates all intermediate artifacts for a task.
 */

import type { Message } from "../infra/llm-types.ts";

// ── PlanStep ─────────────────────────────────────────

export interface PlanStep {
  index: number;
  description: string;
  actionType: string; // "tool_call" | "generate" | "sub_task"
  actionParams: Record<string, unknown>;
  completed: boolean;
}

// ── Plan ─────────────────────────────────────────────

export interface Plan {
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

export function currentStep(plan: Plan): PlanStep | null {
  return plan.steps.find((s) => !s.completed) ?? null;
}

export function hasMoreSteps(plan: Plan): boolean {
  return plan.steps.some((s) => !s.completed);
}

export function markStepDone(plan: Plan, index: number): void {
  const step = plan.steps.find((s) => s.index === index);
  if (step) step.completed = true;
}

// ── ActionResult ─────────────────────────────────────

export interface ActionResult {
  stepIndex: number;
  actionType: string;
  actionInput: Record<string, unknown>;
  result?: unknown;
  success: boolean;
  error?: string;
  startedAt: number; // Unix ms
  completedAt?: number;
  durationMs?: number;
}

// ── Reflection ───────────────────────────────────────

export interface Reflection {
  verdict: "complete" | "continue" | "replan";
  assessment: string;
  lessons: string[];
  nextFocus?: string;
}

// ── TaskContext ───────────────────────────────────────

export interface TaskContext {
  // Task identifier
  id: string;

  // Original input
  inputText: string;
  inputMetadata: Record<string, unknown>;
  source: string;

  // Cognitive stage outputs
  perception: Record<string, unknown> | null;
  reasoning: Record<string, unknown> | null;
  plan: Plan | null;
  actionsDone: ActionResult[];
  reflections: Reflection[];

  // Loop control
  iteration: number;

  // Final result
  finalResult: unknown | null;
  error: string | null;

  // Suspend/resume
  suspendedState: string | null;
  suspendReason: string | null;

  // Conversation history
  messages: Message[];
}

export function createTaskContext(
  opts: {
    id?: string;
    inputText?: string;
    inputMetadata?: Record<string, unknown>;
    source?: string;
  } = {},
): TaskContext {
  return {
    id: opts.id ?? crypto.randomUUID(),
    inputText: opts.inputText ?? "",
    inputMetadata: opts.inputMetadata ?? {},
    source: opts.source ?? "",
    perception: null,
    reasoning: null,
    plan: null,
    actionsDone: [],
    reflections: [],
    iteration: 0,
    finalResult: null,
    error: null,
    suspendedState: null,
    suspendReason: null,
    messages: [],
  };
}
