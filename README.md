# Pegasus — Event-Driven Autonomous Agent System

**Pegasus** is an event-driven, state-machine-based autonomous agent system. Rather than a traditional request-response service, it is a continuously running autonomous worker that can handle multiple tasks concurrently, call tools, make decisions, and learn from experience.

## ✨ Core Features

- 🧠 **Inner monologue** — Main Agent's LLM output is private thinking; only `reply` tool calls reach the user
- 🔄 **Event-driven architecture** — everything is an event, dispatched via EventBus, non-blocking concurrency
- 🤖 **State machine task management** — TaskFSM controls task lifecycle precisely, with suspend/resume
- 🧩 **2-stage cognitive pipeline** — Reason → Act, with async post-task reflection for memory learning
- 📡 **Multi-channel adapter** — Channel Adapter pattern, supports CLI / Slack / SMS / Web
- 🎭 **Identity system** — configurable persona, consistent personality and behavior
- 🔧 **Built-in tool system** — file, network, system, data, memory tools + LLM function calling
- 💾 **Memory system** — long-term memory (facts + episodes), markdown file based
- 📝 **Task persistence** — incremental JSONL event logs with replay
- 🔁 **Startup recovery** — session repair + pending task auto-recovery
- 🧠 **Multi-model support** — per-role model configuration (default, subAgent, compact, reflection)
- 📦 **Session compaction** — automatic context window management with summarization
- 🧩 **Skill system** — extensible SKILL.md files with LLM auto-trigger and `/` commands

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- **Choose one**:
  - **OpenAI API Key** (recommended) — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
  - **Anthropic API Key** — [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
  - **Local model** (no API key needed) — [Ollama](https://ollama.com/) or [LM Studio](https://lmstudio.ai/)

### Install

```bash
bun install
```

### Configure

Pegasus uses layered config: `config.yml` (base) → `config.local.yml` (override) → Zod validation.

Create `config.local.yml`:

```yaml
# OpenAI
llm:
  provider: openai
  providers:
    openai:
      apiKey: sk-proj-your-key
      model: gpt-4o-mini

# Or Anthropic
# llm:
#   provider: anthropic
#   providers:
#     anthropic:
#       apiKey: sk-ant-your-key
#       model: claude-sonnet-4-20250514

# Or local Ollama
# llm:
#   provider: ollama
#   providers:
#     ollama:
#       model: llama3.2:latest
#       baseURL: http://localhost:11434/v1
```

### Run

```bash
bun run dev
```

## 🏗️ Architecture

```
┌─────────────────────────────────────┐
│  Channel Adapters (CLI / Slack ...) │
├─────────────────────────────────────┤
│  Main Agent (inner monologue +      │
│              reply tool)            │
├─────────────────────────────────────┤
│  EventBus → Agent → TaskFSM        │
│  Reason → Act (+ async Reflection) │
├─────────────────────────────────────┤
│  Tools │ Memory │ Identity │ LLM   │
└─────────────────────────────────────┘
```

## 📚 Documentation

- [Architecture](./docs/architecture.md) — layered design, core abstractions, data flow
- [Main Agent](./docs/main-agent.md) — inner monologue, Channel Adapter, Session, System Prompt
- [Cognitive Processors](./docs/cognitive.md) — Reason → Act (2-stage) + async PostTaskReflector
- [Task FSM](./docs/task-fsm.md) — states, transitions, suspend/resume
- [Event System](./docs/events.md) — EventType, EventBus, priority queue
- [Agent Core](./docs/agent.md) — event processing, cognitive dispatch, concurrency
- [Tool System](./docs/tools.md) — registration, execution, timeout, LLM function calling
- [Memory System](./docs/memory-system.md) — long-term memory (facts + episodes)
- [Task Persistence](./docs/task-persistence.md) — JSONL event logs, replay
- [Multi-Model](./docs/multi-model.md) — per-role model config with ModelRegistry
- [Session Compact](./docs/session-compact.md) — auto-compact with context window awareness
- [Configuration](./docs/configuration.md) — YAML config + env var interpolation
- [Logging](./docs/logging.md) — log format, output, rotation
- [Running Guide](./docs/running.md) — detailed setup and usage
- [Progress](./docs/progress.md) — milestones, test coverage, tech stack
- [TODOs](./docs/todos.md) — planned features and ideas
- [Skill System](./docs/skill-system.md) — SKILL.md format, loader, registry, triggering

## 🛠️ Development

```bash
make check     # typecheck + tests
make coverage  # tests + coverage report
bun test       # run tests
```

## 📄 License

MIT
