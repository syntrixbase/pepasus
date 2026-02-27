# TODOs

Tracked features, improvements, and ideas that are planned but not yet started.

## Next Up

### Skill System
- [x] Skill framework: SkillLoader, SkillRegistry, SKILL.md format (YAML frontmatter + markdown body)
- [x] Skill storage: `skills/` (builtin, git tracked) + `data/skills/` (user/LLM created, runtime)
- [x] Skill triggering: LLM-driven (description in context) + user `/` command
- [x] Skill injection: inline (MainAgent/TaskAgent context) + fork (spawn_task)
- [ ] LLM-created skills: PostTaskReflector can create new skills from repeated patterns

### Task Types (Subagent Specialization)
- [x] Task type system: explore, plan, general
- [x] Per-type tool sets: explore (read-only), plan (read-only + write plans), general (all tools)
- [x] Per-type system prompts: specialized instructions for each type
- [x] `spawn_task` type parameter: MainAgent specifies task type when spawning
- [x] Skill `agent` field maps to task type
- [x] Two-layer tool restriction: LLM visibility + execution validation
- [x] Persistence backward compatibility (old JSONL defaults to "general")
- [ ] Additional types: deepresearch, code (future)

### Task Progress Notification
- [x] `notify` tool for Task Agent: send messages to MainAgent during execution
- [x] TASK_NOTIFY EventBus event (persisted to JSONL)
- [x] MainAgent receives notify as `task_notify` events (same channel as completion)

## Planned

### MainAgent Reflection
- [ ] Reflection during session compact: extract facts/episodes while summarizing
- [ ] MainAgent sees user preferences, identity info — most valuable facts come from here

### Multi-Channel
- [x] Telegram channel adapter (Grammy + long polling, text-only MVP)
- [x] Multi-channel adapter routing in MainAgent (`registerAdapter()`)
- [x] CLIAdapter extracted from cli.ts as proper ChannelAdapter
- [ ] Slack channel adapter
- [ ] SMS channel adapter
- [ ] Web/API channel adapter

### Memory Improvements
- [ ] Episode splitting: break large monthly files by week
- [ ] Episode summarization: compress old episodes into higher-level summaries
- [ ] Selective injection: only list recent/relevant memory in context
- [ ] Memory decay: auto-archive old, unused facts

### Tool System
- [x] MCP server integration: connect external tool services via standard protocol
- [ ] Custom tool plugins: user-defined TypeScript tools
- [ ] Tool permission system: per-tool approval rules

### Observability
- [ ] Task execution dashboard
- [ ] Memory usage visualization
- [ ] Token cost tracking per task/session
