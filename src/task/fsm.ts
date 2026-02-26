/**
 * TaskFSM — pure state-driven task execution model.
 *
 * The FSM performs NO I/O.  It only:
 *   1. Validates transitions
 *   2. Updates state
 *   3. Records history
 */
import type { Event } from "../events/types.ts";
import { EventType } from "../events/types.ts";
import { InvalidStateTransition } from "../infra/errors.ts";
import { shortId } from "../infra/id.ts";
import { getLogger } from "../infra/logger.ts";
import type { TaskContext } from "./context.ts";
import { createTaskContext } from "./context.ts";
import { TaskState, TERMINAL_STATES, RESUMABLE_STATES, SUSPENDABLE_STATES } from "./states.ts";

const logger = getLogger("task_fsm");

// ── StateTransition record ──────────────────────────

export interface StateTransition {
  fromState: TaskState;
  toState: TaskState;
  triggerEventType: EventType;
  triggerEventId: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

// ── Transition table ────────────────────────────────
// (currentState, eventType) → targetState
// null means "resolve dynamically at runtime"

type TransitionKey = `${TaskState}:${EventType}`;

const TRANSITION_TABLE = new Map<TransitionKey, TaskState | null>([
  // Create → Reason
  [`${TaskState.IDLE}:${EventType.TASK_CREATED}`, TaskState.REASONING],

  // Reason → Act / Suspended
  [`${TaskState.REASONING}:${EventType.REASON_DONE}`, TaskState.ACTING],
  [`${TaskState.REASONING}:${EventType.NEED_MORE_INFO}`, TaskState.SUSPENDED],

  // Act → Act (tool chain) / Reasoning / Completed (dynamic)
  [`${TaskState.ACTING}:${EventType.TOOL_CALL_COMPLETED}`, null], // dynamic
  [`${TaskState.ACTING}:${EventType.TOOL_CALL_FAILED}`, null],    // dynamic
  [`${TaskState.ACTING}:${EventType.STEP_COMPLETED}`, null],      // dynamic

  // Suspended → Resume
  [`${TaskState.SUSPENDED}:${EventType.TASK_RESUMED}`, null],     // dynamic
  [`${TaskState.SUSPENDED}:${EventType.MESSAGE_RECEIVED}`, TaskState.REASONING],

  // Completed → Resume (task continuation with new instructions)
  [`${TaskState.COMPLETED}:${EventType.TASK_RESUMED}`, TaskState.REASONING],
]);

// ── TaskFSM ─────────────────────────────────────────

export class TaskFSM {
  readonly taskId: string;
  state: TaskState;
  context: TaskContext;
  history: StateTransition[];
  createdAt: number;
  updatedAt: number;
  priority: number;
  metadata: Record<string, unknown>;

  constructor(opts?: {
    taskId?: string;
    state?: TaskState;
    context?: TaskContext;
    priority?: number;
    metadata?: Record<string, unknown>;
  }) {
    this.taskId = opts?.taskId ?? shortId();
    this.state = opts?.state ?? TaskState.IDLE;
    this.context = opts?.context ?? createTaskContext();
    this.history = [];
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.priority = opts?.priority ?? 100;
    this.metadata = opts?.metadata ?? {};
  }

  /** Factory: create TaskFSM from an external input event. */
  static fromEvent(event: Event): TaskFSM {
    const task = new TaskFSM({
      context: createTaskContext({
        inputText: (event.payload["text"] as string) ?? "",
        inputMetadata: (event.payload["metadata"] as Record<string, unknown>) ?? {},
        source: event.source,
      }),
      priority: event.priority ?? event.type,
    });
    logger.info({ taskId: task.taskId, source: event.source }, "task_created");
    return task;
  }

  /**
   * Hydrate: reconstruct a TaskFSM from persisted state.
   * Unlike fromEvent, does NOT log task_created — this is a restoration.
   */
  static hydrate(taskId: string, context: TaskContext, state: TaskState): TaskFSM {
    const task = new TaskFSM({ taskId, context, state });
    return task;
  }

  /** Execute a state transition. Returns the new state. Throws on invalid. */
  transition(event: Event): TaskState {
    if (TERMINAL_STATES.has(this.state)) {
      throw new InvalidStateTransition(
        `Task ${this.taskId} is in terminal state ${this.state}, cannot process ${event.type}`,
      );
    }

    // COMPLETED can only accept TASK_RESUMED
    if (RESUMABLE_STATES.has(this.state) && event.type !== EventType.TASK_RESUMED) {
      throw new InvalidStateTransition(
        `Task ${this.taskId} is in state ${this.state}, only TASK_RESUMED is allowed`,
      );
    }

    // Any state → Suspended (special)
    if (event.type === EventType.TASK_SUSPENDED && SUSPENDABLE_STATES.has(this.state)) {
      return this._doTransition(TaskState.SUSPENDED, event, { suspendedFrom: this.state });
    }

    // Any state → Failed (special)
    if (event.type === EventType.TASK_FAILED) {
      return this._doTransition(TaskState.FAILED, event);
    }

    // Lookup table
    const key: TransitionKey = `${this.state}:${event.type}`;
    const target = TRANSITION_TABLE.get(key);

    if (target === undefined) {
      throw new InvalidStateTransition(
        `No transition defined for (${this.state}, ${event.type})`,
      );
    }

    const resolved = target ?? this._resolveDynamicTarget(event);
    return this._doTransition(resolved, event);
  }

  /** Check if a transition is possible without executing it. */
  canTransition(eventType: EventType): boolean {
    if (TERMINAL_STATES.has(this.state)) return false;
    // COMPLETED only accepts TASK_RESUMED
    if (RESUMABLE_STATES.has(this.state)) return eventType === EventType.TASK_RESUMED;
    if (eventType === EventType.TASK_SUSPENDED) return SUSPENDABLE_STATES.has(this.state);
    if (eventType === EventType.TASK_FAILED) return true;
    const key: TransitionKey = `${this.state}:${eventType}`;
    return TRANSITION_TABLE.has(key);
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.state);
  }

  /** True when task is not actively running (completed or failed). */
  get isDone(): boolean {
    return this.state === TaskState.COMPLETED || this.state === TaskState.FAILED;
  }

  get isActive(): boolean {
    return (
      this.state !== TaskState.IDLE &&
      this.state !== TaskState.SUSPENDED &&
      !TERMINAL_STATES.has(this.state) &&
      !RESUMABLE_STATES.has(this.state)
    );
  }

  // ── Internal ──

  private _doTransition(
    toState: TaskState,
    event: Event,
    meta?: Record<string, unknown>,
  ): TaskState {
    const oldState = this.state;

    if (toState === TaskState.SUSPENDED) {
      this.context.suspendedState = oldState;
      this.context.suspendReason = (event.payload["reason"] as string) ?? "";
    }

    this.history.push({
      fromState: oldState,
      toState,
      triggerEventType: event.type,
      triggerEventId: event.id,
      timestamp: Date.now(),
      metadata: meta ?? {},
    });

    this.state = toState;
    this.updatedAt = Date.now();

    logger.info(
      { taskId: this.taskId, from: oldState, to: toState, trigger: event.type },
      "task_state_changed",
    );

    return toState;
  }

  private _resolveDynamicTarget(event: Event): TaskState {
    // ACTING + tool completed/failed/step completed
    if (
      this.state === TaskState.ACTING &&
      (event.type === EventType.TOOL_CALL_COMPLETED ||
       event.type === EventType.TOOL_CALL_FAILED ||
       event.type === EventType.STEP_COMPLETED)
    ) {
      if (this.context.plan && this.context.plan.steps.some((s) => !s.completed)) {
        return TaskState.ACTING;
      }
      // All steps done — route by plan step type
      const hasToolCalls = this.context.plan?.steps.some(
        (s) => s.actionType === "tool_call",
      ) ?? false;
      return hasToolCalls ? TaskState.REASONING : TaskState.COMPLETED;
    }

    // SUSPENDED + resumed → restore previous state
    if (this.state === TaskState.SUSPENDED && event.type === EventType.TASK_RESUMED) {
      const target = this.context.suspendedState;
      if (target) {
        this.context.suspendedState = null;
        this.context.suspendReason = null;
        return target as TaskState;
      }
      return TaskState.REASONING; // fallback
    }

    throw new InvalidStateTransition(
      `Cannot dynamically resolve target for (${this.state}, ${event.type})`,
    );
  }
}
