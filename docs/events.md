# 事件系统

> 对应代码：`src/pegasus/events/`

## 核心思想

系统中发生的一切都是事件。用户发了一条消息是事件，工具返回了结果是事件，定时器触发了是事件，任务状态变了也是事件。Agent 唯一做的事就是：处理事件。

## Event

事件是不可变的值对象，一旦创建不可修改。

```
Event
├── id: string                  # 短 ID，全局唯一
├── type: EventType             # 事件类型
├── timestamp: number           # Unix ms 时间戳
├── source: string              # 来源（"user", "cognitive.reason", "system"...）
├── taskId: string | null       # 关联的任务 ID（null = 未分派）
├── payload: Record<string, unknown>  # 事件携带的数据
├── priority: number | null     # 自定义优先级（null 则用 EventType 数值）
└── parentEventId: string | null # 因果链：派生自哪个事件
```

**不可变性**：Event 使用 `Object.freeze`，创建后任何字段都不能修改。这保证了事件在系统中传递时不会被意外篡改。

**因果链**：`parentEventId` 记录事件的因果关系。例如 `REASON_DONE` 的 parent 指向触发它的 `TASK_CREATED`。可以从任何事件回溯完整的事件链。

**优先级**：`effectivePriority` 决定事件在队列中的排序。默认使用 EventType 的数值（越小越优先），也可以通过 `priority` 字段覆盖。

**派生**：`deriveEvent(parent, type, overrides)` 创建一个继承了 `taskId`、`source` 和因果链的新事件。

## EventType

事件类型是数值常量，数值本身就是默认优先级。按段分配：

```
EventType
│
├── 系统事件 (0-99)                # 最高优先级
│   ├── SYSTEM_STARTED       = 0   # 系统启动
│   ├── SYSTEM_SHUTTING_DOWN = 1   # 系统关闭中
│   └── HEARTBEAT            = 90  # 心跳
│
├── 外部输入事件 (100-199)
│   ├── MESSAGE_RECEIVED     = 100 # 用户/外部消息
│   ├── WEBHOOK_TRIGGERED    = 110 # Webhook 回调
│   └── SCHEDULE_FIRED       = 120 # 定时器触发
│
├── 任务生命周期事件 (200-299)
│   ├── TASK_CREATED         = 200 # 新任务创建
│   ├── TASK_STATE_CHANGED   = 210 # 状态变更
│   ├── TASK_COMPLETED       = 220 # 任务完成
│   ├── TASK_FAILED          = 230 # 任务失败
│   ├── TASK_SUSPENDED       = 240 # 任务挂起
│   └── TASK_RESUMED         = 250 # 任务恢复
│
├── 认知阶段事件 (300-399)
│   ├── REASON_DONE          = 300 # 推理完成（理解+思考+规划）
│   ├── ACT_DONE             = 330 # 行动完成
│   ├── STEP_COMPLETED       = 335 # 单步完成（非工具步骤）
│   ├── REFLECT_DONE         = 340 # 反思完成
│   └── NEED_MORE_INFO       = 350 # 需要更多信息
│
└── 工具/能力事件 (400-499)
    ├── TOOL_CALL_REQUESTED  = 400 # 请求调用工具
    ├── TOOL_CALL_COMPLETED  = 410 # 工具调用完成
    └── TOOL_CALL_FAILED     = 420 # 工具调用失败
```

**分段的意义**：数值越小优先级越高。系统事件（0-99）永远优先于用户消息（100-199），用户消息优先于内部状态变更（200+）。这保证了：系统关闭信号不会被排在大量任务事件之后。

## EventBus

事件总线。系统的神经中枢。

```typescript
class EventBus {
    async emit(event)                              // 发布事件（非阻塞，放入队列立即返回）
    subscribe(eventType, handler)                  // 订阅事件（eventType=null 为通配符）
    unsubscribe(eventType, handler)                // 取消订阅
    async start()                                  // 启动消费循环
    async stop()                                   // 优雅关闭
}
```

**内部实现**：

- 使用优先级队列，按 `(effectivePriority, counter)` 排序
- `counter` 保证同优先级时 FIFO
- 消费循环 `_consumeLoop` 从队列取事件，分发给所有匹配的 handler
- handler 并发执行，**不等待完成**
- handler 异常被捕获并记录日志，不会崩溃总线
- 可选的事件历史记录（`keepHistory=true`）

**通配符订阅**：`subscribe(null, handler)` 订阅所有事件，适合日志、监控等横切关注点。

**优雅关闭**：`stop()` 发送一个 `SYSTEM_SHUTTING_DOWN` 哨兵事件确保消费循环退出阻塞的 `queue.get()`。

## 事件流转示例

```
用户输入 "帮我搜索 AI Agent 论文"

  ① MESSAGE_RECEIVED {text: "帮我搜索...", source: "user"}
     ↓ Agent._onExternalInput
  ② TASK_CREATED {taskId: "abc123"}
     ↓ Agent._onTaskEvent → TaskFSM: IDLE → REASONING
  ③ REASON_DONE {taskId: "abc123", payload: {approach: "tool_use", steps: [...]}}
     ↓ Agent._onTaskEvent → TaskFSM: REASONING → ACTING
  ④ TOOL_CALL_COMPLETED {taskId: "abc123", payload: {tool: "search", result: ...}}
     ↓ Agent._onTaskEvent → TaskFSM: ACTING → REFLECTING (no more steps)
  ⑤ REFLECT_DONE {taskId: "abc123", payload: {verdict: "continue"}}
     ↓ Agent._onTaskEvent → TaskFSM: REFLECTING → REASONING
  ⑥ REASON_DONE {taskId: "abc123", payload: {approach: "direct", response: "..."}}
     ↓ Agent._onTaskEvent → TaskFSM: REASONING → ACTING
  ⑦ STEP_COMPLETED {taskId: "abc123"}
     ↓ Agent._onTaskEvent → TaskFSM: ACTING → REFLECTING
  ⑧ REFLECT_DONE {taskId: "abc123", payload: {verdict: "complete"}}
     ↓ Agent._onTaskEvent → TaskFSM: REFLECTING → COMPLETED
  ⑨ TASK_COMPLETED {taskId: "abc123", payload: {result: ...}}
```

每个事件都是独立的、不可变的。每个事件都通过 `parentEventId` 指向上一个事件，形成完整的因果链。
