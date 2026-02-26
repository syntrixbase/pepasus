/**
 * Agent — Pegasus core event processor.
 *
 * Agent is NOT a loop, NOT a controller. It is a pure event processor:
 *   receive event → find TaskFSM → drive state transition → spawn async cognitive stage
 *
 * Agent itself holds NO task execution state. All state lives in TaskFSM.
 */
import type { LanguageModel } from "../infra/llm-types.ts";
import type { Event } from "../events/types.ts";
import { EventType, createEvent } from "../events/types.ts";
import { EventBus } from "../events/bus.ts";
import { Thinker } from "../cognitive/think.ts";
import { Planner } from "../cognitive/plan.ts";
import { Actor } from "../cognitive/act.ts";
import { PostTaskReflector, shouldReflect } from "../cognitive/reflect.ts";
import { getLogger } from "../infra/logger.ts";
import { InvalidStateTransition, TaskNotFoundError } from "../infra/errors.ts";
import type { Settings } from "../infra/config.ts";
import { getSettings } from "../infra/config.ts";
import type { Persona } from "../identity/persona.ts";
import { TaskFSM } from "../task/fsm.ts";
import { TaskRegistry } from "../task/registry.ts";
import { TaskState } from "../task/states.ts";
import { currentStep, markStepDone, prepareContextForResume } from "../task/context.ts";
import type { TaskContext } from "../task/context.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ToolExecutor } from "../tools/executor.ts";
import type { ToolResult } from "../tools/types.ts";
import { allBuiltInTools, reflectionTools } from "../tools/builtins/index.ts";
import type { MemoryIndexEntry } from "../identity/prompt.ts";
import { TaskPersister } from "../task/persister.ts";
import { getContextWindowSize } from "../session/context-windows.ts";
import path from "node:path";

const logger = getLogger("agent");

export type TaskNotification =
  | { type: "completed"; taskId: string; result: unknown }
  | { type: "failed"; taskId: string; error: string };

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
  reflectionModel?: LanguageModel;
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
  private postReflector: PostTaskReflector;

  // Tool infrastructure
  private toolExecutor: ToolExecutor;

  // Concurrency control
  private llmSemaphore: Semaphore;
  private toolSemaphore: Semaphore;

  // Runtime state
  private _running = false;
  private backgroundTasks = new Set<Promise<void>>();
  private settings: Settings;
  private notifyCallback: ((notification: TaskNotification) => void) | null = null;

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

    // Task persistence (side-effect: subscribes to EventBus)
    new TaskPersister(this.eventBus, this.taskRegistry, this.settings.dataDir);

    // Initialize cognitive processors with model + persona
    this.thinker = new Thinker(deps.model, deps.persona, toolRegistry);
    this.planner = new Planner(deps.model, deps.persona);
    this.actor = new Actor(deps.model, deps.persona);
    // Create reflection tool registry (memory tools only, no memory_list)
    const reflectionToolRegistry = new ToolRegistry();
    reflectionToolRegistry.registerMany(reflectionTools);

    this.postReflector = new PostTaskReflector({
      model: deps.reflectionModel ?? deps.model,
      persona: deps.persona,
      toolRegistry: reflectionToolRegistry,
      toolExecutor,
      memoryDir: path.join(this.settings.dataDir, "memory"),
      contextWindowSize: getContextWindowSize(
        (deps.reflectionModel ?? deps.model).modelId,
        this.settings.llm.contextWindow,
      ),
    });
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

    // Recover pending tasks from previous run
    const tasksDir = path.join(this.settings.dataDir, "tasks");
    const recovered = await TaskPersister.recoverPending(tasksDir);
    if (recovered.length > 0) {
      logger.info({ count: recovered.length, taskIds: recovered }, "recovered_pending_tasks");
      for (const taskId of recovered) {
        if (this.notifyCallback) {
          this.notifyCallback({
            type: "failed",
            taskId,
            error: "process restarted, task cancelled",
          });
        }
      }
    }

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
    bus.subscribe(EventType.STEP_COMPLETED, this._onTaskEvent);
    bus.subscribe(EventType.TOOL_CALL_COMPLETED, this._onTaskEvent);
    bus.subscribe(EventType.TOOL_CALL_FAILED, this._onTaskEvent);
    bus.subscribe(EventType.NEED_MORE_INFO, this._onTaskEvent);
  }

  // ═══════════════════════════════════════════════════
  // Event handlers
  // ═══════════════════════════════════════════════════

  private _onExternalInput = async (event: Event): Promise<void> => {
    if (!this._running) return;
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
    if (!this._running) return;
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

      case TaskState.SUSPENDED:
        logger.info({ taskId: task.taskId }, "task_suspended");
        break;

      case TaskState.COMPLETED:
        task.context.finalResult = this._compileResult(task);
        logger.info({ taskId: task.taskId, iterations: task.context.iteration }, "task_completed");
        await this.eventBus.emit(
          createEvent(EventType.TASK_COMPLETED, {
            source: "agent",
            taskId: task.taskId,
            payload: { result: task.context.finalResult },
            parentEventId: trigger.id,
          }),
        );
        if (this.notifyCallback) {
          this.notifyCallback({
            type: "completed",
            taskId: task.taskId,
            result: task.context.finalResult,
          });
        }
        // Async post-task reflection (fire-and-forget)
        if (shouldReflect(task.context)) {
          this._spawn(this._runPostReflection(task));
        }
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
        if (this.notifyCallback) {
          this.notifyCallback({
            type: "failed",
            taskId: task.taskId,
            error: task.context.error ?? "unknown error",
          });
        }
        break;
    }
  }

  // ═══════════════════════════════════════════════════
  // Cognitive stage execution (async, non-blocking)
  // ═══════════════════════════════════════════════════

  private async _runReason(task: TaskFSM, trigger: Event): Promise<void> {
    // Track cognitive loop iteration
    task.context.iteration++;

    // Guard against infinite loops
    if (task.context.iteration > this.settings.agent.maxCognitiveIterations) {
      logger.error(
        { taskId: task.taskId, iteration: task.context.iteration, max: this.settings.agent.maxCognitiveIterations },
        "max_cognitive_iterations_exceeded",
      );
      task.context.error = `Max cognitive iterations exceeded (${this.settings.agent.maxCognitiveIterations})`;
      await this.eventBus.emit(
        createEvent(EventType.TASK_FAILED, {
          source: "agent",
          taskId: task.taskId,
          payload: { error: task.context.error },
          parentEventId: trigger.id,
        }),
      );
      return;
    }
    // Fetch memory index ONLY on first iteration (cache-friendly: avoids system prompt mutation)
    let memoryIndex: MemoryIndexEntry[] | undefined;
    if (task.context.iteration === 1) {
      try {
        const memResult = await this.toolExecutor.execute(
          "memory_list",
          {},
          { taskId: task.context.id, memoryDir: path.join(this.settings.dataDir, "memory") },
        );
        if (memResult.success && Array.isArray(memResult.result)) {
          memoryIndex = memResult.result as MemoryIndexEntry[];
        }
      } catch {
        // Memory unavailable — continue without it
      }
    }

    const reasoning = await this.llmSemaphore.use(() =>
      this.thinker.run(task.context, memoryIndex),
    );
    task.context.reasoning = reasoning;

    // Plan inline — pure logic, no LLM call, no semaphore needed
    const plan = await this.planner.run(task.context);
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
      // No pending steps — transition already handled by last STEP_COMPLETED/TOOL_CALL_COMPLETED
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
          { taskId: task.context.id, memoryDir: path.join(this.settings.dataDir, "memory") },
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

  private async _runPostReflection(task: TaskFSM): Promise<void> {
    try {
      // Pre-load existing facts (full content) and episode index
      const memoryDir = path.join(this.settings.dataDir, "memory");
      const existingFacts: Array<{ path: string; content: string }> = [];
      const episodeIndex: Array<{ path: string; summary: string }> = [];

      try {
        const listResult = await this.toolExecutor.execute(
          "memory_list", {}, { taskId: task.context.id, memoryDir },
        );
        if (listResult.success && Array.isArray(listResult.result)) {
          const entries = listResult.result as Array<{ path: string; summary: string; size: number }>;

          for (const entry of entries) {
            if (entry.path.startsWith("facts/")) {
              const readResult = await this.toolExecutor.execute(
                "memory_read", { path: entry.path }, { taskId: task.context.id, memoryDir },
              );
              if (readResult.success && typeof readResult.result === "string") {
                existingFacts.push({ path: entry.path, content: readResult.result });
              }
            } else if (entry.path.startsWith("episodes/")) {
              episodeIndex.push({ path: entry.path, summary: entry.summary });
            }
          }

          // Trim episodes to ~10K chars, most recent first
          let totalChars = 0;
          const trimmedEpisodes: typeof episodeIndex = [];
          for (const ep of [...episodeIndex].reverse()) {
            const lineLen = ep.path.length + ep.summary.length + 4;
            if (totalChars + lineLen > 10_000) break;
            totalChars += lineLen;
            trimmedEpisodes.push(ep);
          }
          episodeIndex.length = 0;
          episodeIndex.push(...trimmedEpisodes);
        }
      } catch {
        // Memory unavailable — continue without existing memory
      }

      const reflection = await this.llmSemaphore.use(() =>
        this.postReflector.run(task.context, existingFacts, episodeIndex),
      );
      task.context.postReflection = reflection;

      // Observability event
      await this.eventBus.emit(
        createEvent(EventType.REFLECTION_COMPLETE, {
          source: "cognitive.reflect",
          taskId: task.taskId,
          payload: {
            toolCallsCount: reflection.toolCallsCount,
            assessment: reflection.assessment,
          },
        }),
      );

      logger.info(
        { taskId: task.taskId, toolCalls: reflection.toolCallsCount },
        "post_reflection_complete",
      );
    } catch (err) {
      logger.warn({ taskId: task.taskId, error: err }, "post_reflection_failed");
    }
  }

  // ═══════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════

  private _spawn(promise: Promise<void>): void {
    const tracked = promise.catch((err) => {
      logger.error({ error: err }, "spawned_task_error");
    });
    this.backgroundTasks.add(tracked);
    tracked.finally(() => this.backgroundTasks.delete(tracked));
  }

  private _compileResult(task: TaskFSM): Record<string, unknown> {
    // For conversation tasks, extract the response text from the last "respond" action
    const respondAction = task.context.actionsDone.findLast((a) => a.actionType === "respond");
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

  /** Register a callback for task completion/failure notifications. */
  onNotify(callback: (notification: TaskNotification) => void): void {
    this.notifyCallback = callback;
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

  /**
   * Resume a previously completed task with new instructions.
   * Reuses existing conversation history and re-enters the cognitive loop.
   */
  async resume(taskId: string, newInput: string): Promise<string> {
    // 1. Check if task is already in registry
    let task = this.taskRegistry.getOrNull(taskId);

    if (task) {
      // Task is in registry — verify it's completed
      if (task.state !== TaskState.COMPLETED) {
        throw new Error(`Task ${taskId} is in state ${task.state}, can only resume COMPLETED tasks`);
      }
    } else {
      // 2. Not in registry — try to hydrate from JSONL
      const tasksDir = path.join(this.settings.dataDir, "tasks");
      const filePath = await TaskPersister.resolveTaskPath(tasksDir, taskId);
      if (!filePath) {
        throw new TaskNotFoundError(`Task ${taskId} not found`);
      }

      // 3. Replay JSONL to reconstruct context
      const context = await TaskPersister.replay(filePath);

      // 4. Hydrate FSM and register
      task = TaskFSM.hydrate(taskId, context, TaskState.COMPLETED);
      this.taskRegistry.register(task);
    }

    // 5. Prepare context for resume
    prepareContextForResume(task.context, newInput);

    // 6. Emit TASK_RESUMED → triggers FSM transition COMPLETED → REASONING
    await this.eventBus.emit(
      createEvent(EventType.TASK_RESUMED, {
        source: "agent",
        taskId: task.taskId,
        payload: { newInput },
      }),
    );

    return taskId;
  }

  /** Wait for a task to complete (for testing and simple scenarios). */
  async waitForTask(taskId: string, timeout?: number): Promise<TaskFSM> {
    const effectiveTimeout = timeout ?? this.settings.agent.taskTimeout * 1000;
    const deadline = Date.now() + effectiveTimeout;
    while (Date.now() < deadline) {
      const task = this.taskRegistry.getOrNull(taskId);
      if (task?.isDone) return task;
      await Bun.sleep(50);
    }
    throw new Error(`Task ${taskId} did not complete within ${effectiveTimeout}ms`);
  }
}
