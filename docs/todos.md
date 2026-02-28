# TODOs

Tracked features, improvements, and ideas that are planned but not yet started.

## Next Up

### Skill System
- [x] Skill framework: SkillLoader, SkillRegistry, SKILL.md format (YAML frontmatter + markdown body)
- [x] Skill storage: `skills/` (builtin, git tracked) + `data/skills/` (user/LLM created, runtime)
- [x] Skill triggering: LLM-driven (description in context) + user `/` command
- [x] Skill injection: inline (MainAgent/TaskAgent context) + fork (spawn_subagent)
- [ ] LLM-created skills: PostTaskReflector can create new skills from repeated patterns

### Task Types (Subagent Specialization)
- [x] Task type system: explore, plan, general
- [x] Per-type tool sets: explore (read-only), plan (read-only + write plans), general (all tools)
- [x] Per-type system prompts: specialized instructions for each type
- [x] `spawn_subagent` type parameter: MainAgent specifies task type when spawning
- [x] Skill `agent` field maps to task type
- [x] Two-layer tool restriction: LLM visibility + execution validation
- [x] Persistence backward compatibility (old JSONL defaults to "general")
- [ ] Additional types: deepresearch, code (future)

### Task Progress Notification
- [x] `notify` tool for Task Agent: send messages to MainAgent during execution
- [x] TASK_NOTIFY EventBus event (persisted to JSONL)
- [x] MainAgent receives notify as `task_notify` events (same channel as completion)

## Planned

### System Prompt Optimization (learned from OpenClaw)

Comprehensive prompt improvements based on analysis of OpenClaw's system prompt architecture.
See `docs/architecture.md` and `docs/main-agent.md` for Pegasus's own design context.

**P0 — Token efficiency & accuracy:**
- [x] Prompt Mode (full/minimal): Main Agent gets full prompt; Task Agents get minimal (strip "How You Think", "Reply vs Spawn", "Channels", "Session History", Skill metadata — none of which apply to subagents). Saves ~200 lines of irrelevant tokens per Task Agent LLM call.
- [x] Main Agent tool descriptions: Current prompt lumps 13 tools into 3 vague categories. Add per-tool one-line descriptions and usage guidance (especially memory_write vs memory_patch vs memory_append, task_replay use cases, session_archive_read purpose).

**P1 — Safety & efficiency:**
- [x] Safety section: Anti-power-seeking guardrails for a continuously-running autonomous agent that accepts messages from external channels (Telegram, Slack, SMS). "No independent goals", "prioritize safety over completion", "do not bypass safeguards".
- [x] Tool Call Style guidance: Tell Main Agent when to think silently vs narrate in inner monologue. "Default: just call the tool. Narrate only for multi-step work, complex problems, or sensitive actions." Reduces inner monologue token waste.
- [x] Input sanitization: Strip Unicode control characters (bidi marks, zero-width chars, format overrides) from external channel messages before prompt injection. Defense against prompt injection via crafted Unicode.

**P2 — Context awareness & architecture:**
- [ ] Runtime metadata: One-line runtime info in system prompt (host, OS, model, timezone, workspace). Enables environment-aware decisions (e.g., brew vs apt).
- [ ] Section modularization: Refactor `_buildSystemPrompt()` into composable `buildXxxSection()` functions (identity, tools, safety, channels, session, skills). Independently testable, conditionally includable.

**P3 — Alignment verification:**
- [ ] Verify SUBAGENT.md content matches task-types.md design: Confirm explore/plan/general prompts include all designed constraints (e.g., "CONCISE RESULT: keep under 2000 chars", "READ ONLY", "NOTIFY: use notify() for progress").

### Project System (Long-Lived Task Spaces)
- [ ] PROJECT.md format: frontmatter (name, status, model, workdir, timestamps) + markdown body (goal, background, constraints)
- [ ] Project directory structure: `data/projects/<name>/` with session/, memory/, skills/
- [ ] ProjectAdapter: ChannelAdapter implementation using Bun Worker threads
- [ ] Project Agent Worker: independent Agent instance (own EventBus, TaskFSM, cognitive pipeline) running in Worker thread
- [ ] Project lifecycle FSM: created → active ⇄ suspended → completed → archived
- [ ] Project discovery: scan `data/projects/*/PROJECT.md` on startup, resume active Projects
- [ ] MainAgent project tools: create_project, list_projects, suspend_project, resume_project, complete_project, archive_project
- [ ] Project memory isolation: scoped memory_* tools, independent facts/episodes per Project
- [ ] Project skill loading: global skills + project-specific skills from `data/projects/<name>/skills/`
- [ ] Project Agent can spawn_subagent for one-off sub-tasks
- See `docs/project-system.md` for full design.

### Heartbeat & Scheduled Tasks
- [ ] Heartbeat system: periodic poll mechanism where the system pings the Agent to check if anything needs attention. Agent responds with ack (no-op) or alert message. Useful for: monitoring long-running background work, periodic memory consolidation, proactive user updates.
- [ ] Cron/scheduled tasks: time-based task triggers (reminders, periodic checks, scheduled reports). Integrate with EventBus as scheduled event sources.
- [ ] Wake events: external triggers that wake the Agent from idle (e.g., file system changes, webhook callbacks).

### MainAgent Reflection
- [ ] Reflection during session compact: extract facts/episodes while summarizing
- [ ] MainAgent sees user preferences, identity info — most valuable facts come from here

### Multi-User Identity & Permissions
- [ ] Owner ID hashing: In system prompt, represent authorized user IDs as HMAC-SHA256 hashes (first 12 hex chars) instead of raw phone numbers / Telegram IDs. Prevents identity leakage if prompt is extracted via prompt injection. Learned from OpenClaw's `formatOwnerDisplayId()`.
- [ ] Authorized senders: System prompt declares allowlisted sender hashes so the LLM can distinguish owner vs guest without seeing real identifiers.
- [ ] Per-user permission model: Different users get different tool access levels (e.g., owner can spawn_subagent, guest can only converse).

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
