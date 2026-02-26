/** Task states for the finite state machine. */
export const TaskState = {
  IDLE: "idle",
  REASONING: "reasoning",
  ACTING: "acting",
  SUSPENDED: "suspended",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.FAILED,
]);

export const RESUMABLE_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.COMPLETED,
]);

export const SUSPENDABLE_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.REASONING,
  TaskState.ACTING,
]);
