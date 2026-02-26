# Cognitive Pipeline

> Source code: `src/pegasus/cognitive/`

## Core Idea

Cognition is not a loop — it is a **state machine path**. Reason → Act is not `for` or `while`; it is a sequence of FSM state transitions. Each stage is an independent, stateless processor — it takes a TaskContext as input and produces a result. That is all.

## Two Stages

```
Reason ──▶ Act
  ▲          │
  └── tool_call steps: back to Reason
             │
             └── respond steps: → COMPLETED
```

### Reason

```
Input:  TaskContext (inputText, messages, memory index)
Output: dict (reasoning conclusions) + Plan (execution plan)

Internal flow:
1. Thinker — LLM call: understand input + reason + tool selection
2. Planner — pure code: convert Thinker's toolCalls into PlanStep[]
```

Reason is the merged first stage, replacing the original Perceive + Think + Plan as three separate stages. Reasons for merging:

- **Perceive wasted an LLM call** — it extracted taskType/intent/urgency/keyEntities, but downstream only used taskType (a simple `=== "conversation"` check)
- **Plan did not call LLM** — it just mechanically converted Think's toolCalls into PlanStep[], which is data format conversion, not planning
- **Context fragmentation** — Perceive and Think each independently called LLM; Perceive's analysis was never passed into Think's context

After merging: a single LLM call handles understanding + reasoning + tool selection, then Planner (pure code) internally converts the result into an execution plan.

**Why keep the Planner class**:
- Keeps format conversion logic isolated and testable
- Reserves an extension point for LLM-based planning in future milestones
- Avoids bloating `_runReason()`

Reason is also the re-entry point after Act completes with tool_call steps — the FSM routes back to REASONING for a new round of reasoning with updated context.

The Think stage is the only place that can produce `NEED_MORE_INFO`. If information is judged insufficient, the task enters SUSPENDED and waits for supplementary input.

### Act

```
Input:  TaskContext (contains plan.currentStep)
Output: ActionResult

Responsibilities:
- Execute steps from the Plan one by one
- Call tools (MCP), generate content, or spawn sub-tasks
- Record each step's result, duration, success/failure
```

Act differs from Reason — it **self-loops** within the ACTING state. If the Plan has 3 steps, Actor executes 3 times. After each step completes, the FSM checks for remaining steps: if more exist, stay in ACTING; if none remain, the FSM resolves the target state dynamically based on plan step types.

**Completion decision**: when all steps are done, the FSM examines the plan:
- If the plan contains any `tool_call` steps → transition to **REASONING** (continue cognitive loop)
- If the plan contains only `respond` steps → transition to **COMPLETED** (task is done)

Act uses `_tool_semaphore` instead of `_llm_semaphore`, since it primarily calls tools rather than LLM.

## Async Post-Task Reflection

After a task reaches COMPLETED, the Agent optionally spawns an async **PostTaskReflector**. This is **not** a cognitive stage — it is a fire-and-forget background process for memory learning.

```
COMPLETED → shouldReflect(context)?
              ├── No  → done
              └── Yes → _spawn(_runPostReflection)
                          ├── Pre-load existing facts (full content)
                          ├── Pre-load episode index (summaries)
                          ├── Tool-use loop (max 5 rounds):
                          │     LLM decides what to remember
                          │     LLM calls memory tools directly:
                          │       memory_read / memory_write /
                          │       memory_patch / memory_append
                          └── Emit REFLECTION_COMPLETE (observability only)
```

**Key properties**:
- Runs **after** the task result has been delivered to the user
- Uses a **tool-use loop**: the LLM calls memory tools directly (read/write/patch/append) rather than producing structured JSON for the Agent to execute
- The Reflector's system prompt includes memory format instructions so the LLM knows how to structure facts and episodes
- Existing facts and episode index are pre-loaded and provided as context, so the LLM can make informed decisions about what to update vs. create
- Maximum **5 tool-use rounds** to prevent runaway reflection
- `reflectionTools` collection: includes `memory_read`, `memory_write`, `memory_patch`, `memory_append` (no `memory_list` — index is pre-loaded)
- Errors never affect task results (caught and logged)
- `shouldReflect()` filters out trivial tasks (single iteration, short response)
- Emits `REFLECTION_COMPLETE` event for observability and persistence

## Processor Interface

```typescript
class Thinker:
    async run(context: TaskContext, memoryIndex?: MemoryIndexEntry[]) -> Record<string, unknown>

class Planner:
    async run(context: TaskContext) -> Plan

class Actor:
    async run(context: TaskContext, step: PlanStep) -> ActionResult

class PostTaskReflector:
    async run(context: TaskContext, existingFacts: FactFile[], episodeIndex: EpisodeIndex[]) -> PostTaskReflection
```

**Stateless**: processors hold no instance state. All needed information is read from TaskContext, and all output is written back to TaskContext. The same Thinker instance can simultaneously serve 10 different tasks.

Note: `PostTaskReflector.run()` receives pre-loaded `existingFacts` (full file content) and `episodeIndex` (summaries only) so the LLM can decide what to update, patch, or create. It returns `PostTaskReflection` containing `{ assessment, toolCallsCount }` — the actual memory writes are performed by the LLM directly via the tool-use loop inside `run()`.

## Agent._runReason() Internal Flow

```typescript
private async _runReason(task, trigger):
  // 1. Fetch memory index ONLY on first iteration
  if (context.iteration === 1)
    memoryIndex = await memory_list(...)

  // 2. LLM call — understand + reason + decide actions
  //    memoryIndex (if present) is injected as a user message, not system prompt
  reasoning = await thinker.run(context, memoryIndex)
  context.reasoning = reasoning

  // 3. Pure code — convert toolCalls to Plan steps
  plan = await planner.run(context)
  context.plan = plan

  // 4. Emit single event
  emit(REASON_DONE) or emit(NEED_MORE_INFO)
```

One LLM call, one state transition, continuous context maintained via `context.messages`. Memory index is fetched once and injected as a user message at `iteration === 1` — subsequent iterations already have it in conversation history.

## Concurrency

```
Timeline:

t0: User: "Search for AI Agent papers"
    → Task-A created, enters REASONING

t1: User: "Also write a CSV parsing script"
    → Task-B created, enters REASONING
    → Task-A and Task-B Thinkers run concurrently

t2: Task-A reasoning done → ACTING (calls search tool)
    Task-B reasoning done → ACTING
    → Fully concurrent, no mutual blocking

t3: User: "Only papers from 2024"
    → New message arrives, but Task-A is in ACTING
    → Agent can:
      a) Create new Task-C to handle this message
      b) Inject info into Task-A's context, suspend and re-reason
```

## Evolution: From 5 Stages to 2 Stages

Original 5 stages: Perceive → Think → Plan → Act → Reflect (2 LLM calls in cognitive loop)

Current 2 stages: Reason → Act (1 LLM call in cognitive loop, async reflection outside the loop)

The merge reduced initial processing LLM calls by 50%, eliminated 3 valueless state transitions, moved reflection out of the critical path as an async post-task process, and achieved continuous context passing via `context.messages`.
