# 认知阶段

> 对应代码：`src/pegasus/cognitive/`

## 核心思想

认知不是一个循环，是一个**状态机的路径**。Reason → Act → Reflect 不是 `for` 或 `while`，而是 TaskFSM 的状态转换序列。每个阶段是一个独立的、无状态的处理器——输入 TaskContext，输出结果，仅此而已。

## 三个阶段

```
Reason ──▶ Act ──▶ Reflect
 推理        行动     反思
   ▲                   │
   └── continue/replan─┘
```

### Reason（推理）

```
输入：TaskContext（input_text, messages, memory index）
输出：dict（推理结论）+ Plan（执行计划）

内部流程：
1. Thinker — LLM 调用：理解输入 + 推理 + 工具选择
2. Planner — 纯代码：将 Thinker 的 toolCalls 转换为 PlanStep[]
```

Reason 是合并后的第一阶段，取代了原来的 Perceive + Think + Plan 三个独立阶段。合并的原因：

- **Perceive 浪费了一次 LLM 调用** — 它提取 taskType/intent/urgency/keyEntities，但下游只用了 taskType（一个简单的 `=== "conversation"` 判断）
- **Plan 不调用 LLM** — 它只是把 Think 的 toolCalls 机械转换为 PlanStep[]，这是数据格式转换，不是规划
- **上下文碎片化** — Perceive 和 Think 各自独立调用 LLM，Perceive 的分析结果不会传入 Think 的上下文

合并后：一次 LLM 调用完成理解 + 推理 + 工具选择，然后 Planner（纯代码）在内部将结果转换为执行计划。

**为什么保留 Planner 类**：
- 保持格式转换逻辑隔离、可测试
- 为 M4 阶段的 LLM 规划预留扩展点
- 避免 `_runReason()` 膨胀

Reason 也是认知循环回来的入口——Reflect 之后如果 verdict 是 "continue" 或 "replan"，回到 Reason 用新的上下文重新推理。

Think 阶段是唯一可能产出 `NEED_MORE_INFO` 的逻辑。如果判断信息不足，任务进入 SUSPENDED 等待补充。

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
| `continue` | 还没完，但方向对 | REFLECTING → REASONING |
| `replan` | 计划有问题，需要重新规划 | REFLECTING → REASONING |

注意：`replan` 现在也回到 REASONING（不再有独立的 PLANNING 状态），因为 Planner 在 Reason 内部运行。

## 处理器接口

```typescript
class Thinker:
    async run(context: TaskContext, memoryIndex?: MemoryIndexEntry[]) -> Record<string, unknown>

class Planner:
    async run(context: TaskContext) -> Plan

class Actor:
    async run(context: TaskContext, step: PlanStep) -> ActionResult

class Reflector:
    async run(context: TaskContext) -> Reflection
```

**无状态**：处理器不持有实例状态。所有需要的信息都从 TaskContext 读取，所有产出都写回 TaskContext。同一个 Thinker 实例可以同时为 10 个不同的任务工作。

## Agent._runReason() 内部流程

```typescript
private async _runReason(task, trigger):
  // 1. Fetch memory index (non-blocking)
  memoryIndex = await memory_list(...)

  // 2. LLM call — understand + reason + decide actions
  reasoning = await thinker.run(context, memoryIndex)
  context.reasoning = reasoning

  // 3. Pure code — convert toolCalls to Plan steps
  plan = await planner.run(context)
  context.plan = plan

  // 4. Emit single event
  emit(REASON_DONE) or emit(NEED_MORE_INFO)
```

一次 LLM 调用，一次状态转换，通过 `context.messages` 保持连续上下文。

## 并发场景

```
时间线：

t0: 用户: "搜索 AI Agent 论文"
    → Task-A 创建，进入 REASONING

t1: 用户: "另外写一个 CSV 解析脚本"
    → Task-B 创建，进入 REASONING
    → Task-A 和 Task-B 的 Thinker 并发执行

t2: Task-A 推理完成 → ACTING（调用搜索工具）
    Task-B 推理完成 → ACTING
    → 完全并发，互不阻塞

t3: 用户: "论文只要 2024 年的"
    → 新消息进来，但 Task-A 在 ACTING
    → Agent 可以：
      a) 创建新任务 Task-C 处理这条消息
      b) 将信息注入 Task-A 的 context，挂起后重新推理
```

## 从 5 阶段到 3 阶段的演进

原 5 阶段：Perceive → Think → Plan → Act → Reflect（2 次 LLM 调用）

现 3 阶段：Reason → Act → Reflect（1 次 LLM 调用）

合并减少了 50% 的初始处理 LLM 调用，消除了 3 个无价值的状态转换，并通过 `context.messages` 实现了连续上下文传递。
