/**
 * MainAgent — persistent LLM conversation partner.
 *
 * Sits between channel adapters and the Task System. Receives messages via
 * send(), processes them through an internal queue with LLM calls, and
 * replies via onReply() callback. Has curated simple tools and delegates
 * complex work to the existing Task System via spawn_task.
 */

import type { Message } from "../infra/llm-types.ts";
import { generateText } from "../infra/llm-utils.ts";
import type { Persona } from "../identity/persona.ts";
import type { Settings } from "../infra/config.ts";
import { getSettings } from "../infra/config.ts";
import { getLogger } from "../infra/logger.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ToolExecutor } from "../tools/executor.ts";
import type { InboundMessage, OutboundMessage } from "../channels/types.ts";
import { SessionStore } from "../session/store.ts";
import { Agent } from "./agent.ts";
import type { TaskNotification } from "./agent.ts";
import type { ToolCall } from "../models/tool.ts";
import { EstimateCounter } from "../infra/token-counter.ts";
import { getContextWindowSize } from "../session/context-windows.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import path from "node:path";
import { SkillRegistry, loadAllSkills } from "../skills/index.ts";

// Main Agent's curated tool set
import { mainAgentTools } from "../tools/builtins/index.ts";
import { MCPManager, wrapMCPTools } from "../mcp/index.ts";
import type { MCPServerConfig } from "../mcp/index.ts";

const logger = getLogger("main_agent");

export interface MainAgentDeps {
  models: ModelRegistry;
  persona: Persona;
  settings?: Settings;
}

type QueueItem =
  | { kind: "message"; message: InboundMessage }
  | { kind: "task_notify"; notification: TaskNotification }
  | { kind: "think"; channel: { type: string; channelId: string; replyTo?: string } };

export class MainAgent {
  private models: ModelRegistry;
  private persona: Persona;
  private settings: Settings;
  private agent: Agent; // Task execution engine
  private mcpManager: MCPManager | null = null;
  private sessionStore: SessionStore;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private sessionMessages: Message[] = [];
  private replyCallback: ((msg: OutboundMessage) => void) | null = null;
  private queue: QueueItem[] = [];
  private processing = false;
  private lastPromptTokens = 0;
  private tokenCounter = new EstimateCounter();
  private skillRegistry: SkillRegistry;

  constructor(deps: MainAgentDeps) {
    this.models = deps.models;
    this.persona = deps.persona;
    this.settings = deps.settings ?? getSettings();

    // Session persistence
    this.sessionStore = new SessionStore(this.settings.dataDir);

    // Task execution engine (existing Agent) — pass sub-agent + reflection models
    this.agent = new Agent({
      model: deps.models.get("subAgent"),
      reflectionModel: deps.models.get("reflection"),
      persona: deps.persona,
      settings: this.settings,
    });

    // Main Agent's curated tool set
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerMany(mainAgentTools);

    // Tool executor for Main Agent's simple tools (no EventBus needed)
    this.toolExecutor = new ToolExecutor(
      this.toolRegistry,
      { emit: () => {} }, // Main Agent doesn't use EventBus for its own tools
      (this.settings.tools?.timeout ?? 30) * 1000,
    );

    // Skill system
    this.skillRegistry = new SkillRegistry();
  }

  /** Start the Main Agent and underlying Task System. */
  async start(): Promise<void> {
    // Load session history from disk
    this.sessionMessages = await this.sessionStore.load();

    // Register notification callback BEFORE agent.start()
    this.agent.onNotify((notification) => {
      this.queue.push({ kind: "task_notify", notification });
      this._processQueue();
    });

    // Start task execution engine
    await this.agent.start();

    // Connect to MCP servers and register tools in both Agent and MainAgent
    const mcpConfigs = (this.settings.tools?.mcpServers ?? []) as MCPServerConfig[];
    if (mcpConfigs.length > 0) {
      this.mcpManager = new MCPManager();
      await this.mcpManager.connectAll(mcpConfigs);

      // Register in Agent's tool registry (for task execution)
      await this.agent.loadMCPTools(this.mcpManager, mcpConfigs);

      // Register in MainAgent's own tool registry (for conversation)
      for (const config of mcpConfigs.filter((c) => c.enabled)) {
        try {
          const mcpTools = await this.mcpManager.listTools(config.name);
          const wrapped = wrapMCPTools(config.name, mcpTools, this.mcpManager);
          for (const tool of wrapped) {
            this.toolRegistry.register(tool);
          }
        } catch (err) {
          logger.warn(
            { server: config.name, error: err instanceof Error ? err.message : String(err) },
            "main_agent_mcp_tools_register_failed",
          );
        }
      }
      logger.info(
        { servers: mcpConfigs.filter((c) => c.enabled).length },
        "mcp_connected",
      );
    }

    // Load skills from builtin and user directories
    const builtinSkillDir = path.join(process.cwd(), "skills");
    const userSkillDir = path.join(this.settings.dataDir, "skills");
    this.skillRegistry.registerMany(loadAllSkills(builtinSkillDir, userSkillDir));
    logger.info({ skillCount: this.skillRegistry.listAll().length }, "skills_loaded");

    logger.info(
      { sessionMessages: this.sessionMessages.length },
      "main_agent_started",
    );
  }

  /** Stop the Main Agent. */
  async stop(): Promise<void> {
    // Disconnect MCP servers first (before agent stops)
    if (this.mcpManager) {
      await this.mcpManager.disconnectAll();
      this.mcpManager = null;
    }

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
        } else if (item.kind === "task_notify") {
          await this._handleTaskNotify(item.notification);
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
    const text = message.text.trim();

    // Check for /skill command
    if (text.startsWith("/")) {
      const handled = await this._handleSkillCommand(text, message.channel);
      if (handled) return;
    }

    // Normal message: add to session and think
    const userMsg: Message = { role: "user", content: message.text };
    this.sessionMessages.push(userMsg);
    await this.sessionStore.append(userMsg, { channel: message.channel });

    await this._think(message.channel);
  }

  /**
   * Handle /skill-name args command.
   * Returns true if handled, false if not a skill (treat as normal message).
   */
  private async _handleSkillCommand(
    text: string,
    channel: { type: string; channelId: string; replyTo?: string },
  ): Promise<boolean> {
    const spaceIdx = text.indexOf(" ");
    const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? undefined : text.slice(spaceIdx + 1).trim() || undefined;

    const skill = this.skillRegistry.get(name);
    if (!skill) return false;
    if (!skill.userInvocable) return false;

    const body = this.skillRegistry.loadBody(name, args);
    if (!body) return false;

    if (skill.context === "fork") {
      // Spawn task with skill content
      const taskId = await this.agent.submit(body, "skill:" + name);
      const systemMsg: Message = {
        role: "user",
        content: `[Skill "${name}" spawned as task ${taskId}]`,
      };
      this.sessionMessages.push(systemMsg);
      await this.sessionStore.append(systemMsg);
      logger.info({ skill: name, taskId }, "skill_fork_spawned");
    } else {
      // Inline: inject skill content as user message, then think
      const skillMsg: Message = {
        role: "user",
        content: `[Skill: ${name} invoked]\n\n${body}`,
      };
      this.sessionMessages.push(skillMsg);
      await this.sessionStore.append(skillMsg);
      await this._think(channel);
    }

    return true;
  }

  /**
   * One step of thinking: single LLM call → execute tools → results back to queue.
   *
   * This is NOT a loop. Each call does exactly one LLM invocation.
   * If the LLM returns tool calls, tool results are queued as a new event,
   * which will trigger another _think when processed.
   */
  private async _think(channel: { type: string; channelId: string; replyTo?: string }): Promise<void> {
    // Check if compact is needed before LLM call
    await this._checkAndCompact();

    const system = this._buildSystemPrompt({ text: "", channel });
    const tools = this.toolRegistry.toLLMTools();

    const result = await generateText({
      model: this.models.get("default"),
      system,
      messages: this.sessionMessages,
      tools: tools.length ? tools : undefined,
      toolChoice: tools.length ? "auto" : undefined,
    });

    // Update lastPromptTokens for compact estimation
    this.lastPromptTokens = result.usage.promptTokens;

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

      // Execute all tool calls, track whether any need LLM follow-up
      let needsFollowUp = false;

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
        } else if (tc.name === "resume_task") {
          const resumeNeedsFollowUp = await this._handleResumeTask(tc);
          if (resumeNeedsFollowUp) needsFollowUp = true;
        } else if (tc.name === "use_skill") {
          // Handle use_skill tool call
          const { skill: skillName, args: skillArgs } = tc.arguments as { skill: string; args?: string };
          const skill = this.skillRegistry.get(skillName);

          if (!skill) {
            const toolMsg: Message = {
              role: "tool",
              content: JSON.stringify({ error: `Skill "${skillName}" not found` }),
              toolCallId: tc.id,
            };
            this.sessionMessages.push(toolMsg);
            await this.sessionStore.append(toolMsg);
            needsFollowUp = true;
          } else if (skill.context === "fork") {
            const body = this.skillRegistry.loadBody(skillName, skillArgs);
            const taskId = await this.agent.submit(body ?? "", "skill:" + skillName);
            const toolMsg: Message = {
              role: "tool",
              content: JSON.stringify({ taskId, status: "spawned", skill: skillName }),
              toolCallId: tc.id,
            };
            this.sessionMessages.push(toolMsg);
            await this.sessionStore.append(toolMsg);
            // fork does NOT trigger follow-up think
          } else {
            // Inline: return skill content as tool result
            const body = this.skillRegistry.loadBody(skillName, skillArgs);
            const toolMsg: Message = {
              role: "tool",
              content: body ?? `Skill "${skillName}" body could not be loaded`,
              toolCallId: tc.id,
            };
            this.sessionMessages.push(toolMsg);
            await this.sessionStore.append(toolMsg);
            needsFollowUp = true; // LLM needs to follow skill instructions
          }
        } else {
          // Execute simple tool directly — results need LLM follow-up
          needsFollowUp = true;
          const toolResult = await this.toolExecutor.execute(
            tc.name,
            tc.arguments,
            {
              taskId: "main-agent",
              memoryDir: `${this.settings.dataDir}/memory`,
              sessionDir: `${this.settings.dataDir}/main`,
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

      // Only queue another think if there are tool results the LLM needs to process.
      // reply() and spawn_task() are terminal actions — their results don't need follow-up.
      if (needsFollowUp) {
        this.queue.push({ kind: "think", channel });
      }
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
    const taskId = await this.agent.submit(input, "main-agent");

    const toolMsg: Message = {
      role: "tool",
      content: JSON.stringify({ taskId, status: "spawned" }),
      toolCallId: tc.id,
    };
    this.sessionMessages.push(toolMsg);
    await this.sessionStore.append(toolMsg);

    // No per-task callback — Agent calls onNotify automatically
    logger.info({ taskId, input }, "task_spawned");
  }

  // ── Task resuming ──

  /**
   * Handle resume_task tool call.
   * Returns true if the LLM needs a follow-up think (e.g., on error).
   */
  private async _handleResumeTask(tc: ToolCall): Promise<boolean> {
    const { task_id, input } = tc.arguments as { task_id: string; input: string };

    try {
      await this.agent.resume(task_id, input);

      const toolMsg: Message = {
        role: "tool",
        content: JSON.stringify({ taskId: task_id, status: "resumed" }),
        toolCallId: tc.id,
      };
      this.sessionMessages.push(toolMsg);
      await this.sessionStore.append(toolMsg);

      logger.info({ taskId: task_id, input }, "task_resumed");
      return false; // No follow-up needed — notification arrives via onNotify
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const toolMsg: Message = {
        role: "tool",
        content: JSON.stringify({ error: errorMsg }),
        toolCallId: tc.id,
      };
      this.sessionMessages.push(toolMsg);
      await this.sessionStore.append(toolMsg);

      logger.warn({ taskId: task_id, error: errorMsg }, "task_resume_failed");
      return true; // LLM needs to see the error and react
    }
  }

  // ── Task notification handling ──

  private async _handleTaskNotify(notification: TaskNotification): Promise<void> {
    const resultText = notification.type === "failed"
      ? `[Task ${notification.taskId} failed]\nError: ${notification.error}`
      : `[Task ${notification.taskId} completed]\nResult: ${JSON.stringify(notification.result)}`;

    const systemMsg: Message = { role: "user", content: resultText };
    this.sessionMessages.push(systemMsg);
    await this.sessionStore.append(systemMsg, {
      type: "task_notify",
      taskId: notification.taskId,
    });

    const lastChannel = this._getLastChannel();
    if (lastChannel) {
      this.queue.push({ kind: "think", channel: lastChannel });
    }
  }

  // ── Compact ──

  /**
   * Check if session needs compaction based on token estimate.
   * Returns true if compact was performed.
   */
  private async _checkAndCompact(): Promise<boolean> {
    const contextWindow = getContextWindowSize(
      this.models.getModelId("default"),
      this.settings.llm.contextWindow,
    );
    const threshold = this.settings.session?.compactThreshold ?? 0.8;
    const maxTokens = contextWindow * threshold;

    // Estimate current token usage
    let estimatedTokens: number;
    if (this.lastPromptTokens > 0) {
      // Use lastPromptTokens as base, but also estimate full session
      // to catch cases where many messages were added since last LLM call
      const fullEstimate = await this.sessionStore.estimateTokens(
        this.sessionMessages,
        this.tokenCounter,
      );
      // Use the larger of: lastPromptTokens or full estimate
      estimatedTokens = Math.max(this.lastPromptTokens, fullEstimate);
    } else {
      // First call: no lastPromptTokens, estimate everything
      estimatedTokens = await this.sessionStore.estimateTokens(
        this.sessionMessages,
        this.tokenCounter,
      );
    }

    if (estimatedTokens < maxTokens) return false;

    // Trigger compact
    logger.info(
      { estimatedTokens, maxTokens, threshold },
      "compact_triggered",
    );

    // 1. Generate summary via independent LLM call
    const summary = await this._generateSummary();

    // 2. Archive current session and create new one with summary
    const archiveName = await this.sessionStore.compact(summary);

    // 3. Reset in-memory state
    this.sessionMessages = await this.sessionStore.load();
    this.lastPromptTokens = 0;

    logger.info({ archiveName }, "compact_completed");
    return true;
  }

  /**
   * Generate a summary of the current session via an independent LLM call.
   * This is NOT part of Main Agent's inner monologue — it's a system operation.
   */
  private async _generateSummary(): Promise<string> {
    const systemPrompt = [
      "You are a conversation summarizer. Summarize the following conversation.",
      "",
      "Your summary MUST include:",
      "- The user's most recent intent and what needs to happen next",
      "- Key decisions and conclusions reached",
      "- Ongoing tasks and their current status",
      "- Important user preferences or context",
      "",
      "Your summary MUST NOT include:",
      "- Greetings or small talk",
      "- Internal reasoning or thinking process",
      "- Redundant tool call details",
      "- Intermediate results that led to final conclusions",
      "",
      "Write the summary as a concise, structured document.",
      "Use bullet points for clarity.",
    ].join("\n");

    const result = await generateText({
      model: this.models.get("compact"),
      system: systemPrompt,
      messages: this.sessionMessages,
    });

    return result.text || "No summary generated.";
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
      "the user NEVER sees. No matter what you write in text, the user",
      "cannot read it. It is only visible to you.",
      "",
      "The ONLY way to communicate with the user is by calling the reply() tool.",
      "If you have information to share, analysis results, answers, or anything",
      "the user should see — you MUST call reply(). Otherwise it is lost.",
      "",
      "Available tool calls:",
      "- reply(): the ONLY way the user hears you — ALWAYS call this when you have something to say",
      "- spawn_task(): delegate complex work to a background worker",
      "- Other tools: gather information for your thinking",
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
      "- Think about it, then ALWAYS call reply() to inform the user",
      "- Never just think about the result without calling reply()",
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

    // Session history / compact info
    lines.push("", [
      "## Session History",
      "",
      "Your conversation history may have been compacted to stay within context limits.",
      "If you see a system message starting with a summary, the full previous conversation",
      "is archived. You can read it with session_archive_read(file) if you need more detail.",
      "The archive filename is in the compact metadata.",
    ].join("\n"));

    // Skill metadata injection
    const contextWindow = getContextWindowSize(
      this.models.getModelId("default"),
      this.settings.llm.contextWindow,
    );
    const skillBudget = Math.max(Math.floor(contextWindow * 0.02 * 4), 16_000); // 2% in chars, min 16K
    const skillMetadata = this.skillRegistry.getMetadataForPrompt(skillBudget);
    if (skillMetadata) {
      lines.push("", skillMetadata);
    }

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

  /** Expose skill registry for testing. */
  get skills(): SkillRegistry {
    return this.skillRegistry;
  }
}
