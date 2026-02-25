/**
 * Channel types — defines the interface between channel adapters and Main Agent.
 */

/** Channel identification — where the message came from. */
export interface ChannelInfo {
  type: string; // "cli" | "slack" | "sms" | "web" | "api"
  channelId: string; // unique channel instance
  userId?: string;
  replyTo?: string; // thread ID, conversation ID
}

/** Inbound message from any channel. */
export interface InboundMessage {
  text: string;
  channel: ChannelInfo;
  metadata?: Record<string, unknown>;
}

/** Outbound response from Main Agent. */
export interface OutboundMessage {
  text: string;
  channel: ChannelInfo;
  metadata?: Record<string, unknown>;
}

/** Channel adapter interface. */
export interface ChannelAdapter {
  readonly type: string;
  start(agent: { send(msg: InboundMessage): void }): Promise<void>;
  deliver(message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}
