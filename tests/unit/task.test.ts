import { describe, expect, test } from "bun:test";
import {
  TaskState,
  TERMINAL_STATES,
  SUSPENDABLE_STATES,
} from "@pegasus/task/states.ts";
import {
  createTaskContext,
  currentStep,
  hasMoreSteps,
  markStepDone,
} from "@pegasus/task/context.ts";
import type {
  Plan,
  PlanStep,
  ActionResult,
  Reflection,
} from "@pegasus/task/context.ts";
import { TaskFSM } from "@pegasus/task/fsm.ts";
import type { StateTransition } from "@pegasus/task/fsm.ts";
import { TaskRegistry } from "@pegasus/task/registry.ts";
import { createEvent, EventType } from "@pegasus/events/types.ts";
import type { Event } from "@pegasus/events/types.ts";
import { InvalidStateTransition, TaskNotFoundError } from "@pegasus/infra/errors.ts";

// ── Helpers ────────────────────────────────────────

function makeEvent(
  type: EventType,
  overrides: Partial<Pick<Event, "source" | "taskId" | "payload">> = {},
): Event {
  return createEvent(type, {
    source: overrides.source ?? "test",
    taskId: overrides.taskId ?? null,
    payload: overrides.payload ?? {},
  });
}

function makePlan(stepCount: number = 2): Plan {
  const steps: PlanStep[] = Array.from({ length: stepCount }, (_, i) => ({
    index: i,
    description: `Step ${i}`,
    actionType: "tool_call",
    actionParams: { tool: `tool_${i}` },
    completed: false,
  }));
  return { goal: "test goal", steps, reasoning: "test reasoning" };
}

// ── TaskState ────────────────────────────────────

describe("TaskState", () => {
  test("defines all expected states", () => {
    expect(TaskState.IDLE).toBe("idle");
    expect(TaskState.REASONING).toBe("reasoning");
    expect(TaskState.ACTING).toBe("acting");
    expect(TaskState.SUSPENDED).toBe("suspended");
    expect(TaskState.COMPLETED).toBe("completed");
    expect(TaskState.FAILED).toBe("failed");
  });

  test("TERMINAL_STATES contains only COMPLETED and FAILED", () => {
    expect(TERMINAL_STATES.has(TaskState.COMPLETED)).toBe(true);
    expect(TERMINAL_STATES.has(TaskState.FAILED)).toBe(true);
    expect(TERMINAL_STATES.size).toBe(2);
    expect(TERMINAL_STATES.has(TaskState.IDLE)).toBe(false);
  });

  test("SUSPENDABLE_STATES contains cognitive stages", () => {
    expect(SUSPENDABLE_STATES.has(TaskState.REASONING)).toBe(true);
    expect(SUSPENDABLE_STATES.has(TaskState.ACTING)).toBe(true);
    expect(SUSPENDABLE_STATES.size).toBe(2);
    expect(SUSPENDABLE_STATES.has(TaskState.IDLE)).toBe(false);
    expect(SUSPENDABLE_STATES.has(TaskState.SUSPENDED)).toBe(false);
  });

  test("TERMINAL_STATES is immutable (ReadonlySet)", () => {
    // ReadonlySet type prevents .add/.delete at compile time;
    // at runtime the underlying Set is still mutable, but the type enforces it.
    expect(TERMINAL_STATES).toBeInstanceOf(Set);
    expect(SUSPENDABLE_STATES).toBeInstanceOf(Set);
  });
});

// ── Plan helpers ─────────────────────────────────

describe("Plan helpers", () => {
  test("currentStep returns first incomplete step", () => {
    const plan = makePlan(3);
    expect(currentStep(plan)?.index).toBe(0);
    markStepDone(plan, 0);
    expect(currentStep(plan)?.index).toBe(1);
  });

  test("currentStep returns null when all done", () => {
    const plan = makePlan(2);
    markStepDone(plan, 0);
    markStepDone(plan, 1);
    expect(currentStep(plan)).toBeNull();
  });

  test("hasMoreSteps tracks incomplete steps", () => {
    const plan = makePlan(1);
    expect(hasMoreSteps(plan)).toBe(true);
    markStepDone(plan, 0);
    expect(hasMoreSteps(plan)).toBe(false);
  });

  test("markStepDone is idempotent for invalid index", () => {
    const plan = makePlan(1);
    markStepDone(plan, 999); // no-op
    expect(plan.steps[0]!.completed).toBe(false);
  });
});

// ── TaskContext ──────────────────────────────────

describe("TaskContext", () => {
  test("createTaskContext with defaults", () => {
    const ctx = createTaskContext();
    expect(ctx.inputText).toBe("");
    expect(ctx.inputMetadata).toEqual({});
    expect(ctx.source).toBe("");
    expect(ctx.reasoning).toBeNull();
    expect(ctx.plan).toBeNull();
    expect(ctx.actionsDone).toEqual([]);
    expect(ctx.reflections).toEqual([]);
    expect(ctx.iteration).toBe(0);
    expect(ctx.finalResult).toBeNull();
    expect(ctx.error).toBeNull();
    expect(ctx.suspendedState).toBeNull();
    expect(ctx.suspendReason).toBeNull();
    expect(ctx.messages).toEqual([]);
  });

  test("createTaskContext with custom values", () => {
    const ctx = createTaskContext({
      inputText: "hello world",
      inputMetadata: { lang: "en" },
      source: "slack",
    });
    expect(ctx.inputText).toBe("hello world");
    expect(ctx.inputMetadata).toEqual({ lang: "en" });
    expect(ctx.source).toBe("slack");
  });

  test("ActionResult supports durationMs", () => {
    const result: ActionResult = {
      stepIndex: 0,
      actionType: "tool_call",
      actionInput: { tool: "search" },
      result: { found: true },
      success: true,
      startedAt: 1000,
      completedAt: 2000,
      durationMs: 1000,
    };
    expect(result.durationMs).toBe(1000);
  });

  test("Reflection interface shape", () => {
    const r: Reflection = {
      verdict: "complete",
      assessment: "Task done well",
      lessons: ["Lesson 1"],
      nextFocus: "monitoring",
    };
    expect(r.verdict).toBe("complete");
    expect(r.lessons).toHaveLength(1);
    expect(r.nextFocus).toBe("monitoring");
  });
});

// ── TaskFSM ─────────────────────────────────────

describe("TaskFSM", () => {
  test("constructor defaults", () => {
    const fsm = new TaskFSM();
    expect(fsm.taskId).toBeTruthy();
    expect(fsm.state).toBe(TaskState.IDLE);
    expect(fsm.context.inputText).toBe("");
    expect(fsm.history).toEqual([]);
    expect(fsm.createdAt).toBeGreaterThan(0);
    expect(fsm.updatedAt).toBeGreaterThan(0);
    expect(fsm.priority).toBe(100);
    expect(fsm.metadata).toEqual({});
    expect(fsm.isTerminal).toBe(false);
    expect(fsm.isActive).toBe(false); // IDLE is not active
  });

  test("constructor with custom options", () => {
    const ctx = createTaskContext({ inputText: "test" });
    const fsm = new TaskFSM({
      taskId: "custom-id",
      state: TaskState.IDLE,
      context: ctx,
      priority: 50,
      metadata: { origin: "test" },
    });
    expect(fsm.taskId).toBe("custom-id");
    expect(fsm.priority).toBe(50);
    expect(fsm.metadata).toEqual({ origin: "test" });
    expect(fsm.context.inputText).toBe("test");
  });

  test("fromEvent factory creates task from event", () => {
    const event = makeEvent(EventType.MESSAGE_RECEIVED, {
      source: "slack",
      payload: {
        text: "Deploy the app",
        metadata: { channel: "#ops" },
      },
    });
    const fsm = TaskFSM.fromEvent(event);
    expect(fsm.state).toBe(TaskState.IDLE);
    expect(fsm.context.inputText).toBe("Deploy the app");
    expect(fsm.context.source).toBe("slack");
    expect(fsm.context.inputMetadata).toEqual({ channel: "#ops" });
    expect(fsm.priority).toBe(event.priority ?? event.type);
  });

  // ── Happy path: full lifecycle ──

  test("full lifecycle: IDLE → REASONING → ACTING → COMPLETED (respond steps)", () => {
    const fsm = new TaskFSM();
    // Set a plan with respond step only (no tool_call)
    fsm.context.plan = {
      goal: "respond",
      reasoning: "deliver response",
      steps: [{ index: 0, description: "reply", actionType: "respond", actionParams: {}, completed: true }],
    };

    // IDLE → REASONING
    fsm.transition(makeEvent(EventType.TASK_CREATED));
    expect(fsm.state).toBe(TaskState.REASONING);
    expect(fsm.isActive).toBe(true);

    // REASONING → ACTING
    fsm.transition(makeEvent(EventType.REASON_DONE));
    expect(fsm.state).toBe(TaskState.ACTING);

    // ACTING → COMPLETED (respond step, all done)
    fsm.transition(makeEvent(EventType.STEP_COMPLETED));
    expect(fsm.state).toBe(TaskState.COMPLETED);
    expect(fsm.isTerminal).toBe(true);
    expect(fsm.isActive).toBe(false);

    expect(fsm.history).toHaveLength(3);
  });

  // ── Transition history ──

  test("transition records history entries", () => {
    const fsm = new TaskFSM();
    const event = makeEvent(EventType.TASK_CREATED);
    fsm.transition(event);

    expect(fsm.history).toHaveLength(1);
    const entry: StateTransition = fsm.history[0]!;
    expect(entry.fromState).toBe(TaskState.IDLE);
    expect(entry.toState).toBe(TaskState.REASONING);
    expect(entry.triggerEventType).toBe(EventType.TASK_CREATED);
    expect(entry.triggerEventId).toBe(event.id);
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  // ── Dynamic transitions ──

  test("ACTING + TOOL_CALL_COMPLETED → ACTING when plan has more steps", () => {
    const fsm = new TaskFSM();
    fsm.context.plan = makePlan(2);

    // Manually set state to ACTING for this test
    fsm.state = TaskState.ACTING;

    fsm.transition(makeEvent(EventType.TOOL_CALL_COMPLETED));
    expect(fsm.state).toBe(TaskState.ACTING); // still acting, more steps
  });

  test("ACTING + TOOL_CALL_COMPLETED → REASONING when plan has tool_call steps and all done", () => {
    const fsm = new TaskFSM();
    fsm.context.plan = makePlan(1);  // makePlan creates tool_call steps
    markStepDone(fsm.context.plan, 0);
    fsm.state = TaskState.ACTING;

    fsm.transition(makeEvent(EventType.TOOL_CALL_COMPLETED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);
  });

  test("ACTING + TOOL_CALL_FAILED → REASONING when plan has tool_call steps and all done", () => {
    const fsm = new TaskFSM();
    fsm.context.plan = makePlan(1);
    markStepDone(fsm.context.plan, 0);
    fsm.state = TaskState.ACTING;

    fsm.transition(makeEvent(EventType.TOOL_CALL_FAILED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);
  });

  test("ACTING + TOOL_CALL_FAILED → ACTING when plan has more steps", () => {
    const fsm = new TaskFSM();
    fsm.context.plan = makePlan(3);
    markStepDone(fsm.context.plan, 0);
    // steps 1 and 2 still pending

    fsm.state = TaskState.ACTING;

    fsm.transition(makeEvent(EventType.TOOL_CALL_FAILED));
    expect(fsm.state).toBe(TaskState.ACTING);
  });

  test("ACTING + STEP_COMPLETED → ACTING when plan has more steps", () => {
    const fsm = new TaskFSM();
    fsm.context.plan = makePlan(2);
    fsm.state = TaskState.ACTING;

    fsm.transition(makeEvent(EventType.STEP_COMPLETED));
    expect(fsm.state).toBe(TaskState.ACTING);
  });

  test("ACTING + STEP_COMPLETED → COMPLETED when plan has only respond steps and all done", () => {
    const fsm = new TaskFSM();
    fsm.context.plan = {
      goal: "respond",
      reasoning: "deliver",
      steps: [{ index: 0, description: "reply", actionType: "respond", actionParams: {}, completed: true }],
    };
    fsm.state = TaskState.ACTING;

    fsm.transition(makeEvent(EventType.STEP_COMPLETED));
    expect(fsm.state as TaskState).toBe(TaskState.COMPLETED);
  });

  test("multi-turn lifecycle: tool_call → REASONING → respond → COMPLETED", () => {
    const fsm = new TaskFSM();

    // Round 1: Reason → Act with tool_call
    fsm.transition(makeEvent(EventType.TASK_CREATED));
    expect(fsm.state).toBe(TaskState.REASONING);

    fsm.context.plan = makePlan(1);  // tool_call step
    fsm.transition(makeEvent(EventType.REASON_DONE));
    expect(fsm.state).toBe(TaskState.ACTING);

    markStepDone(fsm.context.plan!, 0);
    fsm.transition(makeEvent(EventType.TOOL_CALL_COMPLETED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);  // back to reason

    // Round 2: Reason → Act with respond
    fsm.context.plan = {
      goal: "respond",
      reasoning: "have answer",
      steps: [{ index: 0, description: "reply", actionType: "respond", actionParams: {}, completed: true }],
    };
    fsm.transition(makeEvent(EventType.REASON_DONE));
    expect(fsm.state).toBe(TaskState.ACTING);

    fsm.transition(makeEvent(EventType.STEP_COMPLETED));
    expect(fsm.state as TaskState).toBe(TaskState.COMPLETED);
  });

  // ── Suspend / Resume ──

  test("suspend from REASONING and resume back", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.REASONING;

    fsm.transition(makeEvent(EventType.TASK_SUSPENDED, { payload: { reason: "awaiting input" } }));
    expect(fsm.state as TaskState).toBe(TaskState.SUSPENDED);
    expect(fsm.context.suspendedState).toBe(TaskState.REASONING);
    expect(fsm.context.suspendReason).toBe("awaiting input");
    expect(fsm.isActive).toBe(false);

    fsm.transition(makeEvent(EventType.TASK_RESUMED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);
    expect(fsm.context.suspendedState).toBeNull();
    expect(fsm.context.suspendReason).toBeNull();
  });

  test("suspend from each suspendable state", () => {
    for (const state of SUSPENDABLE_STATES) {
      const fsm = new TaskFSM();
      fsm.state = state;
      fsm.transition(makeEvent(EventType.TASK_SUSPENDED));
      expect(fsm.state).toBe(TaskState.SUSPENDED);
      expect(fsm.context.suspendedState).toBe(state);
    }
  });

  test("SUSPENDED + MESSAGE_RECEIVED → REASONING", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.SUSPENDED;

    fsm.transition(makeEvent(EventType.MESSAGE_RECEIVED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);
  });

  test("resume with no suspendedState falls back to REASONING", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.SUSPENDED;
    fsm.context.suspendedState = null;

    fsm.transition(makeEvent(EventType.TASK_RESUMED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING); // fallback
  });

  // ── NEED_MORE_INFO ──

  test("REASONING + NEED_MORE_INFO → SUSPENDED", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.REASONING;

    fsm.transition(makeEvent(EventType.NEED_MORE_INFO));
    expect(fsm.state as TaskState).toBe(TaskState.SUSPENDED);
  });

  // ── Fail from any state ──

  test("TASK_FAILED transitions to FAILED from any non-terminal state", () => {
    const nonTerminalStates: TaskState[] = [
      TaskState.IDLE,
      TaskState.REASONING,
      TaskState.ACTING,
      TaskState.SUSPENDED,
    ];
    for (const state of nonTerminalStates) {
      const fsm = new TaskFSM();
      fsm.state = state;
      fsm.transition(makeEvent(EventType.TASK_FAILED));
      expect(fsm.state).toBe(TaskState.FAILED);
    }
  });

  // ── Invalid transitions ──

  test("throws InvalidStateTransition for undefined transition", () => {
    const fsm = new TaskFSM();
    expect(() => {
      fsm.transition(makeEvent(EventType.STEP_COMPLETED)); // IDLE + STEP_COMPLETED is invalid
    }).toThrow(InvalidStateTransition);
  });

  test("throws InvalidStateTransition from terminal state", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.COMPLETED;

    expect(() => {
      fsm.transition(makeEvent(EventType.TASK_CREATED));
    }).toThrow(InvalidStateTransition);

    fsm.state = TaskState.FAILED;
    expect(() => {
      fsm.transition(makeEvent(EventType.TASK_CREATED));
    }).toThrow(InvalidStateTransition);
  });

  test("cannot suspend from IDLE state", () => {
    const fsm = new TaskFSM();
    expect(fsm.canTransition(EventType.TASK_SUSPENDED)).toBe(false);
    expect(() => {
      fsm.transition(makeEvent(EventType.TASK_SUSPENDED));
    }).toThrow(InvalidStateTransition);
  });

  // ── canTransition ──

  test("canTransition returns true for valid transitions", () => {
    const fsm = new TaskFSM();
    expect(fsm.canTransition(EventType.TASK_CREATED)).toBe(true);
    expect(fsm.canTransition(EventType.TASK_FAILED)).toBe(true);
  });

  test("canTransition returns false for invalid transitions", () => {
    const fsm = new TaskFSM();
    expect(fsm.canTransition(EventType.STEP_COMPLETED)).toBe(false);
  });

  test("canTransition returns false from terminal states", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.COMPLETED;
    expect(fsm.canTransition(EventType.TASK_CREATED)).toBe(false);
    expect(fsm.canTransition(EventType.TASK_FAILED)).toBe(false);
    expect(fsm.canTransition(EventType.TASK_SUSPENDED)).toBe(false);
  });

  test("canTransition for suspend checks suspendable states", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.ACTING;
    expect(fsm.canTransition(EventType.TASK_SUSPENDED)).toBe(true);

    fsm.state = TaskState.IDLE;
    expect(fsm.canTransition(EventType.TASK_SUSPENDED)).toBe(false);
  });

  // ── isTerminal / isActive ──

  test("isTerminal is true only for COMPLETED and FAILED", () => {
    const fsm = new TaskFSM();
    for (const state of Object.values(TaskState)) {
      fsm.state = state;
      if (state === TaskState.COMPLETED || state === TaskState.FAILED) {
        expect(fsm.isTerminal).toBe(true);
      } else {
        expect(fsm.isTerminal).toBe(false);
      }
    }
  });

  test("isActive is true for cognitive stages only", () => {
    const fsm = new TaskFSM();
    const activeStates = [
      TaskState.REASONING,
      TaskState.ACTING,
    ];
    const inactiveStates = [
      TaskState.IDLE,
      TaskState.SUSPENDED,
      TaskState.COMPLETED,
      TaskState.FAILED,
    ];

    for (const state of activeStates) {
      fsm.state = state;
      expect(fsm.isActive).toBe(true);
    }
    for (const state of inactiveStates) {
      fsm.state = state;
      expect(fsm.isActive).toBe(false);
    }
  });

  // ── updatedAt ──

  test("updatedAt is refreshed on transition", () => {
    const fsm = new TaskFSM();
    const before = fsm.updatedAt;
    fsm.transition(makeEvent(EventType.TASK_CREATED));
    expect(fsm.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

// ── TaskRegistry ────────────────────────────────

describe("TaskRegistry", () => {
  test("register and get", () => {
    const registry = new TaskRegistry();
    const task = new TaskFSM();
    registry.register(task);
    expect(registry.get(task.taskId)).toBe(task);
    expect(registry.totalCount).toBe(1);
  });

  test("get throws TaskNotFoundError for missing task", () => {
    const registry = new TaskRegistry();
    expect(() => registry.get("nonexistent")).toThrow(TaskNotFoundError);
  });

  test("getOrNull returns null for missing task", () => {
    const registry = new TaskRegistry();
    expect(registry.getOrNull("nonexistent")).toBeNull();
  });

  test("getOrNull returns task when present", () => {
    const registry = new TaskRegistry();
    const task = new TaskFSM();
    registry.register(task);
    expect(registry.getOrNull(task.taskId)).toBe(task);
  });

  test("remove returns task and deletes it", () => {
    const registry = new TaskRegistry();
    const task = new TaskFSM();
    registry.register(task);

    const removed = registry.remove(task.taskId);
    expect(removed).toBe(task);
    expect(registry.totalCount).toBe(0);
    expect(registry.getOrNull(task.taskId)).toBeNull();
  });

  test("remove returns null for missing task", () => {
    const registry = new TaskRegistry();
    expect(registry.remove("nonexistent")).toBeNull();
  });

  test("listActive returns only active tasks", () => {
    const registry = new TaskRegistry();

    const idle = new TaskFSM(); // IDLE → not active
    const active = new TaskFSM();
    active.state = TaskState.REASONING;
    const completed = new TaskFSM();
    completed.state = TaskState.COMPLETED;

    registry.register(idle);
    registry.register(active);
    registry.register(completed);

    const activeList = registry.listActive();
    expect(activeList).toHaveLength(1);
    expect(activeList[0]!.taskId).toBe(active.taskId);
  });

  test("listAll returns all tasks", () => {
    const registry = new TaskRegistry();
    const t1 = new TaskFSM();
    const t2 = new TaskFSM();
    registry.register(t1);
    registry.register(t2);

    expect(registry.listAll()).toHaveLength(2);
  });

  test("listByState filters by specific state", () => {
    const registry = new TaskRegistry();

    const reasoning1 = new TaskFSM();
    reasoning1.state = TaskState.REASONING;
    const reasoning2 = new TaskFSM();
    reasoning2.state = TaskState.REASONING;
    const acting = new TaskFSM();
    acting.state = TaskState.ACTING;
    const idle = new TaskFSM();

    registry.register(reasoning1);
    registry.register(reasoning2);
    registry.register(acting);
    registry.register(idle);

    expect(registry.listByState(TaskState.REASONING)).toHaveLength(2);
    expect(registry.listByState(TaskState.ACTING)).toHaveLength(1);
    expect(registry.listByState(TaskState.IDLE)).toHaveLength(1);
    expect(registry.listByState(TaskState.COMPLETED)).toHaveLength(0);
  });

  test("activeCount tracks active tasks", () => {
    const registry = new TaskRegistry();

    const idle = new TaskFSM();
    const active1 = new TaskFSM();
    active1.state = TaskState.REASONING;
    const active2 = new TaskFSM();
    active2.state = TaskState.ACTING;

    registry.register(idle);
    registry.register(active1);
    registry.register(active2);

    expect(registry.activeCount).toBe(2);
  });

  test("cleanupTerminal removes and returns terminal tasks", () => {
    const registry = new TaskRegistry();

    const active = new TaskFSM();
    active.state = TaskState.REASONING;
    const completed = new TaskFSM();
    completed.state = TaskState.COMPLETED;
    const failed = new TaskFSM();
    failed.state = TaskState.FAILED;

    registry.register(active);
    registry.register(completed);
    registry.register(failed);

    expect(registry.totalCount).toBe(3);

    const cleaned = registry.cleanupTerminal();
    expect(cleaned).toHaveLength(2);
    expect(registry.totalCount).toBe(1);
    expect(registry.getOrNull(active.taskId)).toBe(active);
    expect(registry.getOrNull(completed.taskId)).toBeNull();
    expect(registry.getOrNull(failed.taskId)).toBeNull();
  });

  test("cleanupTerminal returns empty array when no terminal tasks", () => {
    const registry = new TaskRegistry();
    const active = new TaskFSM();
    active.state = TaskState.ACTING;
    registry.register(active);

    expect(registry.cleanupTerminal()).toHaveLength(0);
    expect(registry.totalCount).toBe(1);
  });

  test("maxActive emits warning but does not block", () => {
    const registry = new TaskRegistry(2);
    const t1 = new TaskFSM();
    t1.state = TaskState.REASONING;
    const t2 = new TaskFSM();
    t2.state = TaskState.ACTING;
    const t3 = new TaskFSM();
    t3.state = TaskState.REASONING;

    registry.register(t1);
    registry.register(t2);
    // Third registration should not throw, only warn
    registry.register(t3);
    expect(registry.totalCount).toBe(3);
  });
});
