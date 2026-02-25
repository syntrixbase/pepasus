# Pegasus — 系统架构

## 定位

Pegasus不是「请求-响应」服务，是一个**持续运行的自主工作者**（continuously running worker）。像一个真正的员工坐在工位上——脑子里同时想着好几件事，手上在做一件事，随时能听到新指令、收到新邮件，自己决定怎么安排。

## 核心设计原则

| 原则 | 含义 |
|------|------|
| **一切皆事件** | 用户消息、工具返回、定时触发、状态变更——统统是 Event，通过 EventBus 分发 |
| **任务即状态机** | 每个任务是独立的 TaskFSM，有明确的状态和转换规则，不是 while 循环 |
| **Agent 是事件处理器** | 没有 `while True` 循环，没有 `await task.run()` 阻塞。只有：收到事件 → 驱动状态机 → 产出新事件 |
| **无阻塞、纯异步、可并发** | Agent 的事件处理函数永远不阻塞，多个任务交错推进，共享算力 |
| **纯函数认知** | 认知阶段处理器（Thinker/Planner/Actor/Reflector）不持有状态，可被任意任务复用 |
| **身份一致性** | 无论并发多少任务、跨多少会话，人格和行为风格保持一致 |
| **记忆持久化** | 经验不丢失，能从历史中学习和改进 |
| **模型无关** | 核心逻辑不绑定特定 LLM，支持动态切换和路由 |

## 两个核心抽象

```
┌──────────────────────────────────────────────────────────────┐
│  系统有三个核心层次：                                           │
│                                                              │
│  1. Main Agent — 对话大脑（决定做什么）                         │
│  2. Event + TaskFSM — 执行引擎（怎么做）                       │
│  3. Channel Adapters — I/O 适配（从哪来、回哪去）               │
│                                                              │
│  Main Agent 接收消息，决定直接回复还是启动 Task。               │
│  Task 通过 EventBus + FSM 异步执行，结果回传给 Main Agent。     │
└──────────────────────────────────────────────────────────────┘
```

## 分层架构总览

```
┌─────────────────────────────────────────────────────┐
│        Channel Adapters (渠道适配层)                   │
│   CLI │ Slack │ SMS │ Web │ REST API                  │
│        ↓ 所有输入统一为 InboundMessage ↓               │
├─────────────────────────────────────────────────────┤
│        Main Agent (全局 LLM 角色 / 对话大脑)            │
│   Session 管理 │ 对话决策 │ 简单工具 │ Task 调度        │
│        ↓ 需要执行时 spawn_task ↓                       │
├─────────────────────────────────────────────────────┤
│             EventBus (事件总线 / 神经系统)              │
│   Priority Queue │ Pub/Sub │ Event Routing           │
├─────────────────────────────────────────────────────┤
│         Agent (薄层编排器 / 事件处理器)                  │
│   事件分发 │ 状态转换 │ 认知阶段调度 │ 并发控制          │
├─────────────────────────────────────────────────────┤
│        TaskFSM Layer (任务状态机层)                     │
│   IDLE → REASONING → ACTING → REFLECTING             │
│                  → COMPLETED                          │
│                  │ SUSPENDED │ FAILED │                │
├─────────────────────────────────────────────────────┤
│       Cognitive Processors (认知处理器 / 无状态)         │
│   Thinker │ Planner │ Actor │ Reflector               │
├─────────────────────────────────────────────────────┤
│          Identity Layer (身份层)                       │
│   Persona │ Preferences │ Evolution                   │
├─────────────────────────────────────────────────────┤
│          Memory System (记忆系统)                      │
│   Facts │ Episodes │ Long-term Memory                 │
├─────────────────────────────────────────────────────┤
│          LLM Adapter (模型适配层)                      │
│   Claude │ OpenAI │ Gemini │ Local (Ollama)           │
├─────────────────────────────────────────────────────┤
│        Capability Layer (能力层)                       │
│   MCP Tools │ Skills │ A2A │ Multimodal IO            │
├─────────────────────────────────────────────────────┤
│         Infrastructure (基础设施)                      │
│   Storage │ Persistence │ Logging │ Config            │
└─────────────────────────────────────────────────────┘
```

## 系统运行全景

```
                     ┌──────────────┐
  CLI ──────────────▶│              │
  Slack ────────────▶│   Channel    │
  SMS ──────────────▶│  Adapters    │
  Web ──────────────▶│              │
                     └──────┬───────┘
                            │ InboundMessage
                            ▼
                     ┌──────────────┐
                     │  Main Agent  │──── Session History (data/main/)
                     │  (LLM brain) │
                     └──────┬───────┘
                            │ spawn_task (when needed)
                            ▼
                     ┌──────────────┐
  工具返回结果 ────────▶│              │
  认知阶段完成 ────────▶│  EventBus   │
  任务状态变更 ────────▶│ (优先级队列) │
                     └──────┬───────┘
                            │ 分发事件
                            ▼
                     ┌──────────────┐
                     │    Agent     │
                     │ (事件处理器)  │
                     └──────┬───────┘
                            │ 查找/驱动
                            ▼
             ┌──────────────────────────────┐
             │       TaskRegistry           │
             │  ┌──────┐ ┌──────┐ ┌──────┐  │
             │  │Task A│ │Task B│ │Task C│  │
             │  │ 状态机│ │ 状态机│ │ 状态机│  │
             │  │ACTING│ │REASON│ │IDLE  │  │
             │  └──────┘ └──────┘ └──────┘  │
             └──────────────────────────────┘
                            │ 调用
                 ┌──────────┼──────────┐
                 ▼          ▼          ▼
           ┌─────────┐ ┌────────┐ ┌────────┐
           │ Identity│ │ Memory │ │  LLM   │
           └─────────┘ └────────┘ └────────┘
```

## 与传统方案的对比

| 维度 | 传统 while 循环 | 事件驱动 + 状态机 |
|------|----------------|------------------|
| **并发** | 一次一个任务，串行执行 | 多任务交错执行，真正并发 |
| **阻塞** | 等待工具/LLM 时整个 Agent 阻塞 | 等待期间处理其他任务 |
| **可恢复** | 进程崩溃 = 任务丢失 | 状态持久化，崩溃后从检查点恢复 |
| **可挂起** | 不支持（或需要复杂 hack） | 原生 SUSPENDED 状态 |
| **可观测** | 需要额外日志 | 事件流 = 天然审计日志 |
| **可测试** | 需要 mock 整个循环 | 单独测试每个状态转换 |

```typescript
// ❌ 旧方案：阻塞式 while 循环
class CognitiveLoop {
    async run(task: Task): Promise<TaskResult> {
        const context = await this.perceive(task)
        while (!context.isComplete) {          // Agent 被锁死在这里
            const thinking = await this.think(context)
            const plan = await this.plan(thinking)
            const results = await this.act(plan)
            context = await this.reflect(context, results)
        }
        return context.finalResult
    }
}

// ✅ 新方案：事件驱动，Agent 是处理器
class Agent {
    async _onTaskEvent(event: Event) {
        const task = this.registry.get(event.taskId)
        const newState = task.transition(event)       // 纯状态转换
        this._dispatch(task, newState)                // 非阻塞启动下一阶段
        // 立即返回，处理下一个事件
    }
}
```

## 详细设计文档

各子系统的详细设计拆分到独立文档：

| 文档 | 内容 |
|------|------|
| [main-agent.md](./main-agent.md) | Main Agent：全局 LLM 角色、对话管理、多渠道适配、Session 持久化 |
| [events.md](./events.md) | 事件系统：Event、EventType、EventBus、优先级队列 |
| [task-fsm.md](./task-fsm.md) | 任务状态机：TaskState、TaskFSM、TaskContext、状态转换表 |
| [agent.md](./agent.md) | Agent 核心：事件处理、认知阶段调度、并发控制（信号量）、生命周期 |
| [cognitive.md](./cognitive.md) | 认知阶段：Reason → Act → Reflect，处理器接口 |
| [task-persistence.md](./task-persistence.md) | 任务持久化：增量 JSONL 事件日志、replay、index |
| [memory-system.md](./memory-system.md) | 长期记忆：facts + episodes，Markdown 文件存储 |
| [tools.md](./tools.md) | 工具系统：注册、执行、超时、LLM 函数调用 |
| [project-structure.md](./project-structure.md) | 代码目录结构与模块依赖关系 |
