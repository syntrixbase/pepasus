/**
 * Tests for ProjectAdapter — ChannelAdapter multiplexer for Worker threads.
 *
 * We test the adapter's management logic (type, activeCount, has, error paths)
 * without spawning real Worker threads, since that requires the actual Worker
 * entry point file (Task 5).
 *
 * For _handleLLMRequest and worker.onerror, we inject mock Worker objects
 * directly into the adapter's workers Map to avoid real thread spawning.
 */
import { describe, it, expect } from "bun:test";
import { ProjectAdapter } from "@pegasus/projects/project-adapter.ts";
import type { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LanguageModel, GenerateTextResult } from "@pegasus/infra/llm-types.ts";

describe("ProjectAdapter", () => {
  it("should have type 'project'", () => {
    const adapter = new ProjectAdapter();
    expect(adapter.type).toBe("project");
  });

  it("should start with 0 active count", () => {
    const adapter = new ProjectAdapter();
    expect(adapter.activeCount).toBe(0);
  });

  it("has() returns false for unknown project", () => {
    const adapter = new ProjectAdapter();
    expect(adapter.has("nonexistent")).toBe(false);
  });

  it("deliver() should silently handle unknown channelId (no throw)", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Should not throw when delivering to unknown project
    await expect(
      adapter.deliver({
        text: "hello",
        channel: { type: "project", channelId: "unknown-project" },
      }),
    ).resolves.toBeUndefined();
  });

  it("startProject should throw if adapter not started", () => {
    const adapter = new ProjectAdapter();
    // Adapter not started — agentSend is null
    expect(() => adapter.startProject("proj-1", "/tmp/proj-1")).toThrow(
      "ProjectAdapter not started",
    );
  });

  it("stopProject should be no-op for unknown project", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Should not throw when stopping unknown project
    await expect(adapter.stopProject("nonexistent")).resolves.toBeUndefined();
  });

  it("stop() with no workers should work", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Should complete without error
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.activeCount).toBe(0);
  });

  it("should implement ChannelAdapter interface", () => {
    const adapter = new ProjectAdapter();
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.deliver).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(adapter.type).toBe("project");
  });

  it("setModelRegistry should accept a ModelRegistry", () => {
    const adapter = new ProjectAdapter();
    // Just verify it doesn't throw — we pass a mock object
    const mockRegistry = { get: () => ({}) } as any;
    adapter.setModelRegistry(mockRegistry);
    // No assertion needed — if it doesn't throw, it works
  });

  it("_handleLLMRequest should warn and return for unknown project", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Should not throw for unknown project
    await expect(
      adapter._handleLLMRequest("unknown", {
        type: "llm_request",
        requestId: "req-1",
        options: { messages: [] },
      }),
    ).resolves.toBeUndefined();
  });

  it("_handleLLMRequest should post llm_error when ModelRegistry not configured", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Inject a mock Worker (no real thread)
    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("test-proj", mockWorker);

    // Do NOT call setModelRegistry — models is null
    await adapter._handleLLMRequest("test-proj", {
      type: "llm_request",
      requestId: "req-no-registry",
      options: { messages: [] },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "llm_error",
      requestId: "req-no-registry",
      error: "ModelRegistry not configured",
    });
  });

  it("_handleLLMRequest should call model.generate and post llm_response", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Inject mock Worker
    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("test-proj", mockWorker);

    // Create a mock ModelRegistry with a model that returns a stub result
    const stubResult: GenerateTextResult = {
      text: "Hello from mock model",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 10 },
    };
    const mockModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        return stubResult;
      },
    };
    const mockRegistry = { get: () => mockModel } as unknown as ModelRegistry;
    adapter.setModelRegistry(mockRegistry);

    await adapter._handleLLMRequest("test-proj", {
      type: "llm_request",
      requestId: "req-success",
      options: { messages: [] },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "llm_response",
      requestId: "req-success",
      result: stubResult,
    });
  });

  it("_handleLLMRequest should post llm_error when model.generate throws", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Inject mock Worker
    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("test-proj", mockWorker);

    // Create a mock ModelRegistry with a model that throws
    const mockModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        throw new Error("LLM service unavailable");
      },
    };
    const mockRegistry = { get: () => mockModel } as unknown as ModelRegistry;
    adapter.setModelRegistry(mockRegistry);

    await adapter._handleLLMRequest("test-proj", {
      type: "llm_request",
      requestId: "req-fail",
      options: { messages: [] },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "llm_error",
      requestId: "req-fail",
      error: "LLM service unavailable",
    });
  });

  it("_handleLLMRequest should stringify non-Error throws", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Inject mock Worker
    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("test-proj", mockWorker);

    // Create a mock model that throws a non-Error value
    const mockModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        throw "raw string error";
      },
    };
    const mockRegistry = { get: () => mockModel } as unknown as ModelRegistry;
    adapter.setModelRegistry(mockRegistry);

    await adapter._handleLLMRequest("test-proj", {
      type: "llm_request",
      requestId: "req-non-error",
      options: { messages: [] },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "llm_error",
      requestId: "req-non-error",
      error: "raw string error",
    });
  });

  it("deliver should postMessage to the correct worker", async () => {
    const adapter = new ProjectAdapter();
    await adapter.start({ send: () => {} });

    // Inject mock Worker
    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("proj-deliver", mockWorker);

    await adapter.deliver({
      text: "hello worker",
      channel: { type: "project", channelId: "proj-deliver" },
    });

    expect(posted).toHaveLength(1);
    expect((posted[0] as any).type).toBe("message");
    expect((posted[0] as any).message.text).toBe("hello worker");
  });
});

/**
 * Tests that exercise the worker.onmessage and worker.onerror handlers
 * inside startProject() by monkey-patching the global Worker constructor.
 */
describe("ProjectAdapter — worker event handlers (mocked Worker)", () => {
  const OriginalWorker = globalThis.Worker;

  // Helper: create a fake Worker class that captures onmessage/onerror/addEventListener
  function createFakeWorkerClass() {
    const instances: FakeWorker[] = [];

    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      posted: unknown[] = [];
      closeListeners: (() => void)[] = [];

      postMessage(data: unknown) {
        this.posted.push(data);
      }

      addEventListener(event: string, handler: () => void) {
        if (event === "close") {
          this.closeListeners.push(handler);
        }
      }

      terminate() {
        // no-op
      }

      constructor() {
        instances.push(this);
      }
    }

    return { FakeWorker, instances };
  }

  it("worker.onmessage 'llm_request' branch should call _handleLLMRequest", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new ProjectAdapter();
      const received: unknown[] = [];
      await adapter.start({ send: (msg) => received.push(msg) });

      // Set up a model registry that returns a stub result
      const stubResult: GenerateTextResult = {
        text: "response from onmessage path",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      };
      const mockModel: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          return stubResult;
        },
      };
      const mockRegistry = { get: () => mockModel } as unknown as ModelRegistry;
      adapter.setModelRegistry(mockRegistry);

      // startProject creates a FakeWorker and registers onmessage/onerror
      adapter.startProject("proj-onmsg", "/tmp/proj-onmsg");
      expect(instances).toHaveLength(1);

      const fakeWorker = instances[0]!;
      expect(fakeWorker.onmessage).not.toBeNull();

      // Simulate Worker posting an llm_request message
      fakeWorker.onmessage!(new MessageEvent("message", {
        data: {
          type: "llm_request",
          requestId: "req-from-worker",
          options: { messages: [] },
        },
      }));

      // Allow the async _handleLLMRequest to complete
      await Bun.sleep(50);

      // The adapter should have posted llm_response back to the worker
      // posted[0] is the init message, posted[1] should be the llm_response
      const llmResponse = fakeWorker.posted.find(
        (msg: any) => msg.type === "llm_response",
      ) as any;
      expect(llmResponse).toBeDefined();
      expect(llmResponse.requestId).toBe("req-from-worker");
      expect(llmResponse.result).toEqual(stubResult);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage 'notify' branch should forward to agentSend", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new ProjectAdapter();
      const received: unknown[] = [];
      await adapter.start({ send: (msg) => received.push(msg) });

      adapter.startProject("proj-notify", "/tmp/proj-notify");
      const fakeWorker = instances[0]!;

      // Simulate Worker posting a notify message
      const inboundMsg = {
        text: "hello from worker",
        channel: { type: "project", channelId: "proj-notify" },
      };
      fakeWorker.onmessage!(new MessageEvent("message", {
        data: { type: "notify", message: inboundMsg },
      }));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(inboundMsg);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onerror should log error without throwing", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new ProjectAdapter();
      await adapter.start({ send: () => {} });

      adapter.startProject("proj-err", "/tmp/proj-err");
      const fakeWorker = instances[0]!;
      expect(fakeWorker.onerror).not.toBeNull();

      // Simulate Worker error — should not throw
      expect(() => {
        fakeWorker.onerror!(new ErrorEvent("error", {
          message: "Worker crashed",
        }));
      }).not.toThrow();
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage unknown type should log warning", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new ProjectAdapter();
      await adapter.start({ send: () => {} });

      adapter.startProject("proj-unknown-msg", "/tmp/proj-unknown-msg");
      const fakeWorker = instances[0]!;

      // Simulate Worker posting an unknown message type — should not throw
      expect(() => {
        fakeWorker.onmessage!(new MessageEvent("message", {
          data: { type: "some_unknown_type" },
        }));
      }).not.toThrow();
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker close event should cleanup and notify agentSend", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new ProjectAdapter();
      const received: unknown[] = [];
      await adapter.start({ send: (msg) => received.push(msg) });

      adapter.startProject("proj-close", "/tmp/proj-close");
      expect(adapter.has("proj-close")).toBe(true);
      expect(adapter.activeCount).toBe(1);

      const fakeWorker = instances[0]!;

      // Trigger all close listeners (simulates Worker close event)
      for (const listener of fakeWorker.closeListeners) {
        listener();
      }

      // Worker should be removed from the map
      expect(adapter.has("proj-close")).toBe(false);
      expect(adapter.activeCount).toBe(0);

      // agentSend should have received a termination notification
      expect(received).toHaveLength(1);
      const msg = received[0] as any;
      expect(msg.text).toContain('Project "proj-close" Worker has terminated');
      expect(msg.channel.channelId).toBe("proj-close");
      expect(msg.metadata.event).toBe("worker_closed");
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("stopProject should handle graceful close via close event", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new ProjectAdapter();
      await adapter.start({ send: () => {} });

      adapter.startProject("proj-graceful", "/tmp/proj-graceful");
      expect(adapter.has("proj-graceful")).toBe(true);

      const fakeWorker = instances[0]!;

      // Override addEventListener to immediately fire close when stopProject registers its listener
      const originalAddEventListener = fakeWorker.addEventListener.bind(fakeWorker);
      fakeWorker.addEventListener = (event: string, handler: () => void) => {
        originalAddEventListener(event, handler);
        // Immediately fire close to simulate graceful shutdown
        if (event === "close") {
          setTimeout(() => {
            for (const l of fakeWorker.closeListeners) l();
          }, 10);
        }
      };

      await adapter.stopProject("proj-graceful");

      // Worker should be cleaned up by the close handler
      expect(adapter.has("proj-graceful")).toBe(false);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  }, 5_000);

  it("stopProject should force terminate on timeout", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new ProjectAdapter();
      // Use a very short timeout so the test doesn't block
      adapter.shutdownTimeoutMs = 50;
      await adapter.start({ send: () => {} });

      adapter.startProject("proj-timeout", "/tmp/proj-timeout");
      expect(adapter.has("proj-timeout")).toBe(true);

      const fakeWorker = instances[0]!;

      // Track if terminate was called
      let terminateCalled = false;
      fakeWorker.terminate = () => { terminateCalled = true; };

      // The FakeWorker's addEventListener stores handlers but never fires them.
      // So stopProject will timeout and force-terminate.
      await adapter.stopProject("proj-timeout");

      expect(terminateCalled).toBe(true);
      expect(adapter.has("proj-timeout")).toBe(false);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  }, 5_000);
});
