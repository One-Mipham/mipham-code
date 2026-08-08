# Mipham Code — Phase 10 CRSI 经验驱动行为进化设计 Spec

> **版本**: 1.0.0
> **日期**: 2026-08-08
> **阶段**: Phase 10 — Continuous Recursive Self Improvement
> **前置依赖**: Phase 7 Agent Memory 持久化（已完成）
> **维护人**: One Mipham Corporation 技术委员会

---

## 一、动机与背景

### 1.1 Phase 7 成果

Phase 7 实现了 Agent Memory 持久化的三个子系统：

| 子系统 | 能力 |
|--------|------|
| Enhanced MemoryManager | wikilinks + 去重 + distillFromSession + 时间衰减召回 |
| Session Resume | 会话索引 + 摘要 + /resume 命令 + SessionStart 注入 |
| Agent Experience | 成功/失败模式记录 + 经验注入系统提示 |

### 1.2 核心断裂点

当前 CRSI 数据流存在关键断裂：

```
对话结束 → distillFromSession() → 记忆文件
Agent 执行 → logSuccess/logFailure → experience.md（被动记录）
下次启动 → SessionStart 注入 → 系统提示里加一段经验文字
```

**经验被"说出来"了，但没有被"执行"。** AI 在下一轮对话中看到了"上次 Bash 超时因为没设 timeout"，但它不会在调用 Bash 前主动检查 timeout 是否足够。经验只是背景信息，不是行为约束。

### 1.3 Phase 10 目标

弥合"经验→行为"的断裂，构建三层递进架构：

- **10.1（B 方案）**：经验格式化为强制规则注入系统提示
- **10.2（A 方案）**：可编程规则通过 PreTool Hook 确定性拦截
- **10.3（C 方案）**：自动模式发现 + 规则效果追踪 + 自动升降级

---

## 二、整体架构

```
                    ┌──────────────────────────────┐
                    │     Phase 10.3 (C)            │
                    │  ┌─────────────────────────┐  │
                    │  │   PatternAnalyzer        │  │
                    │  │   (自动规则挖掘)          │  │
                    │  │   EffectivenessTracker   │  │
                    │  │   (规则效果追踪)          │  │
                    │  └──────────┬──────────────┘  │
                    │             ↓                 │
                    │  ┌─────────────────────────┐  │
Phase 10.2 (A)      │  │   ExperienceRuleEngine  │  │
                    │  │   ┌───────────────────┐ │  │
                    │  │   │  PreTool Hooks    │ │  │
                    │  │   │  (确定性修正)      │ │  │
                    │  │   └───────────────────┘ │  │
                    │  └──────────┬──────────────┘  │
                    │             ↓                 │
Phase 10.1 (B)      │  ┌─────────────────────────┐  │
                    │  │   MandatoryRuleInjector  │  │
                    │  │   (经验→强制规则注入)     │  │
                    │  └─────────────────────────┘  │
                    └──────────────────────────────┘
```

**三层关系**：10.1 是基础层（所有规则都注入提示），10.2 在此基础上拦截可编程规则，10.3 是大脑层（自动发现规则并管理生命周期）。

---

## 三、Phase 10.1 — 经验 → 强制规则注入（B 方案）

### 3.1 核心改动

`AgentExperience` 的 `getExperience()` 不再返回原始 Markdown，而是返回结构化的 `ExperienceRule[]`。规则注入系统提示时使用强制性语言和证据链。

### 3.2 数据结构

```typescript
interface ExperienceRule {
  id: string                    // 唯一标识，格式: rule-<category>-<hash>
  type: 'mandatory' | 'warning'
  condition: string             // 触发条件描述
  action: string                // 必须执行的动作
  evidence: {                   // 证据链
    failureCount: number
    lastFailure: string         // ISO date
    examples: string[]          // 具体失败案例（最多 3 条）
  }
  category: 'timeout' | 'import' | 'search' | 'tool-params' | 'semantic'
  source: 'agent-experience' | 'manual' | 'pattern-analyzer'
  agentName: string             // 来源 Agent
  createdAt: string             // ISO date
}
```

### 3.3 规则注入格式

系统提示中注入格式：

```
## ⚠️ Active Mandatory Rules (learned from past failures)

1. [timeout] npm/docker 命令 → timeout≥300s
   Evidence: 3 failures in last 7 days
   Last failure: 2026-08-07 — npm install timeout at 120s

2. [import] ESM 模块导入 → 必须加 .js 扩展名
   Evidence: 7 failures in last 14 days
   Last failure: 2026-08-07 — MODULE_NOT_FOUND for './foo'

3. [search] 全仓库 Grep → 先用 Glob 限定目录
   Evidence: 2 failures, 1 token overflow
   Last failure: 2026-08-06 — 450K tokens consumed
```

### 3.4 RuleExtractor 工作流

```typescript
class ExperienceRuleExtractor {
  // 从 experience.md 提取规则
  extract(experienceContent: string, agentName: string): ExperienceRule[]
  
  // 按 category 和 type 排序
  prioritize(rules: ExperienceRule[]): ExperienceRule[]
  
  // 生成注入 system prompt 的文本块
  formatForInjection(rules: ExperienceRule[]): string
}
```

**提取逻辑**：

1. 解析 experience.md → Success Patterns / Failure Patterns
2. 对每个 Failure Pattern，用关键词匹配分类：
   - `timeout` → category: 'timeout'
   - `MODULE_NOT_FOUND` / `import` / `.js` → category: 'import'
   - `grep` / `search` / `token` → category: 'search'
   - `bash` / `command` → category: 'tool-params'
   - 其他 → category: 'semantic'
3. 同类失败 ≥3 次 → `type: 'mandatory'`
4. 同类失败 = 2 次 → `type: 'warning'`
5. 同类失败 = 1 次 → 不提取为规则
6. 去重：已存在的规则（同 id）不重复创建

### 3.5 改动文件

| 文件 | 改动 | 行数 |
|------|------|------|
| `agent/experience-rules.ts` | **新文件** — ExperienceRule 类型 + RuleExtractor | ~120 |
| `agent/agent-context.ts` | 替换 getExperience() 调用为 extractor | ~15 |
| `agent/agent-experience.ts` | 新增 getRules() 方法 | ~20 |

### 3.6 测试

- 同类失败 <2 次不生成规则
- 同类失败 = 2 次生成 warning 规则
- 同类失败 ≥3 次生成 mandatory 规则
- extraction 正确分类（timeout/import/search/tool-params/semantic）
- formatForInjection 输出格式符合规范
- 空 experience 不崩溃，返回空数组

---

## 四、Phase 10.2 — PreTool Hook 确定性拦截（A 方案）

### 4.1 核心思路

Phase 10.1 的规则依赖 AI "看到并遵守"指令。对于可编程验证的规则（timeout、路径格式等），在工具执行前直接修正——不依赖 AI 自觉。

### 4.2 架构位置

在现有 Hook 系统（13 种生命周期事件）中新增 `PreToolUse` 事件。

```
工具调用发出
    ↓
Permission 层检查
    ↓
PreToolUse Hook ← 🆕 RuleEngine 在此介入
    ├── 匹配到规则 → 修正参数 + 注入 warning 到 tool result
    └── 未匹配 → 透传
    ↓
工具实际执行
```

### 4.3 RuleEngine 设计

```typescript
interface ToolRule {
  id: string
  toolName: string                    // 'bash' | 'write' | 'edit' | 'grep' | ...
  category: string
  match: (params: Record<string, unknown>) => boolean
  fix: (params: Record<string, unknown>) => {
    modified: Record<string, unknown>  // 修正后的参数
    warning: string                    // 告知 AI 的修正说明
  }
  source: 'builtin' | 'pattern-analyzer' | 'manual'
  enabled: boolean
}

class ExperienceRuleEngine {
  private rules: ToolRule[]
  
  // 注册规则
  register(rule: ToolRule): void
  
  // 在工具执行前检查并修正
  intercept(toolName: string, params: Record<string, unknown>): {
    modified: Record<string, unknown>
    warnings: string[]
  }
  
  // 从 ExperienceRule[] 转换为 ToolRule[] (10.3 调用)
  convertFromExperienceRules(experienceRules: ExperienceRule[]): ToolRule[]
  
  // 获取所有活跃规则
  getActiveRules(): ToolRule[]
  
  // 禁用/启用规则
  setRuleEnabled(id: string, enabled: boolean): void
}
```

### 4.4 内置规则示例

```typescript
const BUILTIN_RULES: ToolRule[] = [
  {
    id: 'rule-timeout-bash-heavy',
    toolName: 'bash',
    category: 'timeout',
    match: (p) => {
      const cmd = String(p.command ?? '')
      return /npm (install|ci|test)|docker build|pnpm install|cargo build|brew install/.test(cmd)
        && (!p.timeout || p.timeout < 300_000)
    },
    fix: (p) => ({
      modified: { ...p, timeout: 300_000 },
      warning: `⏱️ timeout 已从 ${p.timeout || 'default'}ms 自动提升至 300000ms（该命令类型历史超时率 > 50%）`
    }),
    source: 'builtin',
    enabled: true
  },
  {
    id: 'rule-git-force-protection',
    toolName: 'bash',
    category: 'tool-params',
    match: (p) => {
      const cmd = String(p.command ?? '')
      return /git (push|reset) .*--force/.test(cmd) && !p.dangerouslyDisableSandbox
    },
    fix: (p) => ({
      modified: p,
      warning: `⚠️ 检测到 git --force 操作。如需执行请设置 dangerouslyDisableSandbox: true`
    }),
    source: 'builtin',
    enabled: true
  }
]
```

### 4.5 关键设计决策

- **修正必须告知 AI**：每次修正通过 tool result warning 注入，否则 AI 推理会出错
- **修正是可追溯的**：每次修正记录到 `~/.mipham/rule-engine/audit.log`
- **用户可控**：`/crsi rules` 查看所有活跃规则，`/crsi disable <rule-id>` 禁用

### 4.6 改动文件

| 文件 | 改动 | 行数 |
|------|------|------|
| `core/rule-engine.ts` | **新文件** — RuleEngine + ToolRule + builtin rules | ~150 |
| `core/hooks.ts` | 新增 PreToolUse 事件类型 + 触发逻辑 | ~30 |
| `core/permission.ts` | 在工具执行前调用 RuleEngine.intercept() | ~20 |
| `ui/commands.ts` | 注册 `/crsi rules`、`/crsi disable` | ~30 |

### 4.7 测试

- builtin rule 匹配并修正 timeout
- builtin rule 不匹配时透传
- warning 正确注入 tool result
- 禁用规则后不再触发
- audit.log 记录每次修正

---

## 五、Phase 10.3 — 自动模式发现 + 规则生命周期（C 方案）

### 5.1 核心循环

```
                    ┌──────────────┐
                    │  经验积累     │  ← 日常对话产生 experience.md
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │  模式分析     │  ← PatternAnalyzer 定期扫描
                    │  (离线/触发式)│
                    └──────┬───────┘
                           ↓
              ┌────────────┼────────────┐
              ↓            ↓            ↓
        频率≥3次      频率=2次      频率=1次
        自动创建规则   创建 warning    仅记录，不动作
              ↓            ↓
         ┌────────────────────────────┐
         │     规则生效                │
         │  (注入 + PreTool Hook)     │
         └────────────┬───────────────┘
                      ↓
         ┌────────────────────────────┐
         │  EffectivenessTracker      │
         │  规则应用 N 次后对比前后   │
         │  成功率变化                 │
         └────────────┬───────────────┘
                      ↓
         ┌────────────┼─────────────┐
         ↓            ↓             ↓
    成功率 ↑       成功率不变      成功率 ↓
    保持/升级      标记待观察       自动降级
                                 (mandatory→warning
                                  →disabled)
```

### 5.2 PatternAnalyzer

**触发时机**：
- 会话退出时（SessionEnd hook）
- 手动触发：`/crsi analyze`
- 累计阈值：Agent 每累计 5 次新执行后自动扫描

**发现模式类型**：

| 模式 | 检测方式 | 生成规则类型 |
|------|---------|-------------|
| 同类工具重复失败 | 同一 agent + toolName + 相似 error message ≥3 次 | ToolRule (PreTool Hook) |
| 命令超时模式 | Bash 超时中同一类命令（npm/docker/cargo）≥3 次 | ToolRule (timeout boost) |
| 文件路径错误 | Write/Edit 导致 MODULE_NOT_FOUND ≥3 次 | SemanticRule (注入提示) |
| 搜索模式低效 | Grep 无结果 + 后续缩小范围后找到 ≥3 次 | SemanticRule |

**相似度判断**：对 error message 提取关键词（移除路径、时间戳等变量），计算 Jaccard 相似度。

```typescript
class PatternAnalyzer {
  // 扫描所有 Agent 的 experience.md
  analyzeAllAgents(): Pattern[]
  
  // 针对单个 Agent 扫描
  analyzeAgent(agentName: string): Pattern[]
  
  // 将 Pattern 转换为 ExperienceRule
  toRule(pattern: Pattern): ExperienceRule
  
  // 将 Pattern 转换为 ToolRule（供 RuleEngine 使用）
  toToolRule(pattern: Pattern): ToolRule
}
```

### 5.3 EffectivenessTracker

```typescript
interface RuleEffectiveness {
  ruleId: string
  appliedCount: number           // 规则被触发次数
  successAfterCount: number      // 规则应用后操作成功的次数
  preRuleFailureRate: number     // 规则创建前该操作的失败率
  postRuleFailureRate: number    // 规则创建后该操作的失败率（最近 20 次）
  status: 'active' | 'degrading' | 'disabled'
  createdAt: string
  lastEvaluatedAt: string
  evaluationHistory: { date: string; appliedCount: number; failureRate: number }[]
}

class EffectivenessTracker {
  // 记录规则应用
  recordApplication(ruleId: string, success: boolean): void
  
  // 获取规则效果
  getEffectiveness(ruleId: string): RuleEffectiveness
  
  // 评估所有规则，返回需要升降级的规则
  evaluate(): { upgrades: string[]; degradations: string[]; disables: string[] }
  
  // 持久化到 ~/.mipham/rule-engine/effectiveness.json
  persist(): void
  
  // 从文件加载
  load(): void
}
```

### 5.4 自动降级规则

| 条件 | 动作 |
|------|------|
| 应用 ≥10 次，失败率不降反升 | `mandatory` → `warning` |
| `warning` 状态再观察 10 次，依然无效 | `warning` → `disabled` |
| 用户手动恢复后，重新观察 20 次 | 按正常逻辑评估 |

- `disabled` 状态保留记录但不再生效
- 用户可手动恢复：`/crsi restore <rule-id>`

### 5.5 配置存储

```
~/.mipham/rule-engine/
├── rules.json              # 所有规则（builtin + auto-generated + manual）
├── effectiveness.json      # 规则效果追踪数据
├── patterns.json           # 已发现的模式（含未生成规则的）
└── audit.log               # 每次修正的审计日志
```

### 5.6 新增命令

| 命令 | 功能 |
|------|------|
| `/crsi analyze` | 手动触发模式分析 |
| `/crsi rules` | 列出所有规则：类型、状态、效果数据 |
| `/crsi disable <id>` | 禁用指定规则 |
| `/crsi restore <id>` | 恢复被降级或禁用的规则 |
| `/crsi stats` | 显示 CRSI 整体效果：规则数、拦截次数、成功率变化 |

### 5.7 改动文件

| 文件 | 改动 | 行数 |
|------|------|------|
| `agent/pattern-analyzer.ts` | **新文件** — 模式扫描 + 规则生成 | ~150 |
| `agent/effectiveness-tracker.ts` | **新文件** — 规则效果追踪 | ~120 |
| `core/hooks.ts` | SessionEnd hook 触发 analyze | ~15 |
| `ui/commands.ts` | 注册 `/crsi analyze`、`/crsi restore`、`/crsi stats` | ~40 |

### 5.8 测试

- PatternAnalyzer 正确识别 timeout 模式（≥3 次同类超时）
- PatternAnalyzer 正确识别 import 错误模式
- 同类失败=2 次生成 warning 但不生成 ToolRule
- 同类失败=1 次不产生任何规则
- EffectivenessTracker 正确统计规则应用前后的失败率
- 连续 10 次无改善 → 自动降级
- 降级后 10 次仍无效 → 自动禁用
- SessionEnd 正确触发 analyze

---

## 六、数据流全景

```
日常对话
    ↓
工具调用 → RuleEngine.intercept() [10.2] → 参数修正 → 执行
    ↓
    ├─ 成功 → AgentExperience.logSuccess() [Phase 7]
    └─ 失败 → AgentExperience.logFailure() [Phase 7]
    ↓
experience.md 积累 [Phase 7]
    ↓
SessionEnd → PatternAnalyzer.analyzeAgent() [10.3]
    ├─ 发现模式 → 生成 ExperienceRule [10.1]
    │              → 转换 ToolRule → RuleEngine.register() [10.2]
    └─ 无新模式
    ↓
下次对话启动:
  ├─ agent-context 加载 ExperienceRule[] → 注入系统提示 [10.1]
  └─ RuleEngine 加载 ToolRule[] → 等待工具调用 [10.2]
    ↓
每次工具调用:
  └─ EffectivenessTracker.recordApplication() [10.3]
    ↓
定期评估 → 自动升降级 [10.3]
    ↓
AI 越来越少犯同类错误 ← CRSI
```

---

## 七、Feature Flags

所有新功能通过 feature flag 控制（`~/.mipham/config.json`）：

```json
{
  "crsi": {
    "ruleInjection": true,        // 10.1 — 经验→强制规则注入
    "preToolHook": true,          // 10.2 — PreTool Hook 确定性拦截
    "autoPatternAnalysis": true,  // 10.3 — 自动模式发现
    "autoRuleManagement": true    // 10.3 — 自动规则升降级
  }
}
```

默认全部开启，用户可关闭任一子功能。

---

## 八、交付顺序

```
Phase 10.1 (B)
    │  基础：规则提取 + 注入
    │  改动：3 files, ~155 lines, +5 tests
    ▼
Phase 10.2 (A)
    │  加固：PreTool Hook + RuleEngine
    │  依赖：10.1 的 ExperienceRule 类型
    │  改动：4 files, ~230 lines, +4 tests
    ▼
Phase 10.3 (C)
    │  闭环：PatternAnalyzer + EffectivenessTracker
    │  依赖：10.1 + 10.2 的规则系统
    │  改动：4 files, ~325 lines, +6 tests
    ▼
合计：11 files (含 5 新文件), ~710 lines, +15 tests
```

**为什么这个顺序**：
- 10.1 是数据基础——定义了规则的统一结构
- 10.2 依赖 10.1 的类型定义，但可以独立测试
- 10.3 是消费者——它发现模式、创建规则，通过 10.1 和 10.2 的渠道生效

---

## 九、风险与缓解

| 风险 | 缓解 |
|------|------|
| 规则误匹配（false positive） | ToolRule.match() 必须足够精确；用户可随时 disable |
| 规则爆炸式增长 | 全局上限 50 条规则；超过则淘汰最久未触发的 |
| 自动修正引入新错误 | 修正后通过 EffectivenessTracker 监控，失败率上升则自动降级 |
| PatternAnalyzer 消耗过多资源 | 仅在 SessionEnd 时运行，手动触发备选 |
| 隐私风险（audit.log） | audit.log 仅存储 ruleId + timestamp + toolName，不含参数内容 |

---

## 十、不做什么（明确排除）

- ❌ 跨机器规则同步 — 保持单机范围
- ❌ 规则共享/市场 — 不在本阶段范围
- ❌ ML 模型替换规则引擎 — 保持确定性规则
- ❌ CRSI 可视化面板 — 已有 `/crsi stats` 命令行，UI 后续增强
- ❌ 修改已有工具的行为签名 — RuleEngine 只修正参数，不改变工具接口

---

### 修订历史

| 版本 | 日期 | 变更内容 | 维护人 |
|------|------|---------|--------|
| 1.0.0 | 2026-08-08 | 初版：三阶段递进架构完整设计 | 技术委员会 |
