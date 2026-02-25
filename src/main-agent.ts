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
import { reply } from "./tools/builtins/reply-tool.ts";

const logger = getLogger("main_agent");

export interface MainAgentDeps {
  model: LanguageModel;
  persona: Persona;
  settings?: Settings;
}

type QueueItem =
  | { kind: "message"; message: InboundMessage }
  | { kind: "task_result"; taskId: string; result: unknown; error?: string }
  | { kind: "think"; channel: { type: string; channelId: string; replyTo?: string } };

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
      reply,
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
        } else if (item.kind === "task_result") {
          await this._handleTaskResult(item.taskId, item.result, item.error);
        } else if (item.kind === "think") {
          await this._think(item.channel);
        }
      } catch (err) {
        logger.error({ error: err }, "main_agent_process_error");
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

    // One step of thinking
    await this._think(message.channel);
  }

  /**
   * One step of thinking: single LLM call → execute tools → results back to queue.
   *
   * This is NOT a loop. Each call does exactly one LLM invocation.
   * If the LLM returns tool calls, tool results are queued as a new event,
   * which will trigger another _think when processed.
   */
  private async _think(channel: { type: string; channelId: string; replyTo?: string }): Promise<void> {
    const system = this._buildSystemPrompt({ text: "", channel });
    const tools = this.toolRegistry.toLLMTools();

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

      // Execute all tool calls and collect results
      for (const tc of result.toolCalls) {
        if (tc.name === "reply") {
          const { text, channelId, replyTo } = tc.arguments as { text: string; channelId: string; replyTo?: string };
          const toolMsg: Message = {
            role: "tool",
            content: JSON.stringify({ delivered: true }),
            toolCallId: tc.id,
          };
          this.sessionMessages.push(toolMsg);
          await this.sessionStore.append(toolMsg);
          if (this.replyCallback) {
            this.replyCallback({
              text,
              channel: { type: channel.type, channelId, replyTo },
            });
          }
        } else if (tc.name === "spawn_task") {
          await this._handleSpawnTask(tc);
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

      // Tool results are now in session — queue another think step
      this.queue.push({ kind: "think", channel });
      return;
    }

    // No tool calls — inner monologue only (user doesn't see this)
    if (result.text) {
      const assistantMsg: Message = { role: "assistant", content: result.text };
      this.sessionMessages.push(assistantMsg);
      await this.sessionStore.append(assistantMsg);
    }
    // Done thinking for now. Next event will trigger new thinking.
  }

  // ── Task spawning ──

  private async _handleSpawnTask(tc: ToolCall): Promise<void> {
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
    const resultText = error
      ? `[Task ${taskId} failed]\nError: ${error}`
      : `[Task ${taskId} completed]\nResult: ${JSON.stringify(result)}`;

    const systemMsg: Message = { role: "user", content: resultText };
    this.sessionMessages.push(systemMsg);
    await this.sessionStore.append(systemMsg, {
      type: "task_result",
      taskId,
    });

    // Queue a think step — Main Agent will process the result
    const lastChannel = this._getLastChannel();
    if (lastChannel) {
      this.queue.push({ kind: "think", channel: lastChannel });
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

    // Inner monologue explanation
    lines.push("", [
      "## How You Think",
      "",
      "Your text output is your INNER MONOLOGUE — private thinking that",
      "the user never sees. Think freely: reason, analyze, hesitate, change your mind.",
      "",
      "To act on the outside world, use tool calls:",
      "- reply(): the ONLY way the user hears you",
      "- spawn_task(): delegate complex work to a background worker",
      "- Other tools: gather information for your thinking",
      "",
      "If you don't call reply(), the user receives silence.",
      "That's fine when no response is needed.",
    ].join("\n"));

    // Decision guidelines
    lines.push("", [
      "## When to Reply vs Spawn",
      "",
      "Reply directly (via reply tool) when:",
      "- Simple conversation, greetings, opinions, follow-ups",
      "- You can answer from session context or memory",
      "- A quick tool call is enough (time, memory lookup)",
      "",
      "Spawn a task when:",
      "- You need file I/O, shell commands, or web requests",
      "- The work requires multiple steps",
      "- You're unsure — err on the side of spawning",
      "",
      "After calling spawn_task, the task runs in the background.",
      "You will receive the result automatically when it completes.",
      "Do NOT poll with task_replay — just wait for the result to arrive.",
      "",
      "On task completion:",
      "- You will receive the result in your session",
      "- Think about it, then call reply() to inform the user",
    ].join("\n"));

    // Channel-specific style
    const channelType = message.channel.type;
    const styleGuides: Record<string, string> = {
      cli: "You are in a terminal session. Use detailed responses, code blocks are welcome. No character limit.",
      sms: "You are communicating via SMS. Keep replies under 160 characters. Be extremely concise.",
      slack: "You are in a Slack workspace. Use markdown formatting. Use threads for long discussions.",
      web: "You are on a web interface. You can use rich formatting and links.",
    };
    const style = styleGuides[channelType] ?? "Adapt your response style to the channel.";
    lines.push("", `## Response Style\n\n${style}`);

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
