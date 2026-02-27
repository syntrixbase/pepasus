/**
 * Tests for TelegramAdapter — Grammy-based Telegram bot channel adapter.
 *
 * Grammy's Bot is mocked to avoid real Telegram API calls.
 * We test the adapter's public API and inbound message mapping by
 * intercepting Grammy's middleware chain via handleUpdate().
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { TelegramAdapter } from "@pegasus/channels/telegram.ts";
import type { InboundMessage, OutboundMessage } from "@pegasus/channels/types.ts";

/** Fake bot info to initialize Grammy without API call. */
const FAKE_BOT_INFO = {
  id: 123456789,
  is_bot: true as const,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

/** Set up adapter for handleUpdate tests: mock start, set botInfo. */
function prepareForHandleUpdate(adapter: TelegramAdapter) {
  const bot = adapter.botInstance;
  (bot as any).start = mock(() => {});
  bot.botInfo = FAKE_BOT_INFO;
  return bot;
}

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
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      expect((bot as any).start).toHaveBeenCalled();
    });

    it("should map inbound text messages correctly via middleware", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      const mockUpdate = {
        update_id: 1,
        message: {
          message_id: 42,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345, type: "private" as const, first_name: "Test" },
          from: {
            id: 67890,
            is_bot: false,
            first_name: "Test",
            username: "testuser",
          },
          text: "Hello from Telegram",
        },
      };

      await bot.handleUpdate(mockUpdate);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("Hello from Telegram");
      expect(received[0]!.channel.type).toBe("telegram");
      expect(received[0]!.channel.channelId).toBe("12345");
      expect(received[0]!.channel.userId).toBe("67890");
      expect(received[0]!.channel.replyTo).toBeUndefined();
      expect(received[0]!.metadata?.messageId).toBe(42);
      expect(received[0]!.metadata?.chatType).toBe("private");
      expect(received[0]!.metadata?.username).toBe("testuser");
    });

    it("should include replyTo when message_thread_id is present", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      const mockUpdate = {
        update_id: 2,
        message: {
          message_id: 100,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 99999, type: "supergroup" as const, title: "Test Group" },
          from: {
            id: 111,
            is_bot: false,
            first_name: "Group",
            username: "groupuser",
          },
          text: "Thread message",
          message_thread_id: 55,
        },
      };

      await bot.handleUpdate(mockUpdate);

      expect(received).toHaveLength(1);
      expect(received[0]!.channel.replyTo).toBe("55");
      expect(received[0]!.metadata?.chatType).toBe("supergroup");
    });

    it("should handle group chat type", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      const mockUpdate = {
        update_id: 3,
        message: {
          message_id: 200,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 44444, type: "group" as const, title: "Group Chat" },
          from: {
            id: 222,
            is_bot: false,
            first_name: "User",
          },
          text: "Group message",
        },
      };

      await bot.handleUpdate(mockUpdate);

      expect(received).toHaveLength(1);
      expect(received[0]!.channel.channelId).toBe("44444");
      expect(received[0]!.channel.userId).toBe("222");
      expect(received[0]!.metadata?.chatType).toBe("group");
      expect(received[0]!.metadata?.username).toBeUndefined();
    });

    it("should not process non-text messages", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      const mockUpdate = {
        update_id: 4,
        message: {
          message_id: 300,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 55555, type: "private" as const, first_name: "Photographer" },
          from: {
            id: 333,
            is_bot: false,
            first_name: "Photographer",
          },
          photo: [{ file_id: "abc", file_unique_id: "xyz", width: 100, height: 100 }],
        },
      };

      await bot.handleUpdate(mockUpdate);

      expect(received).toHaveLength(0);
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
