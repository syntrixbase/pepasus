/**
 * Agent — Pegasus core event processor.
 *
 * Agent is NOT a loop, NOT a controller. It is a pure event processor:
 *   receive event → find TaskFSM → drive state transition → spawn async cognitive stage
 *
 * Agent itself holds NO task execution state. All state lives in TaskFSM.
 */
import type { LanguageModel } from "./infra/llm-types.ts";
import type { Event } from "./events/types.ts";
import { EventType, createEvent } from "./events/types.ts";
import { EventBus } from "./events/bus.ts";
import { Thinker } from "./cognitive/think.ts";
import { Planner } from "./cognitive/plan.ts";
import { Actor } from "./cognitive/act.ts";
import { Reflector } from "./cognitive/reflect.ts";
import { getLogger } from "./infra/logger.ts";
import { InvalidStateTransition, TaskNotFoundError } from "./infra/errors.ts";
import type { Settings } from "./infra/config.ts";
import { getSettings } from "./infra/config.ts";
import type { Persona } from "./identity/persona.ts";
import { TaskFSM } from "./task/fsm.ts";
import { TaskRegistry } from "./task/registry.ts";
import { TaskState } from "./task/states.ts";
import { currentStep, markStepDone } from "./task/context.ts";
import type { TaskContext } from "./task/context.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ToolExecutor } from "./tools/executor.ts";
import type { ToolResult } from "./tools/types.ts";
import { allBuiltInTools } from "./tools/builtins/index.ts";
import type { MemoryIndexEntry } from "./identity/prompt.ts";

const logger = getLogger("agent");

/** Push a tool result message into context.messages. */
function context_pushToolResult(
  context: TaskContext,
  toolCallId: string,
  toolResult: ToolResult,
): void {
  context.messages.push({
    role: "tool",
    content: toolResult.success
      ? JSON.stringify(toolResult.result)
      : `Error: ${toolResult.error}`,
    toolCallId,
  });
}

// ── Async Semaphore ──────────────────────────────────

class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve();
    } else {
      this.permits++;
    }
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ── Agent ────────────────────────────────────────────

export interface AgentDeps {
  model: LanguageModel;
  persona: Persona;
  settings?: Settings;
}

export class Agent {
  readonly eventBus: EventBus;
  readonly taskRegistry: TaskRegistry;

  // Cognitive processors (stateless)
  private thinker: Thinker;
  private planner: Planner;
  private actor: Actor;
  private reflector: Reflector;

  // Tool infrastructure
  private toolExecutor: ToolExecutor;

  // Concurrency control
  private llmSemaphore: Semaphore;
  private toolSemaphore: Semaphore;

  // Runtime state
  private _running = false;
  private backgroundTasks = new Set<Promise<void>>();
  private settings: Settings;

  constructor(deps: AgentDeps) {
    this.settings = deps.settings ?? getSettings();
    this.eventBus = new EventBus({ keepHistory: true });
    this.taskRegistry = new TaskRegistry(this.settings.agent.maxActiveTasks);
    this.llmSemaphore = new Semaphore(this.settings.llm.maxConcurrentCalls);
    this.toolSemaphore = new Semaphore(this.settings.agent.maxConcurrentTools);

    // Create tool infrastructure
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany(allBuiltInTools);

    const toolExecutor = new ToolExecutor(
      toolRegistry,
      this.eventBus,
      (this.settings.tools?.timeout ?? 30) * 1000,
    );
    this.toolExecutor = toolExecutor;

    // Initialize cognitive processors with model + persona
    this.thinker = new Thinker(deps.model, deps.persona, toolRegistry);
    this.planner = new Planner(deps.model, deps.persona);
    this.actor = new Actor(deps.model, deps.persona);
    this.reflector = new Reflector(deps.model, deps.persona);
  }

  // ═══════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════

  async start(): Promise<void> {
    logger.info("agent_starting");
    this._subscribeEvents();
    await this.eventBus.start();
    this._running = true;

    await this.eventBus.emit(
      createEvent(EventType.SYSTEM_STARTED, { source: "system" }),
    );

    logger.info("agent_started");
  }

  async stop(): Promise<void> {
    logger.info("agent_stopping");
    this._running = false;

    // Wait for all background tasks
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
    this.backgroundTasks.clear();

    await this.eventBus.stop();
    logger.info("agent_stopped");
  }

  get isRunning(): boolean {
    return this._running;
  }

  // ═══════════════════════════════════════════════════
  // Event subscription
  // ═══════════════════════════════════════════════════

  private _subscribeEvents(): void {
    const bus = this.eventBus;

    // External input → create task
    bus.subscribe(EventType.MESSAGE_RECEIVED, this._onExternalInput);
    bus.subscribe(EventType.WEBHOOK_TRIGGERED, this._onExternalInput);
    bus.subscribe(EventType.SCHEDULE_FIRED, this._onExternalInput);

    // Task lifecycle
    bus.subscribe(EventType.TASK_CREATED, this._onTaskEvent);
    bus.subscribe(EventType.TASK_SUSPENDED, this._onTaskEvent);
    bus.subscribe(EventType.TASK_RESUMED, this._onTaskEvent);

    // Cognitive stage completions
    bus.subscribe(EventType.REASON_DONE, this._onTaskEvent);
    bus.subscribe(EventType.ACT_DONE, this._onTaskEvent);
    bus.subscribe(EventType.STEP_COMPLETED, this._onTaskEvent);
    bus.subscribe(EventType.TOOL_CALL_COMPLETED, this._onTaskEvent);
    bus.subscribe(EventType.TOOL_CALL_FAILED, this._onTaskEvent);
    bus.subscribe(EventType.REFLECT_DONE, this._onTaskEvent);
    bus.subscribe(EventType.NEED_MORE_INFO, this._onTaskEvent);
  }

  // ═══════════════════════════════════════════════════
  // Event handlers
  // ═══════════════════════════════════════════════════

  private _onExternalInput = async (event: Event): Promise<void> => {
    const task = TaskFSM.fromEvent(event);
    this.taskRegistry.register(task);

    await this.eventBus.emit(
      createEvent(EventType.TASK_CREATED, {
        source: "agent",
        taskId: task.taskId,
        parentEventId: event.id,
      }),
    );
  };

  private _onTaskEvent = async (event: Event): Promise<void> => {
    if (!event.taskId) {
      logger.warn({ eventType: event.type }, "task_event_no_task_id");
      return;
    }

    let task: TaskFSM;
    try {
      task = this.taskRegistry.get(event.taskId);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        logger.warn({ taskId: event.taskId, eventType: event.type }, "task_not_found");
        return;
      }
      throw err;
    }

    let newState: TaskState;
    try {
      newState = task.transition(event);
    } catch (err) {
      if (err instanceof InvalidStateTransition) {
        logger.warn({ error: (err as Error).message, taskId: task.taskId }, "invalid_transition");
        return;
      }
      throw err;
    }

    await this._dispatchCognitiveStage(task, newState, event);
  };

  // ═══════════════════════════════════════════════════
  // Cognitive stage dispatch
  // ═══════════════════════════════════════════════════

  private async _dispatchCognitiveStage(
    task: TaskFSM,
    state: TaskState,
    trigger: Event,
  ): Promise<void> {
    switch (state) {
      case TaskState.REASONING:
        this._spawn(this._runReason(task, trigger));
        break;

      case TaskState.ACTING:
        this._spawn(this._runAct(task, trigger));
        break;

      case TaskState.REFLECTING:
        this._spawn(this._runReflect(task, trigger));
        break;

      case TaskState.SUSPENDED:
        logger.info({ taskId: task.taskId }, "task_suspended");
        break;

      case TaskState.COMPLETED:
        logger.info({ taskId: task.taskId, iterations: task.context.iteration }, "task_completed");
        await this.eventBus.emit(
          createEvent(EventType.TASK_COMPLETED, {
            source: "agent",
            taskId: task.taskId,
            payload: { result: task.context.finalResult },
            parentEventId: trigger.id,
          }),
        );
        break;

      case TaskState.FAILED:
        logger.error({ taskId: task.taskId, error: task.context.error }, "task_failed");
        await this.eventBus.emit(
          createEvent(EventType.TASK_FAILED, {
            source: "agent",
            taskId: task.taskId,
            payload: { error: task.context.error },
            parentEventId: trigger.id,
          }),
        );
        break;
    }
  }

  // ═══════════════════════════════════════════════════
  // Cognitive stage execution (async, non-blocking)
  // ═══════════════════════════════════════════════════

  private async _runReason(task: TaskFSM, trigger: Event): Promise<void> {
    // Fetch memory index (non-blocking, graceful failure)
    let memoryIndex: MemoryIndexEntry[] | undefined;
    try {
      const memResult = await this.toolExecutor.execute(
        "memory_list",
        {},
        { taskId: task.context.id, dataDir: this.settings.memory.dataDir },
      );
      if (memResult.success && Array.isArray(memResult.result)) {
        memoryIndex = memResult.result as MemoryIndexEntry[];
      }
    } catch {
      // Memory unavailable — continue without it
    }

    const reasoning = await this.llmSemaphore.use(() =>
      this.thinker.run(task.context, memoryIndex),
    );
    task.context.reasoning = reasoning;

    // Plan inline — no separate planning stage
    const plan = await this.llmSemaphore.use(() =>
      this.planner.run(task.context),
    );
    task.context.plan = plan;

    if (reasoning["needsClarification"]) {
      await this.eventBus.emit(
        createEvent(EventType.NEED_MORE_INFO, {
          source: "cognitive.reason",
          taskId: task.taskId,
          payload: reasoning,
          parentEventId: trigger.id,
        }),
      );
    } else {
      await this.eventBus.emit(
        createEvent(EventType.REASON_DONE, {
          source: "cognitive.reason",
          taskId: task.taskId,
          payload: reasoning,
          parentEventId: trigger.id,
        }),
      );
    }
  }

  private async _runAct(task: TaskFSM, trigger: Event): Promise<void> {
    if (!task.context.plan) {
      logger.error({ taskId: task.taskId }, "act_no_plan");
      return;
    }

    const step = currentStep(task.context.plan);
    if (!step) {
      // No pending steps — signal act phase is done
      await this.eventBus.emit(
        createEvent(EventType.ACT_DONE, {
          source: "cognitive.act",
          taskId: task.taskId,
          payload: { actionsCount: task.context.actionsDone.length },
          parentEventId: trigger.id,
        }),
      );
      return;
    }

    // Actor.run is fast (no I/O) — gets cognitive decision
    const actorResult = await this.actor.run(task.context, step);

    if (step.actionType === "tool_call") {
      // Fire-and-forget tool execution — _runAct returns immediately
      this._spawn(this.toolSemaphore.use(async () => {
        const { toolCallId, toolName, toolParams } = step.actionParams as {
          toolCallId: string;
          toolName: string;
          toolParams: Record<string, unknown>;
        };

        const toolResult = await this.toolExecutor.execute(
          toolName,
          toolParams,
          { taskId: task.context.id, dataDir: this.settings.memory.dataDir },
        );

        // Push tool result message to context
        context_pushToolResult(task.context, toolCallId, toolResult);

        // Build final ActionResult from actorResult + toolResult
        const finalResult = {
          ...actorResult,
          result: toolResult.result,
          success: toolResult.success,
          error: toolResult.error,
          completedAt: Date.now(),
          durationMs: toolResult.durationMs,
        };

        // Update context BEFORE emitting event (FSM checks plan.steps)
        task.context.actionsDone.push(finalResult);
        markStepDone(task.context.plan!, step.index);

        // Emit completion event via ToolExecutor
        this.toolExecutor.emitCompletion(
          toolName,
          {
            success: toolResult.success,
            error: toolResult.error,
            result: toolResult.result,
            startedAt: actorResult.startedAt,
            completedAt: Date.now(),
            durationMs: toolResult.durationMs,
          },
          { taskId: task.taskId },
        );
      }));
      // Return immediately — non-blocking
      return;
    }

    // respond / stub — synchronous completion
    task.context.actionsDone.push(actorResult);
    markStepDone(task.context.plan, step.index);

    // Emit STEP_COMPLETED — event-driven continuation (no direct recursion)
    await this.eventBus.emit(
      createEvent(EventType.STEP_COMPLETED, {
        source: "cognitive.act",
        taskId: task.taskId,
        payload: { stepIndex: step.index, actionsCount: task.context.actionsDone.length },
        parentEventId: trigger.id,
      }),
    );
  }

  private async _runReflect(task: TaskFSM, trigger: Event): Promise<void> {
    const reflection = await this.llmSemaphore.use(() =>
      this.reflector.run(task.context),
    );
    task.context.reflections.push(reflection);

    if (reflection.verdict === "complete") {
      task.context.finalResult = this._compileResult(task);
    }

    await this.eventBus.emit(
      createEvent(EventType.REFLECT_DONE, {
        source: "cognitive.reflect",
        taskId: task.taskId,
        payload: { verdict: reflection.verdict, assessment: reflection.assessment },
        parentEventId: trigger.id,
      }),
    );
  }

  // ═══════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════

  private _spawn(promise: Promise<void>): void {
    this.backgroundTasks.add(promise);
    promise.finally(() => this.backgroundTasks.delete(promise));
  }

  private _compileResult(task: TaskFSM): Record<string, unknown> {
    // For conversation tasks, extract the response text from the last "respond" action
    const respondAction = task.context.actionsDone.find((a) => a.actionType === "respond");
    const responseText = respondAction?.result as string | undefined;

    return {
      taskId: task.taskId,
      input: task.context.inputText,
      response: responseText ?? null,
      actions: task.context.actionsDone,
      reflections: task.context.reflections,
      iterations: task.context.iteration,
    };
  }

  // ═══════════════════════════════════════════════════
  // Public API (convenience methods)
  // ═══════════════════════════════════════════════════

  /** Register a one-shot callback for task completion (or failure). */
  onTaskComplete(taskId: string, callback: (task: TaskFSM) => void): void {
    // Check if already terminal (race condition safety)
    const existing = this.taskRegistry.getOrNull(taskId);
    if (existing?.isTerminal) {
      callback(existing);
      return;
    }

    // Subscribe to both TASK_COMPLETED and TASK_FAILED
    const handler = async (event: Event): Promise<void> => {
      if (event.taskId !== taskId) return;
      const task = this.taskRegistry.getOrNull(taskId);
      if (!task) return;
      this.eventBus.unsubscribe(EventType.TASK_COMPLETED, handler);
      this.eventBus.unsubscribe(EventType.TASK_FAILED, handler);
      callback(task);
    };

    this.eventBus.subscribe(EventType.TASK_COMPLETED, handler);
    this.eventBus.subscribe(EventType.TASK_FAILED, handler);
  }

  /** Submit a task. Returns the taskId. */
  async submit(text: string, source: string = "user"): Promise<string> {
    const event = createEvent(EventType.MESSAGE_RECEIVED, {
      source,
      payload: { text },
    });
    await this.eventBus.emit(event);

    // Wait for TASK_CREATED event to appear in history
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(10);
      for (let j = this.eventBus.history.length - 1; j >= 0; j--) {
        const e = this.eventBus.history[j]!;
        if (e.type === EventType.TASK_CREATED && e.parentEventId === event.id) {
          return e.taskId ?? "";
        }
      }
    }
    return "";
  }

  /** Wait for a task to complete (for testing and simple scenarios). */
  async waitForTask(taskId: string, timeout?: number): Promise<TaskFSM> {
    const effectiveTimeout = timeout ?? this.settings.agent.taskTimeout * 1000;
    const deadline = Date.now() + effectiveTimeout;
    while (Date.now() < deadline) {
      const task = this.taskRegistry.getOrNull(taskId);
      if (task?.isTerminal) return task;
      await Bun.sleep(50);
    }
    throw new Error(`Task ${taskId} did not complete within ${effectiveTimeout}ms`);
  }
}
