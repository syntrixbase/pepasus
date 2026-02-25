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
│   ├── cognitive.md                # 认知阶段（3 阶段：Reason → Act → Reflect）
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
│   │   ├── think.ts                # Thinker — 推理思考（LLM 调用）
│   │   ├── plan.ts                 # Planner — 任务规划（纯代码，在 Reason 内部调用）
│   │   ├── act.ts                  # Actor — 执行动作
│   │   └── reflect.ts              # Reflector — 反思评估
│   │
│   ├── tools/                      # 工具系统
│   │   ├── index.ts
│   │   ├── types.ts                # Tool, ToolResult, ToolContext, ToolCategory
│   │   ├── registry.ts             # ToolRegistry（注册 + LLM 格式转换）
│   │   ├── executor.ts             # ToolExecutor（参数验证 + 超时 + 事件发射）
│   │   └── builtins/               # 内置工具
│   │       ├── index.ts
│   │       ├── system-tools.ts     # current_time
│   │       └── memory-tools.ts     # memory_list/read/write/append
│   │
│   ├── identity/                   # 身份层
│   │   ├── persona.ts              # Persona 类型定义
│   │   └── prompt.ts               # 系统提示词构建
│   │
│   ├── models/                     # 数据模型
│   │   ├── index.ts
│   │   └── tool.ts                 # 工具调用模型（ToolDefinition, ToolCall）
│   │
│   └── infra/                      # 基础设施
│       ├── index.ts
│       ├── config.ts               # 配置加载（Zod schema + env vars）
│       ├── config-schema.ts        # 配置 schema 定义
│       ├── config-loader.ts        # 配置文件加载
│       ├── logger.ts               # 日志（pino）
│       ├── errors.ts               # 异常层级（PegasusError → ...）
│       ├── id.ts                   # 短 ID 生成
│       ├── llm-types.ts            # LLM 类型定义
│       └── llm-utils.ts            # LLM 调用工具函数
│
├── tests/
│   ├── unit/
│   │   ├── events.test.ts          # Event + EventBus 测试
│   │   ├── task.test.ts            # TaskFSM + Registry + Context 测试
│   │   ├── cognitive.test.ts       # 认知处理器测试
│   │   ├── llm-router.test.ts      # LLMRouter 测试
│   │   └── tools/
│   │       ├── registry.test.ts    # ToolRegistry 测试
│   │       ├── executor.test.ts    # ToolExecutor 测试
│   │       └── memory-tools.test.ts # 记忆工具测试
│   └── integration/
│       ├── agent-lifecycle.test.ts  # Agent 端到端测试
│       └── agent-tool-loop.test.ts  # Agent 工具循环测试
│
└── data/                           # 运行时数据（.gitignore）
    └── memory/                     # 记忆存储
        ├── facts/                  # 事实文件
        └── episodes/               # 经历文件
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
                 ├──▶ tools
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
