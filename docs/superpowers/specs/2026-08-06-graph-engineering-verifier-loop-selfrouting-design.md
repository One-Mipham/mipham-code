# Graph Engineering: Verifier, Loop, Self-Routing

> **版本**: 1.0.0
> **日期**: 2026-08-06
> **状态**: Design Approved — 待实现
> **参考**: Claude Code Dynamic Workflows 14-Step Graph Engineering ([@0xCodez](https://x.com/0xCodez/status/2079165300625330317))

## 概述

Mipham Code v0.13.0 已具备 Workflow 核心引擎（`runtime.ts` + `parallel()` + `pipeline()` + `agent()` + schema validation），但缺少三个关键能力使其成为完整的 Graph Engineering 平台：

| Step   | 原语                     | 定位     | 解决的问题                                         |
| ------ | ------------------------ | -------- | -------------------------------------------------- |
| **09** | `verify()` / `judge()`   | 质量闸门 | 没有验证器，graph 只能加速不能提升置信度           |
| **11** | `loopUntilConvergence()` | 收敛循环 | 未知规模任务无法安全自动化；seen-vs-confirmed 陷阱 |
| **14** | Self-Routing             | 自动编排 | 7 家 provider 的模型都不会写 workflow 脚本         |

三个 Step 基于完全相同的已有积木（`parallel()` + `agent()` + `schema`）构建，零新依赖。

---

## Step 09: Verifier Primitives — `verify()` + `judge()`

### 动机

一张 graph 真正的杠杆不在于更多的 agent —— 而在于你能围绕它们构建出用来产生**置信度**的结构。当前 Mipham Code 的 workflow 可以让 agent 并行工作，但没有内置机制来验证它们的输出。用户必须手写锅炉代码做对抗式验证。

### 设计

**文件**: `src/workflow/primitives/verify.ts`（新建）

#### `verify(finding, opts)` → `VerifyResult`

```typescript
interface VerifyOpts {
  // 模式选择
  mode: 'adversarial' | 'perspective' | 'consensus'

  // 对抗式: N 个独立怀疑者
  skeptics?: number // default: 3

  // 多视角: K 个不同检查维度
  lenses?: string[] // e.g. ['correctness', 'security', 'performance']

  // 共识: N 个投票者
  voters?: number // default: 3

  // 通过阈值（票数 >= threshold 则 survives）
  threshold?: number // default: 2（adversarial/consensus）, 1（perspective）

  // 输出 schema
  schema: object // { real: boolean, reason: string }
}

interface VerifyResult {
  finding: unknown
  survives: boolean
  votes: Array<{
    real: boolean
    reason: string
    lens?: string // perspective 模式下的视角标签
  }>
  score: number // 0.0 ~ 1.0（survives 的票数占比）
}
```

**内部实现**：

```
verify(finding, opts):
  switch mode:
    adversarial → parallel(N skeptics, prompt="Try to refute: {finding}")
    perspective → parallel(N lenses, prompt="Judge via {lens}: {finding}")
    consensus   → parallel(N voters, prompt="Is this correct? {finding}")
  votes ← results.filter(Boolean)
  survives ← votes.filter(v => v.real).length >= threshold
  return { finding, survives, votes, score }
```

#### `judge(attempts, opts)` → `JudgeResult`

```typescript
interface JudgeOpts {
  criteria: string[] // e.g. ['completeness', 'correctness', 'elegance']
  judges?: number // default: 3
  synthesize?: boolean // default: true — 综合报告
  schema: object // { scores: Record<criteria, number>, notes: string }
}

interface JudgeResult {
  winner: unknown // 总得分最高的方案
  winnerIndex: number
  scores: Array<{
    attemptIndex: number
    judgeIndex: number
    criteria: Record<string, number>
    total: number
    notes: string
  }>
  synthesis?: string // 综合报告（从胜者综合 + 嫁接其他方案亮点）
}
```

### 行为约束

- 两个原语均使用 `parallel()` 扇出验证者/评委
- 失败的 agent 返回 null，被 `.filter(Boolean)` 过滤
- `verify()` 返回 `survives: boolean`，由调用方决定是否继续传递
- `judge()` 始终返回结果——即使所有评委都打低分（调用方决定阈值）

### 测试要点

| 测试                                                         | 验证 |
| ------------------------------------------------------------ | ---- |
| adversarial: 3 skeptics, 2 real → survives=true, score=0.67  |
| adversarial: 3 skeptics, 1 real → survives=false, score=0.33 |
| adversarial: 1 agent 失败 → 其余 2 票正常统计                |
| perspective: 4 lenses, 3 pass → survives=true                |
| consensus: 5 voters, 5 real → survives=true, score=1.0       |
| judge: 3 attempts × 3 judges → 9 个评分，winner 正确         |
| judge: synthesize=false → synthesis 字段为 undefined         |
| verify schema 校验失败 → agent 自动重试（复用现有机制）      |

---

## Step 11: Convergence Loop — `loopUntilConvergence()`

### 动机

未知规模的发现型任务（bug 排查、安全扫描、边缘案例收集）无法预设 step 数。需要循环直到"找不到新东西"。但**拿什么去重**是决定成败的细节：

- ❌ 对 **confirmed** 去重 → 被否决的发现每轮复活 → 无限循环
- ✅ 对 **seen** 去重 → 被否决的发现不再出现 → 自然收敛

此原语将"seen-set dedup"永久封印在内部，用户不会犯这个错。

### 设计

**文件**: `src/workflow/primitives/loop.ts`（新建）

```typescript
interface LoopUntilConvergenceOpts<T> {
  // 发现者：并行 fan-out，每个返回 { items: T[] }
  finders: Array<() => Promise<{ items: T[] }>>

  // 去重键函数（纯 JS，零 token）
  keyFn: (item: T) => string

  // 可选验证器 — 复用 Step 09
  verify?: (item: T) => Promise<VerifyResult>

  // 收敛参数
  dryRounds?: number // 连续 N 轮无新发现 → 停止（默认 2）
  maxRounds?: number // 安全上限（默认 20）

  // 可选 schema 约束 finder 输出
  schema?: object
}

interface LoopUntilConvergenceResult<T> {
  confirmed: T[] // 通过验证的发现
  totalSeen: number // 见过的唯一发现总数（含被否决的）
  rounds: number // 实际运行轮数
  converged: boolean // true=自然收敛, false=maxRounds 截断
}
```

**核心算法**：

```
loopUntilConvergence(opts):
  seen ← Set()           // ⚠️ seen-set, NOT confirmed-set
  confirmed ← []
  dry ← 0
  rounds ← 0

  while dry < dryRounds AND rounds < maxRounds:
    rounds++

    // FAN OUT: 所有发现者并行
    raw ← parallel(finders)
    items ← raw.flatMap(filter(Boolean), r → r.items)

    // EDGE LOGIC: 纯 JS 去重（零 token）
    fresh ← items.filter(i → !seen.has(keyFn(i)))

    if fresh.length == 0:
      dry++               // 无新发现 → 趋向收敛
      continue

    dry ← 0
    fresh.forEach(i → seen.add(keyFn(i)))   // ← 进 SEEN

    // VERIFY: 每个新发现经过验证（可选）
    if verify:
      judged ← parallel(fresh.map(i → verify(i)))
      confirmed.push(...judged.filter(Boolean).filter(v → v.survives).map(v → v.finding))
    else:
      confirmed.push(...fresh)

  return {
    confirmed,
    totalSeen: seen.size,
    rounds,
    converged: dry >= dryRounds,
  }
```

### 与 Step 09 的协作

`loopUntilConvergence()` 的 `verify` 参数直接消费 `verify()` 的返回值：

```javascript
const result = await loopUntilConvergence({
  finders: SCANNERS.map((s) => () => agent(s.prompt, { schema: VULN })),
  keyFn: (v) => `${v.file}:${v.line}:${v.type}`,
  verify: async (v) =>
    verify(v, {
      mode: 'adversarial',
      skeptics: 3,
      threshold: 2,
      schema: VERDICT,
    }),
  dryRounds: 2,
})
```

### 测试要点

| 测试                   | 验证                                                            |
| ---------------------- | --------------------------------------------------------------- |
| 自然收敛               | 第 3 轮无新发现 → dry=2 → converged=true, rounds=3              |
| seen vs confirmed 语义 | finder 返回相同 item + verify=false → seen 拦截 → 不复活        |
| maxRounds 截断         | finder 每轮返回新 item, maxRounds=5 → rounds=5, converged=false |
| 空 finder              | 第 1 轮就 0 结果 → rounds=1, confirmed=[]                       |
| verify 集成            | verify returns survives=false → 不进 confirmed，进 seen         |
| 一个 finder 失败       | parallel 返回 null → filter(Boolean) 过滤 → 其余正常            |

---

## Step 14: Self-Routing — Auto-Workflow Generation

### 动机

Claude Code 的模型已被 fine-tune 能自动写 workflow 编排脚本。Mipham Code 支持 7 家 provider（Anthropic, OpenAI, DeepSeek, Qwen, Doubao, Hunyuan, Mipham），**没有一家做过这个 fine-tune**。

解决方案：把 Workflow 工具描述变成"教科书"，让任何模型读完就能写编排脚本。

### 设计：三层架构

```
Layer 1: Knowledge Injection
  Workflow 工具描述 = Graph Engineering 教科书
  ~800 词，覆盖所有 primitives + patterns + pitfalls

Layer 2: Trigger Mechanism
  /workflow <task>    — 显式触发：描述任务，Claude 自动生成+执行
  System Instruction  — 隐式触发：复杂任务自动考虑 workflow

Layer 3: Persistence
  运行成功 → 提示保存 → .claude/workflows/<name>.js
  /workflows          — 列出可复用 graph
  /workflow run <name> — 按名运行
```

### Layer 1: 扩展工具描述

**当前** (~50 词):

```
'Execute a multi-agent workflow script. The script uses agent(),
parallel(), pipeline(), phase(), log(), args, budget primitives...'
```

**新设计** (~800 词，结构化教科书):

文件 `src/tools/agent/workflow.ts` 中的 `description` 字段扩展为完整指南，包含：

1. **Primitives 清单** — 每个原语的签名、语义、返回值
2. **Topology 选择指南** — 何时用 diamond/pipeline/loop/verify/judge
3. **Critical Rules** — barrier 何时值、edge logic 用 JS 不用 agent、seen vs confirmed
4. **Anti-Patterns** — 常见错误及正确做法
5. **Script 格式** — `export const meta` 头 + 脚本体
6. **完整示例** — 一个 diamond topology 的端到端示例

### Layer 2: 触发机制

**a) `/workflow <task>` 命令**

```
用户: /workflow audit all routes for missing auth
  → 模型读 Workflow 工具描述（800词教科书）
  → 模型理解任务，写出编排脚本
  → 模型调用 Workflow({script, args}) 执行
  → 用户看到实时进度 + 最终结果
```

**b) System Instruction 注入**

在 `instructions.ts` 的 `buildSystemPrompt()` 末尾注入：

```markdown
## Workflow Auto-Generation

When a task involves 3+ independent subtasks, multi-file operations,
or unknown-size discovery, generate a workflow script and execute it
via the Workflow tool instead of running agents sequentially. The
orchestration itself is code (zero tokens for coordination).

Prefer workflows for: audits, research, migrations, multi-file refactors,
code reviews across dimensions, security scans, bug hunts.

Available primitives: agent(), parallel(), pipeline(), verify(),
judge(), loopUntilConvergence(), phase(), log(), args, budget.

When a workflow completes successfully, offer to save it:
"Workflow complete. Save? /workflow save <name>"
```

**c) `/workflow save <name>`**

保存最近成功运行的脚本到 `.claude/workflows/<name>.js`。

### Layer 3: 预置模板

`skills/workflows/` 目录，6 个可复用模板：

| 模板          | Topology                | 用途                                                        |
| ------------- | ----------------------- | ----------------------------------------------------------- |
| `audit.js`    | Diamond + verify        | 安全检查：fan-out per file → verify → report                |
| `research.js` | Diamond + verify        | 深度研究：scope → parallel search → verify → synthesize     |
| `migrate.js`  | Pipeline + verify       | 代码迁移：discover → fan-out transform → verify → integrate |
| `review.js`   | Fan-out + judge         | 代码审查：per dimension → judge panel → report              |
| `hunt.js`     | Loop-until-dry + verify | Bug 排查：反复发现 → 对抗式验证 → 收敛                      |
| `judge.js`    | Parallel + judge        | 方案评审：N attempts × M judges → winner                    |

每个模板是独立的 `.js` 文件，有完整的 `export const meta` 头和实现逻辑。既是直接可用的工具，也是模型学习的范例。

### 关键设计决策

| 决策                           | 理由                                               |
| ------------------------------ | -------------------------------------------------- |
| 知识放在工具描述而非 CLAUDE.md | 模型是通过工具描述学习工具的。放在别处不会自动关联 |
| 不抄 Claude Code 描述          | 法律风险。内容等价但措辞独立                       |
| 模板是 .js 而非 .md            | 可直接被 `/workflow run` 执行；模型也能读源码学习  |
| `/workflow save` 不是自动的    | 遵循 Surgical Changes 原则——用户决定什么值得保存   |

---

## 文件变更汇总

### 新建文件

| 文件                                | 行数（估） | 说明                        |
| ----------------------------------- | ---------- | --------------------------- |
| `src/workflow/primitives/verify.ts` | ~200       | verify() + judge() 实现     |
| `src/workflow/primitives/loop.ts`   | ~180       | loopUntilConvergence() 实现 |
| `skills/workflows/audit.js`         | ~60        | Diamond + verify 模板       |
| `skills/workflows/research.js`      | ~60        | Diamond + verify 模板       |
| `skills/workflows/migrate.js`       | ~60        | Pipeline + verify 模板      |
| `skills/workflows/review.js`        | ~60        | Fan-out + judge 模板        |
| `skills/workflows/hunt.js`          | ~60        | Loop-until-dry 模板         |
| `skills/workflows/judge.js`         | ~50        | Judge panel 模板            |
| `test/workflow/verify.test.ts`      | ~150       | verify() + judge() 测试     |
| `test/workflow/loop.test.ts`        | ~120       | loopUntilConvergence() 测试 |

### 修改文件

| 文件                          | 变更     | 说明                                                   |
| ----------------------------- | -------- | ------------------------------------------------------ |
| `src/workflow/runtime.ts`     | +~30 行  | 注入 verify/judge/loopUntilConvergence/workflow 到沙箱 |
| `src/tools/agent/workflow.ts` | +~500 行 | 工具描述 50→800 词 + 增加 args/scriptPath/name 参数    |
| `src/ui/commands.ts`          | +~100 行 | `/workflow <task>`, `/workflow save`, `/workflow run`  |
| `src/core/instructions.ts`    | +~20 行  | Workflow auto-generation system instruction            |

### 统计

| 指标           | 数值      |
| -------------- | --------- |
| 新增代码       | ~1,650 行 |
| 新建文件       | 10        |
| 修改文件       | 4         |
| 测试用例（估） | ~30       |
| 零新依赖       | ✅        |

---

## 自行审查

### Placeholder 扫描

- 无 TBD/TODO
- 所有接口定义完整
- 所有文件路径明确

### 内部一致性

- Step 09 和 11 通过 `verify` 参数协作，接口对齐
- Step 14 的教科书内容引用了 Step 09 和 11 的新原语
- 预置模板使用所有三个 Step 的新原语

### 范围检查

- 三个 Step 构成一个逻辑整体：质量 → 收敛 → 自动编排
- 不涉及 CLI UI、Web、MCP、其他工具
- 纯 workflow 层增强

### 歧义检查

- `verify()` 的 threshold 默认值按模式区分（adversarial/consensus=2, perspective=1）—— 已明确
- `loopUntilConvergence()` 的 seen-set 语义通过算法伪代码固化 —— 无歧义
- 工具描述扩展不改变 Workflow 工具的 API 兼容性 —— 明确

---

## 实现顺序

```
Phase 1: Step 09 (verify + judge)
  → src/workflow/primitives/verify.ts
  → test/workflow/verify.test.ts
  → runtime.ts 注入
  → 验证：15 tests green

Phase 2: Step 11 (loopUntilConvergence)
  → src/workflow/primitives/loop.ts
  → test/workflow/loop.test.ts
  → runtime.ts 注入
  → 验证：25 tests green (累加)

Phase 3: Step 14 (Self-Routing)
  → tools/agent/workflow.ts 描述扩展
  → commands.ts 增强
  → instructions.ts 注入
  → skills/workflows/ 6 模板
  → 验证：手动测试 /workflow <task>
```
