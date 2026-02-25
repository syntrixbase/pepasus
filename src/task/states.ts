/** Task states for the finite state machine. */
export const TaskState = {
  IDLE: "idle",
  REASONING: "reasoning",
  ACTING: "acting",
  REFLECTING: "reflecting",
  SUSPENDED: "suspended",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.COMPLETED,
  TaskState.FAILED,
]);

export const SUSPENDABLE_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.REASONING,
  TaskState.ACTING,
  TaskState.REFLECTING,
]);
