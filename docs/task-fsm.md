# Task State Machine

> Source code: `src/pegasus/task/`

## Core Idea

Each task is an independent finite state machine (FSM). The FSM itself **performs no I/O operations** — it is responsible for only three things:
1. Validate the legality of state transitions
2. Update state
3. Record transition history

Actual LLM calls, tool calls, and other I/O operations are initiated by the Agent after a state transition.

## TaskState

6 states, 2 terminal:

```
                    ┌─────────┐
                    │  IDLE   │ ← just created
                    └────┬────┘
                         │ TASK_CREATED
                    ┌────▼─────┐
              ┌────▶│REASONING │ ← reason (understand + think + plan)
              │     └────┬─────┘
              │          │ REASON_DONE          NEED_MORE_INFO
              │     ┌────▼────┐                     │
              │     │ ACTING  │←── multi-step loop ┌▼─────────┐
              │     └────┬────┘                    │SUSPENDED │
              │          │                         └──┬───────┘
              │     ┌────▼────┐                       │
              │     │ Done?   │    MESSAGE_RECEIVED    │
              │     └────┬────┘    / TASK_RESUMED ─────┘
              │  tool_call│  respond
              │   steps   │  steps
              └───────────┘   │
                         ┌────▼─────┐
                         │COMPLETED │ ← terminal state
                         └──────────┘
                         ┌──────────┐
                         │ FAILED   │ ← terminal state (reachable from any)
                         └──────────┘
```

```typescript
const TaskState = {
    IDLE:        "idle",
    REASONING:   "reasoning",
    ACTING:      "acting",
    SUSPENDED:   "suspended",
    COMPLETED:   "completed",    // terminal
    FAILED:      "failed",       // terminal
} as const;
```

**Terminal states**: after reaching `COMPLETED` or `FAILED`, no further transitions are accepted; throws `InvalidStateTransition`.

**Suspendable states**: only active states (REASONING / ACTING) can be suspended.

## Transition Table

Static transitions (target state is fixed):

| Current State | Event | → Target State |
|---------------|-------|----------------|
| IDLE | TASK_CREATED | REASONING |
| REASONING | REASON_DONE | ACTING |
| REASONING | NEED_MORE_INFO | SUSPENDED |
| SUSPENDED | MESSAGE_RECEIVED | REASONING |

Dynamic transitions (target state determined at runtime):

| Current State | Event | → Dynamic Decision |
|---------------|-------|--------------------|
| ACTING | TOOL_CALL_COMPLETED | plan has more steps → ACTING; otherwise → see below |
| ACTING | TOOL_CALL_FAILED | plan has more steps → ACTING; otherwise → see below |
| ACTING | STEP_COMPLETED | plan has more steps → ACTING; otherwise → see below |
| SUSPENDED | TASK_RESUMED | restore to pre-suspend state |

**Completion routing** (when all plan steps are done):
- Plan contains any `tool_call` steps → **REASONING** (continue cognitive loop)
- Plan contains only `respond` steps → **COMPLETED** (task is done)

This replaces the old Reflect stage verdict. The FSM now makes the completion decision based on plan step types, eliminating the need for a separate reflection stage in the cognitive loop.

Special transitions (triggerable from any active state):

| Event | → Target State | Condition |
|-------|----------------|-----------|
| TASK_SUSPENDED | SUSPENDED | current state is active (suspendable) |
| TASK_FAILED | FAILED | any non-terminal state |

## TaskFSM

```
TaskFSM
├── taskId: string                     # short ID
├── state: TaskState                   # current state
├── context: TaskContext               # accumulated intermediate artifacts
├── history: StateTransition[]         # state transition history
├── createdAt / updatedAt: number
├── priority: number                   # priority (lower = higher)
└── metadata: Record<string, unknown>
```

**Key methods**:
- `transition(event) → TaskState`: execute transition, return new state; throws on invalid
- `canTransition(eventType) → boolean`: check if transition is valid (without executing)
- `fromEvent(event) → TaskFSM`: create task from external input event
- `isTerminal` / `isActive`: state queries

**Transition history**: each transition records a `StateTransition` (fromState, toState, triggerEventType, triggerEventId, timestamp), enabling precise reconstruction of every step.

## TaskContext

Task context — all information accumulated from task creation to completion:

```
TaskContext
├── Original input
│   ├── inputText: string
│   ├── inputMetadata: Record<string, unknown>
│   └── source: string
│
├── Cognitive stage outputs
│   ├── reasoning: Record<string, unknown> | null   # Reason (Thinker) output
│   ├── plan: Plan | null                           # Reason (Planner) output
│   ├── actionsDone: ActionResult[]
│   ├── reflections: Reflection[]                   # legacy, kept for compat
│   └── postReflection?: PostTaskReflection | null  # async post-task reflection
│
├── Loop control
│   └── iteration: number                           # Reason → Act loop iteration
│
├── Result
│   ├── finalResult: unknown
│   └── error: string | null
│
├── Suspend / Resume
│   ├── suspendedState: string | null               # state before suspension
│   └── suspendReason: string | null
│
└── Conversation history
    └── messages: Message[]                         # Working Memory fragment
```

**Plan data structure**:
```
Plan
├── goal: string                          # task goal
├── steps: PlanStep[]                     # execution steps
│   └── PlanStep
│       ├── index: number
│       ├── description: string
│       ├── actionType: string            # "tool_call" / "respond" / "generate"
│       ├── actionParams: Record<string, unknown>
│       └── completed: boolean
└── reasoning: string                     # planning rationale
```

Plan provides `currentStep` (next uncompleted step) and `hasMoreSteps` properties, which Actor uses to drive step execution.

**PostTaskReflection data structure**:
```
PostTaskReflection
├── facts: Array<{ path: string; content: string }>   # memory facts to write
├── episode: {                                         # episodic memory entry
│     title: string
│     summary: string
│     details: string
│     lesson: string
│   } | null
└── assessment: string                                 # brief assessment
```

PostTaskReflection is produced by the async PostTaskReflector after task completion. It writes extracted facts and episode summaries to long-term memory. Unlike the old Reflection verdict, it does not influence the cognitive loop — it is purely for learning.

## TaskRegistry

Active task registry. Maintains all uncompleted tasks.

```typescript
class TaskRegistry {
    register(task)                       // register new task
    get(taskId) → TaskFSM               // get task (throws if not found)
    getOrNull(taskId)                   // get task (returns null if not found)
    remove(taskId)                       // remove task
    listActive() → TaskFSM[]           // list active tasks
    listAll() → TaskFSM[]              // list all tasks
    cleanupTerminal()                    // clean up terminal tasks
    activeCount → number                // active task count
}
```

When the active task count reaches the `maxActive` limit, registration is not blocked but a warning is logged. The scheduling layer can decide whether to queue based on this.

## Persistence Strategy

Not every step is written to disk — only at critical checkpoints:

| Timing | Persisted Content | Reason |
|--------|-------------------|--------|
| TASK_CREATED | Input, source, metadata | Task identity and origin |
| REASON_DONE | Full Plan + reasoning + new messages | Planning is expensive, cannot lose |
| TOOL_CALL_COMPLETED | New messages (tool results) | Tool actions may be irreversible |
| TOOL_CALL_FAILED | New messages | Record failures for debugging |
| NEED_MORE_INFO | Reasoning | Track why task was suspended |
| TASK_SUSPENDED | Full TaskContext snapshot | Recovery needs full context |
| TASK_COMPLETED | Full TaskContext | Archive to Episodic Memory |
| REFLECTION_COMPLETE | Facts written, episode flag, assessment | Observability (async, post-task) |
| TASK_FAILED | TaskContext + error | Post-mortem analysis |
