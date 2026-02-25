/**
 * TaskPersister — append-only JSONL persistence for task events.
 *
 * Subscribes to EventBus events and writes delta lines to
 * `{dataDir}/tasks/YYYY-MM-DD/{taskId}.jsonl`.
 *
 * An `index.jsonl` maps taskId → date for lookup.
 * A `pending.json` tracks active tasks.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLogger } from "../infra/logger.ts";
import { EventType } from "../events/types.ts";
import type { EventBus } from "../events/bus.ts";
import type { TaskRegistry } from "./registry.ts";

const logger = getLogger("task_persister");

export class TaskPersister {
  private dataDir: string;
  private tasksDir: string;
  private bus: EventBus;
  private registry: TaskRegistry;
  private messageIndex = new Map<string, number>(); // taskId → last written message index

  constructor(bus: EventBus, registry: TaskRegistry, dataDir: string) {
    this.bus = bus;
    this.registry = registry;
    this.dataDir = dataDir;
    this.tasksDir = path.join(dataDir, "tasks");
    this._subscribe();
  }

  // ── Core write methods ──

  /** Append a JSONL line to the task's event log. */
  private async _append(
    taskId: string,
    createdAt: number,
    event: string,
    data: unknown,
  ): Promise<void> {
    const date = this._dateStr(createdAt);
    const dir = path.join(this.tasksDir, date);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${taskId}.jsonl`);
    const line = JSON.stringify({ ts: Date.now(), event, taskId, data }) + "\n";
    await appendFile(filePath, line, "utf-8");
  }

  /** Append a line to index.jsonl */
  private async _appendIndex(taskId: string, date: string): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    const filePath = path.join(this.tasksDir, "index.jsonl");
    const line = JSON.stringify({ taskId, date }) + "\n";
    await appendFile(filePath, line, "utf-8");
  }

  /** Add or remove a task from pending.json */
  private async _updatePending(
    action: "add" | "remove",
    taskId: string,
    ts?: number,
  ): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    const filePath = path.join(this.tasksDir, "pending.json");
    let arr: Array<{ taskId: string; ts: number }> = [];
    try {
      const content = await readFile(filePath, "utf-8");
      arr = JSON.parse(content);
    } catch {
      // File doesn't exist yet
    }
    if (action === "add") {
      arr.push({ taskId, ts: ts ?? Date.now() });
    } else {
      arr = arr.filter((e) => e.taskId !== taskId);
    }
    await writeFile(filePath, JSON.stringify(arr, null, 2), "utf-8");
  }

  // ── Test helpers ──

  _appendForTest(
    taskId: string,
    createdAt: number,
    event: string,
    data: unknown,
  ) {
    return this._append(taskId, createdAt, event, data);
  }

  _appendIndexForTest(taskId: string, date: string) {
    return this._appendIndex(taskId, date);
  }

  _updatePendingForTest(
    action: "add" | "remove",
    taskId: string,
    ts?: number,
  ) {
    return this._updatePending(action, taskId, ts);
  }

  // ── Internals ──

  private _dateStr(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10); // "YYYY-MM-DD"
  }

  private _subscribe(): void {
    // TASK_CREATED
    this.bus.subscribe(EventType.TASK_CREATED, async (event) => {
      if (!event.taskId) return;
      const task = this.registry.getOrNull(event.taskId);
      if (!task) return;
      try {
        const date = this._dateStr(task.createdAt);
        await this._append(event.taskId, task.createdAt, "TASK_CREATED", {
          inputText: task.context.inputText,
          source: task.context.source,
          inputMetadata: task.context.inputMetadata,
        });
        await this._appendIndex(event.taskId, date);
        await this._updatePending("add", event.taskId, task.createdAt);
      } catch (err) {
        logger.warn({ taskId: event.taskId, error: err }, "persist_created_failed");
      }
    });

    // REASON_DONE
    this.bus.subscribe(EventType.REASON_DONE, async (event) => {
      if (!event.taskId) return;
      const task = this.registry.getOrNull(event.taskId);
      if (!task) return;
      try {
        const lastIdx = this.messageIndex.get(event.taskId) ?? 0;
        const newMessages = task.context.messages.slice(lastIdx);
        this.messageIndex.set(event.taskId, task.context.messages.length);
        await this._append(event.taskId, task.createdAt, "REASON_DONE", {
          reasoning: task.context.reasoning,
          plan: task.context.plan,
          newMessages,
        });
      } catch (err) {
        logger.warn({ taskId: event.taskId, error: err }, "persist_reason_failed");
      }
    });

    // TOOL_CALL_COMPLETED / TOOL_CALL_FAILED
    for (const evtName of ["TOOL_CALL_COMPLETED", "TOOL_CALL_FAILED"] as const) {
      this.bus.subscribe(EventType[evtName], async (event) => {
        if (!event.taskId) return;
        const task = this.registry.getOrNull(event.taskId);
        if (!task) return;
        try {
          const lastIdx = this.messageIndex.get(event.taskId) ?? 0;
          const newMessages = task.context.messages.slice(lastIdx);
          this.messageIndex.set(event.taskId, task.context.messages.length);
          const lastAction = task.context.actionsDone[task.context.actionsDone.length - 1];
          await this._append(event.taskId, task.createdAt, evtName, {
            action: lastAction,
            newMessages,
          });
        } catch (err) {
          logger.warn({ taskId: event.taskId, error: err }, "persist_tool_failed");
        }
      });
    }

    // ACT_DONE
    this.bus.subscribe(EventType.ACT_DONE, async (event) => {
      if (!event.taskId) return;
      const task = this.registry.getOrNull(event.taskId);
      if (!task) return;
      try {
        await this._append(event.taskId, task.createdAt, "ACT_DONE", {
          actionsCount: task.context.actionsDone.length,
        });
      } catch (err) {
        logger.warn({ taskId: event.taskId, error: err }, "persist_act_failed");
      }
    });

    // REFLECT_DONE
    this.bus.subscribe(EventType.REFLECT_DONE, async (event) => {
      if (!event.taskId) return;
      const task = this.registry.getOrNull(event.taskId);
      if (!task) return;
      try {
        const lastReflection = task.context.reflections[task.context.reflections.length - 1];
        await this._append(event.taskId, task.createdAt, "REFLECT_DONE", {
          reflection: lastReflection,
        });
      } catch (err) {
        logger.warn({ taskId: event.taskId, error: err }, "persist_reflect_failed");
      }
    });

    // NEED_MORE_INFO
    this.bus.subscribe(EventType.NEED_MORE_INFO, async (event) => {
      if (!event.taskId) return;
      const task = this.registry.getOrNull(event.taskId);
      if (!task) return;
      try {
        await this._append(event.taskId, task.createdAt, "NEED_MORE_INFO", {
          reasoning: task.context.reasoning,
        });
      } catch (err) {
        logger.warn({ taskId: event.taskId, error: err }, "persist_needinfo_failed");
      }
    });

    // TASK_COMPLETED
    this.bus.subscribe(EventType.TASK_COMPLETED, async (event) => {
      if (!event.taskId) return;
      const task = this.registry.getOrNull(event.taskId);
      if (!task) return;
      try {
        const lastIdx = this.messageIndex.get(event.taskId) ?? 0;
        const newMessages = task.context.messages.slice(lastIdx);
        this.messageIndex.set(event.taskId, task.context.messages.length);
        await this._append(event.taskId, task.createdAt, "TASK_COMPLETED", {
          finalResult: task.context.finalResult,
          iterations: task.context.iteration,
          newMessages,
        });
        await this._updatePending("remove", event.taskId);
        this.messageIndex.delete(event.taskId);
      } catch (err) {
        logger.warn({ taskId: event.taskId, error: err }, "persist_completed_failed");
      }
    });

    // TASK_FAILED
    this.bus.subscribe(EventType.TASK_FAILED, async (event) => {
      if (!event.taskId) return;
      const task = this.registry.getOrNull(event.taskId);
      if (!task) return;
      try {
        await this._append(event.taskId, task.createdAt, "TASK_FAILED", {
          error: task.context.error,
        });
        await this._updatePending("remove", event.taskId);
        this.messageIndex.delete(event.taskId);
      } catch (err) {
        logger.warn({ taskId: event.taskId, error: err }, "persist_failed_failed");
      }
    });
  }
}
