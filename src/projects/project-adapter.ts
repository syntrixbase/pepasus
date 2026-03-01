/**
 * ProjectAdapter — ChannelAdapter that multiplexes multiple Worker threads.
 *
 * Each Project runs in a Bun Worker thread. The ProjectAdapter manages
 * Worker lifecycle and routes messages by channelId (projectId).
 * LLM requests from Workers are proxied back to the main thread via
 * ModelRegistry.
 */
import { getLogger } from "../infra/logger.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "../channels/types.ts";
import type { LLMProxyRequest } from "./proxy-language-model.ts";

const logger = getLogger("project_adapter");

/** Messages sent from Worker → Main thread. */
type WorkerOutbound =
  | { type: "notify"; message: InboundMessage }
  | LLMProxyRequest;

/** Messages sent from Main thread → Worker. */
type WorkerInbound =
  | { type: "init"; projectPath: string; contextWindow?: number }
  | { type: "message"; message: OutboundMessage }
  | { type: "shutdown" }
  | { type: "llm_response"; requestId: string; result: unknown }
  | { type: "llm_error"; requestId: string; error: string };

const WORKER_URL = new URL("./project-worker.ts", import.meta.url).href;

export class ProjectAdapter implements ChannelAdapter {
  readonly type = "project";
  /** Timeout (ms) for graceful Worker shutdown before force-terminate. */
  shutdownTimeoutMs = 30_000;
  private workers = new Map<string, Worker>();
  private agentSend: ((msg: InboundMessage) => void) | null = null;
  private models: ModelRegistry | null = null;

  /** Number of running Workers. */
  get activeCount(): number {
    return this.workers.size;
  }

  /** Check if a Worker exists for the given projectId. */
  has(projectId: string): boolean {
    return this.workers.has(projectId);
  }

  /** Set ModelRegistry for LLM proxy handling. */
  setModelRegistry(models: ModelRegistry): void {
    this.models = models;
  }

  /** ChannelAdapter.start — store the agent.send callback. */
  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    this.agentSend = agent.send;
    logger.info("project_adapter_started");
  }

  /** ChannelAdapter.deliver — route outbound message to Worker by channelId. */
  async deliver(message: OutboundMessage): Promise<void> {
    const projectId = message.channel.channelId;
    const worker = this.workers.get(projectId);
    if (!worker) {
      logger.warn({ projectId }, "deliver_to_unknown_project");
      return;
    }

    const msg: WorkerInbound = { type: "message", message };
    worker.postMessage(msg);
  }

  /**
   * Spawn a Worker for a project.
   *
   * Sets up message handlers for "notify" (→ agent.send) and "llm_request"
   * (→ _handleLLMRequest). Sends `{ type: "init", projectPath }` to the Worker.
   *
   * @throws if adapter not started or Worker already exists
   */
  startProject(projectId: string, projectPath: string): void {
    if (!this.agentSend) {
      throw new Error("ProjectAdapter not started — call start() first");
    }
    if (this.workers.has(projectId)) {
      throw new Error(`Worker already exists for project "${projectId}"`);
    }

    const worker = new Worker(WORKER_URL);

    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const data = event.data;

      switch (data.type) {
        case "notify":
          this.agentSend!(data.message);
          break;
        case "llm_request":
          this._handleLLMRequest(projectId, data).catch((err) => {
            logger.error({ projectId, error: String(err) }, "llm_proxy_error");
          });
          break;
        default:
          logger.warn({ projectId, data }, "unknown_worker_message");
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      logger.error(
        { projectId, error: event.message },
        "worker_error",
      );
    };

    // Handle Worker close — cleanup and notify MainAgent
    worker.addEventListener("close", () => {
      this.workers.delete(projectId);
      logger.info({ projectId }, "worker_closed");

      // Notify MainAgent that the project Worker has terminated
      if (this.agentSend) {
        this.agentSend({
          text: `[system] Project "${projectId}" Worker has terminated.`,
          channel: { type: "project", channelId: projectId },
          metadata: { system: true, event: "worker_closed" },
        });
      }
    });

    this.workers.set(projectId, worker);

    // Initialize the Worker with the project path and resolved contextWindow
    const contextWindow = this.models?.getContextWindowForTier("balanced");
    const initMsg: WorkerInbound = {
      type: "init",
      projectPath,
      ...(contextWindow != null && { contextWindow }),
    };
    worker.postMessage(initMsg);

    logger.info({ projectId, projectPath }, "worker_started");
  }

  /**
   * Stop a project Worker gracefully.
   *
   * Sends "shutdown" message, waits up to 30s for the Worker to close,
   * then force-terminates if still running.
   */
  async stopProject(projectId: string): Promise<void> {
    const worker = this.workers.get(projectId);
    if (!worker) {
      logger.warn({ projectId }, "stop_unknown_project");
      return;
    }

    // Send shutdown signal
    const shutdownMsg: WorkerInbound = { type: "shutdown" };
    worker.postMessage(shutdownMsg);

    // Wait for close with timeout
    const closed = await Promise.race([
      new Promise<boolean>((resolve) => {
        worker.addEventListener("close", () => resolve(true));
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), this.shutdownTimeoutMs),
      ),
    ]);

    if (!closed) {
      logger.warn({ projectId }, "worker_shutdown_timeout_force_terminate");
      worker.terminate();
      this.workers.delete(projectId);
    }
  }

  /** ChannelAdapter.stop — stop all Workers. */
  async stop(): Promise<void> {
    const projectIds = [...this.workers.keys()];
    await Promise.all(projectIds.map((id) => this.stopProject(id)));
    logger.info("project_adapter_stopped");
  }

  /**
   * Handle an LLM proxy request from a Worker.
   *
   * Uses ModelRegistry to call the LLM, then sends the result back to
   * the Worker as llm_response or llm_error.
   */
  async _handleLLMRequest(
    projectId: string,
    request: LLMProxyRequest,
  ): Promise<void> {
    const worker = this.workers.get(projectId);
    if (!worker) {
      logger.warn({ projectId, requestId: request.requestId }, "llm_request_for_unknown_project");
      return;
    }

    if (!this.models) {
      const errorMsg: WorkerInbound = {
        type: "llm_error",
        requestId: request.requestId,
        error: "ModelRegistry not configured",
      };
      worker.postMessage(errorMsg);
      return;
    }

    try {
      const model = this.models.getForTier("balanced");
      const result = await model.generate(request.options);

      const responseMsg: WorkerInbound = {
        type: "llm_response",
        requestId: request.requestId,
        result,
      };
      worker.postMessage(responseMsg);
    } catch (err) {
      const errorMsg: WorkerInbound = {
        type: "llm_error",
        requestId: request.requestId,
        error: err instanceof Error ? err.message : String(err),
      };
      worker.postMessage(errorMsg);
    }
  }
}
