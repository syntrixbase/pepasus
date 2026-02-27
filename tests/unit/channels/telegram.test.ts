/**
 * Tests for TelegramAdapter — Grammy-based Telegram bot channel adapter.
 *
 * Grammy's Bot is mocked to avoid real Telegram API calls.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { TelegramAdapter } from "@pegasus/channels/telegram.ts";
import type { InboundMessage, OutboundMessage } from "@pegasus/channels/types.ts";

describe("TelegramAdapter", () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter("fake-token-123");
  });

  it("should have type 'telegram'", () => {
    expect(adapter.type).toBe("telegram");
  });

  it("should implement ChannelAdapter interface", () => {
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.deliver).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(adapter.type).toBe("telegram");
  });

  it("should expose bot instance", () => {
    expect(adapter.botInstance).toBeDefined();
  });

  describe("start()", () => {
    it("should register handler and start polling", async () => {
      const received: InboundMessage[] = [];
      const bot = adapter.botInstance;

      // Mock bot.start to prevent actual polling
      (bot as any).start = mock(() => {});

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      // Verify bot.start was called
      expect((bot as any).start).toHaveBeenCalled();
    });
  });

  describe("deliver()", () => {
    it("should call bot.api.sendMessage with correct arguments", async () => {
      const sentMessages: Array<{
        chatId: number;
        text: string;
        options: Record<string, unknown>;
      }> = [];

      const bot = adapter.botInstance;
      (bot.api as any).sendMessage = mock(
        (chatId: number, text: string, options: Record<string, unknown>) => {
          sentMessages.push({ chatId, text, options });
          return Promise.resolve({});
        },
      );

      const message: OutboundMessage = {
        text: "Hello Telegram!",
        channel: {
          type: "telegram",
          channelId: "12345",
        },
      };

      await adapter.deliver(message);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.chatId).toBe(12345);
      expect(sentMessages[0]!.text).toBe("Hello Telegram!");
      expect(sentMessages[0]!.options.parse_mode).toBe("Markdown");
    });

    it("should pass message_thread_id when replyTo is set", async () => {
      const sentMessages: Array<{
        chatId: number;
        text: string;
        options: Record<string, unknown>;
      }> = [];

      const bot = adapter.botInstance;
      (bot.api as any).sendMessage = mock(
        (chatId: number, text: string, options: Record<string, unknown>) => {
          sentMessages.push({ chatId, text, options });
          return Promise.resolve({});
        },
      );

      const message: OutboundMessage = {
        text: "Reply in thread",
        channel: {
          type: "telegram",
          channelId: "67890",
          replyTo: "42",
        },
      };

      await adapter.deliver(message);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.options.message_thread_id).toBe(42);
    });

    it("should not include message_thread_id when replyTo is absent", async () => {
      const sentMessages: Array<{
        chatId: number;
        text: string;
        options: Record<string, unknown>;
      }> = [];

      const bot = adapter.botInstance;
      (bot.api as any).sendMessage = mock(
        (chatId: number, text: string, options: Record<string, unknown>) => {
          sentMessages.push({ chatId, text, options });
          return Promise.resolve({});
        },
      );

      const message: OutboundMessage = {
        text: "No thread",
        channel: { type: "telegram", channelId: "11111" },
      };

      await adapter.deliver(message);

      expect(sentMessages[0]!.options.message_thread_id).toBeUndefined();
    });

    it("should propagate sendMessage errors", async () => {
      const bot = adapter.botInstance;
      (bot.api as any).sendMessage = mock(() =>
        Promise.reject(new Error("Telegram API error")),
      );

      const message: OutboundMessage = {
        text: "Will fail",
        channel: { type: "telegram", channelId: "999" },
      };

      await expect(adapter.deliver(message)).rejects.toThrow("Telegram API error");
    });
  });

  describe("stop()", () => {
    it("should call bot.stop()", async () => {
      const bot = adapter.botInstance;
      (bot as any).stop = mock(() => Promise.resolve());

      await adapter.stop();

      expect((bot as any).stop).toHaveBeenCalled();
    });
  });
});
