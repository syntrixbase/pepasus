# M2: Memory System Design

> Status: **✅ Completed** (PR #17, #18)
> Date: 2026-02-25

## 1. Core Philosophy

**Long-term memory** — not conversation history storage, but remembering **meaningful, important things**.

Like a human: does not memorize every word verbatim, but remembers key facts and significant experiences.

### What This Is NOT

- NOT a conversation window / sliding-window manager
- NOT a vector database or embedding search
- NOT a token-counting context compressor

## 2. Memory Content: Facts + Episodes

Two complementary types of memory, combined:

| Type | What It Captures | Example |
|------|-----------------|---------|
| **Facts** | Persistent truths about the user, project, preferences | "User prefers Chinese discussion, English code" |
| **Episodes** | Summaries of significant tasks and their outcomes | "Fixed logger stdout leak by replacing pipeline with custom line-transport" |

### Why Both?

- **Facts alone** lose context — knowing a preference without knowing why it matters.
- **Episodes alone** are hard to query — searching through stories for a simple fact is wasteful.
- **Combined**: facts for quick lookups, episodes for reasoning and learning from experience.

## 3. Storage: Pure Markdown Files

**Zero external dependencies.** No SQLite, no ChromaDB, no vector DB.

### Directory Layout

```
data/memory/
├── facts/
│   ├── user.md          # User-related facts
│   ├── project.md       # Project-related facts
│   └── preferences.md   # Preference settings
└── episodes/
    ├── 2026-02.md       # Experience summaries for Feb 2026
    └── 2026-03.md       # Organized by month
```

### Why Markdown?

- **Human-readable**: open with any editor, review and correct anytime
- **Human-editable**: user can directly add, remove, or fix memories
- **Versionable**: works with git, diffs are meaningful
- **Zero dependencies**: just `fs.readFile` / `fs.writeFile`
- **LLM-native**: LLMs understand markdown natively, no serialization needed

### File Format: Facts

Each fact file also has a file-level `> Summary:` line, same as episodes.

```markdown
# User Facts

> Summary: user name, language, role

- Name: Zhang San
- Language: prefers Chinese discussion, English code
- Role: Full-stack developer
- Updated: 2026-02-24
```

### File Format: Episodes

Each episode entry starts with a one-line `Summary`. This summary is injected into the system prompt index so the LLM can decide whether to load the full entry without reading the entire file.

**Summary must be ultra-concise** — every token in the system prompt costs context window budget. Use shorthand, arrows, abbreviations. Aim for under 10 words.

```markdown
# 2026-02 Episodes

> Summary: logger fix, short ID, config refactor

## Logger stdout leak fix
- Summary: pino pipeline stdout leak → custom JS transport
- Date: 2026-02-24
- Problem: pino-pretty in pipeline mode leaks to stdout
- Solution: Custom line-transport.js, removed pipeline entirely
- Lesson: pino worker threads cannot load .ts files in Bun

## Short ID implementation
- Summary: UUID → 16-char hex short ID
- Date: 2026-02-24
- Task: Replace full UUID with shorter IDs
- Solution: First 64 bits of UUID v4 as 16-char hex
- Collision probability: ~1 in 2^64
```

The file-level `> Summary:` line is regenerated after each `memory_write` or `memory_append`. The `memory_list` tool reads these summaries and the system prompt is built from `memory_list` output at the start of each task.

## 4. Organization: Directory Structure IS the Index

No separate index file or database needed. The directory tree itself serves as the index.

The LLM reads the directory listing to know what memories are available, then selects which files to read — a progressive, two-step retrieval.

### Why This Works

- Adding a new memory category = creating a new file
- The "schema" is just the directory layout — infinitely extensible
- No index maintenance, no sync issues, no corruption risk

## 5. Retrieval: LLM Judges Relevance via User Message

### Two-Step Retrieval Process

**Step 1 — Inject memory index as the first user message (iteration=1 only):**

At the start of a task (first cognitive iteration only), `memory_list` is called and its output is injected as a **user message** — not in the system prompt. This keeps the system prompt clean and avoids wasting context budget on every subsequent iteration.

```
[User message injected at iteration=1]

Available memory:
- facts/user.md (320B): user name, language, role
- facts/project.md (210B): tech stack, conventions
- episodes/2026-02.md (1.2KB): logger fix, short ID, config refactor

Use memory_read to load relevant files before responding.
```

This message is only added once (when `iteration === 1`). On subsequent reasoning iterations (after tool calls return), the memory index is already in the conversation history and does not need to be re-fetched.

**Step 2 — LLM decides** which files to read (if any) based on the current task.

### Why LLM-Driven?

- **Semantic understanding**: the LLM knows whether "what's my name?" requires `facts/user.md`
- **No keyword matching**: avoids brittle regex or TF-IDF approaches
- **Context-aware**: the same memory file may be relevant in one context and irrelevant in another
- **Prompt guidance**: we control retrieval behavior through prompt engineering, not code

## 6. Implementation: Memory Tools

Memory is accessed through the existing tool system (M3 infrastructure), requiring no changes to the cognitive loop.

### Tool Definitions

| Tool | Purpose | When Called |
|------|---------|------------|
| `memory_read` | Read a specific memory file | Thinker decides current task needs it |
| `memory_write` | Create or overwrite a fact file | New important fact learned |
| `memory_patch` | Patch specific sections of a memory file | Update individual facts without rewriting entire file |
| `memory_append` | Append an episode entry | After significant task completion |
| `memory_list` | List available memory files with summary | Auto-called at iteration=1 to build memory index |

### Tool Signatures

```typescript
// memory_read: Read a memory file
{
  name: "memory_read",
  params: { path: string }  // e.g., "facts/user.md"
  returns: string            // file content
}

// memory_write: Write/overwrite a fact file
{
  name: "memory_write",
  params: { path: string, content: string }
  returns: { success: boolean }
}

// memory_patch: Patch specific sections of a memory file
{
  name: "memory_patch",
  params: {
    path: string,            // e.g., "facts/user.md"
    patches: Array<{
      oldText: string,       // text to find
      newText: string        // replacement text
    }>
  }
  returns: { success: boolean, appliedCount: number }
}

// memory_append: Append an episode entry
{
  name: "memory_append",
  params: {
    path: string,
    entry: string,           // markdown block
    summary?: string         // optional: override file-level summary line
  }
  returns: { success: boolean }
}

// memory_list: List memory files with summary
{
  name: "memory_list",
  params: {}
  returns: Array<{
    path: string,
    summary: string,  // e.g. "user name, language, role"
    size: number      // bytes, so LLM can avoid loading huge files
  }>
}
```

### Path Sandboxing

All paths are relative to `data/memory/` and **must not escape** that directory. The tools validate paths to prevent directory traversal attacks.

## 7. Write Timing: When Memories Are Created

### How the Reflector Works

The **PostTaskReflector** runs as a **tool-use loop** after task completion. Instead of producing structured JSON output that the Agent then parses and executes, the Reflector LLM directly calls memory tools (read/write/patch/append) in a multi-turn conversation.

Before the loop starts, the Agent pre-loads:
- **Existing facts** (full content of all fact files)
- **Episode index** (summaries from episode files)

These are provided to the Reflector's system prompt so it has full context to decide what to update.

### Fact Extraction

```
Reflector (tool-use loop):
  "User mentioned their name is Zhang San — this is a persistent fact."
  → LLM calls memory_write("facts/user.md", updated content)
  "User's role already recorded but needs update."
  → LLM calls memory_patch("facts/user.md", [{ oldText: ..., newText: ... }])
```

### Episode Archival

```
Reflector (tool-use loop):
  "We fixed a non-trivial bug (logger stdout leak). The root cause and
   solution are worth remembering for similar issues."
  → LLM calls memory_append("episodes/2026-02.md", summary block)
```

### What Triggers a Write?

Not every conversation creates a memory. The LLM judges importance:

- **Write**: user states personal info, project preference, or we solve a non-trivial problem
- **Skip**: casual chat, simple questions with no lasting value

## 8. Architecture Integration

```
                    ┌─ memory_list → directory index (iteration=1 only)
First User Msg ─────┤
                    └─ "use memory tools if relevant"
                           │
Thinker ───── LLM call ────┤── may request memory_read
                           │── generates response
                           │
Reflector ── tool-use loop ┤── LLM directly calls memory_write (new facts)
  (pre-loaded facts +      │── LLM directly calls memory_patch (update facts)
   episode index)          └── LLM directly calls memory_append (experience)
```

### Key Insight

The memory system integrates **entirely through the tool mechanism**. No modifications needed to:

- EventBus
- TaskFSM state machine
- Cognitive loop (reason → act)
- Agent event dispatch

The only changes are:

1. Register memory tools in the ToolRegistry (and a separate `reflectionToolRegistry` for PostTaskReflector)
2. Inject memory directory listing as the first user message (iteration=1 only)
3. Let the existing tool-call loop handle `memory_read` during reasoning
4. PostTaskReflector uses its own tool-use loop to call `memory_write` / `memory_patch` / `memory_append` directly

## 9. Configuration

```yaml
memory:
  dataDir: data/memory    # Root directory for memory files
```

Replace the current `dbPath` / `vectorDbPath` config with a single `dataDir`.

## 10. Acceptance Criteria

| # | Criterion | How to Verify |
|---|-----------|---------------|
| 1 | **Remembers user info across restarts** | User says "I'm Zhang San" → restart → ask "what's my name?" → correct answer |
| 2 | **Remembers past work** | Ask "what bug did we fix last time?" → accurate summary |
| 3 | **Human-readable files** | Open `data/memory/facts/user.md` in an editor → makes sense |
| 4 | **Human-editable** | Manually edit a memory file → agent uses updated content |
| 5 | **Zero new dependencies** | No new entries in `package.json` |
| 6 | **Test coverage >= 95%** | `make coverage` passes |

## 11. Explicitly Out of Scope

- **Conversation history / working memory** — Not part of M2. Context window management is a separate concern.
- **Vector search / embeddings** — Overkill for the current scale. Directory-based retrieval with LLM judgment is sufficient.
- **Database storage** — No SQLite, no KV store. Plain files only.
- **Token counting / context compression** — No sliding window, no summarization of old messages.
- **Automatic forgetting / decay** — Memories persist until explicitly updated or deleted.

## 12. Future Considerations

If memory files grow very large (hundreds of entries), we may need:

- **Splitting**: break large episode files into smaller chunks (e.g., by week instead of month)
- **Summarization**: periodically compress old episodes into higher-level summaries
- **Selective injection**: instead of listing all files in the system prompt, only list recent or frequently-accessed ones

These are optimizations for scale, not needed for M2 MVP.
