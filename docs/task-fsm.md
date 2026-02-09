# 任务状态机

> 对应代码：`src/pegasus/task/`

## 核心思想

每个任务是一个独立的有限状态机（FSM）。状态机本身**不执行任何 IO 操作**——它只负责三件事：
1. 验证状态转换的合法性
2. 更新状态
3. 记录转换历史

实际的 LLM 调用、工具调用等 IO 操作由 Agent 在状态转换后启动。

## TaskState

9 个状态，2 个终态：

```
                    ┌─────────┐
                    │  IDLE   │ ← 刚创建
                    └────┬────┘
                         │ TASK_CREATED
                    ┌────▼────┐
                    │PERCEIVE │ ← 感知输入
                    └────┬────┘
                         │ PERCEIVE_DONE
                    ┌────▼────┐
              ┌────▶│ THINKING│ ← 推理、检索记忆
              │     └────┬────┘
              │          │ THINK_DONE          NEED_MORE_INFO
              │     ┌────▼────┐                     │
              │     │PLANNING │                ┌────▼─────┐
              │     └────┬────┘                │SUSPENDED │
              │          │ PLAN_DONE           └────┬─────┘
              │     ┌────▼────┐                     │
              │     │ ACTING  │←───── 多步骤循环     │ MESSAGE_RECEIVED
              │     └────┬────┘                     │ / TASK_RESUMED
              │          │ ACT_DONE                 │
              │     ┌────▼────┐                     │
              │     │REFLECT  │◀────────────────────┘
              │     └────┬────┘
              │          │ REFLECT_DONE
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

```python
class TaskState(StrEnum):
    IDLE        = "idle"
    PERCEIVING  = "perceiving"
    THINKING    = "thinking"
    PLANNING    = "planning"
    ACTING      = "acting"
    REFLECTING  = "reflecting"
    SUSPENDED   = "suspended"
    COMPLETED   = "completed"    # 终态
    FAILED      = "failed"       # 终态
```

**终态**：`COMPLETED` 和 `FAILED` 到达后不再接受任何转换，抛出 `InvalidStateTransition`。

**可挂起状态**：只有活跃状态（PERCEIVING/THINKING/PLANNING/ACTING/REFLECTING）可以被挂起。

## 状态转换表

静态转换（目标状态确定）：

| 当前状态 | 事件 | → 目标状态 |
|---------|------|-----------|
| IDLE | TASK_CREATED | PERCEIVING |
| PERCEIVING | PERCEIVE_DONE | THINKING |
| THINKING | THINK_DONE | PLANNING |
| THINKING | NEED_MORE_INFO | SUSPENDED |
| PLANNING | PLAN_DONE | ACTING |
| ACTING | ACT_DONE | REFLECTING |
| SUSPENDED | MESSAGE_RECEIVED | THINKING |

动态转换（目标状态由运行时条件决定）：

| 当前状态 | 事件 | → 动态决策 |
|---------|------|-----------|
| ACTING | TOOL_CALL_COMPLETED | plan 还有步骤 → ACTING；否则 → REFLECTING |
| ACTING | TOOL_CALL_FAILED | plan 还有步骤 → ACTING；否则 → REFLECTING |
| REFLECTING | REFLECT_DONE | verdict="complete" → COMPLETED；"continue" → THINKING；"replan" → PLANNING |
| SUSPENDED | TASK_RESUMED | 恢复到挂起前的状态 |

特殊转换（任意活跃状态均可触发）：

| 事件 | → 目标状态 | 条件 |
|------|-----------|------|
| TASK_SUSPENDED | SUSPENDED | 当前状态是活跃状态 |
| TASK_FAILED | FAILED | 任意非终态 |

## TaskFSM

```
TaskFSM
├── task_id: str                        # UUID
├── state: TaskState                    # 当前状态
├── context: TaskContext                # 累积的所有中间产物
├── history: list[StateTransition]      # 状态转换历史
├── created_at / updated_at: datetime
├── priority: int                       # 优先级（越小越优先）
└── metadata: dict
```

**关键方法**：
- `transition(event) → TaskState`：执行转换，返回新状态，非法则抛异常
- `can_transition(event_type) → bool`：检查转换是否合法（不实际执行）
- `from_event(event) → TaskFSM`：从外部输入事件创建任务
- `is_terminal` / `is_active`：状态查询

**转换历史**：每次转换记录 `StateTransition`（from_state, to_state, trigger_event_type, trigger_event_id, timestamp），可以精确复现任务的每一步。

## TaskContext

任务上下文 — 一个任务从创建到完成过程中累积的所有信息：

```
TaskContext
├── 原始输入
│   ├── input_text: str
│   ├── input_metadata: dict
│   └── source: str
│
├── 认知阶段产出
│   ├── perception: dict | None        # Perceive 的输出
│   ├── reasoning: dict | None         # Think 的输出
│   ├── plan: Plan | None              # Plan 的输出
│   ├── actions_done: list[ActionResult]
│   └── reflections: list[Reflection]
│
├── 循环控制
│   └── iteration: int                 # Think→Act→Reflect 循环轮次
│
├── 结果
│   ├── final_result: Any
│   └── error: str | None
│
├── 挂起/恢复
│   ├── suspended_state: str | None    # 挂起前的状态
│   └── suspend_reason: str | None
│
└── 对话历史
    └── messages: list[dict]           # Working Memory 片段
```

**Plan 数据结构**：
```
Plan
├── goal: str                          # 任务目标
├── steps: list[PlanStep]              # 执行步骤
│   └── PlanStep
│       ├── index: int
│       ├── description: str
│       ├── action_type: str           # "tool_call" / "generate" / "sub_task"
│       ├── action_params: dict
│       └── completed: bool
└── reasoning: str                     # 规划推理过程
```

Plan 提供 `current_step`（下一个未完成步骤）和 `has_more_steps` 属性，Actor 用这些驱动步骤执行。

**Reflection 数据结构**：
```
Reflection
├── verdict: str          # "complete" | "continue" | "replan"
├── assessment: str       # 评估说明
├── lessons: list[str]    # 提取的经验
└── next_focus: str | None
```

verdict 决定了 REFLECTING 之后的走向——这就是认知循环的核心：反思后决定是完成、继续、还是重新规划。

## TaskRegistry

活跃任务注册表。维护所有未完成的任务。

```python
class TaskRegistry:
    def register(task)                  # 注册新任务
    def get(task_id) → TaskFSM          # 获取任务（不存在则抛异常）
    def get_or_none(task_id)            # 获取任务（不存在返回 None）
    def remove(task_id)                 # 移除任务
    def list_active() → list[TaskFSM]  # 列出活跃任务
    def list_all() → list[TaskFSM]     # 列出所有任务
    def cleanup_terminal()              # 清理终态任务
    active_count → int                  # 活跃任务数
```

当活跃任务数达到 `max_active` 上限时，不阻止注册但记录警告。调度层可据此决定是否排队。

## 持久化策略

不是每一步都写磁盘，只在关键节点持久化：

| 时机 | 持久化内容 | 原因 |
|------|-----------|------|
| PLAN_DONE | 完整 Plan | 规划成本高，不能丢 |
| ACT_DONE（每步） | ActionResult | 动作不可逆，必须记录 |
| SUSPENDED | 完整 TaskContext | 恢复时需要完整上下文 |
| COMPLETED | 完整 TaskContext | 归档到 Episodic Memory |
| FAILED | TaskContext + error | 事后分析 |
