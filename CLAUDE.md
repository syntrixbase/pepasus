# CLAUDE.md - 开发指南

- Always disucss in "中文" with user and write document and code in English.
- Always run testing after code changes to ensure code quality.
- Always run `make coverage` to evaluate test coverage and fix as needed.
- Always ask "should I add more testing" and make robust but not over-engineering testing.
- Always document the "Why" (reasoning/analysis) alongside the "How" (decision/implementation) in design discussion documents.
- Reminder: Add timeout to test if potential stuck.
- Reminder: Fix everything in one pass—search globally first, then verify and echo back, so the user never has to repeat the same request.

## 🚨 STOP CONDITIONS

IMMEDIATELY STOP and ask user when:

- Authentication/permission errors
- Need to add new dependencies
- Creating new architectural patterns
- **Ambiguous Intent**: If user says "load task", "check this", or "investigate", ONLY analyze and plan. DO NOT CODE.

## 🚫 FORBIDDEN PATTERNS

- Start coding without a **confirmed plan** from the user.
- Adding "Generated with Claude Code", "via Happy", or any co-author credits in commit messages.
- **Git force push**: Never use `git push --force` or `git push -f`. Use `git push --force-with-lease` only when absolutely necessary and with explicit user consent.
- **NEVER push directly to main**: All changes must go through Pull Request workflow:
  1. Commit to feature branch
  2. Push feature branch to remote
  3. Create Pull Request
  4. Wait for CI to pass
  5. Merge to main (CI passed)
  6. DO NOT merge or push to main directly under any circumstances
- **NEVER delete or modify files under `data/`**: The `data/` directory contains live runtime data (sessions, task logs, memory). Never `rm -rf data/`, never clean up `data/` subdirectories. If you suspect test pollution, report it — do NOT delete.
- **NEVER remove or modify worktrees you did not create**: Other worktrees (e.g., `/workspace/pegasus-1`) belong to the user or other sessions. Never run `git worktree remove` on them. If a worktree blocks an operation, STOP and ask the user — do NOT force-remove it.

## 🔄 DECISION TREE

Before ANY file creation:

1. Can I modify existing file? → Do that
2. Is there a similar file? → Copy and modify
3. Neither? → Ask user first

Before ANY change:

1. Will this need new imports? → Check if already available

## 📝 HIERARCHY RULES

- Check for AGENTS.md in current directory
- Subdirectory rules compliment root rules
- If conflict → subdirectory wins

## Preference

- Uses `bun` for frontend package scripts.
- `README.md` is the project entry point.
- `docs/` — persistent system design docs: architecture decisions, the "Why" behind designs. Survives implementation.
- `docs/plans/` — disposable implementation plans: step-by-step task lists, checklists. Gitignored. Delete after execution.

## Documentation Map

| Document | Content |
|----------|---------|
| `docs/architecture.md` | Layered architecture, core abstractions, system diagrams |
| `docs/main-agent.md` | Main Agent: inner monologue, reply tool, Channel Adapter, Session, System Prompt |
| `docs/cognitive.md` | Cognitive pipeline: Reason → Act (2-stage) + async PostTaskReflector |
| `docs/task-fsm.md` | TaskFSM: states, transitions, suspend/resume |
| `docs/events.md` | EventType, EventBus, priority queue |
| `docs/agent.md` | Agent (Task System): event processing, cognitive dispatch |
| `docs/tools.md` | Tool registration, execution, timeout, LLM function calling |
| `docs/memory-system.md` | Long-term memory: facts + episodes, memory tools |
| `docs/task-persistence.md` | JSONL event logs, replay, index, pending |
| `docs/configuration.md` | YAML config + env var interpolation |
| `docs/multi-model.md` | Per-role model config with ModelRegistry |
| `docs/session-compact.md` | Auto-compact with context window awareness |
| `docs/logging.md` | Log format, output, rotation |
| `docs/running.md` | Setup and usage guide |
| `docs/progress.md` | Milestones, test coverage, tech stack |
| `docs/todos.md` | Planned features, improvements, ideas |
| `docs/skill-system.md` | Prompt-based skill system: SKILL.md format, loader, registry |
| `docs/task-types.md` | Subagent specialization: file-based definitions (SUBAGENT.md), loader, registry |
| `docs/codex-api.md` | Codex API integration: Responses API, OAuth, provider config |
