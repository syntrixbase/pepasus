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
| **纯函数认知** | 认知阶段处理器（Perceiver/Thinker/Planner/Actor/Reflector）不持有状态，可被任意任务复用 |
| **身份一致性** | 无论并发多少任务、跨多少会话，人格和行为风格保持一致 |
| **记忆持久化** | 经验不丢失，能从历史中学习和改进 |
| **模型无关** | 核心逻辑不绑定特定 LLM，支持动态切换和路由 |

## 两个核心抽象

```
┌──────────────────────────────────────────────────────────────┐
│  系统中只有两个核心概念：                                       │
│                                                              │
│  1. Event  — 发生的事                                        │
│  2. TaskFSM — 正在做的事                                      │
│                                                              │
│  Agent 是连接它们的胶水：                                       │
│  收到 Event → 找到 TaskFSM → 驱动状态转换 → 产出新 Event       │
└──────────────────────────────────────────────────────────────┘
```

## 分层架构总览

```
┌─────────────────────────────────────────────────────┐
│          Interface Layer (接口层 / 事件源)             │
│   Chat API │ Scheduler │ Webhook │ Patrol Loop       │
│        ↓ 所有输入统一转化为 Event ↓                     │
├─────────────────────────────────────────────────────┤
│             EventBus (事件总线 / 神经系统)              │
│   Priority Queue │ Pub/Sub │ Event Routing           │
├─────────────────────────────────────────────────────┤
│         Agent (薄层编排器 / 事件处理器)                  │
│   事件分发 │ 状态转换 │ 认知阶段调度 │ 并发控制          │
├─────────────────────────────────────────────────────┤
│        TaskFSM Layer (任务状态机层)                     │
│   IDLE → PERCEIVING → THINKING → PLANNING            │
│        → ACTING → REFLECTING → COMPLETED              │
│                  │ SUSPENDED │ FAILED │                │
├─────────────────────────────────────────────────────┤
│       Cognitive Processors (认知处理器 / 无状态)         │
│   Perceiver │ Thinker │ Planner │ Actor │ Reflector   │
├─────────────────────────────────────────────────────┤
│          Identity Layer (身份层)                       │
│   Persona │ Preferences │ Evolution                   │
├─────────────────────────────────────────────────────┤
│          Memory System (记忆系统)                      │
│   Working │ Episodic │ Semantic │ Procedural          │
├─────────────────────────────────────────────────────┤
│          LLM Adapter (模型适配层)                      │
│   Claude │ OpenAI │ Gemini │ Local (Ollama)           │
├─────────────────────────────────────────────────────┤
│        Capability Layer (能力层)                       │
│   MCP Tools │ Skills │ A2A │ Multimodal IO            │
├─────────────────────────────────────────────────────┤
│         Infrastructure (基础设施)                      │
│   Storage │ EventStore │ Logging │ Config             │
└─────────────────────────────────────────────────────┘
```

## 系统运行全景

```
                        ┌─────────────┐
  用户消息 ──────────────▶│             │
  Webhook ──────────────▶│  EventBus   │◀──── 工具返回结果
  定时器 ───────────────▶│ (优先级队列) │◀──── 认知阶段完成事件
  心跳 ─────────────────▶│             │◀──── 任务状态变更事件
                        └──────┬──────┘
                               │ 分发事件
                               ▼
                        ┌─────────────┐
                        │    Agent    │
                        │ (事件处理器) │
                        └──────┬──────┘
                               │ 查找/驱动
                               ▼
                ┌──────────────────────────────┐
                │       TaskRegistry           │
                │  ┌──────┐ ┌──────┐ ┌──────┐  │
                │  │Task A│ │Task B│ │Task C│  │
                │  │ 状态机│ │ 状态机│ │ 状态机│  │
                │  │ACTING│ │THINK │ │IDLE  │  │
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

```python
# ❌ 旧方案：阻塞式 while 循环
class CognitiveLoop:
    async def run(self, task: Task) -> TaskResult:
        context = await self.perceive(task)
        while not context.is_complete:          # Agent 被锁死在这里
            thinking = await self.think(context)
            plan = await self.plan(thinking)
            results = await self.act(plan)
            context = await self.reflect(context, results)
        return context.final_result

# ✅ 新方案：事件驱动，Agent 是处理器
class Agent:
    async def _on_task_event(self, event: Event):
        task = self.registry.get(event.task_id)
        new_state = task.transition(event)       # 纯状态转换
        self._dispatch(task, new_state)          # 非阻塞启动下一阶段
        # 立即返回，处理下一个事件
```

## 详细设计文档

各子系统的详细设计拆分到独立文档：

| 文档 | 内容 |
|------|------|
| [events.md](./events.md) | 事件系统：Event、EventType、EventBus、优先级队列 |
| [task-fsm.md](./task-fsm.md) | 任务状态机：TaskState、TaskFSM、TaskContext、状态转换表、持久化策略 |
| [agent.md](./agent.md) | Agent 核心：事件处理、认知阶段调度、并发控制（信号量）、生命周期 |
| [cognitive.md](./cognitive.md) | 认知阶段：Perceive → Think → Plan → Act → Reflect，处理器接口 |
| [project-structure.md](./project-structure.md) | 代码目录结构与模块依赖关系 |
| [mvp-plan.md](./mvp-plan.md) | MVP 实现路线与里程碑 |
