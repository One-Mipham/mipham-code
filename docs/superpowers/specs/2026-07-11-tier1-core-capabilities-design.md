# Mipham Code — 第一梯队核心能力对标设计

> **版本**: 1.0.0
> **日期**: 2026-07-11
> **作者**: Zhang Guohua & Claude — One Mipham Corporation
> **对标基准**: Claude Code v2.1.207
> **状态**: 设计已定稿，待进入实施规划

---

## 目录

1. [概述与战略背景](#1-概述与战略背景)
2. [子系统一：Subagent 真实 AI 执行 + 自定义配置体系](#2-子系统一subagent-真实-ai-执行--自定义配置体系)
3. [子系统二：Skills 自动触发 + context:fork 隔离](#3-子系统二skills-自动触发--contextfork-隔离)
4. [子系统三：Hook 系统增强](#4-子系统三hook-系统增强)
5. [子系统四：Context 多层压缩](#5-子系统四context-多层压缩)
6. [跨子系统交互](#6-跨子系统交互)
7. [验证标准](#7-验证标准)

---

## 1. 概述与战略背景

### 1.1 目标

对标 Claude Code v2.1.207，补齐 Mipham Code 作为 AI 编程终端的四项核心基础能力。

### 1.2 三梯队路线图

```
第一梯队（当前）── 核心能力补齐
  ├─ Subagent 真实 AI 执行 + 自定义配置体系
  ├─ Skills 自动触发 + context:fork 隔离
  ├─ Hook 系统增强
  └─ Context 多层压缩

第二梯队（后续）── 差异化能力
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

### 1.3 设计原则

- **匹配现有代码风格** — 遵循已有命名、目录结构、TypeScript strict 模式
- **向后兼容** — 现有 API 不破坏，新功能通过新增文件和接口扩展实现
- **对标但不盲从** — 借鉴 Claude Code 的核心思路，保留 Mipham Code 的差异化（多模型、双轨 skills）

---

## 2. 子系统一：Subagent 真实 AI 执行 + 自定义配置体系

### 2.1 现状诊断

```
apps/cli/src/agent/sub-agent.ts   ← SubAgent 类
apps/cli/src/tools/agent/agent.ts ← Agent 工具包装
```

`SubAgent.execute()` 存在 `simulate()` 降级路径，在 API 不可用时返回固定模板文本。内置 4 种类型（general/explore/plan/code-review）仅通过硬编码的 `TYPE_SYSTEM_PROMPTS` 区分。无自定义代理配置体系。

### 2.2 架构变更

```
apps/cli/src/agent/
├── sub-agent.ts          ← 重构：移除 simulate()，强制 AI 执行
├── agent-registry.ts     ← 新增：加载 .mipham/agents/*.md + ~/.mipham/agents/*.md
├── agent-context.ts      ← 新增：隔离上下文工厂（ContextManager + tool scoping）
└── types.ts              ← 新增：AgentDefinition, AgentFrontmatter
```

### 2.3 自定义 Agent 定义格式

文件位置（优先级从高到低）：

1. `.mipham/agents/` — 项目级
2. `~/.mipham/agents/` — 用户级
3. 内置类型（general/explore/plan/code-review）— 默认兜底

```markdown
---
name: code-reviewer
description: 代码审查代理。在代码变更后主动触发，或用户提及 code review/PR/安全审计时使用。
tools: Read, Grep, Glob
model: inherit
permissionMode: acceptEdits
---

你是一个资深代码审查者。被调用时按以下顺序执行：

1. 用 git diff 识别当前分支的变更文件
2. 逐文件阅读变更及其测试
3. 按文件和行号标记问题：正确性、安全性、性能、可读性
4. 给出具体修复建议，而非模糊意见

## 输出格式

按文件分组的 Markdown 报告，严重程度标记：

- 🚨 BLOCKER — 合并前必须修复
- ⚠️ MAJOR — 应当修复
- 💡 NIT — 建议改进

不要修改文件。你被设计为只读。
```

### 2.4 Frontmatter 字段

| 字段              | 必需 | 默认值    | 说明                                            |
| ----------------- | ---- | --------- | ----------------------------------------------- |
| `name`            | 是   | —         | 唯一标识符，小写字母和连字符                    |
| `description`     | 是   | —         | 触发条件描述，用于自动路由                      |
| `tools`           | 否   | `all`     | 逗号分隔的工具白名单                            |
| `disallowedTools` | 否   | —         | 工具黑名单（先于 tools 应用）                   |
| `model`           | 否   | `inherit` | `sonnet`/`opus`/`haiku`/`inherit` 或具体模型 ID |
| `permissionMode`  | 否   | `inherit` | `default`/`acceptEdits`/`auto`/`bypass`/`plan`  |
| `maxTurns`        | 否   | —         | 最大 agent 轮次限制                             |
| `skills`          | 否   | —         | 启动时注入的 skill 列表                         |
| `background`      | 否   | `false`   | 是否始终作为后台任务运行                        |

### 2.5 SubAgent 重构

```typescript
// apps/cli/src/agent/sub-agent.ts

export class SubAgent {
  constructor(
    private registry: ProviderRegistry,
    private toolRegistry: Map<string, ToolDefinition>,
  ) {}

  async execute(
    prompt: string,
    description: string,
    options: SubAgentOptions = {},
  ): Promise<string> {
    const type = options.type || 'general'
    const agentDef = options.agentDef // 自定义 AgentDefinition

    // 1. 创建隔离上下文
    const context = new ContextManager({
      maxTokens: agentDef?.contextWindow || 100_000,
      compactionThreshold: 0.85,
    })

    // 2. 设置系统提示
    const systemPrompt = agentDef?.systemPrompt || TYPE_SYSTEM_PROMPTS[type]
    context.setSystemPrompt(systemPrompt)

    // 3. 工具沙箱
    const allowedTools = this.scopeTools(agentDef?.tools, agentDef?.disallowedTools)

    // 4. 添加用户消息
    context.addMessage({ role: 'user', content: prompt })

    // 5. 真实 AI 执行（无 simulate 降级）
    const provider = this.registry.getActive()
    if (!provider) {
      throw new Error('No active provider available for sub-agent execution')
    }

    const messages = context.getMessages()
    const chunks: string[] = []

    for await (const chunk of provider.chat({
      model: this.resolveModel(agentDef?.model),
      messages,
      systemPrompt,
      tools: this.formatTools(allowedTools),
      maxTokens: 4096,
    })) {
      if (chunk.type === 'text' && chunk.content) {
        chunks.push(chunk.content)
      }
      if (chunk.type === 'error') {
        throw new Error(`Sub-agent execution failed: ${chunk.error}`)
      }
    }

    return chunks.join('')
  }

  private scopeTools(allowed?: string, disallowed?: string): ToolDefinition[] {
    // 白名单/黑名单过滤逻辑
  }

  private resolveModel(modelOverride?: string): string {
    // inherit → 父级模型；具体值 → 直接使用
  }
}
```

### 2.6 内置 Subagent 类型

保留现有 4 种，系统提示增强：

| 类型          | 系统提示关键词     | 默认工具         | 典型场景           |
| ------------- | ------------------ | ---------------- | ------------------ |
| `general`     | 通用任务执行       | 全部             | 多步骤复杂任务     |
| `explore`     | 代码搜索和分析     | Read, Grep, Glob | 文件搜索、代码定位 |
| `plan`        | 架构设计和实现规划 | Read, Grep, Glob | 方案设计           |
| `code-review` | 代码审查           | Read, Grep, Glob | Bug 查找、安全审查 |

### 2.7 验证标准

- [ ] SubAgent.execute() 移除 simulate() 路径
- [ ] 自定义 agent 从 `.mipham/agents/*.md` 正确加载
- [ ] 工具沙箱正确过滤（白名单 + 黑名单）
- [ ] model 字段正确解析（inherit / 具体值）
- [ ] 隔离上下文不污染主对话
- [ ] Agent 工具在真实 AI 下正确返回结果

---

## 3. 子系统二：Skills 自动触发 + context:fork 隔离

### 3.1 现状诊断

```
apps/cli/src/skills/loader.ts           ← 被动加载，无自动匹配
apps/cli/src/skills/standard/runtime.ts ← 仅有 prompt 变量替换
apps/cli/src/tools/agent/skill.ts       ← 手动调用入口
```

用户必须知道 skill 名称并显式调用，AI 无法根据对话内容自动触发匹配的 skill。

### 3.2 架构变更

```
apps/cli/src/skills/
├── loader.ts              ← 重构：增加 description 索引 + 热重载路径
├── auto-trigger.ts        ← 新增：构建 system-reminder 注入块
├── fork-executor.ts       ← 新增：context:fork 的 subagent 执行逻辑
├── standard/runtime.ts    ← 保持
└── mipham/runtime.ts      ← 保持
```

### 3.3 自动触发机制

#### 3.3.1 System Prompt 注入

在每次构建 system prompt 时，将所有已加载 skill 的 `name + description` 注入：

```
<system-reminder>
The following skills are available. Invoke via the Skill tool when relevant:
- code-review: 代码审查。在代码变更后主动触发，或用户提及 review/PR 时使用。
- tdd: 测试驱动开发。实现功能或修复 bug 前先写测试。
- compassionate-communication: 共情沟通。当对话涉及情感或人际沟通时使用。
...
</system-reminder>
```

#### 3.3.2 Token 预算控制

- system-reminder 总 token 不超过 system prompt 的 10%
- 超出时按 skill 加载顺序截断，保留前 N 个
- `user-invocable: false` 的 skill 不占用此预算（仅 `/` 菜单隐藏）

#### 3.3.3 触发流程

```
用户提交请求
  → InstructionsLoader 构建 system prompt
  → SkillsLoader.buildSystemReminder() 注入可用 skill 列表
  → AI 分析请求，判断是否匹配某个 skill
  → 匹配 → AI 调用 Skill 工具 { skill: "code-review", args: "<file>" }
  → Skill 工具根据 context 字段决定执行方式
```

### 3.4 SKILL.md Frontmatter 扩展

新增字段：

```yaml
---
name: code-review
description: 代码审查。在代码变更后主动触发，或用户提及 review/PR 时使用。
version: 1.0.0
type: standard

# 新增字段
context: fork # "fork" | 不设置（默认 inline）
model: inherit # 模型覆盖
allowed-tools: # 工具白名单
  - Read
  - Grep
  - Glob
disable-model-invocation: false # true 禁止 AI 自动触发
user-invocable: true # false 从 / 菜单隐藏
---
```

### 3.5 context: fork 隔离执行

```typescript
// apps/cli/src/skills/fork-executor.ts

export async function executeForkedSkill(
  skill: SkillDefinition,
  args: string,
  registry: ProviderRegistry,
  toolRegistry: Map<string, ToolDefinition>,
): Promise<string> {
  // 1. 创建 SubAgent，传入 skill 的配置
  const subAgent = new SubAgent(registry, toolRegistry)

  // 2. skill 的 markdown 正文作为 system prompt
  // 3. args 作为 user prompt
  // 4. allowed-tools 转换为工具沙箱
  // 5. model 覆盖父级模型

  const result = await subAgent.execute(
    args || 'Execute the skill as described.',
    `skill:${skill.name}`,
    {
      type: 'general',
      agentDef: {
        systemPrompt: skill.content, // markdown 正文
        tools: skill.allowedTools?.join(', '),
        model: skill.model || 'inherit',
      },
    },
  )

  // 6. 结果返回给 AI 作为内部上下文（不直接展示给用户）
  return result
}
```

### 3.6 加载路径

| 优先级 | 路径                | 说明           |
| ------ | ------------------- | -------------- |
| 1      | `.mipham/skills/`   | 项目级         |
| 2      | `~/.mipham/skills/` | 用户级         |
| 3      | `apps/cli/skills/`  | 内置（打包时） |

### 3.7 验证标准

- [ ] system-reminder 正确注入到 system prompt
- [ ] AI 可以根据 description 自动匹配并调用 Skill 工具
- [ ] `disable-model-invocation: true` 阻止自动触发
- [ ] `context: fork` 正确创建隔离 subagent
- [ ] fork 结果返回给 AI 作为内部上下文
- [ ] `user-invocable: false` 从 `/` 菜单隐藏
- [ ] `~/.mipham/skills/` 路径正确加载
- [ ] token 预算控制在 10% 以内

---

## 4. 子系统三：Hook 系统增强

### 4.1 现状诊断

```
apps/cli/src/core/hooks.ts  ← 5 事件, 仅 code handler, 仅 PreToolUse 可阻止
```

### 4.2 架构变更

```
apps/cli/src/core/
├── hooks.ts              ← 重构：多类型支持 + 新增事件
├── hooks-config.ts       ← 新增：从 settings.json 加载 hook 配置
└── hooks-executor.ts     ← 新增：按类型分发执行（command/http/code/mcp_tool）
```

### 4.3 新增事件

| 事件               | 触发时机              | 可否阻止    | 典型用途                 |
| ------------------ | --------------------- | ----------- | ------------------------ |
| `Stop`             | AI 完成响应、准备停止 | ✅ 可阻止   | "测试未通过，继续修复"   |
| `UserPromptSubmit` | 用户每次提交输入      | ✅ 可阻止   | 输入预处理、敏感信息拦截 |
| `PreCompact`       | 上下文压缩前          | ❌ 不可阻止 | 压缩前保存关键信息       |
| `PostCompact`      | 上下文压缩后          | ❌ 不可阻止 | 验证压缩结果             |
| `ConfigChange`     | 配置变更时            | ❌ 不可阻止 | 审计日志                 |

现有事件保持：`PreToolUse` / `PostToolUse` / `SessionStart` / `SessionEnd` / `Notification`

### 4.4 Hook 类型

```typescript
type HookType = 'command' | 'http' | 'code' | 'mcp_tool'

interface HookConfig {
  type: HookType
  // command: 执行 shell 命令
  command?: string
  args?: string[] // exec form（防 shell 注入）
  // http: 回调 URL
  url?: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  // code: 内联 JS 函数（当前方式）
  handler?: (ctx: HookContext) => Promise<HookResult>
  // mcp_tool: 调用 MCP 工具
  mcpServer?: string
  mcpTool?: string
}
```

### 4.5 JSON 声明式配置

```json
// .mipham/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.mipham/hooks/block-dangerous.sh",
            "args": ["$TOOL_NAME", "$INPUT"]
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.mipham/hooks/require-tests-pass.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "~/.mipham/hooks/format-check.sh",
            "continueOnBlock": true
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "https://api.example.com/audit",
            "method": "POST"
          }
        ]
      }
    ]
  }
}
```

### 4.6 HookResult 增强

```typescript
interface HookResult {
  // 现有字段
  allowed: boolean
  reason?: string
  modifiedInput?: Record<string, unknown>

  // 新增字段
  decision?: 'allow' | 'block' // Stop hook 专用
  permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer' // PreToolUse 专用
  additionalContext?: string // 注入 AI 上下文
  updatedOutput?: string // PostToolUse 替换输出
}
```

### 4.7 Stop Hook 流程

```
AI 完成响应文本生成
  → 触发 Stop hook
  → 遍历匹配的 hook 链
    ├─ hook 返回 { decision: "block", reason: "测试未通过" }
    │   → reason 注入 AI 上下文
    │   → AI 继续工作（新一轮）
    └─ hook 返回 { decision: "allow" }
        → 正常停止，返回给用户
```

### 4.8 执行优先级规则

PreToolUse 的 permissionDecision 优先级：

```
deny > defer > ask > allow
```

### 4.9 验证标准

- [ ] 5 种新事件正确触发
- [ ] 4 种 hook 类型正确分发执行
- [ ] command 类型支持 args 数组防注入
- [ ] Stop hook 的 block 决策正确阻止 AI 停止
- [ ] PostToolUse 的 additionalContext 正确注入
- [ ] JSON 配置与代码注册的 hook 共存
- [ ] settings.json 格式错误时优雅降级

---

## 5. 子系统四：Context 多层压缩

### 5.1 现状诊断

```
apps/cli/src/core/context.ts  ← 单层压缩
```

`compact()` 只有一个策略：保留最后 20 条消息，前面用 LLM 摘要或直接丢弃。缺少差量压缩、缓存感知、和 413 错误恢复。

### 5.2 架构变更

```
apps/cli/src/core/
├── context.ts              ← 重构：多层压缩引擎
├── context-snip.ts         ← 新增：Layer 1 零成本修剪
├── context-microcompact.ts ← 新增：Layer 2 缓存感知压缩
├── context-compact.ts      ← 新增：Layer 3 API 摘要
├── context-drain.ts        ← 新增：Layer 4 413 紧急自救
└── context-token.ts        ← 新增：增强 token 估算（含缓存感知）
```

### 5.3 四层压缩栈

```
Layer 1: Snip（零成本修剪）
  ├─ 触发: 每次 addMessage() 后异步执行
  ├─ 操作: 移除空值 tool_result + assistant 消息对
  ├─ API 调用: 无
  └─ 成本: 零

Layer 2: Microcompact（缓存感知压缩）
  ├─ 触发: Token 估算 > 70%
  ├─ 操作: 替换旧 tool_result 为占位符 "[earlier result omitted]"
  ├─ 保留: 消息结构不删除
  ├─ 缓存: 仅压缩不在 prompt cache 中的消息
  └─ 决策: 节省的 tokens > 缓存失效损失 → 执行

Layer 3: Reactive Compact（API 摘要）
  ├─ 触发: Token 估算 > 85% 或手动 /compact
  ├─ 操作: 独立 API 调用生成历史摘要
  ├─ 重新注入: 系统提示 + skills(≤25K) + CLAUDE.md(≤50K) + 最近 N 条
  └─ API 调用: 1 次

Layer 4: Emergency Drain（413 自救）
  ├─ 触发: 收到 413 错误
  ├─ 第一阶段: 丢弃最早 50% 消息 → 重试
  ├─ 第二阶段: 仅保留 system prompt + 最后 5 条 → 重试
  └─ API 调用: 无
```

### 5.4 压缩决策流程

```
addMessage(msg):
  │
  ├─ 估算 tokens
  │
  ├─ Layer 1 "Snip" — 静默清理空值对（始终执行）
  │
  ├─ tokens > 70%? → Layer 2 "Microcompact"（缓存感知）
  │    └─ 对每条消息: 在 cache 中? → 跳过 : 是 tool_result? → 替换
  │
  ├─ tokens > 85%? → Layer 3 "Reactive Compact"（API 摘要）
  │    ├─ 独立 API 调用生成摘要
  │    ├─ 保留最近 10 条消息
  │    └─ 重新注入关键上下文
  │
  └─ 收到 413? → Layer 4 "Emergency Drain"
       ├─ 尝试 1: 丢弃最早 50% → 重试
       └─ 尝试 2: 仅保留 system + 5 条 → 重试
```

### 5.5 缓存感知逻辑

```typescript
// apps/cli/src/core/context-microcompact.ts

function shouldMicrocompact(messages: Message[], cacheTracker: CacheTracker): boolean {
  let savingsTokens = 0
  let cacheLossTokens = 0

  for (const msg of messages) {
    if (isOldToolResult(msg) && !cacheTracker.isInCache(msg)) {
      // 不在缓存中，可以安全压缩
      savingsTokens += estimateTokens(msg)
    } else if (isOldToolResult(msg) && cacheTracker.isInCache(msg)) {
      // 在缓存中，压缩会导致缓存失效
      cacheLossTokens += estimateTokens(msg)
    }
  }

  // 只有节省的 tokens 明显大于缓存损失时才执行
  return savingsTokens > cacheLossTokens * 1.5
}
```

### 5.6 关键数据保护

压缩后**必须保留或重新注入**的内容：

| 内容             | 保护方式         | Token 上限 |
| ---------------- | ---------------- | ---------- |
| System prompt    | 始终保留，不压缩 | 无限制     |
| 项目根 CLAUDE.md | 重新注入         | 50K        |
| Skills 定义      | 按优先级重新注入 | 25K        |
| Auto memory      | 摘要后重新注入   | 10K        |
| 最近消息         | 保留最后 10 条   | —          |
| Checkpoint 数据  | 不变（独立存储） | —          |

### 5.7 ContextManager 新接口

```typescript
class ContextManager {
  // 现有接口保持兼容

  // 新增
  addMessage(msg: Message): void // 增加后自动检查压缩
  getCacheStatus(): CacheStatus // 缓存命中状态
  setCacheTracker(tracker: CacheTracker): void // 注入缓存跟踪器
  on413Error(): Promise<boolean> // 413 自救（返回是否恢复成功）
  getCompactionStats(): CompactionStats // 压缩统计
  forceCompact(focus?: string): Promise<void> // 手动压缩（/compact 命令）
}
```

### 5.8 压缩统计

```typescript
interface CompactionStats {
  snipCount: number // Snip 执行次数
  snipMessagesRemoved: number // Snip 移除消息数
  microcompactCount: number // Microcompact 执行次数
  microcompactTokensSaved: number
  compactCount: number // Reactive Compact 执行次数
  compactTokensSaved: number
  drainCount: number // Emergency Drain 执行次数
  lastCompaction: Date | null
}
```

### 5.9 验证标准

- [ ] Layer 1 Snip 正确移除空值消息对
- [ ] Layer 2 Microcompact 替换旧 tool_result 为占位符
- [ ] Layer 2 仅在节省 > 缓存损失时执行
- [ ] Layer 3 Reactive Compact 重新注入关键上下文
- [ ] Layer 4 Emergency Drain 从 413 恢复
- [ ] addMessage() 后自动触发压缩检查
- [ ] 压缩后 system prompt / CLAUDE.md / skills 不丢失
- [ ] 压缩统计可查询

---

## 6. 跨子系统交互

### 6.1 Subagent ↔ Skills (context:fork)

Skills 的 `context: fork` 模式直接依赖 Subagent 系统：

```
Skill 工具 (skill.ts)
  → 读取 skill frontmatter
  → context === 'fork'?
    → 创建 SubAgent（agent-context.ts）
    → 传入 skill body 作为 system prompt
    → 传入 allowed-tools 作为工具沙箱
    → 执行并返回结果
```

### 6.2 Subagent ↔ Context

每个 SubAgent 内部使用独立的 ContextManager 实例：

```
SubAgent.execute()
  → new ContextManager({ maxTokens: 100K })
  → 使用 Layer 1-4 完整压缩栈
  → 执行完毕后销毁（不持久化）
```

### 6.3 Hook ↔ Context

PreCompact/PostCompact hook 在压缩前后触发：

```
Reactive Compact 执行前
  → 触发 PreCompact hook
  → hook 可返回 additionalContext（保存到临时变量）
  → 执行压缩
  → 触发 PostCompact hook
  → hook 可返回 additionalContext（注入到压缩后的上下文）
```

### 6.4 共享类型

所有子系统共享 `apps/cli/src/shared/types.ts` 中的基础类型：

```typescript
// 扩展 ToolContext
interface ToolContext {
  // 现有字段
  cwd: string
  sessionId: string
  provider: string
  model: string
  skillsLoader?: SkillsLoader
  registry?: ProviderRegistry
  artifactServer?: ArtifactServer

  // 新增字段
  agentRegistry?: AgentRegistry // 自定义 agent 注册表
  hookEngine?: HookEngine // hook 引擎引用
  cacheTracker?: CacheTracker // prompt cache 跟踪器
}
```

---

## 7. 验证标准

### 7.1 单元测试覆盖

| 子系统               | 测试文件                                 | 最少测试数 |
| -------------------- | ---------------------------------------- | ---------- |
| Subagent             | `test/agent/sub-agent.test.ts`           | 15         |
| Agent Registry       | `test/agent/agent-registry.test.ts`      | 10         |
| Skills Auto-trigger  | `test/skills/auto-trigger.test.ts`       | 12         |
| Skills Fork Executor | `test/skills/fork-executor.test.ts`      | 10         |
| Hook Engine          | `test/core/hooks.test.ts`                | 20         |
| Hook Config          | `test/core/hooks-config.test.ts`         | 8          |
| Context Snip         | `test/core/context-snip.test.ts`         | 8          |
| Context Microcompact | `test/core/context-microcompact.test.ts` | 10         |
| Context Compact      | `test/core/context-compact.test.ts`      | 10         |
| Context Drain        | `test/core/context-drain.test.ts`        | 8          |

### 7.2 集成测试

- Subagent + Skills fork: fork 模式端到端执行
- Hook + Context: PreCompact/PostCompact 在压缩流程中正确触发
- Subagent + Tool Scoping: 工具沙箱白名单/黑名单正确过滤

### 7.3 回归验证

- 现有 295 个测试全部继续通过
- 现有 slash commands 行为不变
- 现有 Provider 层功能不变
- 现有 MCP 客户端功能不变

---

## 修订历史

| 版本  | 日期       | 变更内容                     | 作者                  |
| ----- | ---------- | ---------------------------- | --------------------- |
| 1.0.0 | 2026-07-11 | 初始版本：四个子系统完整设计 | Zhang Guohua & Claude |
