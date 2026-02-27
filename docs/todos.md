# TODOs

Tracked features, improvements, and ideas that are planned but not yet started.

## Next Up

### Skill System
- [ ] Skill framework: SkillLoader, SkillRegistry, SKILL.md format (YAML frontmatter + markdown body)
- [ ] Skill storage: `skills/` (builtin, git tracked) + `data/skills/` (user/LLM created, runtime)
- [ ] Skill triggering: LLM-driven (description in context) + user `/` command
- [ ] Skill injection: inline (MainAgent/TaskAgent context) + fork (spawn_task)
- [ ] LLM-created skills: PostTaskReflector can create new skills from repeated patterns

### Task Types (Subagent Specialization)
- [ ] Task type system: explore, plan, general, deepresearch, etc.
- [ ] Per-type tool sets: explore (read-only), plan (read-only + write plans), general (all tools)
- [ ] Per-type system prompts: specialized instructions for each type
- [ ] `spawn_task` type parameter: MainAgent specifies task type when spawning
- [ ] Skill `agent` field maps to task type

## Planned

### MainAgent Reflection
- [ ] Reflection during session compact: extract facts/episodes while summarizing
- [ ] MainAgent sees user preferences, identity info — most valuable facts come from here

### Multi-Channel
- [ ] Slack channel adapter
- [ ] SMS channel adapter
- [ ] Web/API channel adapter

### Memory Improvements
- [ ] Episode splitting: break large monthly files by week
- [ ] Episode summarization: compress old episodes into higher-level summaries
- [ ] Selective injection: only list recent/relevant memory in context
- [ ] Memory decay: auto-archive old, unused facts

### Tool System
- [ ] MCP server integration: connect external tool services via standard protocol
- [ ] Custom tool plugins: user-defined TypeScript tools
- [ ] Tool permission system: per-tool approval rules

### Observability
- [ ] Task execution dashboard
- [ ] Memory usage visualization
- [ ] Token cost tracking per task/session
