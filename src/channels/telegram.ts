/**
 * TelegramAdapter — Grammy-based Telegram bot channel adapter.
 *
 * Uses long polling to receive messages. MVP scope: text-only messages,
 * private + group chats, Markdown formatting for responses.
 */
import { Bot } from "grammy";
import { getLogger } from "../infra/logger.ts";
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "./types.ts";

const logger = getLogger("telegram");

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram";
  private bot: Bot;
  private send!: (msg: InboundMessage) => void;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    this.send = agent.send;

    this.bot.on("message:text", (ctx) => {
      this.send({
        text: ctx.message.text,
        channel: {
          type: "telegram",
          channelId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ""),
          replyTo: ctx.message.message_thread_id
            ? String(ctx.message.message_thread_id)
            : undefined,
        },
        metadata: {
          messageId: ctx.message.message_id,
          chatType: ctx.chat.type,
          username: ctx.from?.username,
        },
      });
    });

    // Non-blocking start — Grammy polling runs in background
    this.bot.start({
      onStart: () => logger.info("telegram_bot_started"),
    });
  }

  async deliver(message: OutboundMessage): Promise<void> {
    const chatId = Number(message.channel.channelId);
    const options: Record<string, unknown> = { parse_mode: "Markdown" };
    if (message.channel.replyTo) {
      options.message_thread_id = Number(message.channel.replyTo);
    }
    await this.bot.api.sendMessage(chatId, message.text, options);
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  /** Expose bot instance for testing. */
  get botInstance(): Bot {
    return this.bot;
  }
}
