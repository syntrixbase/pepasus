# Project Progress

## Milestones

| Milestone | Status | Description |
|-----------|--------|-------------|
| **M0: Skeleton** | ✅ Done | EventBus + TaskFSM + Agent core architecture |
| **M1: Conversation** | ✅ Done | CLI chat + Identity system + LLM integration |
| **M2: Memory** | ✅ Done | Long-term memory (facts + episodes), markdown files |
| **M3: Action** | ✅ Done | Built-in tools + LLM function calling + event-driven Actor |
| **Cognitive merge** | ✅ Done | 5-stage → 3-stage → 2-stage pipeline (Reason → Act) |
| **Task persistence** | ✅ Done | JSONL incremental event logs, replay, index |
| **Main Agent** | ✅ Done | Inner monologue, reply tool, event-driven single-step thinking |
| **Channel Adapter** | ✅ Done | Multi-channel architecture (CLI adapter implemented) |
| **Startup recovery** | ✅ Done | Session repair + pending task recovery via onNotify |
| **Token counting** | ✅ Done | tiktoken (OpenAI) + Anthropic count_tokens API |
| **M4: Cognitive upgrade** | ✅ Done | 2-stage pipeline, async PostTaskReflector with tool-use loop |
| **Multi-model** | ✅ Done | Per-role model config (default, subAgent, compact, reflection) |
| **Session compact** | ✅ Done | Auto-compact with context window awareness |
| **Memory redesign** | ✅ Done | Cache-friendly index, tool-use reflector, memory_patch |
| **Skill system** | ✅ Done | SKILL.md format, SkillLoader/Registry, use_skill tool, / commands |
| **M5: Multi-channel** | 📋 Planned | Slack / SMS / Web channel adapters |

## Test Coverage

- **Tests**: 655 pass, 0 fail
- **Line coverage**: 99.81%
- **Function coverage**: 98.86%
- **Threshold**: 95% per file (enforced by CI + git hooks)

## Project Structure

```
pegasus/
├── src/
│   ├── agents/
│   │   ├── agent.ts         # Task execution engine (event processor)
│   │   └── main-agent.ts    # Main Agent (inner monologue + task dispatch)
│   ├── cli.ts               # CLI channel adapter
│   ├── channels/            # Channel adapter types (InboundMessage, OutboundMessage)
│   ├── session/             # Session persistence + compaction
│   ├── events/              # Event system (EventType, EventBus)
│   ├── task/                # TaskFSM + TaskContext + TaskPersister
│   ├── cognitive/           # Reason → Act processors + PostTaskReflector
│   ├── identity/            # Persona + system prompt builder
│   ├── tools/
│   │   ├── registry.ts      # Tool registration
│   │   ├── executor.ts      # Tool execution (timeout, validation)
│   │   └── builtins/        # Built-in tools (system/file/network/data/memory/task)
│   ├── models/              # ToolCall, ToolDefinition types
│   └── infra/               # Config, Logger, LLM clients, TokenCounter, ModelRegistry
├── tests/
│   ├── unit/                # Unit tests
│   └── integration/         # Integration tests
├── docs/                    # System design documents
├── data/
│   ├── main/                # Main Agent session (current.jsonl)
│   ├── tasks/               # Task execution logs (JSONL per task)
│   ├── memory/              # Long-term memory (facts/, episodes/)
│   └── personas/            # Persona config files
└── .github/workflows/       # CI/CD
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Language | TypeScript 5.x |
| Schema | Zod |
| Logger | pino (lazy init, file-only) |
| Test | bun:test |
| Token counting | tiktoken (OpenAI) / Anthropic API |
| LLM | OpenAI / Anthropic SDKs |

## Development Workflow

All changes go through Pull Request:

1. Create feature branch
2. Implement + test (≥ 95% coverage per file)
3. Push (pre-push hook checks coverage)
4. Create PR → CI runs typecheck + tests + coverage
5. Merge to main when CI passes

Pre-commit hooks run typecheck + tests on every commit.
