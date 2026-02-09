# Agent 核心

> 对应代码：`src/pegasus/agent.py`

## 核心思想

Agent 是一个**薄层编排器**，不是胖控制器。它做且只做三件事：
1. 收到事件
2. 找到对应的 TaskFSM，执行状态转换
3. 根据新状态，非阻塞启动对应的认知阶段处理器

Agent 本身**不持有任何任务的执行状态**。所有状态都在 TaskFSM 中。

## 结构

```python
class Agent:
    event_bus: EventBus                  # 事件总线
    task_registry: TaskRegistry          # 活跃任务注册表

    # 认知阶段处理器（无状态的纯函数）
    perceiver: Perceiver
    thinker: Thinker
    planner: Planner
    actor: Actor
    reflector: Reflector

    # 并发控制
    _llm_semaphore: asyncio.Semaphore    # 限制并发 LLM 调用
    _tool_semaphore: asyncio.Semaphore   # 限制并发工具调用
    _background_tasks: set[asyncio.Task] # 跟踪后台协程
```

## 事件订阅表

Agent 启动时注册两类处理器：

**外部输入 → `_on_external_input`**（创建新任务）：
- `MESSAGE_RECEIVED`
- `WEBHOOK_TRIGGERED`
- `SCHEDULE_FIRED`

**任务事件 → `_on_task_event`**（驱动状态转换）：
- `TASK_CREATED`、`TASK_SUSPENDED`、`TASK_RESUMED`
- `PERCEIVE_DONE`、`THINK_DONE`、`PLAN_DONE`
- `ACT_DONE`、`TOOL_CALL_COMPLETED`、`TOOL_CALL_FAILED`
- `REFLECT_DONE`、`NEED_MORE_INFO`

## 事件处理流程

### 外部输入处理

```
MESSAGE_RECEIVED / WEBHOOK_TRIGGERED / SCHEDULE_FIRED
    ↓
_on_external_input(event)
    ↓
1. TaskFSM.from_event(event)     ← 创建新任务
2. task_registry.register(task)   ← 注册
3. emit(TASK_CREATED)             ← 驱动状态机开始转动
```

### 任务事件处理

```
任何任务相关事件
    ↓
_on_task_event(event)
    ↓
1. task_registry.get(event.task_id)  ← 查找任务
2. task.transition(event)             ← 执行状态转换
3. _dispatch_cognitive_stage(task, new_state)  ← 启动下一阶段
```

### 认知阶段调度

`_dispatch_cognitive_stage` 是一个 match 语句，根据新状态启动对应的处理器：

```python
match state:
    case PERCEIVING  → _spawn(_run_perceive(task))
    case THINKING    → _spawn(_run_think(task))
    case PLANNING    → _spawn(_run_plan(task))
    case ACTING      → _spawn(_run_act(task))
    case REFLECTING  → _spawn(_run_reflect(task))
    case SUSPENDED   → 不做任何事，等待外部事件
    case COMPLETED   → emit(TASK_COMPLETED)
    case FAILED      → 记录日志
```

**`_spawn` 是关键**：使用 `asyncio.create_task` 非阻塞启动协程，立即返回。处理器完成后会 emit 新事件，驱动状态机继续前进。所有后台任务被跟踪在 `_background_tasks` 集合中，关闭时统一取消。

## 认知阶段执行

每个 `_run_xxx` 方法的模式相同：

```python
async def _run_perceive(self, task, trigger):
    async with self._llm_semaphore:        # 1. 获取信号量
        result = await self.perceiver.run(task.context)  # 2. 执行认知处理

    task.context.perception = result       # 3. 写入上下文
    await self.event_bus.emit(Event(       # 4. 发出完成事件
        type=EventType.PERCEIVE_DONE,
        task_id=task.task_id,
        payload=result,
    ))
```

四步固定模式：**获取信号量 → 执行处理器 → 写入上下文 → 发出事件**。

### Act 阶段的特殊性

Act 阶段需要逐步执行 Plan 中的步骤：

```
_run_act(task)
  ↓
plan.current_step 存在？
  ├── 是 → 执行该步骤 → mark_step_done
  │         ↓
  │   plan.has_more_steps？
  │     ├── 是 → _spawn(_run_act(task))   ← 自递归，继续下一步
  │     └── 否 → emit(ACT_DONE)            ← 所有步骤完成
  └── 否 → emit(ACT_DONE)
```

步骤在 ACTING 状态内循环，不需要状态转换。直到所有步骤完成才发出 ACT_DONE 触发 → REFLECTING 转换。

## 并发控制

### 信号量

```python
_llm_semaphore = asyncio.Semaphore(max_concurrent_calls)  # 默认 3
_tool_semaphore = asyncio.Semaphore(max_concurrent_tools)  # 默认 3
```

- Perceiver/Thinker/Planner/Reflector 调用 LLM 前获取 `_llm_semaphore`
- Actor 调用工具前获取 `_tool_semaphore`
- 超出限制的调用自动排队等待

### 任务并发

TaskRegistry 设有 `max_active_tasks` 上限（默认 5）。多个任务可以同时处于不同的认知阶段，例如：
- Task A 在 ACTING（等待工具返回）
- Task B 在 THINKING（等待 LLM 信号量）
- Task C 在 PERCEIVING（正在执行）

它们互不阻塞，由 EventBus 自然调度。

## 外部接口

```python
# 提交任务，返回 task_id
task_id = await agent.submit("帮我搜索论文")

# 等待任务完成（用于测试）
task = await agent.wait_for_task(task_id, timeout=30.0)
```

`submit` 是 CLI/API 调用 Agent 的主要方式。内部发出 `MESSAGE_RECEIVED` 事件，等待 `TASK_CREATED` 事件返回 task_id。

## 生命周期

```python
agent = Agent(settings)
await agent.start()    # 启动 EventBus + 订阅事件 + emit SYSTEM_STARTED
# ... 运行中 ...
await agent.stop()     # 取消后台任务 + 关闭 EventBus
```

优雅关闭：先取消所有后台协程（`_background_tasks`），再关闭 EventBus。

## 为什么这是「纯状态驱动」

| 特性 | 实现方式 |
|------|---------|
| **无阻塞** | `_on_task_event` 启动异步操作后立即返回 |
| **可并发** | EventBus 不等待 handler 完成，可以立即处理下一个事件 |
| **可中断** | 任何时刻发出 `TASK_SUSPENDED`，任务保存上下文进入挂起 |
| **可恢复** | TaskFSM 的完整状态可序列化，崩溃后从检查点恢复 |
| **可观测** | 每次状态转换记录在 history 中，每个事件有因果链 |
