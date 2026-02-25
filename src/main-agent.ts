/**
 * MainAgent — persistent LLM conversation partner.
 *
 * Sits between channel adapters and the Task System. Receives messages via
 * send(), processes them through an internal queue with LLM calls, and
 * replies via onReply() callback. Has curated simple tools and delegates
 * complex work to the existing Task System via spawn_task.
 */

import type { LanguageModel, Message } from "./infra/llm-types.ts";
import { generateText } from "./infra/llm-utils.ts";
import type { Persona } from "./identity/persona.ts";
import type { Settings } from "./infra/config.ts";
import { getSettings } from "./infra/config.ts";
import { getLogger } from "./infra/logger.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ToolExecutor } from "./tools/executor.ts";
import type { InboundMessage, OutboundMessage } from "./channels/types.ts";
import { SessionStore } from "./session/store.ts";
import { Agent } from "./agent.ts";
import type { ToolCall } from "./models/tool.ts";

// Main Agent's simple tools
import { current_time } from "./tools/builtins/system-tools.ts";
import { memory_list, memory_read } from "./tools/builtins/memory-tools.ts";
import { task_list, task_replay } from "./tools/builtins/task-tools.ts";
import { spawn_task } from "./tools/builtins/spawn-task-tool.ts";

const logger = getLogger("main_agent");

export interface MainAgentDeps {
  model: LanguageModel;
  persona: Persona;
  settings?: Settings;
}

type QueueItem =
  | { kind: "message"; message: InboundMessage }
  | { kind: "task_result"; taskId: string; result: unknown; error?: string };

export class MainAgent {
  private model: LanguageModel;
  private persona: Persona;
  private settings: Settings;
  private agent: Agent; // Task execution engine
  private sessionStore: SessionStore;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private sessionMessages: Message[] = [];
  private replyCallback: ((msg: OutboundMessage) => void) | null = null;
  private queue: QueueItem[] = [];
  private processing = false;

  constructor(deps: MainAgentDeps) {
    this.model = deps.model;
    this.persona = deps.persona;
    this.settings = deps.settings ?? getSettings();

    // Session persistence
    this.sessionStore = new SessionStore(this.settings.dataDir);

    // Task execution engine (existing Agent)
    this.agent = new Agent(deps);

    // Main Agent's curated tool set
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerMany([
      current_time,
      memory_list,
      memory_read,
      task_list,
      task_replay,
      spawn_task,
    ]);

    // Tool executor for Main Agent's simple tools (no EventBus needed)
    this.toolExecutor = new ToolExecutor(
      this.toolRegistry,
      { emit: () => {} }, // Main Agent doesn't use EventBus for its own tools
      (this.settings.tools?.timeout ?? 30) * 1000,
    );
  }

  /** Start the Main Agent and underlying Task System. */
  async start(): Promise<void> {
    // Load session history from disk
    this.sessionMessages = await this.sessionStore.load();

    // Start task execution engine
    await this.agent.start();

    logger.info(
      { sessionMessages: this.sessionMessages.length },
      "main_agent_started",
    );
  }

  /** Stop the Main Agent. */
  async stop(): Promise<void> {
    await this.agent.stop();
    logger.info("main_agent_stopped");
  }

  /** Register reply callback. */
  onReply(callback: (msg: OutboundMessage) => void): void {
    this.replyCallback = callback;
  }

  /** Send a message to Main Agent (fire-and-forget, queued). */
  send(message: InboundMessage): void {
    this.queue.push({ kind: "message", message });
    this._processQueue();
  }

  /** Internal: notify Main Agent of task completion. */
  private _onTaskResult(
    taskId: string,
    result: unknown,
    error?: string,
  ): void {
    this.queue.push({ kind: "task_result", taskId, result, error });
    this._processQueue();
  }

  // ── Queue processing ──

  private _processQueue(): void {
    if (this.processing) return; // Already processing
    this.processing = true;
    this._drainQueue().finally(() => {
      this.processing = false;
    });
  }

  private async _drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        if (item.kind === "message") {
          await this._handleMessage(item.message);
        } else {
          await this._handleTaskResult(item.taskId, item.result, item.error);
        }
      } catch (err) {
        logger.error({ error: err }, "main_agent_process_error");
        // Send error reply if possible
        if (item.kind === "message" && this.replyCallback) {
          this.replyCallback({
            text: "Sorry, I encountered an internal error. Please try again.",
            channel: item.message.channel,
          });
        }
      }
    }
  }

  // ── Message handling ──

  private async _handleMessage(message: InboundMessage): Promise<void> {
    // Add user message to session
    const userMsg: Message = { role: "user", content: message.text };
    this.sessionMessages.push(userMsg);
    await this.sessionStore.append(userMsg, { channel: message.channel });

    // Build system prompt
    const system = this._buildSystemPrompt(message);

    // LLM call with tool support
    await this._llmLoop(message, system);
  }

  private async _llmLoop(
    message: InboundMessage,
    system: string,
  ): Promise<void> {
    const tools = this.toolRegistry.toLLMTools();
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;

      const result = await generateText({
        model: this.model,
        system,
        messages: this.sessionMessages,
        tools: tools.length ? tools : undefined,
        toolChoice: tools.length ? "auto" : undefined,
      });

      // Handle tool calls
      if (result.toolCalls?.length) {
        // Push assistant message with tool calls
        const assistantMsg: Message = {
          role: "assistant",
          content: result.text ?? "",
          toolCalls: result.toolCalls,
        };
        this.sessionMessages.push(assistantMsg);
        await this.sessionStore.append(assistantMsg);

        // Execute each tool call
        for (const tc of result.toolCalls) {
          if (tc.name === "spawn_task") {
            // Handle spawn_task specially
            await this._handleSpawnTask(tc, message);
          } else {
            // Execute simple tool directly
            const toolResult = await this.toolExecutor.execute(
              tc.name,
              tc.arguments,
              {
                taskId: "main-agent",
                memoryDir: `${this.settings.dataDir}/memory`,
              },
            );
            const toolMsg: Message = {
              role: "tool",
              content: toolResult.success
                ? JSON.stringify(toolResult.result)
                : `Error: ${toolResult.error}`,
              toolCallId: tc.id,
            };
            this.sessionMessages.push(toolMsg);
            await this.sessionStore.append(toolMsg);
          }
        }

        // Continue loop — LLM will process tool results
        continue;
      }

      // No tool calls — direct text response
      if (result.text) {
        const assistantMsg: Message = {
          role: "assistant",
          content: result.text,
        };
        this.sessionMessages.push(assistantMsg);
        await this.sessionStore.append(assistantMsg);

        if (this.replyCallback) {
          this.replyCallback({
            text: result.text,
            channel: message.channel,
          });
        }
      }

      // Done with this message
      break;
    }
  }

  // ── Task spawning ──

  private async _handleSpawnTask(
    tc: ToolCall,
    _message: InboundMessage,
  ): Promise<void> {
    const { input } = tc.arguments as { description: string; input: string };

    // Spawn task via existing Agent
    const taskId = await this.agent.submit(input, "main-agent");

    // Reply with acknowledgment (tool result in session)
    const toolMsg: Message = {
      role: "tool",
      content: JSON.stringify({ taskId, status: "spawned" }),
      toolCallId: tc.id,
    };
    this.sessionMessages.push(toolMsg);
    await this.sessionStore.append(toolMsg);

    // Register completion callback
    this.agent.onTaskComplete(taskId, (task) => {
      const result = task.context.finalResult;
      const error = task.context.error ?? undefined;
      this._onTaskResult(taskId, result, error);
    });

    logger.info({ taskId, input }, "task_spawned");
  }

  // ── Task result handling ──

  private async _handleTaskResult(
    taskId: string,
    result: unknown,
    error?: string,
  ): Promise<void> {
    // Inject task result as system message into session
    const resultText = error
      ? `[Task ${taskId} failed]\nError: ${error}`
      : `[Task ${taskId} completed]\nResult: ${JSON.stringify(result)}`;

    const systemMsg: Message = { role: "user", content: resultText };
    this.sessionMessages.push(systemMsg);
    await this.sessionStore.append(systemMsg, {
      type: "task_result",
      taskId,
    });

    // Determine channel from last user message
    const lastChannel = this._getLastChannel();
    if (!lastChannel) return;

    // LLM call to format the result for the user
    const system = this._buildSystemPrompt({ text: "", channel: lastChannel });
    const llmResult = await generateText({
      model: this.model,
      system,
      messages: this.sessionMessages,
    });

    if (llmResult.text) {
      const assistantMsg: Message = {
        role: "assistant",
        content: llmResult.text,
      };
      this.sessionMessages.push(assistantMsg);
      await this.sessionStore.append(assistantMsg);

      if (this.replyCallback) {
        this.replyCallback({ text: llmResult.text, channel: lastChannel });
      }
    }
  }

  // ── Helpers ──

  private _buildSystemPrompt(message: InboundMessage): string {
    const lines: string[] = [
      `You are ${this.persona.name}, ${this.persona.role}.`,
      "",
      `Personality: ${this.persona.personality.join(", ")}.`,
      `Speaking style: ${this.persona.style}.`,
      `Core values: ${this.persona.values.join(", ")}.`,
    ];

    if (this.persona.background) {
      lines.push("", `Background: ${this.persona.background}`);
    }

    lines.push("", `The user is messaging via ${message.channel.type}.`);

    lines.push(
      "",
      [
        "You are the user's primary conversation partner.",
        "",
        "You have direct access to these tools:",
        "- current_time: Get current date/time",
        "- memory_list / memory_read: Access long-term memory",
        "- task_list / task_replay: Check task history",
        "- spawn_task: Launch a background task for complex operations",
        "",
        "Handle directly: simple conversation, follow-ups, memory lookups, quick tool calls.",
        "Spawn a task: file I/O, shell commands, web search, multi-step work.",
        "If unsure whether it's simple, spawn a task.",
      ].join("\n"),
    );

    return lines.join("\n");
  }

  private _getLastChannel() {
    // Walk backwards through session to find the last channel info
    // (stored as metadata on user messages)
    // For now, return a default CLI channel
    return { type: "cli", channelId: "main" };
  }

  /** Expose agent for testing. */
  get taskAgent(): Agent {
    return this.agent;
  }
}
