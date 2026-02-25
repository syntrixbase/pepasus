# 任务状态机

> 对应代码：`src/pegasus/task/`

## 核心思想

每个任务是一个独立的有限状态机（FSM）。状态机本身**不执行任何 IO 操作**——它只负责三件事：
1. 验证状态转换的合法性
2. 更新状态
3. 记录转换历史

实际的 LLM 调用、工具调用等 IO 操作由 Agent 在状态转换后启动。

## TaskState

7 个状态，2 个终态：

```
                    ┌─────────┐
                    │  IDLE   │ ← 刚创建
                    └────┬────┘
                         │ TASK_CREATED
                    ┌────▼─────┐
              ┌────▶│REASONING │ ← 推理（理解 + 思考 + 规划）
              │     └────┬─────┘
              │          │ REASON_DONE          NEED_MORE_INFO
              │     ┌────▼────┐                     │
              │     │ ACTING  │←───── 多步骤循环  ┌──▼───────┐
              │     └────┬────┘                  │SUSPENDED │
              │          │ ACT_DONE              └──┬───────┘
              │     ┌────▼─────┐                    │
              │     │REFLECTING│◀───────────────────┘
              │     └────┬─────┘   MESSAGE_RECEIVED
              │          │ REFLECT_DONE   / TASK_RESUMED
              │     ┌────▼────┐
              │     │ Done?   │
              │     └────┬────┘
              │      No  │  Yes
              └──────────┘   │
                        ┌────▼─────┐
                        │COMPLETED │ ← 终态
                        └──────────┘
                        ┌──────────┐
                        │ FAILED   │ ← 终态（任意状态可达）
                        └──────────┘
```

```typescript
const TaskState = {
    IDLE:        "idle",
    REASONING:   "reasoning",
    ACTING:      "acting",
    REFLECTING:  "reflecting",
    SUSPENDED:   "suspended",
    COMPLETED:   "completed",    // 终态
    FAILED:      "failed",       // 终态
} as const;
```

**终态**：`COMPLETED` 和 `FAILED` 到达后不再接受任何转换，抛出 `InvalidStateTransition`。

**可挂起状态**：只有活跃状态（REASONING/ACTING/REFLECTING）可以被挂起。

## 状态转换表

静态转换（目标状态确定）：

| 当前状态 | 事件 | → 目标状态 |
|---------|------|-----------|
| IDLE | TASK_CREATED | REASONING |
| REASONING | REASON_DONE | ACTING |
| REASONING | NEED_MORE_INFO | SUSPENDED |
| ACTING | ACT_DONE | REFLECTING |
| SUSPENDED | MESSAGE_RECEIVED | REASONING |

动态转换（目标状态由运行时条件决定）：

| 当前状态 | 事件 | → 动态决策 |
|---------|------|-----------|
| ACTING | TOOL_CALL_COMPLETED | plan 还有步骤 → ACTING；否则 → REFLECTING |
| ACTING | TOOL_CALL_FAILED | plan 还有步骤 → ACTING；否则 → REFLECTING |
| ACTING | STEP_COMPLETED | plan 还有步骤 → ACTING；否则 → REFLECTING |
| REFLECTING | REFLECT_DONE | verdict="complete" → COMPLETED；"continue" → REASONING；"replan" → REASONING |
| SUSPENDED | TASK_RESUMED | 恢复到挂起前的状态 |

注意：`replan` 现在也回到 REASONING（不再有独立的 PLANNING 状态），因为 Planner 在 Reason 内部运行。

特殊转换（任意活跃状态均可触发）：

| 事件 | → 目标状态 | 条件 |
|------|-----------|------|
| TASK_SUSPENDED | SUSPENDED | 当前状态是活跃状态 |
| TASK_FAILED | FAILED | 任意非终态 |

## TaskFSM

```
TaskFSM
├── taskId: string                     # 短 ID
├── state: TaskState                   # 当前状态
├── context: TaskContext               # 累积的所有中间产物
├── history: StateTransition[]         # 状态转换历史
├── createdAt / updatedAt: number
├── priority: number                   # 优先级（越小越优先）
└── metadata: Record<string, unknown>
```

**关键方法**：
- `transition(event) → TaskState`：执行转换，返回新状态，非法则抛异常
- `canTransition(eventType) → boolean`：检查转换是否合法（不实际执行）
- `fromEvent(event) → TaskFSM`：从外部输入事件创建任务
- `isTerminal` / `isActive`：状态查询

**转换历史**：每次转换记录 `StateTransition`（fromState, toState, triggerEventType, triggerEventId, timestamp），可以精确复现任务的每一步。

## TaskContext

任务上下文 — 一个任务从创建到完成过程中累积的所有信息：

```
TaskContext
├── 原始输入
│   ├── inputText: string
│   ├── inputMetadata: Record<string, unknown>
│   └── source: string
│
├── 认知阶段产出
│   ├── reasoning: Record<string, unknown> | null   # Reason(Thinker) 的输出
│   ├── plan: Plan | null                           # Reason(Planner) 的输出
│   ├── actionsDone: ActionResult[]
│   └── reflections: Reflection[]
│
├── 循环控制
│   └── iteration: number                           # Reason→Act→Reflect 循环轮次
│
├── 结果
│   ├── finalResult: unknown
│   └── error: string | null
│
├── 挂起/恢复
│   ├── suspendedState: string | null               # 挂起前的状态
│   └── suspendReason: string | null
│
└── 对话历史
    └── messages: Message[]                         # Working Memory 片段
```

**Plan 数据结构**：
```
Plan
├── goal: string                          # 任务目标
├── steps: PlanStep[]                     # 执行步骤
│   └── PlanStep
│       ├── index: number
│       ├── description: string
│       ├── actionType: string            # "tool_call" / "respond" / "generate"
│       ├── actionParams: Record<string, unknown>
│       └── completed: boolean
└── reasoning: string                     # 规划推理过程
```

Plan 提供 `currentStep`（下一个未完成步骤）和 `hasMoreSteps` 属性，Actor 用这些驱动步骤执行。

**Reflection 数据结构**：
```
Reflection
├── verdict: string          # "complete" | "continue" | "replan"
├── assessment: string       # 评估说明
├── lessons: string[]        # 提取的经验
└── nextFocus?: string
```

verdict 决定了 REFLECTING 之后的走向——这就是认知循环的核心：反思后决定是完成、继续、还是重新推理。

## TaskRegistry

活跃任务注册表。维护所有未完成的任务。

```typescript
class TaskRegistry {
    register(task)                       // 注册新任务
    get(taskId) → TaskFSM               // 获取任务（不存在则抛异常）
    getOrNull(taskId)                   // 获取任务（不存在返回 null）
    remove(taskId)                       // 移除任务
    listActive() → TaskFSM[]           // 列出活跃任务
    listAll() → TaskFSM[]              // 列出所有任务
    cleanupTerminal()                    // 清理终态任务
    activeCount → number                // 活跃任务数
}
```

当活跃任务数达到 `maxActive` 上限时，不阻止注册但记录警告。调度层可据此决定是否排队。

## 持久化策略

不是每一步都写磁盘，只在关键节点持久化：

| 时机 | 持久化内容 | 原因 |
|------|-----------|------|
| REASON_DONE | 完整 Plan | 规划成本高，不能丢 |
| ACT_DONE（每步） | ActionResult | 动作不可逆，必须记录 |
| SUSPENDED | 完整 TaskContext | 恢复时需要完整上下文 |
| COMPLETED | 完整 TaskContext | 归档到 Episodic Memory |
| FAILED | TaskContext + error | 事后分析 |
