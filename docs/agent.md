# Agent 核心

> 对应代码：`src/pegasus/agent.ts`

## 核心思想

Agent 是一个**薄层编排器**，不是胖控制器。它做且只做三件事：
1. 收到事件
2. 找到对应的 TaskFSM，执行状态转换
3. 根据新状态，非阻塞启动对应的认知阶段处理器

Agent 本身**不持有任何任务的执行状态**。所有状态都在 TaskFSM 中。

## 结构

```typescript
class Agent {
    eventBus: EventBus                  // 事件总线
    taskRegistry: TaskRegistry          // 活跃任务注册表

    // 认知阶段处理器（无状态）
    thinker: Thinker                    // 推理（LLM 调用）
    planner: Planner                    // 规划（纯代码，在 Reason 内部调用）
    actor: Actor                        // 执行动作
    reflector: Reflector                // 反思评估

    // 工具基础设施
    toolExecutor: ToolExecutor          // 工具执行器

    // 并发控制
    llmSemaphore: Semaphore             // 限制并发 LLM 调用
    toolSemaphore: Semaphore            // 限制并发工具调用
    backgroundTasks: Set<Promise>       // 跟踪后台任务
}
```

## 事件订阅表

Agent 启动时注册两类处理器：

**外部输入 → `_onExternalInput`**（创建新任务）：
- `MESSAGE_RECEIVED`
- `WEBHOOK_TRIGGERED`
- `SCHEDULE_FIRED`

**任务事件 → `_onTaskEvent`**（驱动状态转换）：
- `TASK_CREATED`、`TASK_SUSPENDED`、`TASK_RESUMED`
- `REASON_DONE`
- `ACT_DONE`、`STEP_COMPLETED`、`TOOL_CALL_COMPLETED`、`TOOL_CALL_FAILED`
- `REFLECT_DONE`、`NEED_MORE_INFO`

## 事件处理流程

### 外部输入处理

```
MESSAGE_RECEIVED / WEBHOOK_TRIGGERED / SCHEDULE_FIRED
    ↓
_onExternalInput(event)
    ↓
1. TaskFSM.fromEvent(event)     ← 创建新任务
2. taskRegistry.register(task)   ← 注册
3. emit(TASK_CREATED)             ← 驱动状态机开始转动
```

### 任务事件处理

```
任何任务相关事件
    ↓
_onTaskEvent(event)
    ↓
1. taskRegistry.get(event.taskId)  ← 查找任务
2. task.transition(event)           ← 执行状态转换
3. _dispatchCognitiveStage(task, newState)  ← 启动下一阶段
```

### 认知阶段调度

`_dispatchCognitiveStage` 是一个 switch 语句，根据新状态启动对应的处理器：

```typescript
switch (state) {
    case REASONING   → _spawn(_runReason(task))
    case ACTING      → _spawn(_runAct(task))
    case REFLECTING  → _spawn(_runReflect(task))
    case SUSPENDED   → // 不做任何事，等待外部事件
    case COMPLETED   → emit(TASK_COMPLETED)
    case FAILED      → // 记录日志
}
```

**`_spawn` 是关键**：非阻塞启动异步任务，立即返回。处理器完成后会 emit 新事件，驱动状态机继续前进。所有后台任务被跟踪在 `backgroundTasks` 集合中，关闭时统一等待。

## 认知阶段执行

### _runReason — 合并的推理阶段

```typescript
async _runReason(task, trigger):
    // 1. 获取记忆索引
    memoryIndex = await toolExecutor.execute("memory_list", ...)

    // 2. LLM 调用 — 理解 + 推理 + 工具选择
    reasoning = await llmSemaphore.use(() =>
        thinker.run(task.context, memoryIndex)
    )
    task.context.reasoning = reasoning

    // 3. 纯代码 — 将 toolCalls 转换为 Plan steps
    plan = await planner.run(task.context)
    task.context.plan = plan

    // 4. 发出事件
    if (reasoning.needsClarification)
        emit(NEED_MORE_INFO)
    else
        emit(REASON_DONE)
```

一次 LLM 调用完成全部工作。Planner 在内部调用，不经过 FSM 状态转换。

### Act 阶段的特殊性

Act 阶段需要逐步执行 Plan 中的步骤：

```
_runAct(task)
  ↓
plan.currentStep 存在？
  ├── 是 → 执行该步骤
  │         ↓
  │   tool_call？→ toolSemaphore.use → toolExecutor.execute → emit(TOOL_CALL_COMPLETED)
  │   respond？ → 同步完成 → emit(STEP_COMPLETED)
  │         ↓
  │   FSM 动态判断：plan 还有步骤 → ACTING；否则 → REFLECTING
  └── 否 → emit(ACT_DONE) → REFLECTING
```

步骤在 ACTING 状态内循环，不需要状态转换。直到所有步骤完成才进入 REFLECTING。

## 并发控制

### 信号量

```typescript
llmSemaphore = new Semaphore(maxConcurrentCalls)   // 默认 3
toolSemaphore = new Semaphore(maxConcurrentTools)   // 默认 3
```

- Thinker/Reflector 调用 LLM 前获取 `llmSemaphore`
- Actor 调用工具前获取 `toolSemaphore`
- 超出限制的调用自动排队等待

### 任务并发

TaskRegistry 设有 `maxActiveTasks` 上限（默认 5）。多个任务可以同时处于不同的认知阶段，例如：
- Task A 在 ACTING（等待工具返回）
- Task B 在 REASONING（等待 LLM 信号量）
- Task C 在 REFLECTING

它们互不阻塞，由 EventBus 自然调度。

## 外部接口

```typescript
// 提交任务，返回 taskId
const taskId = await agent.submit("帮我搜索论文")

// 等待任务完成（用于测试）
const task = await agent.waitForTask(taskId, 5000)

// 注册完成回调
agent.onTaskComplete(taskId, (task) => { ... })
```

`submit` 是 CLI/API 调用 Agent 的主要方式。内部发出 `MESSAGE_RECEIVED` 事件，等待 `TASK_CREATED` 事件返回 taskId。

## 生命周期

```typescript
const agent = new Agent(deps)
await agent.start()    // 启动 EventBus + 订阅事件 + emit SYSTEM_STARTED
// ... 运行中 ...
await agent.stop()     // 等待后台任务 + 关闭 EventBus
```

优雅关闭：先等待所有后台任务（`backgroundTasks`），再关闭 EventBus。

## 为什么这是「纯状态驱动」

| 特性 | 实现方式 |
|------|---------|
| **无阻塞** | `_onTaskEvent` 启动异步操作后立即返回 |
| **可并发** | EventBus 不等待 handler 完成，可以立即处理下一个事件 |
| **可中断** | 任何时刻发出 `TASK_SUSPENDED`，任务保存上下文进入挂起 |
| **可恢复** | TaskFSM 的完整状态可序列化，崩溃后从检查点恢复 |
| **可观测** | 每次状态转换记录在 history 中，每个事件有因果链 |
