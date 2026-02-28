/**
 * ProxyLanguageModel — LanguageModel that forwards calls to the main thread.
 *
 * Used inside Worker threads so LLM requests are proxied to the main thread
 * which holds unified credentials and concurrency control.
 * The Worker's postMessage function is injected as `postFn`.
 */
import type { GenerateTextResult, LanguageModel, Message } from "../infra/llm-types.ts";
import type { ToolDefinition } from "../models/tool.ts";

/** Shape of the message posted to the main thread for an LLM request. */
export interface LLMProxyRequest {
  type: "llm_request";
  requestId: string;
  options: {
    system?: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none";
  };
  modelOverride?: string;
}

interface PendingRequest {
  resolve: (result: GenerateTextResult) => void;
  reject: (error: Error) => void;
}

let nextId = 0;

/**
 * ProxyLanguageModel implements LanguageModel but forwards every generate()
 * call to the main thread via postFn. The main thread processes the request,
 * then the Worker calls resolveRequest / rejectRequest when the response arrives.
 */
export class ProxyLanguageModel implements LanguageModel {
  readonly provider: string;
  readonly modelId: string;

  private readonly postFn: (data: unknown) => void;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(provider: string, modelId: string, postFn: (data: unknown) => void) {
    this.provider = provider;
    this.modelId = modelId;
    this.postFn = postFn;
  }

  generate(options: {
    system?: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none";
  }): Promise<GenerateTextResult> {
    const requestId = `proxy_${++nextId}_${Date.now()}`;

    const promise = new Promise<GenerateTextResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    const request: LLMProxyRequest = {
      type: "llm_request",
      requestId,
      options,
      modelOverride: `${this.provider}/${this.modelId}`,
    };

    this.postFn(request);

    return promise;
  }

  /** Resolve a pending request with the LLM result from the main thread. */
  resolveRequest(requestId: string, result: GenerateTextResult): void {
    const entry = this.pending.get(requestId);
    if (!entry) return; // no-op for unknown requestId
    this.pending.delete(requestId);
    entry.resolve(result);
  }

  /** Reject a pending request with an error from the main thread. */
  rejectRequest(requestId: string, error: Error): void {
    const entry = this.pending.get(requestId);
    if (!entry) return; // no-op for unknown requestId
    this.pending.delete(requestId);
    entry.reject(error);
  }
}
