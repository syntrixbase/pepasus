/**
 * EventType enum — numeric values serve as default priority (lower = higher).
 *
 * Segments:
 *   0-99    System events
 *   100-199 External input
 *   200-299 Task lifecycle
 *   300-399 Cognitive stages
 *   400-499 Tools / capabilities
 */
export const EventType = {
  // System (0-99)
  SYSTEM_STARTED: 0,
  SYSTEM_SHUTTING_DOWN: 1,
  HEARTBEAT: 90,

  // External input (100-199)
  MESSAGE_RECEIVED: 100,
  WEBHOOK_TRIGGERED: 110,
  SCHEDULE_FIRED: 120,

  // Task lifecycle (200-299)
  TASK_CREATED: 200,
  TASK_STATE_CHANGED: 210,
  TASK_COMPLETED: 220,
  TASK_FAILED: 230,
  TASK_SUSPENDED: 240,
  TASK_RESUMED: 250,

  // Cognitive stages (300-399)
  PERCEIVE_DONE: 300,
  THINK_DONE: 310,
  PLAN_DONE: 320,
  ACT_DONE: 330,
  STEP_COMPLETED: 335,  // Non-tool step completed during ACTING phase
  REFLECT_DONE: 340,
  NEED_MORE_INFO: 350,

  // Tools (400-499)
  TOOL_CALL_REQUESTED: 400,
  TOOL_CALL_COMPLETED: 410,
  TOOL_CALL_FAILED: 420,
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// ── Event ────────────────────────────────────────────

export interface Event {
  readonly id: string;
  readonly type: EventType;
  readonly timestamp: number; // Unix ms
  readonly source: string;
  readonly taskId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: number | null; // null → use EventType value
  readonly parentEventId: string | null;
}

/** Create an immutable Event. */
export function createEvent(
  type: EventType,
  opts: {
    source?: string;
    taskId?: string | null;
    payload?: Record<string, unknown>;
    priority?: number | null;
    parentEventId?: string | null;
  } = {},
): Event {
  return Object.freeze({
    id: crypto.randomUUID(),
    type,
    timestamp: Date.now(),
    source: opts.source ?? "",
    taskId: opts.taskId ?? null,
    payload: Object.freeze({ ...opts.payload }),
    priority: opts.priority ?? null,
    parentEventId: opts.parentEventId ?? null,
  });
}

/** Effective priority: custom priority ?? EventType numeric value. */
export function effectivePriority(event: Event): number {
  return event.priority ?? event.type;
}

/** Derive a child event, maintaining causality chain. */
export function deriveEvent(
  parent: Event,
  type: EventType,
  overrides: {
    source?: string;
    taskId?: string | null;
    payload?: Record<string, unknown>;
    priority?: number | null;
  } = {},
): Event {
  return createEvent(type, {
    source: overrides.source ?? parent.source,
    taskId: overrides.taskId ?? parent.taskId,
    payload: overrides.payload,
    priority: overrides.priority,
    parentEventId: parent.id,
  });
}
