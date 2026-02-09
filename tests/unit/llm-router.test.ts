import { describe, expect, test } from "bun:test";
import { LLMError } from "@pegasus/infra/errors.ts";
import { LLMProvider, type ChatOptions } from "@pegasus/llm/base.ts";
import { LLMRouter } from "@pegasus/llm/router.ts";
import type { Message } from "@pegasus/models/message.ts";
import { createMessage, Role } from "@pegasus/models/message.ts";

class MockProvider extends LLMProvider {
  readonly name: string;
  readonly model: string;
  private fail: boolean;
  callCount = 0;

  constructor(providerName: string, opts?: { fail?: boolean }) {
    super();
    this.name = providerName;
    this.model = `mock-${providerName}`;
    this.fail = opts?.fail ?? false;
  }

  async chat(_messages: Message[], _options?: ChatOptions): Promise<Message> {
    this.callCount++;
    if (this.fail) throw new LLMError(`${this.name} failed`);
    return createMessage(Role.ASSISTANT, `Response from ${this.name}`, {
      metadata: { provider: this.name },
    });
  }

  async chatWithTools(
    _messages: Message[],
    _tools: Record<string, unknown>[],
    _options?: ChatOptions,
  ): Promise<Message> {
    this.callCount++;
    if (this.fail) throw new LLMError(`${this.name} failed`);
    return createMessage(Role.ASSISTANT, `Tool response from ${this.name}`, {
      metadata: { provider: this.name },
    });
  }
}

describe("LLMRouter", () => {
  test("register and get provider", () => {
    const router = new LLMRouter();
    const provider = new MockProvider("test");
    router.register(provider);
    expect(router.getProvider("test")).toBe(provider);
  });

  test("first registered is default", () => {
    const router = new LLMRouter();
    const p1 = new MockProvider("first");
    const p2 = new MockProvider("second");
    router.register(p1);
    router.register(p2);
    expect(router.getProvider()).toBe(p1);
  });

  test("explicit default overrides", () => {
    const router = new LLMRouter();
    const p1 = new MockProvider("first");
    const p2 = new MockProvider("second");
    router.register(p1);
    router.register(p2, { default: true });
    expect(router.getProvider()).toBe(p2);
  });

  test("get nonexistent throws", () => {
    const router = new LLMRouter();
    expect(() => router.getProvider("ghost")).toThrow(LLMError);
  });

  test("no providers throws", () => {
    const router = new LLMRouter();
    expect(() => router.getProvider()).toThrow(LLMError);
  });

  test("chat uses default provider", async () => {
    const router = new LLMRouter();
    const p1 = new MockProvider("primary");
    const p2 = new MockProvider("secondary");
    router.register(p1, { default: true });
    router.register(p2);

    const messages = [createMessage(Role.USER, "hello")];
    const result = await router.chat(messages);

    expect(result.content).toContain("primary");
    expect(p1.callCount).toBe(1);
    expect(p2.callCount).toBe(0);
  });

  test("chat uses specified provider", async () => {
    const router = new LLMRouter();
    const p1 = new MockProvider("primary");
    const p2 = new MockProvider("secondary");
    router.register(p1, { default: true });
    router.register(p2);

    const messages = [createMessage(Role.USER, "hello")];
    const result = await router.chat(messages, { provider: "secondary" });

    expect(result.content).toContain("secondary");
    expect(p2.callCount).toBe(1);
  });

  test("fallback on failure", async () => {
    const router = new LLMRouter();
    const pFail = new MockProvider("primary", { fail: true });
    const pOk = new MockProvider("backup");
    router.register(pFail, { default: true });
    router.register(pOk);

    const messages = [createMessage(Role.USER, "hello")];
    const result = await router.chat(messages);

    expect(result.content).toContain("backup");
    expect(pFail.callCount).toBe(1);
    expect(pOk.callCount).toBe(1);
  });

  test("all fail throws", async () => {
    const router = new LLMRouter();
    router.register(new MockProvider("a", { fail: true }));
    router.register(new MockProvider("b", { fail: true }));

    const messages = [createMessage(Role.USER, "hello")];
    expect(router.chat(messages)).rejects.toThrow("All providers failed");
  });

  test("chatWithTools with fallback", async () => {
    const router = new LLMRouter();
    const pFail = new MockProvider("primary", { fail: true });
    const pOk = new MockProvider("backup");
    router.register(pFail, { default: true });
    router.register(pOk);

    const messages = [createMessage(Role.USER, "hello")];
    const result = await router.chatWithTools(messages, [{ name: "test" }]);

    expect(result.content).toContain("backup");
  });

  test("available providers", () => {
    const router = new LLMRouter();
    router.register(new MockProvider("a"));
    router.register(new MockProvider("b"));
    expect(router.availableProviders).toEqual(["a", "b"]);
  });
});
