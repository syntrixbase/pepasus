import { describe, test, expect } from "bun:test";
import type {
  InboundMessage,
  OutboundMessage,
  ChannelInfo,
  ChannelAdapter,
} from "../../src/channels/types.ts";

describe("Channel types", () => {
  test("InboundMessage can be constructed", () => {
    const msg: InboundMessage = {
      text: "hello",
      channel: { type: "cli", channelId: "main" },
    };
    expect(msg.text).toBe("hello");
    expect(msg.channel.type).toBe("cli");
  });

  test("OutboundMessage carries channel info back", () => {
    const channel: ChannelInfo = {
      type: "slack",
      channelId: "C123",
      userId: "U456",
    };
    const msg: OutboundMessage = { text: "hi", channel };
    expect(msg.channel.type).toBe("slack");
    expect(msg.channel.userId).toBe("U456");
  });

  test("ChannelAdapter interface is implementable", () => {
    const adapter: ChannelAdapter = {
      type: "test",
      async start() {},
      async deliver() {},
      async stop() {},
    };
    expect(adapter.type).toBe("test");
  });

  test("InboundMessage supports optional metadata", () => {
    const msg: InboundMessage = {
      text: "hello",
      channel: { type: "api", channelId: "api-1" },
      metadata: { source: "webhook", priority: 1 },
    };
    expect(msg.metadata?.source).toBe("webhook");
    expect(msg.metadata?.priority).toBe(1);
  });

  test("ChannelInfo supports optional replyTo", () => {
    const channel: ChannelInfo = {
      type: "slack",
      channelId: "C123",
      userId: "U789",
      replyTo: "thread-abc",
    };
    expect(channel.replyTo).toBe("thread-abc");
  });
});
