# Main Agent

Main Agent is Pegasus's **inner voice** — its continuous mental activity. Like a human's inner monologue when thinking through a problem, Main Agent's LLM output is self-talk: reasoning, weighing options, planning next steps. The user never sees this internal dialogue directly.

All outward behavior is through explicit tool calls. When Main Agent wants to speak to the user, it calls the `reply` tool. When it needs complex work done, it calls `spawn_task`. The LLM's text output is purely internal cognition.

## Core Concept: Inner Monologue

```
User says: "帮我查一下北京天气"

Main Agent's inner monologue (LLM text output, user never sees):
  "The user wants weather info for Beijing. This requires a web search,
   which I can't do directly. I should spawn a task for this and let the
   user know I'm working on it."

Main Agent's actions (tool calls, visible effects):
  → reply("好的，我来帮你查一下...")        ← user sees this
  → spawn_task("search Beijing weather")   ← task system handles this

[Task completes]

Main Agent's inner monologue:
  "The weather result is back — Beijing 25°C, sunny. I should tell the user."

Main Agent's actions:
  → reply("北京今天晴，25°C，适合外出。")   ← user sees this
```

This separation gives Pegasus the ability to **think without speaking** — it can reason, hesitate, change its mind, all without the user seeing unfinished thoughts.

## Role

```
Channel Adapters ──→ Main Agent ──→ Task System
  (CLI, Slack, ...)   (inner voice)   (Reason→Act→Reflect)
                           ↑
                     Session History
                  (monologue + actions)
```

- **Inner voice** — continuous reasoning about what to do and how to respond
- **Decision maker** — all outward actions are deliberate tool calls
- **Result integrator** — receives task results, thinks about them, decides what to tell the user

## API

```typescript
mainAgent.send(message: InboundMessage): void
mainAgent.onReply(callback: (message: OutboundMessage) => void): void
```

`send()` is fire-and-forget. Messages enter an internal queue and are processed sequentially. Main Agent is always responsive — new messages queue up while it's busy.

`onReply()` is triggered only when the LLM calls the `reply` tool. The LLM decides when, whether, and how many times to reply.

## Message Types

```typescript
interface InboundMessage {
  text: string;
  channel: ChannelInfo;
  metadata?: Record<string, unknown>;
}

interface ChannelInfo {
  type: string;       // "cli" | "slack" | "sms" | "web" | "api"
  channelId: string;  // the "space" where the conversation happens
  userId?: string;    // who sent the message
  replyTo?: string;   // thread/conversation within the channel
}

interface OutboundMessage {
  text: string;
  channel: ChannelInfo;
  metadata?: Record<string, unknown>;
}
```

### channelId vs replyTo

**`channelId`** identifies the conversation space:
- CLI: `"main"` (only one)
- Slack: `"#general"`, `"@zhangsan"` (a channel or DM)
- SMS: `"+8613800138000"` (a phone number)

**`replyTo`** identifies a thread or sub-conversation within the space:
- Slack: `"thread:1234567890"` (reply within a message thread)
- Web: `"session:abc123"` (a WebSocket session)
- CLI / SMS: not needed (no thread concept)

### Reply routing examples

```
Scenario: Slack group chat

Inbound message:
  channel: { type: "slack", channelId: "#general", userId: "zhangsan", replyTo: "thread:weather-discussion" }
  text: "@Pegasus 北京天气怎么样？"

Main Agent can reply to different targets:

  → reply({ text: "25°C 晴天", channelId: "#general", replyTo: "thread:weather-discussion" })
    Effect: reply in the same thread where the user asked

  → reply({ text: "结果私聊给你了", channelId: "@zhangsan" })
    Effect: send a direct message to the user

  → reply({ text: "大家注意今天有雨", channelId: "#general" })
    Effect: post a new message in the channel (not in a thread)
```

```
Scenario: CLI (simple)

Inbound message:
  channel: { type: "cli", channelId: "main" }
  text: "你好"

  → reply({ text: "你好！", channelId: "main" })
    Effect: print to stdout
```

```
Scenario: User says "把结果发到 Slack 上"

Main Agent is receiving via CLI, but the user wants output on Slack:

  → reply({ text: "好的，已发送到 Slack", channelId: "main" })         ← reply to CLI
  → reply({ text: "北京今天晴，25°C", channelId: "#weather-updates" }) ← also post to Slack
```

### reply tool signature

```typescript
reply({
  text: string;        // what to say
  channelId: string;   // which channel to send to
  replyTo?: string;    // optional: which thread within the channel
})
```

`channelId` is required — Main Agent must always explicitly choose where to speak. System prompt injects the available channels and the source channel of each inbound message, so the LLM has the context to decide.

## Tools

Main Agent's tools are its way of **acting on the world**. The LLM's text output is thinking; tool calls are doing.

| Tool | Purpose | Effect |
|------|---------|--------|
| `reply` | Speak to the user | Takes `text` + `channelId`, triggers `onReply` → delivered via channel adapter |
| `spawn_task` | Delegate complex work | Creates a task in the Task System |
| `current_time` | Get current date/time | Returns result to inner monologue |
| `memory_list` / `memory_read` | Access long-term memory | Returns result to inner monologue |
| `task_status` / `task_list` | Query task state and history | Returns result to inner monologue |

Information-gathering tools (current_time, memory, task queries) return results into the inner monologue. Only `reply` produces user-visible output — it requires a `channelId` so Main Agent explicitly chooses where to send the message. Only `spawn_task` creates external side effects.

Complex tools (file I/O, shell, web search) are NOT available to Main Agent — they're only available inside Tasks.

## Interaction Examples

### Simple greeting

```
User: "你好"
Inner monologue: "A simple greeting, I should respond warmly."
→ reply("你好！有什么可以帮你的？")
```

### Quick tool lookup

```
User: "现在几点了？"
Inner monologue: "They want the time, I can check this directly."
→ current_time()
Inner monologue: "It's 15:25, let me tell them."
→ reply("现在是下午3:25。")
```

### Complex task delegation

```
User: "查一下北京天气，然后写个总结"
Inner monologue: "This needs web search and multi-step processing.
  I should spawn a task and let the user know."
→ reply("好的，我来帮你查一下...")
→ spawn_task({ description: "search Beijing weather and summarize", input: "..." })

[Task completes, result injected into session]

Inner monologue: "Weather results are back. Beijing 25°C sunny. Let me summarize for the user."
→ reply("北京今天晴，25°C，适合外出。")
```

### Choosing not to reply

```
User: "👍"
Inner monologue: "Just an acknowledgment, no response needed."
(no reply tool called — silence)
```

### Task failure

```
User: "读取 /etc/shadow"
→ spawn_task({ description: "read file", input: "/etc/shadow" })

[Task fails: permission denied]

Inner monologue: "The task failed with a permission error. This is expected —
  /etc/shadow requires root. I should let the user know and suggest alternatives."
→ reply("没有权限读取该文件。需要我换一种方式吗？")
```

## Session

Main Agent maintains a session-level message history. This is the record of its inner monologue and all interactions.

**Session contains:**
- User messages (inbound)
- Main Agent's inner monologue (LLM text output)
- Tool calls and results (reply, spawn_task, current_time, etc.)
- Task result summaries (injected when tasks complete)

**Session does NOT contain:**
- Task-internal messages (tool calls and LLM reasoning inside tasks)
- UI/progress events

### Two Message Streams

| Level | Scope | Content | Lifetime |
|-------|-------|---------|----------|
| **Session** | Main Agent | Inner monologue + tool calls + user messages + task summaries | Persisted across restarts |
| **Task** | Per-task | LLM reasoning + tool calls + tool results | Single task lifecycle |

### Persistence

```
data/main/
├── current.jsonl              ← active session
├── 2026-02-25-143000.jsonl    ← compacted previous session
└── 2026-02-24-180000.jsonl    ← older
```

Session is persisted as append-only JSONL. When token count exceeds threshold, the current session is compacted: renamed to a timestamped file, replaced with a summary that references the archived file.

### Token Counting & Compaction

Token count is tracked in two parts:
- **Known tokens**: from `usage.promptTokens` returned by the last LLM call (exact)
- **New tokens**: counted via provider-specific methods (tiktoken for OpenAI, count_tokens API for Anthropic)

When estimated total exceeds threshold, compact before the next LLM call.

## System Prompt Design

The system prompt has two parts: a fixed template and dynamic context injected per-message.

### Fixed Part (system prompt)

Assembled at session start, rebuilt when channel type changes.

```
You are {persona.name}, {persona.role}.

Personality: {persona.personality}.
Speaking style: {persona.style}.
Core values: {persona.values}.
{persona.background}

## How You Think

Your text output is your INNER MONOLOGUE — private thinking that
the user never sees. Think freely: reason, analyze, hesitate,
change your mind.

To act on the outside world, use tool calls:
- reply(): the ONLY way the user hears you
- spawn_task(): delegate complex work to a background worker
- Other tools: gather information for your thinking

If you don't call reply(), the user receives silence.
That's fine when no response is needed.

## Tools

### reply({ text, channelId, replyTo? })
Speak to the user. Always specify channelId.
Use replyTo to reply within a specific thread.

### spawn_task({ description, input })
Launch a background task with full tool access
(file I/O, shell commands, web search, etc.).
You will receive the result when the task completes.

### current_time({ timezone? })
Get current date and time.

### memory_list(), memory_read({ path })
Access long-term memory files.

### task_status({ taskId }), task_list({ date? })
Query running or historical tasks.

## When to Reply vs Spawn

Reply directly (via reply tool) when:
- Simple conversation, greetings, opinions, follow-ups
- You can answer from session context or memory
- A quick tool call is enough (time, memory lookup)

Spawn a task when:
- You need file I/O, shell commands, or web requests
- The work requires multiple steps
- You're unsure — err on the side of spawning

On task completion:
- You will receive the result in your session
- Think about it, then call reply() to inform the user

On task failure:
- Assess the error: retry, try differently, or inform the user

## Response Style

{channel-specific style section — injected by code based on channel.type}
```

The "Response Style" section is assembled by code based on the active channel:

| channel.type | Injected style guidance |
|-------------|----------------------|
| `cli` | "You are in a terminal session. Use detailed responses, code blocks are welcome. No character limit." |
| `sms` | "You are communicating via SMS. Keep replies under 160 characters. Be extremely concise." |
| `slack` | "You are in a Slack workspace. Use markdown formatting. Use threads for long discussions." |
| `web` | "You are on a web interface. You can use rich formatting and links." |

### Dynamic Part (injected into messages)

Before each LLM call, a context message is prepended to the current user message:

```
[Context]
Source: {channel.type} / {channel.channelId}
{User: {channel.userId}}
{Thread: {channel.replyTo}}
Available channels: {list of active channelIds}

{Memory index (if available):}
{- facts/user.md (1.2KB): user preferences}
{- episodes/2026-02.md (3.4KB): recent interactions}
```

This keeps the system prompt stable while giving the LLM fresh situational awareness for each message.

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

Each adapter listens for input on its channel and calls `agent.send()`. When Main Agent calls the `reply` tool, the outbound message is routed to the correct adapter via `deliver()`.

The system prompt is channel-aware — it adapts response style based on `channel.type` (verbose for CLI, concise for SMS, markdown for Slack).

## Relationship to Task System

Main Agent and the Task System are separate layers:

| Concern | Main Agent | Task System |
|---------|-----------|-------------|
| LLM role | Inner voice (thinking) | Execution engine (doing) |
| Output | Inner monologue + tool calls | Cognitive pipeline results |
| User interaction | Via `reply` tool | None (internal only) |
| State | Session history (cross-task) | TaskContext (per-task) |
| Tools | reply + spawn_task + simple tools | Full tool suite |
| Persistence | data/main/ (session JSONL) | data/tasks/ (task JSONL) |
| Lifetime | Entire session | Single task |

The Task System (Agent, TaskFSM, cognitive pipeline, EventBus) is unchanged. Main Agent creates tasks through `spawn_task`, receives results via internal events, and does not interfere with task execution.
