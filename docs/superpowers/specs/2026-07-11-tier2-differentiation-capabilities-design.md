# Mipham Code — 第二梯队差异化能力对标设计

> **版本**: 1.0.0
> **日期**: 2026-07-11
> **作者**: Zhang Guohua & Claude — One Mipham Corporation
> **对标基准**: Claude Code v2.1.207
> **前置依赖**: 第一梯队核心能力（Subagent/Skills/Hook/Context）
> **状态**: 设计已定稿，待进入实施规划

---

## 目录

1. [概述与战略背景](#1-概述与战略背景)
2. [子系统一：Agent View 仪表盘](#2-子系统一agent-view-仪表盘)
3. [子系统二：Permission 系统深化](#3-子系统二permission-系统深化)
4. [子系统三：持久化 Memory 系统](#4-子系统三持久化-memory-系统)
5. [子系统四：Dynamic Workflow 编排引擎](#5-子系统四dynamic-workflow-编排引擎)
6. [跨子系统交互](#6-跨子系统交互)
7. [验证标准](#7-验证标准)

---

## 1. 概述与战略背景

### 1.1 目标

在第一梯队核心能力基础上，对标 Claude Code v2.1.207 构建四项差异化能力，使 Mipham Code 在多模型编程终端中脱颖而出。

### 1.2 前置依赖

本梯队依赖第一梯队成果：

- Subagent 系统（用于 Workflow 的 agent 原语 + Agent View 的后台会话）
- Context 多层压缩（用于 Memory 的自动记忆注入）
- Hook 系统增强（用于 Permission 的安全拦截 + Workflow 的生命周期事件）
- Skills fork 执行（用于 Workflow 的 skill-as-agent 能力）

### 1.3 三梯队路线图

```
第一梯队（已完成）── 核心能力补齐
  ✅ Subagent 真实 AI 执行 + 自定义配置体系
  ✅ Skills 自动触发 + context:fork 隔离
  ✅ Hook 系统增强
  ✅ Context 多层压缩

第二梯队（当前）── 差异化能力
  ├─ Agent View 仪表盘
  ├─ Permission 系统深化
  ├─ 持久化 Memory 系统
  └─ Dynamic Workflow 编排引擎

第三梯队（远期）── 体验与生态
  ├─ Plugins 系统
  ├─ Artifacts 实时分享
  ├─ Computer Use GUI 自动化
  └─ Vim motions / Safe Mode / /goal 等
```

### 1.4 设计原则

- **匹配现有代码风格** — 遵循已有命名、目录结构、TypeScript strict 模式
- **向后兼容** — 现有 API 不破坏，新功能通过新增文件和接口扩展实现
- **多模型差异化** — 每个子系统利用 Mipham Code 的多模型优势
- **对标但不盲从** — 借鉴 Claude Code 的核心思路，保留 Mipham Code 的差异化

---

## 2. 子系统一：Agent View 仪表盘

### 2.1 现状诊断

```
apps/cli/src/ui/app.tsx  ← 单会话面板，仅有一个 AgentProgress 横幅
```

当前 Mipham Code 是单会话、单面板的终端 UI。Claude Code 的 `claude agents` 提供多会话管理仪表盘。

### 2.2 入口方式

独立入口命令：`mipham agents`（对标 `claude agents`），作为 CLI 的子命令启动独立的 Ink TUI。

会话管理通过 `/bg` slash command 推入后台，`/agents` 在会话内跳转到仪表盘。

### 2.3 架构变更

```
apps/cli/src/
├── agent-view/
│   ├── dashboard.tsx          ← 新增：主仪表盘组件 (Ink)
│   ├── session-row.tsx        ← 新增：单行会话组件
│   ├── session-peek.tsx       ← 新增：Space 速览模态面板
│   └── agent-view-manager.ts  ← 新增：多会话生命周期管理
├── bin/
│   └── mipham.ts              ← 修改：添加 'agents' 子命令
└── ui/
    ├── app.tsx                ← 修改：添加 /bg、/agents 命令
    └── commands.ts            ← 修改：注册新 slash commands
```

### 2.4 AgentViewManager 核心接口

```typescript
// apps/cli/src/agent-view/agent-view-manager.ts

interface AgentSession {
  id: string
  task: string
  provider: string
  model: string
  status: 'needs-input' | 'working' | 'completed' | 'failed'
  engine: QueryEngine
  startTime: Date
  lastActivity: Date
  messageCount: number
}

class AgentViewManager {
  private sessions: Map<string, AgentSession>

  /** Create a new agent session and start processing. */
  create(task: string, engine: QueryEngine): string

  /** List all sessions, grouped by status. */
  list(): AgentSession[]

  /** Group sessions by status for dashboard rendering. */
  groupByStatus(): Record<string, AgentSession[]>

  /** Get last N lines of session output without attaching. */
  peek(id: string, lines?: number): string

  /** Attach to a session — returns its engine for full interaction. */
  attach(id: string): QueryEngine | undefined

  /** Terminate a session and free its resources. */
  kill(id: string): void

  /** Push current foreground session to background. */
  pushToBackground(id: string, task: string): void
}
```

### 2.5 仪表盘 UI 布局

```
┌─────────────────────────────────────────────────────────┐
│  Mipham Code · Agent View                    v0.5.0    │
├─────────────────────────────────────────────────────────┤
│  🟡 NEEDS INPUT (1)                                    │
│  ├─ #3  [anthropic/sonnet]  "fix the login bug"        │
│  │     waiting 5m · 127 msgs · [Space] peek · [Enter]  │
│                                                         │
│  🔵 WORKING (2)                                        │
│  ├─ #1  [deepseek/r1]  "refactor auth module"          │
│  │     ⠋ 3m · agent: code-reviewer · [Space] peek      │
│  ├─ #2  [mipham/pro]  "write tests for utils"          │
│  │     ⠙ 1m · [Space] peek                             │
│                                                         │
│  🟢 COMPLETED (1)                                      │
│  ├─ #0  [anthropic/claude]  "explain this code"        │
│  │     done 5m ago · 12 msgs · [Enter] to attach       │
│                                                         │
│  [N]ew  [A]ttach  [K]ill  [Q]uit                       │
└─────────────────────────────────────────────────────────┘
```

### 2.6 键盘快捷键

| 键                     | 操作                                       |
| ---------------------- | ------------------------------------------ |
| `j` / `k` 或 `↑` / `↓` | 上下移动选中会话                           |
| `Space`                | 速览选中会话（底部面板显示最后输出）       |
| `Enter`                | 挂载选中会话（替换仪表盘为完整 ChatPanel） |
| `n`                    | 新建会话                                   |
| `k` (选中后)           | 终止选中会话                               |
| `q` / `Esc`            | 退出仪表盘                                 |
| `r`                    | 刷新会话列表                               |

### 2.7 单进程异步管理

所有后台会话在单 Bun 进程内通过异步任务管理。每个 AgentSession 持有独立的 `QueryEngine` 实例和 `ContextManager`。不使用 worker 线程或子进程。

```
AgentViewManager
  └─ sessions: Map<string, AgentSession>
       ├─ session-1: { engine, context, abortController }
       ├─ session-2: { engine, context, abortController }
       └─ session-3: { engine, context, abortController }

后台执行: engine.process(task, abortController.signal)
取消: abortController.abort()
```

### 2.8 验证标准

- [ ] `mipham agents` 独立命令正确启动仪表盘 TUI
- [ ] 四状态分组正确渲染
- [ ] Space 速览显示会话最后输出
- [ ] Enter 挂载切换到完整 ChatPanel
- [ ] `/bg <task>` 创建后台会话
- [ ] 后台会话异步执行不阻塞前台
- [ ] 会话终止正确释放资源
- [ ] 仪表盘退出后后台会话继续执行

---

## 3. 子系统二：Permission 系统深化

### 3.1 现状诊断

```
apps/cli/src/core/permission.ts  ← 3 模式 (auto/ask/bypass)，无 allowlist/denylist
```

### 3.2 架构变更

```
apps/cli/src/core/
├── permission.ts         ← 重构：6 模式 + allowlist/denylist + 规则解析
├── permission-config.ts  ← 新增：从 settings.json 加载权限配置
└── permission-rules.ts   ← 新增：Bash 命令模式匹配引擎
```

### 3.3 六种权限模式

```typescript
type PermissionMode =
  | 'default' // 仅读取免问
  | 'acceptEdits' // 读取 + 文件编辑 + mkdir/touch/mv/cp
  | 'plan' // 仅读取，无写入或执行
  | 'auto' // 全部允许，后台安全检查
  | 'dontAsk' // 仅 allowlist 中预批准的工具
  | 'bypassPermissions' // 全部允许，无提示（隔离容器专用）
```

### 3.4 模式行为矩阵

| 模式                | Read   | Write/Edit | Bash(安全) | Bash(危险) | Network | Agent  |
| ------------------- | ------ | ---------- | ---------- | ---------- | ------- | ------ |
| `default`           | 免问   | 询问       | 询问       | 询问       | 询问    | 询问   |
| `acceptEdits`       | 免问   | 免问       | 询问       | 询问       | 询问    | 询问   |
| `plan`              | 免问   | 拒绝       | 拒绝       | 拒绝       | 询问    | 询问   |
| `auto`              | 免问   | 免问       | 免问       | 检查       | 免问    | 免问   |
| `dontAsk`           | 免问\* | 免问\*     | 免问\*     | 拒绝\*     | 免问\*  | 免问\* |
| `bypassPermissions` | 免问   | 免问       | 免问       | 免问       | 免问    | 免问   |

\*仅在 allowlist 中时免问

### 3.5 Allowlist/Denylist 规则

```json
// .mipham/settings.json
{
  "permissions": {
    "mode": "acceptEdits",
    "allow": [
      "Edit",
      "Write",
      "Bash(npm test)",
      "Bash(npm run lint)",
      "Bash(git status)",
      "Bash(git diff)",
      "Bash(git log:*)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(curl * | bash)",
      "Bash(> /dev/*)",
      "Write(/etc/*)",
      "Write(~/.ssh/*)"
    ]
  }
}
```

**优先级链（从高到低）：**

1. **Deny** — 始终优先，不可被 allow 覆盖
2. **Ask** — 显式需要用户批准
3. **Allow** — 预批准
4. **Permission mode 基线** — 模式默认行为

### 3.6 Bash 命令模式匹配

```typescript
// 格式: "Bash(<pattern>)"
// 示例:
//   "Bash(git:*)"     → 匹配 git status, git diff, git log...
//   "Bash(npm test:*)" → 匹配 npm test -- --coverage
//   "Bash(npm:*)       → 匹配所有 npm 命令

function matchBashRule(
  pattern: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // 提取 Bash(...) 中的命令模式
  const match = pattern.match(/^Bash\((.+)\)$/)
  if (!match) return false

  const cmdPattern = match[1]!
  const actualCmd = (toolInput.command as string) || ''

  // 使用通配符匹配
  // git:*  → 匹配 "git status", "git diff --cached"
  return wildcardMatch(cmdPattern, actualCmd.trim())
}

function wildcardMatch(pattern: string, input: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return regex.test(input)
}
```

### 3.7 PermissionSystem 重构接口

```typescript
class PermissionSystem {
  private mode: PermissionMode
  private allowRules: PermissionRule[]
  private denyRules: PermissionRule[]

  /** Set the current permission mode. */
  setMode(mode: PermissionMode): void

  /** Add an allow rule. */
  allow(rule: string): void

  /** Add a deny rule (always wins over allow). */
  deny(rule: string): void

  /** Check if a tool call is permitted. Resolution chain: deny → allow → mode baseline. */
  check(tool: ToolDefinition, input: Record<string, unknown>): PermissionLevel

  /** Load rules from settings JSON. */
  loadConfig(config: PermissionConfig): void

  /** Cycle to the next mode (for Shift+Tab cycling). */
  cycleMode(): PermissionMode
}
```

### 3.8 验证标准

- [ ] 6 种模式正确切换
- [ ] Allowlist 规则正确匹配
- [ ] Denylist 规则优先级高于 allowlist
- [ ] Bash(command) 通配符匹配正确
- [ ] settings.json 权限配置正确加载
- [ ] 模式循环 (Shift+Tab) 行为不变
- [ ] 现有权限测试全部通过

---

## 4. 子系统三：持久化 Memory 系统

### 4.1 现状诊断

```
apps/cli/src/core/session-store.ts  ← 仅 JSONL 保存/加载，无自动记忆
```

当前仅能做完整会话持久化，不能提取跨会话记忆或在会话间共享上下文。

### 4.2 架构变更

```
apps/cli/src/core/
└── memory/
    ├── memory-manager.ts    ← 新增：记忆 CRUD + 索引管理
    ├── memory-writer.ts     ← 新增：AI 响应分析 → 自动记忆提取
    └── memory-loader.ts     ← 新增：SessionStart 记忆注入

~/.mipham/
└── memory/
    ├── MEMORY.md            ← 记忆索引文件
    └── *.md                  ← 单个记忆文件
```

### 4.3 记忆文件格式

```markdown
---
name: user-preference-typescript
description: User prefers TypeScript strict mode with no implicit any
metadata:
  type: user
  relevance: [typescript, configuration, coding-style]
---

用户偏好 TypeScript strict 模式，所有新代码必须无 implicit any。

**Why:** 2026-06-15 在 refactor auth module 时用户明确要求
**How to apply:** 所有新 .ts 文件启用 strict，CI 中启用 noImplicitAny
```

### 4.4 记忆类型

| 类型        | 说明                 | 示例                         |
| ----------- | -------------------- | ---------------------------- |
| `user`      | 用户偏好和习惯       | "用户偏好 TypeScript strict" |
| `feedback`  | 用户对 AI 工作的反馈 | "不要使用 `as any`"          |
| `project`   | 项目决策和上下文     | "auth 模块使用 JWT"          |
| `reference` | 外部资源和链接       | "API 文档: https://..."      |

### 4.5 MemoryManager 核心接口

```typescript
interface MemoryMetadata {
  type: 'user' | 'feedback' | 'project' | 'reference'
  relevance: string[]
}

interface MemoryEntry {
  name: string
  description: string
  metadata: MemoryMetadata
  content: string
  filePath: string
  updatedAt: Date
}

class MemoryManager {
  private memories: Map<string, MemoryEntry>
  private memoryDir: string // ~/.mipham/memory/

  /** Load all memories from the memory directory. */
  loadAll(): void

  /** Write or update a single memory fact. Creates/updates individual .md file. */
  write(name: string, content: string, metadata: MemoryMetadata): void

  /** Recall memories relevant to the current context. Uses relevance tags + keyword match. */
  recall(context: string, limit?: number): MemoryEntry[]

  /** Delete a memory that turned out to be wrong. */
  delete(name: string): void

  /** Build <system-reminder> block from relevant memories, capped at token limit. */
  buildSystemReminder(context: string, maxTokens?: number): string

  /** Update index file (MEMORY.md) with current memory list. */
  updateIndex(): void
}
```

### 4.6 自动记忆流程

```
SessionStart
  → MemoryLoader.loadAll()
  → 匹配当前对话上下文
  → 注入 system-reminder: "Previous memories relevant to this session: ..."

AI 完成响应
  → MemoryWriter.analyzeResponse(userMessage, aiResponse)
  → 检测关键信息模式:
    - "用户偏好..." / "I prefer..." / "以后都..." → type: user
    - "记住..." / "remember..." → type: feedback
    - 项目技术决策 → type: project
    - URL / 文档引用 → type: reference
  → 创建/更新记忆文件
  → 更新 MEMORY.md 索引

AI 工具调用 (Write/Edit)
  → MemoryWriter.onToolUse(toolName, input)
  → 检测是否有值得记忆的代码变更
```

### 4.7 验证标准

- [ ] 记忆文件正确创建和读取
- [ ] MEMORY.md 索引自动更新
- [ ] recall() 按 relevance 正确过滤
- [ ] system-reminder 注入格式正确
- [ ] 自动记忆提取识别用户偏好
- [ ] 错误记忆可手动删除
- [ ] 跨会话记忆保持

---

## 5. 子系统四：Dynamic Workflow 编排引擎

### 5.1 现状诊断

Mipham Code 无任何工作流编排能力。第一梯队已交付 Subagent 系统，可作为 Workflow agent 原语的执行基础。

### 5.2 架构变更

```
apps/cli/src/workflow/
├── runtime.ts            ← 核心运行时：执行脚本、管理原语
├── sandbox.ts            ← 沙箱：禁用 Date.now/Math.random
├── primitives/
│   ├── agent.ts          ← agent() 原语实现
│   ├── parallel.ts       ← parallel() 屏障
│   ├── pipeline.ts       ← pipeline() 流式阶段
│   └── phase.ts          ← phase() 进度组
├── journal.ts            ← 日志记录与确定性重放
├── budget.ts             ← Token 预算跟踪
└── cli.ts                ← mipham workflow CLI 命令

apps/cli/bin/
└── mipham.ts             ← 修改：添加 'workflow' 子命令
```

### 5.3 脚本格式

```javascript
// my-workflow.js
export const meta = {
  name: 'code-audit',
  description: 'Multi-model security audit',
  phases: [
    { title: 'Scan', detail: 'grep for vulnerability patterns' },
    { title: 'Verify', detail: 'adversarial verification per finding' },
  ],
}

phase('Scan')
const findings = await agent('Find security vulnerabilities in this codebase', {
  model: 'deepseek-r1',
  provider: 'deepseek', // 多模型差异化：不同阶段用不同模型
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            file: { type: 'string' },
            line: { type: 'number' },
          },
          required: ['title', 'severity', 'file'],
        },
      },
    },
    required: ['items'],
  },
})

phase('Verify')
const verified = await pipeline(findings.items, (f) =>
  agent(`Adversarially verify this finding: ${f.title} at ${f.file}:${f.line}`, {
    model: 'claude-sonnet-5',
    provider: 'anthropic', // 验证阶段用更可靠的模型
    schema: {
      type: 'object',
      properties: {
        isReal: { type: 'boolean' },
        confidence: { type: 'number' },
      },
      required: ['isReal'],
    },
  }),
)

log(`Verified ${verified.filter((v) => v.isReal).length} real findings.`)
```

### 5.4 核心原语

| 原语                         | 签名                                                          | 行为                                                                                                             |
| ---------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, opts?)`       | `→ Promise<any>`                                              | 创建 SubAgent 执行任务。支持 model/provider/schema。有 schema 时自动调用 StructuredOutput 工具，返回验证后的对象 |
| `parallel(thunks)`           | `→ Promise<any[]>`                                            | **屏障**：并发执行所有 thunk，等全部完成。失败项 → null                                                          |
| `pipeline(items, ...stages)` | `→ Promise<any[]>`                                            | **无屏障**：每项独立流经所有阶段。Item A 在 stage 3 时 Item B 可能在 stage 1                                     |
| `phase(title)`               | `→ void`                                                      | 声明逻辑阶段，进度 UI 据此分组                                                                                   |
| `log(message)`               | `→ void`                                                      | 输出进度消息                                                                                                     |
| `args`                       | `any`                                                         | 脚本输入参数                                                                                                     |
| `budget`                     | `{total: number\|null, spent(): number, remaining(): number}` | Token 预算感知                                                                                                   |

### 5.5 Agent 选项（多模型差异化）

```typescript
interface WorkflowAgentOpts {
  label?: string // 显示标签
  phase?: string // 进度阶段（覆盖全局 phase）
  schema?: object // JSON Schema → structured output
  model?: string // 模型覆盖
  provider?: string // provider 覆盖（多模型差异化核心）
  effort?: 'low' | 'medium' | 'high' | 'max'
  isolation?: 'worktree' // git worktree 隔离
}
```

**多模型策略：**

- 扫描/搜索阶段 → DeepSeek/Qwen（成本低、速度快）
- 代码生成/重构 → Claude Sonnet（质量平衡）
- 安全审计/架构设计 → Claude Opus（最高质量）
- 自有模型场景 → Mipham Pro/Apex

### 5.6 确定性重放

```typescript
// 沙箱禁用不可重放的 API
const FORBIDDEN_GLOBALS = [
  'Date.now',
  'Math.random',
  'new Date()', // 无参数构造
  'crypto.randomUUID',
]

// 替代方案
// 通过 args 传入: { timestamp: "2026-07-11T12:00:00Z", seed: 42 }
// agent prompt 中使用: "用随机种子 42 生成..."
```

### 5.7 Journal 与 Resume

```
~/.mipham/workflows/<run-id>/
├── journal.jsonl     ← 每个 agent() 调用的输入/输出
│   {"seq":1,"type":"agent","prompt":"Find bugs","opts":{...},"result":{...}}
│   {"seq":2,"type":"agent","prompt":"Verify bug #1","opts":{...},"result":{...}}
├── script.js          ← 原始脚本副本
└── state.json         ← { seq: 3, phases: [...], budgetRemaining: 450000 }
```

**恢复流程：**

```
mipham workflow resume <run-id>
  → 读取 journal.jsonl
  → 已完成 agent(seq=1,2) → 从缓存返回
  → 未完成 agent(seq=3) → 重新执行
  → 继续执行剩余脚本
```

### 5.8 运行时约束

| 约束                     | 值    | 说明         |
| ------------------------ | ----- | ------------ |
| 最大并发 agent           | 16    | 超出排队等待 |
| 单次运行总 agent         | 1000  | 安全熔断     |
| pipeline/parallel 最大项 | 4096  | 显式上限     |
| agent 超时               | 300s  | 可配置       |
| 脚本无 fs/shell          | ✅    | 沙箱隔离     |
| script 最大长度          | 512KB |              |

### 5.9 CLI 命令

```bash
mipham workflow run <script.js> [--args '{...}']  # 运行工作流
mipham workflow list                                # 列出所有工作流运行
mipham workflow resume <run-id>                     # 恢复暂停的工作流
mipham workflow stop <run-id>                       # 停止运行中的工作流
mipham workflow show <run-id>                       # 显示工作流详情
mipham workflow logs <run-id>                       # 显示运行日志
```

### 5.10 内置工作流

```bash
mipham workflow run builtin:deep-research "量子计算对密码学的影响"
mipham workflow run builtin:code-audit --args '{"path": "apps/cli/src"}'
```

### 5.11 验证标准

- [ ] `agent()` 正确创建 SubAgent 并返回结果
- [ ] `agent()` 支持 provider/model 覆盖
- [ ] `agent()` 支持 schema → structured output
- [ ] `parallel()` 并发执行所有 thunk，失败项 → null
- [ ] `pipeline()` 无屏障流式执行
- [ ] `phase()` 正确分组进度
- [ ] `budget` Token 预算正确跟踪
- [ ] 确定性重放：相同脚本 + 相同 args → 相同 journal
- [ ] Resume：已完成 agent 从缓存返回
- [ ] 沙箱禁用 Date.now/Math.random
- [ ] `mipham workflow` CLI 命令正确工作
- [ ] 内置工作流正确加载和执行

---

## 6. 跨子系统交互

### 6.1 Agent View ↔ Workflow

Workflow 的每个 agent 调用可以在 Agent View 仪表盘中显示为独立的 Working 会话：

```
Workflow agent('Scan auth module') → Agent View 显示 "🔵 WORKING: [workflow:code-audit] Scan auth module"
```

### 6.2 Permission ↔ Agent View

后台会话继承 Agent View 的权限模式设置。每个会话可以有独立的权限模式。

### 6.3 Memory ↔ Workflow

Workflow 执行过程中可以读写 Memory，实现跨 workflow 运行的上下文保持。

### 6.4 Memory ↔ Agent View

不同 Agent View 会话之间通过 Memory 共享上下文（用户偏好、项目决策）。

---

## 7. 验证标准

### 7.1 集成测试

| 测试                    | 覆盖                                |
| ----------------------- | ----------------------------------- |
| Agent View + Workflow   | Workflow agent 在 Agent View 中可见 |
| Permission + Agent View | 后台会话权限模式独立管理            |
| Memory + Session        | 跨会话记忆注入正确                  |
| Workflow + Permission   | Workflow agent 遵守权限规则         |

### 7.2 回归验证

- 第一梯队所有测试（437 tests）继续通过
- 现有 slash commands 行为不变
- Provider 层功能不变

---

## 修订历史

| 版本  | 日期       | 变更内容                           | 作者                  |
| ----- | ---------- | ---------------------------------- | --------------------- |
| 1.0.0 | 2026-07-11 | 初始版本：四个差异化子系统完整设计 | Zhang Guohua & Claude |
