# 认知阶段

> 对应代码：`src/pegasus/cognitive/`

## 核心思想

认知不是一个循环，是一个**状态机的路径**。Perceive → Think → Plan → Act → Reflect 不是 `for` 或 `while`，而是 TaskFSM 的状态转换序列。每个阶段是一个独立的、无状态的处理器——输入 TaskContext，输出结果，仅此而已。

## 五个阶段

```
Perceive ──▶ Think ──▶ Plan ──▶ Act ──▶ Reflect
 感知          思考       规划      行动      反思
                ▲                            │
                └────── continue/replan ─────┘
```

### Perceive（感知）

```
输入：TaskContext.input_text, input_metadata
输出：dict（结构化的感知结果）

职责：
- 解析原始输入
- 提取关键信息（实体、意图、约束）
- 识别任务类型
- 标准化为结构化表示
```

感知是第一道关。把非结构化的用户输入变成结构化数据，供后续阶段使用。

### Think（思考）

```
输入：TaskContext（包含 perception）+ Memory + Identity
输出：dict（推理结论）

职责：
- 结合身份（Identity）理解自己的角色
- 检索相关记忆（有没有做过类似的事？）
- 深度推理和分析
- 判断是否需要更多信息
```

Think 阶段是唯一可能产出 `NEED_MORE_INFO` 的阶段。如果判断信息不足，任务进入 SUSPENDED 等待补充。

这也是认知循环回来的入口——Reflect 之后如果 verdict 是 "continue"，回到 Think 用新的上下文重新思考。

### Plan（规划）

```
输入：TaskContext（包含 perception + reasoning）
输出：Plan（goal + steps）

职责：
- 将模糊的意图分解为可执行的具体步骤
- 每一步标明 action_type（tool_call / generate / sub_task）
- 排序和优先级
- 资源分配（需要哪些工具）
```

Plan 的输出是一个有序的步骤列表，Actor 按顺序执行。

### Act（行动）

```
输入：TaskContext（包含 plan.current_step）
输出：ActionResult

职责：
- 按 Plan 中的步骤逐个执行
- 调用工具（MCP）、生成内容、或发起子任务
- 记录每步的执行结果、耗时、成功/失败
```

Act 和其他阶段不同——它在 ACTING 状态内**自递归**。Plan 有 3 个步骤，Actor 执行 3 次，每次完成后检查 `has_more_steps`，有则继续，无则发出 `ACT_DONE`。

Act 使用 `_tool_semaphore` 而非 `_llm_semaphore`，因为它主要是调用工具而非 LLM。

### Reflect（反思）

```
输入：TaskContext（包含 actions_done）
输出：Reflection（verdict + assessment + lessons）

职责：
- 评估执行结果是否达到目标
- 提取可复用的经验教训
- 决定下一步：complete / continue / replan
```

Reflect 的 `verdict` 决定了状态机的走向：

| verdict | 含义 | 状态转换 |
|---------|------|---------|
| `complete` | 任务完成 | REFLECTING → COMPLETED |
| `continue` | 还没完，但方向对 | REFLECTING → THINKING |
| `replan` | 计划有问题，需要重新规划 | REFLECTING → PLANNING |

## 处理器接口

当前是 Stub 实现（不调用 LLM），接入 LLM 后签名不变：

```python
class Perceiver:
    async def run(self, context: TaskContext) -> dict[str, Any]

class Thinker:
    async def run(self, context: TaskContext) -> dict[str, Any]

class Planner:
    async def run(self, context: TaskContext) -> Plan

class Actor:
    async def run_step(self, context: TaskContext, step: PlanStep) -> ActionResult

class Reflector:
    async def run(self, context: TaskContext) -> Reflection
```

**无状态**：处理器不持有实例状态。所有需要的信息都从 TaskContext 读取，所有产出都写回 TaskContext。同一个 Perceiver 实例可以同时为 10 个不同的任务工作。

## 并发场景

```
时间线：

t0: 用户: "搜索 AI Agent 论文"
    → Task-A 创建，进入 PERCEIVING

t1: 用户: "另外写一个 CSV 解析脚本"
    → Task-B 创建，进入 PERCEIVING
    → Task-A 和 Task-B 的 Perceiver 并发执行

t2: Task-A 感知完成 → THINKING
    Task-B 感知完成 → THINKING
    → 两个 Thinker 争抢 LLM 信号量
    → 如果信号量=3，两个都能立即执行
    → 如果信号量=1，一个执行一个排队

t3: Task-A 进入 ACTING（调用搜索工具）
    Task-B 进入 PLANNING
    → 完全并发，互不阻塞

t4: 用户: "论文只要 2024 年的"
    → 新消息进来，但 Task-A 在 ACTING
    → Agent 可以：
      a) 创建新任务 Task-C 处理这条消息
      b) 将信息注入 Task-A 的 context，挂起后重新思考
```

## 从 Stub 到真实实现

Stub 阶段：处理器返回固定的 mock 数据，用于验证事件流转和状态机正确性。

接入 LLM 后：处理器内部调用 LLM，但接口不变。Agent 和 TaskFSM 的代码**一行都不用改**——这就是分层的好处。
