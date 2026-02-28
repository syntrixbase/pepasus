/**
 * Project Worker Entry Point — runs inside a Bun Worker thread.
 *
 * Bootstraps a full Agent instance for a single project.
 * Communicates with the main thread via postMessage/onmessage:
 *   - Receives: init, message, llm_response, llm_error, shutdown
 *   - Sends:    ready, error, notify, llm_request, shutdown-complete
 *
 * LLM calls are proxied to the main thread via ProxyLanguageModel.
 */
declare var self: Worker;

import path from "node:path";
import { Agent } from "../agents/agent.ts";
import type { TaskNotification } from "../agents/agent.ts";
import { getSettings } from "../infra/config.ts";
import type { Settings } from "../infra/config.ts";
import type { GenerateTextResult } from "../infra/llm-types.ts";
import type { Persona } from "../identity/persona.ts";
import { parseProjectFile } from "./loader.ts";
import { ProxyLanguageModel } from "./proxy-language-model.ts";

// ── Module-level state (initialized on "init") ──────

let agent: Agent | null = null;
let proxyModel: ProxyLanguageModel | null = null;

// ── Message handler ──────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;

  switch (data.type) {
    case "init":
      await handleInit(data.projectPath as string);
      break;

    case "message":
      handleMessage(data.text as string);
      break;

    case "llm_response":
      handleLLMResponse(data.requestId as string, data.result as GenerateTextResult);
      break;

    case "llm_error":
      handleLLMError(data.requestId as string, data.error as string);
      break;

    case "shutdown":
      await handleShutdown();
      break;
  }
};

// ── Handlers ─────────────────────────────────────────

async function handleInit(projectPath: string): Promise<void> {
  try {
    // 1. Load global settings
    const settings = getSettings();

    // 2. Parse PROJECT.md
    const projectFilePath = path.join(projectPath, "PROJECT.md");
    const dirName = path.basename(projectPath);
    const projectDef = parseProjectFile(projectFilePath, dirName);

    if (!projectDef) {
      self.postMessage({
        type: "error",
        message: `Failed to parse PROJECT.md at ${projectFilePath}`,
      });
      return;
    }

    // 3. Create ProxyLanguageModel — LLM calls go to main thread
    const modelId = projectDef.model ?? settings.llm.roles.default;
    proxyModel = new ProxyLanguageModel(
      "proxy",
      modelId,
      (msg: unknown) => self.postMessage(msg),
    );

    // 4. Build project persona
    const persona: Persona = {
      name: `Project:${projectDef.name}`,
      role: "project agent",
      personality: ["focused", "autonomous"],
      style: "concise and task-oriented",
      values: ["accuracy", "efficiency"],
    };

    // 5. Override settings: dataDir → projectPath
    const projectSettings: Settings = {
      ...settings,
      dataDir: projectPath,
    };

    // 6. Create Agent
    agent = new Agent({
      model: proxyModel,
      persona,
      settings: projectSettings,
    });

    // 7. Register notify callback → forward to main thread
    agent.onNotify((notification: TaskNotification) => {
      let text: string;
      switch (notification.type) {
        case "completed":
          text = String(notification.result ?? "[Task completed]");
          break;
        case "failed":
          text = `[Task failed: ${notification.error}]`;
          break;
        default:
          // "notify"
          text = notification.message ?? "";
          break;
      }

      self.postMessage({ type: "notify", text });
    });

    // 8. Start agent
    await agent.start();

    // 9. Signal ready
    self.postMessage({ type: "ready" });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function handleMessage(text: string): void {
  if (!agent) return;
  agent.submit(text, "main-agent");
}

function handleLLMResponse(requestId: string, result: GenerateTextResult): void {
  if (!proxyModel) return;
  proxyModel.resolveRequest(requestId, result);
}

function handleLLMError(requestId: string, error: string): void {
  if (!proxyModel) return;
  proxyModel.rejectRequest(requestId, new Error(error));
}

async function handleShutdown(): Promise<void> {
  if (agent) {
    await agent.stop();
  }
  self.postMessage({ type: "shutdown-complete" });
  process.exit(0);
}
