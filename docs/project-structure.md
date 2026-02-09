# 代码目录结构

```
pegasus/
│
├── package.json                    # 项目配置、依赖管理
├── tsconfig.json                   # TypeScript 编译配置
├── Makefile                        # 常用开发命令
├── CLAUDE.md                       # Claude Code 开发指南
│
├── docs/                           # 设计文档
│   ├── architecture.md             # 系统架构总览（入口）
│   ├── events.md                   # 事件系统
│   ├── task-fsm.md                 # 任务状态机
│   ├── agent.md                    # Agent 核心
│   ├── cognitive.md                # 认知阶段
│   ├── project-structure.md        # 本文件
│   └── mvp-plan.md                 # MVP 实现路线
│
├── src/
│   ├── index.ts                    # 包入口（barrel exports）
│   ├── agent.ts                    # Agent 核心（事件处理器 + 状态转换编排）
│   │
│   ├── events/                     # 事件系统
│   │   ├── index.ts
│   │   ├── types.ts                # Event, EventType 定义
│   │   └── bus.ts                  # EventBus（优先级队列 + 事件分发）
│   │
│   ├── task/                       # 任务状态机
│   │   ├── index.ts
│   │   ├── states.ts               # TaskState 枚举 + 终态/可挂起状态集合
│   │   ├── fsm.ts                  # TaskFSM（状态机 + 转换表 + 动态决策）
│   │   ├── context.ts              # TaskContext, Plan, PlanStep, Reflection, ActionResult
│   │   └── registry.ts             # TaskRegistry（活跃任务管理）
│   │
│   ├── cognitive/                  # 认知阶段处理器（纯函数，无状态）
│   │   ├── index.ts
│   │   ├── perceive.ts             # Perceiver — 感知输入
│   │   ├── think.ts                # Thinker — 推理思考
│   │   ├── plan.ts                 # Planner — 任务规划
│   │   ├── act.ts                  # Actor — 执行动作
│   │   └── reflect.ts              # Reflector — 反思评估
│   │
│   ├── llm/                        # LLM 适配层
│   │   ├── index.ts
│   │   ├── base.ts                 # Provider 抽象基类
│   │   └── router.ts               # 模型路由和 Fallback
│   │
│   ├── models/                     # 数据模型
│   │   ├── index.ts
│   │   ├── message.ts              # 消息模型（Role, Message）
│   │   └── tool.ts                 # 工具调用模型（ToolDefinition, ToolCall, ToolResult）
│   │
│   └── infra/                      # 基础设施
│       ├── index.ts
│       ├── config.ts               # 配置加载（Zod schema + env vars）
│       ├── logger.ts               # 日志（pino）
│       └── errors.ts               # 异常层级（PegasusError → ...）
│
├── tests/
│   ├── unit/
│   │   ├── events.test.ts          # Event + EventBus 测试
│   │   ├── task.test.ts            # TaskFSM + Registry + Context 测试
│   │   └── llm-router.test.ts      # LLMRouter 测试
│   └── integration/
│       └── agent-lifecycle.test.ts  # Agent 端到端测试
│
└── data/                           # 运行时数据（.gitignore）
```

## Tech Stack

| Layer     | Choice           |
|-----------|-----------------|
| Runtime   | Bun             |
| Language  | TypeScript 5.x  |
| Schema    | Zod             |
| Logger    | pino            |
| Test      | bun:test        |

## 模块依赖关系

```
interfaces ──▶ agent ──▶ cognitive
                 │          │
                 ├──▶ task  │  （TaskFSM + TaskContext）
                 │          │
                 ├──▶ events│  （EventBus + Event）
                 │          │
                 ├──▶ identity
                 │
                 ├──▶ memory
                 │
                 └──▶ llm

所有模块 ──▶ infra（config, logger, errors）
```

**关键约束**：
- `interfaces` 只依赖 `agent`（通过 EventBus emit 事件）
- `cognitive` 处理器不依赖 `agent`（纯函数，接收 TaskContext 返回结果）
- `task` 不依赖 `cognitive`（状态机不知道认知处理的具体实现）
- `events` 不依赖任何业务模块（纯基础设施）
- `agent.ts` 是唯一的「知道所有人」的模块，但它自身是薄层
