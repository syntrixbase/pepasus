/** Task states for the finite state machine. */
export const TaskState = {
  IDLE: "idle",
  PERCEIVING: "perceiving",
  THINKING: "thinking",
  PLANNING: "planning",
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
  TaskState.PERCEIVING,
  TaskState.THINKING,
  TaskState.PLANNING,
  TaskState.ACTING,
  TaskState.REFLECTING,
]);
