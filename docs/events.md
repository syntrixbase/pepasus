# Event System

> Source code: `src/pegasus/events/`

## Core Idea

Everything that happens in the system is an event. A user sending a message is an event, a tool returning a result is an event, a timer firing is an event, and a task state change is also an event. The only thing the Agent does is: process events.

## Event

Events are immutable value objects — once created, they cannot be modified.

```
Event
├── id: string                  # short ID, globally unique
├── type: EventType             # event type
├── timestamp: number           # Unix ms timestamp
├── source: string              # origin ("user", "cognitive.reason", "system"...)
├── taskId: string | null       # associated task ID (null = unassigned)
├── payload: Record<string, unknown>  # data carried by the event
├── priority: number | null     # custom priority (null → use EventType numeric value)
└── parentEventId: string | null # causality chain: derived from which event
```

**Immutability**: Event uses `Object.freeze`; no field can be modified after creation. This guarantees that events are never accidentally mutated as they travel through the system.

**Causality chain**: `parentEventId` records the causal relationship between events. For example, `REASON_DONE`'s parent points to the `TASK_CREATED` that triggered it. You can trace the complete event chain backwards from any event.

**Priority**: `effectivePriority` determines the event's order in the queue. By default it uses the EventType numeric value (lower = higher priority), but can be overridden via the `priority` field.

**Derivation**: `deriveEvent(parent, type, overrides)` creates a new event that inherits `taskId`, `source`, and the causality chain from the parent.

## EventType

Event types are numeric constants; the numeric value itself serves as the default priority. Assigned by segment:

```
EventType
│
├── System events (0-99)                 # highest priority
│   ├── SYSTEM_STARTED       = 0        # system started
│   ├── SYSTEM_SHUTTING_DOWN = 1        # system shutting down
│   └── HEARTBEAT            = 90       # heartbeat
│
├── External input events (100-199)
│   ├── MESSAGE_RECEIVED     = 100      # user/external message
│   ├── WEBHOOK_TRIGGERED    = 110      # webhook callback
│   └── SCHEDULE_FIRED       = 120      # timer fired
│
├── Task lifecycle events (200-299)
│   ├── TASK_CREATED         = 200      # new task created
│   ├── TASK_STATE_CHANGED   = 210      # state changed
│   ├── TASK_COMPLETED       = 220      # task completed
│   ├── TASK_FAILED          = 230      # task failed
│   ├── TASK_SUSPENDED       = 240      # task suspended
│   └── TASK_RESUMED         = 250      # task resumed
│
├── Cognitive stage events (300-399)
│   ├── REASON_DONE          = 300      # reasoning complete (understand + think + plan)
│   ├── STEP_COMPLETED       = 335      # single step completed (non-tool step)
│   ├── REFLECTION_COMPLETE  = 345      # async post-task reflection done
│   └── NEED_MORE_INFO       = 350      # needs more information
│
└── Tool / capability events (400-499)
    ├── TOOL_CALL_REQUESTED  = 400      # tool call requested
    ├── TOOL_CALL_COMPLETED  = 410      # tool call completed
    └── TOOL_CALL_FAILED     = 420      # tool call failed
```

**Significance of segments**: lower numeric values mean higher priority. System events (0-99) always take precedence over user messages (100-199), and user messages take precedence over internal state changes (200+). This guarantees that a system shutdown signal will never be queued behind a flood of task events.

## EventBus

The event bus — the system's neural hub.

```typescript
class EventBus {
    async emit(event)                              // publish event (non-blocking, enqueue and return)
    subscribe(eventType, handler)                  // subscribe to events (eventType=null for wildcard)
    unsubscribe(eventType, handler)                // unsubscribe
    async start()                                  // start consumption loop
    async stop()                                   // graceful shutdown
}
```

**Internal implementation**:

- Uses a priority queue, sorted by `(effectivePriority, counter)`
- `counter` ensures FIFO ordering among same-priority events
- The consumption loop `_consumeLoop` dequeues events and dispatches to all matching handlers
- Handlers execute concurrently, **without waiting for completion**
- Handler exceptions are caught and logged; they never crash the bus
- Optional event history recording (`keepHistory=true`)

**Wildcard subscription**: `subscribe(null, handler)` subscribes to all events, suitable for cross-cutting concerns like logging and monitoring.

**Graceful shutdown**: `stop()` sends a `SYSTEM_SHUTTING_DOWN` sentinel event to ensure the consumption loop exits the blocking `queue.get()`.

## Event Flow Example

```
User inputs "Search for AI Agent papers"

  ① MESSAGE_RECEIVED {text: "Search for...", source: "user"}
     ↓ Agent._onExternalInput
  ② TASK_CREATED {taskId: "abc123"}
     ↓ Agent._onTaskEvent → TaskFSM: IDLE → REASONING
  ③ REASON_DONE {taskId: "abc123", payload: {approach: "tool_use", steps: [...]}}
     ↓ Agent._onTaskEvent → TaskFSM: REASONING → ACTING
  ④ TOOL_CALL_COMPLETED {taskId: "abc123", payload: {tool: "search", result: ...}}
     ↓ Agent._onTaskEvent → TaskFSM: ACTING → REASONING (tool_call steps → back to reason)
  ⑤ REASON_DONE {taskId: "abc123", payload: {approach: "direct", response: "..."}}
     ↓ Agent._onTaskEvent → TaskFSM: REASONING → ACTING
  ⑥ STEP_COMPLETED {taskId: "abc123"}
     ↓ Agent._onTaskEvent → TaskFSM: ACTING → COMPLETED (respond steps → done)
  ⑦ TASK_COMPLETED {taskId: "abc123", payload: {result: ...}}
     ... async: PostTaskReflector runs in background ...
  ⑧ REFLECTION_COMPLETE {taskId: "abc123", payload: {factsWritten: 2, hasEpisode: true}}
```

Each event is independent and immutable. Each event points to the previous one via `parentEventId`, forming a complete causality chain.
