/**
 * TaskRegistry — tracks all active tasks.
 */
import { TaskNotFoundError } from "../infra/errors.ts";
import { getLogger } from "../infra/logger.ts";
import { TaskFSM } from "./fsm.ts";
import type { TaskState } from "./states.ts";
import { TERMINAL_STATES } from "./states.ts";

const logger = getLogger("task_registry");

export class TaskRegistry {
  private tasks = new Map<string, TaskFSM>();
  private maxActive: number;

  constructor(maxActive: number = 10) {
    this.maxActive = maxActive;
  }

  register(task: TaskFSM): void {
    const activeCount = this.activeCount;
    if (activeCount >= this.maxActive) {
      logger.warn({ max: this.maxActive, active: activeCount }, "max_active_tasks_reached");
    }
    this.tasks.set(task.taskId, task);
    logger.info({ taskId: task.taskId, total: this.tasks.size }, "task_registered");
  }

  get(taskId: string): TaskFSM {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(`Task ${taskId} not found`);
    return task;
  }

  getOrNull(taskId: string): TaskFSM | null {
    return this.tasks.get(taskId) ?? null;
  }

  remove(taskId: string): TaskFSM | null {
    const task = this.tasks.get(taskId);
    if (task) {
      this.tasks.delete(taskId);
      logger.info({ taskId, finalState: task.state }, "task_removed");
    }
    return task ?? null;
  }

  listActive(): TaskFSM[] {
    return [...this.tasks.values()].filter((t) => t.isActive);
  }

  listAll(): TaskFSM[] {
    return [...this.tasks.values()];
  }

  cleanupTerminal(): TaskFSM[] {
    const terminal: TaskFSM[] = [];
    for (const task of this.tasks.values()) {
      if (TERMINAL_STATES.has(task.state)) {
        terminal.push(task);
      }
    }
    for (const t of terminal) {
      this.tasks.delete(t.taskId);
    }
    if (terminal.length > 0) {
      logger.info({ count: terminal.length }, "terminal_tasks_cleaned");
    }
    return terminal;
  }

  get activeCount(): number {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.isActive) count++;
    }
    return count;
  }

  listByState(state: TaskState): TaskFSM[] {
    return [...this.tasks.values()].filter((t) => t.state === state);
  }

  get totalCount(): number {
    return this.tasks.size;
  }
}
