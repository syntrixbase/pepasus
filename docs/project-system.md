# Project System

> **Status**: Design — not yet implemented

## What Is a Project?

A Project is a **long-lived task space** that MainAgent creates to manage an ongoing effort — frontend redesign, email management, social media operations, API migration, etc.

The key mental model: **one person, many projects**. MainAgent is the single brain; Projects are separate notebooks on different desks. Each notebook has its own notes, skills, and conversation history, but the same person is thinking across all of them.

| Concept | What It Is | Lifecycle | Context |
|---------|-----------|-----------|---------|
| **subagent** | One-off task executor | Created → done → discarded | Inherits from MainAgent |
| **Project** | Persistent task space | Created → active ⇄ suspended → completed → archived | Own session, memory, skills |
| **MainAgent** | The brain | Always running | Global persona + memory |

### Why Not Just Subagents?

Subagents are fire-and-forget: MainAgent describes a task, a subagent executes it, returns a result, and disappears. This works for atomic tasks ("search for X", "write function Y") but falls apart for ongoing work that spans days or weeks:

- **No continuity**: each subagent starts from scratch. Previous context is lost.
- **No accumulation**: a subagent cannot learn and remember across multiple interactions.
- **No initiative**: a subagent cannot proactively report status or ask for help.

Projects solve all three problems.

### How It Differs from OpenClaw's Workspace

OpenClaw's Workspace is an **identity container** — each Workspace is a separate persona with its own personality, memory, and skills. Multiple Workspaces = multiple independent agents that don't know about each other.

Pegasus Projects are different: they are **work contexts owned by a single agent**. MainAgent knows all Projects, can coordinate across them, and can transfer knowledge between them. A Project is not another person — it's another desk.

## Architecture

```
MainAgent (brain)
├── CLIAdapter              ← user terminal
├── TelegramAdapter         ← Telegram messages
├── ProjectAdapter "frontend-redesign"   ← Project channel
│   └── Worker Thread
│       └── ProjectAgent instance
│           ├── PROJECT.md (system prompt)
│           ├── session/ (conversation history)
│           ├── memory/ (facts + episodes)
│           ├── skills/ (project-specific)
│           ├── spawn_subagent (can delegate sub-tasks)
│           └── cwd → /path/to/code/repo (optional)
├── ProjectAdapter "social-media"
│   └── Worker Thread
│       └── ProjectAgent instance
└── spawn_subagent (one-off, existing mechanism unchanged)
```

### Key Design Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Naming | **Project** | Distinct from OpenClaw's Workspace; intuitive |
| 2 | Core directory | `data/projects/<name>/` | Unified plain directory for session, memory, skills |
| 3 | Working data | Separate from core directory | Code/work files live in independent git repos; Project directory stores only the agent's brain (memory, session, skills) |
| 4 | Agent instance | **Independent Agent per Project** | Own EventBus, TaskFSM, cognitive pipeline |
| 5 | Lifecycle | **Full state machine**: created → active ⇄ suspended → completed → archived | Supports long-running, pausable work |
| 6 | Concurrency | **Multiple Projects can be active in parallel** | MainAgent is a project manager overseeing many efforts |
| 7 | Communication | **Channel Adapter pattern** | Project ↔ MainAgent communication uses the same mechanism as Telegram/CLI |
| 8 | Initial context | **PROJECT.md definition file** | MainAgent generates it at creation time; injected as system prompt |
| 9 | LLM model | **Per-Project configurable** | In PROJECT.md frontmatter |
| 10 | Tools | **Base tools + project-specific skills + spawn_subagent** | Projects can delegate sub-tasks just like MainAgent |
| 11 | Runtime isolation | **Bun Worker thread per active Project** | Crash isolation, parallel execution, memory separation |

## Project Directory Structure

```
data/projects/
├── frontend-redesign/
│   ├── PROJECT.md              ← definition file (system prompt + metadata)
│   ├── session/
│   │   └── current.jsonl       ← conversation history
│   ├── memory/
│   │   ├── facts/
│   │   │   └── context.md      ← project-specific facts
│   │   └── episodes/
│   │       └── 2026-02.md      ← project-specific episodes
│   └── skills/
│       └── deploy/SKILL.md     ← project-specific skills
├── social-media/
│   ├── PROJECT.md
│   ├── session/
│   ├── memory/
│   └── skills/
└── api-migration/              ← status: archived
    ├── PROJECT.md
    ├── session/
    └── memory/
```

**Important**: the Project directory stores the agent's **brain** (memory, conversation, skills), not work data. If the Project involves coding, the actual code lives in a separate git repo. The `workdir` field in PROJECT.md points to it.

## PROJECT.md Format

Follows the same frontmatter + markdown body pattern as SUBAGENT.md and SKILL.md.

```yaml
---
name: frontend-redesign
status: active                          # created | active | suspended | completed | archived
model: "anthropic/claude-sonnet-4-20250514"  # optional, falls back to config default
workdir: /home/user/code/my-app         # optional, for code projects
created: 2026-02-28T10:00:00Z
suspended: null                         # timestamp of last suspension
completed: null                         # timestamp of completion
---

## Goal

Migrate the frontend component library from class components to React hooks.

## Background

- Current code is in src/components/ (~50 components)
- Using React 17, needs upgrade to React 18
- Must maintain backward compatibility during migration

## Constraints

- Migrate in batches, not all at once
- All tests must pass after each batch
- Keep backward compatibility
```

**Frontmatter fields**:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Project identifier (must match directory name) |
| `status` | Yes | Current lifecycle state |
| `model` | No | LLM model override (e.g. `"anthropic/claude-sonnet-4-20250514"`) |
| `workdir` | No | External working directory for code/data |
| `created` | Yes | Creation timestamp |
| `suspended` | No | Last suspension timestamp |
| `completed` | No | Completion timestamp |

**Body**: injected into Project Agent's system prompt. Contains goal, background, constraints — everything the agent needs to know about this project. Written by MainAgent at creation time, can be updated later.

## Lifecycle State Machine

```
                 ┌──────────────┐
    create_project()            │
                 ▼              │
            ┌─────────┐        │
            │ created  │        │
            └────┬─────┘        │
                 │ activate     │
                 ▼              │
            ┌─────────┐        │
     ┌─────►│  active  │◄──────┘ resume
     │      └────┬─────┘
     │           │ suspend / idle timeout
     │           ▼
     │      ┌───────────┐
     │      │ suspended  │
     │      └────┬───────┘
     │           │ resume
     └───────────┘
                 │ complete
                 ▼
            ┌───────────┐
            │ completed  │
            └────┬───────┘
                 │ archive
                 ▼
            ┌───────────┐
            │  archived  │
            └────────────┘
```

**State descriptions**:

| State | Worker Thread | Agent Instance | Session | Description |
|-------|--------------|----------------|---------|-------------|
| **created** | No | No | Empty | PROJECT.md exists, nothing running |
| **active** | Running | Running | Accumulating | Worker thread alive, processing messages |
| **suspended** | Stopped | Stopped | Preserved | Worker terminated, session/memory persisted on disk |
| **completed** | Stopped | Stopped | Preserved | Task done, results available |
| **archived** | Stopped | Stopped | Preserved | Historical record, no longer relevant |

**Transitions**:

| From | To | Trigger | What Happens |
|------|-----|---------|-------------|
| — | created | `create_project()` tool call | MainAgent generates PROJECT.md, creates directory structure |
| created | active | Automatic (immediately after creation) | Spawn Worker thread, init Agent, load PROJECT.md as system prompt |
| active | suspended | `suspend_project()` / idle timeout | Graceful shutdown: flush session, terminate Worker |
| suspended | active | `resume_project()` / MainAgent decision | Spawn Worker, load persisted session, continue |
| active | completed | `complete_project()` / Project Agent self-reports | Flush session, terminate Worker, mark done |
| completed | archived | `archive_project()` / auto-archive policy | Update status field, no data deleted |

## Communication: Channel Adapter Pattern

Project ↔ MainAgent communication reuses the existing Channel Adapter architecture. A Project appears to MainAgent as just another channel — like Telegram or CLI.

### ProjectAdapter

```typescript
class ProjectAdapter implements ChannelAdapter {
  readonly type = "project";
  readonly projectId: string;
  private worker: Worker | null = null;

  // MainAgent → Project
  async deliver(message: OutboundMessage): Promise<void> {
    this.worker?.postMessage({
      type: "message",
      text: message.text,
      channel: message.channel,
    });
  }

  // Project → MainAgent (via Worker postMessage)
  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    this.worker = new Worker("./project-agent-worker.ts", { smol: true });
    this.worker.onmessage = (event) => {
      if (event.data.type === "notify") {
        agent.send({
          text: event.data.text,
          channel: { type: "project", channelId: this.projectId },
        });
      }
    };
    this.worker.postMessage({ type: "init", projectPath: "..." });
  }

  async stop(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
  }
}
```

### Message Flow

```
User (CLI): "check on the frontend project"
  → CLIAdapter → MainAgent.send()
  → MainAgent LLM thinks: "I should ask the frontend-redesign project for status"
  → reply(channelType="project", channelId="frontend-redesign", text="what's your current status?")
  → ProjectAdapter.deliver() → Worker.postMessage()
  → ProjectAgent receives message, processes it
  → ProjectAgent responds via postMessage()
  → ProjectAdapter.onmessage → MainAgent.send(channel=project)
  → MainAgent LLM thinks: "Project says X, I should tell the user"
  → reply(channelType="cli", text="Frontend project status: ...")
  → CLIAdapter.deliver() → stdout
```

### Cross-Project Coordination

Because all Project messages flow through MainAgent, cross-project coordination is natural:

```
ProjectAdapter "api-migration" → MainAgent:
  "I found a breaking API change that affects the frontend"

MainAgent thinks:
  "This is relevant to the frontend-redesign project"

MainAgent → ProjectAdapter "frontend-redesign":
  "The API migration project found a breaking change in /api/users. Please adjust the frontend components."
```

## Worker Thread Model

Each active Project runs in a **Bun Worker thread** — a separate JavaScript runtime on its own thread.

### Why Worker Threads?

| Concern | Solution |
|---------|----------|
| **Crash isolation** | Worker crash doesn't take down MainAgent |
| **Memory isolation** | Each Project has its own heap; no cross-contamination |
| **Parallel execution** | Multiple Projects work simultaneously on different threads |
| **Clean lifecycle** | `worker.terminate()` for instant cleanup |

### Worker Architecture

```
Main Thread (MainAgent)
│
├── Worker Thread 1 (Project "frontend-redesign")
│   ├── Own EventBus
│   ├── Own Agent (TaskRegistry, TaskFSM, cognitive pipeline)
│   ├── Own ToolRegistry + ToolExecutor
│   ├── Own SessionStore (data/projects/frontend-redesign/session/)
│   ├── Own MemoryManager (data/projects/frontend-redesign/memory/)
│   └── Communication: postMessage ↔ ProjectAdapter
│
├── Worker Thread 2 (Project "social-media")
│   └── ... (same structure)
│
└── Main thread Agent (for subagents, same as today)
```

### Worker Entry Point

```typescript
// project-agent-worker.ts
declare var self: Worker;

self.onmessage = async (event) => {
  if (event.data.type === "init") {
    const { projectPath, config } = event.data;
    // 1. Load PROJECT.md
    // 2. Initialize Agent, EventBus, ToolRegistry, SessionStore, MemoryManager
    // 3. Build system prompt from PROJECT.md body
    // 4. Start Agent event loop
    // 5. Signal ready
    postMessage({ type: "ready" });
  }

  if (event.data.type === "message") {
    // MainAgent sent a message → inject as user message → trigger reasoning
    agent.submit(event.data.text, "main-agent");
  }

  if (event.data.type === "shutdown") {
    // Graceful shutdown: flush session, stop EventBus
    await agent.shutdown();
    postMessage({ type: "shutdown-complete" });
    process.exit(0);
  }
};
```

### Resource Management

- **`smol: true`**: reduces per-Worker memory footprint
- **`worker.unref()`**: Workers don't prevent MainAgent from exiting
- **Semaphores**: each Worker has its own LLM/tool semaphores (not shared with MainAgent)

## Initial Context Injection

When MainAgent creates a Project, it does NOT copy its entire memory. Instead:

1. **MainAgent generates PROJECT.md** — writes goal, background, constraints based on what it knows
2. **PROJECT.md is the only initial context** — injected as system prompt
3. **Project Agent starts with empty memory** — it accumulates its own facts/episodes over time
4. **MainAgent can send follow-up messages** — additional context via the channel

This is analogous to a manager briefing a team lead: the manager writes a project brief (PROJECT.md), hands it to the team lead, and then they communicate via messages. The team lead doesn't get a copy of the manager's entire brain.

## MainAgent Tools for Project Management

New tools added to MainAgent's tool set:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_project` | `name`, `goal`, `background?`, `constraints?`, `model?`, `workdir?` | Create new Project, generate PROJECT.md, activate |
| `list_projects` | `status?` | List all Projects with status summary |
| `suspend_project` | `name` | Suspend active Project (stop Worker, preserve state) |
| `resume_project` | `name` | Resume suspended Project (start Worker, load state) |
| `complete_project` | `name` | Mark Project as completed |
| `archive_project` | `name` | Archive completed Project |

Note: MainAgent communicates with active Projects via the existing `reply()` tool (channelType = "project"). No special "send message to project" tool is needed.

## Project Agent Tools

A Project Agent has a similar tool set to a `general` subagent, plus:

| Tool | Description |
|------|-------------|
| `spawn_subagent` | Delegate one-off sub-tasks (same as MainAgent) |
| `notify` | Send messages to MainAgent (via Worker postMessage) |
| `memory_*` | Read/write its own memory (scoped to project directory) |
| `read_file`, `write_file`, etc. | File operations (scoped to workdir if specified) |
| `use_skill` | Use project-specific skills |

**Not available**:
- `reply()` — Project Agent doesn't talk to users directly; it communicates through MainAgent
- `create_project` — Projects don't create sub-projects (use subagents instead)

## Project Discovery and Startup

On MainAgent startup:

1. Scan `data/projects/*/PROJECT.md`
2. Parse frontmatter to get status
3. For each `active` Project → spawn Worker thread, register ProjectAdapter
4. For `suspended`/`completed`/`archived` → register metadata only (no Worker)

This mirrors how subagents and skills are discovered — file scanning, no index file.

## Session Management Within Projects

Each Project has its own SessionStore (`data/projects/<name>/session/`):

- **Same format as MainAgent**: JSONL files, append-only
- **Same compaction logic**: auto-compact when context window fills up
- **Independent from MainAgent session**: Project session tracks Project-internal conversations
- **Persisted across suspend/resume**: when a Project is resumed, its session history is loaded

## Memory Isolation

```
data/memory/                          ← MainAgent memory (global)
├── facts/user.md
├── facts/project.md
└── episodes/2026-02.md

data/projects/frontend-redesign/      ← Project memory (scoped)
├── memory/facts/context.md
├── memory/facts/decisions.md
└── memory/episodes/2026-02.md
```

- MainAgent memory = global knowledge (user preferences, system facts)
- Project memory = project-specific knowledge (decisions made, patterns found, progress notes)
- Project Agent's `memory_*` tools are scoped to `data/projects/<name>/memory/`
- MainAgent can read Project memory if needed (via `memory_read` with explicit path)
- Cross-pollination happens through MainAgent ↔ Project messages, not shared memory

## Relationship to Existing Systems

### Subagents (unchanged)

The existing subagent system (`spawn_subagent`, TaskFSM, etc.) is unchanged. Both MainAgent and Project Agents can spawn subagents for one-off tasks.

### Skills

- **Global skills** (`skills/`, `data/skills/`): available to MainAgent and all Projects
- **Project skills** (`data/projects/<name>/skills/`): only available to that Project
- Project Agent's SkillRegistry loads both global and project-specific skills

### Channel Adapters

ProjectAdapter is a new ChannelAdapter implementation. It follows the same interface as CLIAdapter and TelegramAdapter. MainAgent's multi-channel routing handles it transparently.

### EventBus

Each Project Worker has its own EventBus instance. Events don't cross Worker boundaries. Communication between MainAgent and Project happens via postMessage, which the ProjectAdapter translates to/from channel events.

## Future Considerations

- **Heartbeat**: active Projects could have periodic self-check cycles (ties into the planned Heartbeat system)
- **Project templates**: pre-defined PROJECT.md templates for common project types
- **Project-to-Project communication**: currently all communication goes through MainAgent; direct Project ↔ Project channels could be added later
- **Auto-suspend**: idle timeout to automatically suspend Projects that haven't been active
- **Resource limits**: per-Project token budgets, tool call limits
