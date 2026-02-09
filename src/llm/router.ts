/**
 * LLMRouter — smart selection and fallback across LLM providers.
 */
import { LLMError } from "../infra/errors.ts";
import { getLogger } from "../infra/logger.ts";
import type { LLMProvider, ChatOptions } from "./base.ts";
import type { Message } from "../models/message.ts";

const logger = getLogger("llm.router");

export class LLMRouter {
  private providers = new Map<string, LLMProvider>();
  private defaultProvider: string | null = null;
  private fallbackOrder: string[] = [];

  register(provider: LLMProvider, opts?: { default?: boolean }): void {
    this.providers.set(provider.name, provider);
    this.fallbackOrder.push(provider.name);
    if (opts?.default || this.defaultProvider === null) {
      this.defaultProvider = provider.name;
    }
    logger.info({ name: provider.name, model: provider.model, default: opts?.default ?? false }, "provider_registered");
  }

  getProvider(name?: string): LLMProvider {
    const target = name ?? this.defaultProvider;
    if (!target) throw new LLMError("No LLM provider registered");
    const provider = this.providers.get(target);
    if (!provider) throw new LLMError(`Provider '${target}' not registered`);
    return provider;
  }

  async chat(messages: Message[], opts?: ChatOptions & { provider?: string }): Promise<Message> {
    const { provider: preferred, ...chatOpts } = opts ?? {};
    const order = this._getTryOrder(preferred);
    const errors: string[] = [];

    for (const name of order) {
      const p = this.providers.get(name)!;
      try {
        return await p.chat(messages, chatOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ provider: name, error: msg }, "provider_failed");
        errors.push(`${name}: ${msg}`);
      }
    }

    throw new LLMError(`All providers failed: ${errors.join("; ")}`);
  }

  async chatWithTools(
    messages: Message[],
    tools: Record<string, unknown>[],
    opts?: ChatOptions & { provider?: string },
  ): Promise<Message> {
    const { provider: preferred, ...chatOpts } = opts ?? {};
    const order = this._getTryOrder(preferred);
    const errors: string[] = [];

    for (const name of order) {
      const p = this.providers.get(name)!;
      try {
        return await p.chatWithTools(messages, tools, chatOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ provider: name, error: msg }, "provider_failed");
        errors.push(`${name}: ${msg}`);
      }
    }

    throw new LLMError(`All providers failed: ${errors.join("; ")}`);
  }

  get availableProviders(): string[] {
    return [...this.providers.keys()];
  }

  private _getTryOrder(preferred?: string): string[] {
    if (preferred && this.providers.has(preferred)) {
      const others = this.fallbackOrder.filter((n) => n !== preferred);
      return [preferred, ...others];
    }
    if (this.defaultProvider) {
      const others = this.fallbackOrder.filter((n) => n !== this.defaultProvider);
      return [this.defaultProvider, ...others];
    }
    return [...this.fallbackOrder];
  }
}
