# Main Agent

Main Agent is the persistent LLM role that serves as the user's conversation partner. It sits between the channel adapters (CLI, Slack, SMS, etc.) and the Task System, deciding how to handle each message.

## Role

```
Channel Adapters ──→ Main Agent ──→ Task System
  (CLI, Slack, ...)     (LLM brain)    (Reason→Act→Reflect)
                            ↑
                      Session History
```

- **Conversation partner** — maintains dialogue context across tasks and sessions
- **Decision maker** — decides whether to reply directly, use a simple tool, or spawn a task
- **Result integrator** — receives task results, formats them as natural language replies

## API

```typescript
mainAgent.send(message: InboundMessage): void
mainAgent.onReply(callback: (message: OutboundMessage) => void): void
```

`send()` is fire-and-forget. Messages enter an internal queue and are processed sequentially. Main Agent is always responsive — new messages queue up while it's busy.

`onReply()` is called whenever Main Agent decides to speak. It may fire zero, one, or multiple times per inbound message.

## Message Types

```typescript
interface InboundMessage {
  text: string;
  channel: ChannelInfo;
  metadata?: Record<string, unknown>;
}

interface ChannelInfo {
  type: string;       // "cli" | "slack" | "sms" | "web" | "api"
  channelId: string;
  userId?: string;
  replyTo?: string;   // thread ID, conversation ID
}

interface OutboundMessage {
  text: string;
  channel: ChannelInfo;
  metadata?: Record<string, unknown>;
}
```

## Tools

Main Agent has a curated set of tools via LLM function calling:

| Tool | Purpose |
|------|---------|
| `current_time` | Get current date/time |
| `memory_list` / `memory_read` | Access long-term memory |
| `task_status` / `task_list` | Query task state and history |
| `spawn_task` | Launch a background task with full tool access |

Complex tools (file I/O, shell, web search) are only available inside Tasks. `spawn_task` is Main Agent's way to delegate heavy work.

## Decision Flow

On each message, Main Agent does one LLM call with session history. The LLM decides:

1. **Direct reply** — greetings, follow-ups, questions answerable from context
2. **Simple tool call** — `current_time`, memory lookup
3. **Spawn task** — call `spawn_task` tool for complex operations
4. **No reply** — message doesn't need a response

The decision logic lives in the system prompt, not in code.

## Task Integration

When Main Agent calls `spawn_task`:
1. Task runs asynchronously through Reason→Act→Reflect
2. On completion, a structured summary enters Main Agent's message queue
3. Main Agent does another LLM call with the summary in session history
4. LLM decides how to reply to the user

Task failures follow the same path — the LLM sees the error and decides whether to retry, try differently, or inform the user.

## Session

Main Agent maintains a session-level message history, separate from task-level messages.

**Session contains:**
- User messages
- Main Agent's replies
- Task result summaries (compact)

**Session does NOT contain:**
- Task-internal messages (tool calls, LLM reasoning steps)
- UI/progress events

### Persistence

```
data/main/
├── current.jsonl              ← active session
├── 2026-02-25-143000.jsonl    ← compacted previous session
└── 2026-02-24-180000.jsonl    ← older
```

Session is persisted as append-only JSONL. When token count exceeds threshold, the current session is compacted: renamed to a timestamped file, replaced with a summary that references the archived file. The LLM can read old files for detail retrieval.

## Channel Adapters

Multiple channels connect to the same Main Agent through a unified adapter interface:

```
┌─────────┐  ┌─────────┐  ┌─────────┐
│   CLI   │  │  Slack  │  │   SMS   │
│ Adapter │  │ Adapter │  │ Adapter │
└────┬────┘  └────┬────┘  └────┬────┘
     └────────────┴─────┬──────┘
                        ▼
                   Main Agent
```

```typescript
interface ChannelAdapter {
  readonly type: string;
  start(agent: { send(msg: InboundMessage): void }): Promise<void>;
  deliver(message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}
```

Each adapter listens for input on its channel and calls `agent.send()`. Outbound messages from Main Agent are routed to the correct adapter via `deliver()`.

The system prompt is channel-aware — it adapts response style based on `channel.type` (verbose for CLI, concise for SMS, markdown for Slack).

## Relationship to Task System

Main Agent and the Task System are separate layers:

| Concern | Main Agent | Task System |
|---------|-----------|-------------|
| LLM role | Conversational partner | Execution engine |
| State | Session history (cross-task) | TaskContext (per-task) |
| Tools | Simple tools + spawn_task | Full tool suite |
| Persistence | data/main/ (session JSONL) | data/tasks/ (task JSONL) |
| Lifetime | Entire session | Single task |

The Task System (Agent, TaskFSM, cognitive pipeline, EventBus) is unchanged. Main Agent creates tasks through `spawn_task`, receives results via internal events, and does not interfere with task execution.
