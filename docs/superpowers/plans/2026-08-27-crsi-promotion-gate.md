# CRSI 晋升门（Promotion Gate）实施计划

> **日期**: 2026-08-27
> **作者**: Guohua Zhang · One Mipham Corporation
> **状态**: 🟡 研究阶段 —— **尚未实施**，供评审决策
> **前情**: 承接 [[2026-08-19-crsi-behavior-task-suite-design]]（行为任务集）与受约束自改进闭环（`/crsi modify|propose|eval`）；本计划补上 `crsi-lessons.md` eval-rigor 教训明文记录的债务
> **术语**: A1 铁律 = 绝不拿 LLM 当裁判；晋升 = 一次自改进改动通过 eval 闸门被合入

---

## 一、背景与动机

### 1.1 现状：只有一道闸

`core/crsi-modify.ts` 的 `runCrsiModification()` 目前的晋升判定**只有一道闸**：

```typescript
const evalReport = runEval()
const last = getLastEvalScore()
if (last !== null && evalReport.score < last) {
  /* 拒绝：跨合并退化 */
}
appendEvalScore(evalReport)
```

即「**分数不退化**」：只要 `本次分数 >= 上次分数` 就放行。

### 1.2 这道闸的缺陷（对应 eval-rigor 教训）

| 缺陷                                 | 后果                                         |
| ------------------------------------ | -------------------------------------------- |
| 只防「退化」，不辨「真改进 vs 碰巧」 | 改 A 时 B 碰巧变好，闸门放行，误判「改进」   |
| 无因果归因                           | 分数升降无法追溯到「到底哪个组件导致的」     |
| 无最小效应量                         | 微小波动（+1 分）也被当成「改进」            |
| 无误提升预算                         | 反复尝试总能碰巧过一次，把「运气」当「能力」 |
| 无原子激活                           | 晋升记录读写无一致性保证                     |

### 1.3 教训来源

`crsi-lessons.md` **eval-rigor** 教训（2026-08-27 固化）明文记录：

> 自改进的「晋升/固化」不能只靠「整体分数不退化」这一道闸，须统计严谨：① 因果归因 ② 误提升预算 ③ 最小效应量 ④ 原子激活

参考实现：autocontext（Apache-2.0）的「晋升八道检查」——「只有当比较恰好只省略一个 `(kind,key,digest)` 且其余全同时才标因果」「campaign 级持久 alpha 预留 + 块不相交道」「自适应确认置信区间须越过最小效应量」「激活 = 单个 `active.json` 原子指针替换 + compare-and-swap」。

---

## 二、目标与非目标

### 2.1 目标

把单道闸升级为**晋升门四道检查**（不退化 + 因果归因 + 最小效应量 + 误提升预算），并把每次晋升写入**可审计的 ledger**。

### 2.2 非目标（本次不做）

| 非目标                                               | 原因                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ❌ 「改进率作为优化目标」（OpenRSI 方向）            | 涉及 producer 探索机制，是方向性大改，另立计划                                          |
| ❌ `RewardFn` 接口抽象（Godel_Agent 方向）           | crsi-design 教训的延伸，另立计划                                                        |
| ❌ 第二层「任务表现」行为任务（test-driven/bug-fix） | behavior-task-suite 的 M3，需先决「LLM 生成 vs 冻结片段」；且是 M2 最小效应量的**前置** |

---

## 三、核心设计

### 3.1 职责划分

新增纯函数模块 `core/promotion-gate.ts`，`crsi-modify.ts` 只负责「编排」，晋升决策全部收敛到 promotion-gate：

```typescript
// promotion-gate.ts
export interface PromotionContext {
  changeSet: string[] // = proposal.blastRadius（变更文件集）
  kind: 'lesson' | 'managed-rule' | 'prose' // producer 路径
  baselineScore: number // 改前 eval 分数
  postScore: number // 改后 eval 分数
}

export interface PromotionDecision {
  approved: boolean
  causal: boolean // 是否可标因果（单组件变更）
  reasons: string[] // 拒绝理由（approved=false 时非空）
  record: PromotionRecord // 无论通过与否都写入 ledger
}

export function evaluatePromotion(ctx: PromotionContext): PromotionDecision
```

### 3.2 四道检查

| #   | 检查       | 判定                                             | 说明                                               |
| --- | ---------- | ------------------------------------------------ | -------------------------------------------------- |
| ①   | 不退化     | `postScore >= baselineScore`，否则 reject        | 保留现状闸门，fail-closed                          |
| ②   | 因果归因   | `causal = changeSet.length === 1`                | **记录性**，不直接 reject；多组件标 `causal:false` |
| ③   | 最小效应量 | 仅 `kind==='prose'` 时要求 `delta >= MIN_EFFECT` | 改进类改动须越过最小效应，否则 reject（M2）        |
| ④   | 误提升预算 | `campaign.remainingBudget > 0`，否则 reject      | campaign 级 alpha，防穷举（M3）                    |

> ② 是「记录性」而非「决策性」：它把「分数变化」是否可归因到「单组件」写进 ledger，为后续 M2/M3 提供数据基础。决策性的因果归因（多组件必须拆单组件才能标因果）留作后续扩展。

### 3.3 晋升 ledger

`~/.mipham/crsi/promotions.jsonl`（append-only，同 `eval-scores.jsonl` 风格）：

```typescript
interface PromotionRecord {
  id: string
  timestamp: string
  changeSet: string[]
  kind: string
  baselineScore: number
  postScore: number
  delta: number
  causal: boolean
  outcome: 'approved' | 'rejected'
  reasons: string[]
}
```

**失败也记录**（outcome=rejected），供复盘「为什么这次晋升被拒」。

### 3.4 数据流

```
runCrsiModification(proposal)
  ├─ validateBlastRadius（现有，不变）
  ├─ worktree → 改文件 → 跑测试（现有，不变）
  ├─ runEval() → evalReport.score（现有，不变）
  ├─ 【新】evaluatePromotion({ changeSet, kind, baselineScore, postScore })
  │      ├─ ①不退化 ②因果归因 ③最小效应量(M2) ④误提升预算(M3)
  │      └─ 写 promotions.jsonl（通过/拒绝都写）
  └─ approved ? 暂存 pending 待人工 approve : rollback
```

---

## 四、里程碑

| 里程碑 | 内容                                       | 交付物                                             | 依赖                                     |
| ------ | ------------------------------------------ | -------------------------------------------------- | ---------------------------------------- |
| **M1** | 晋升门框架：不退化 + 因果归因 + ledger     | `promotion-gate.ts` + 测试 + `crsi-modify.ts` 接线 | 无（立即可做）                           |
| M2     | 最小效应量                                 | 最小效应检查 + 测试                                | behavior-task-suite M3（第二层任务表现） |
| M3     | 误提升预算（campaign 级 alpha + 块不相交） | campaign state + 测试                              | M1                                       |
| M4     | 原子激活（manifest + 指针 CAS）            | manifest + 测试                                    | M1                                       |

---

## 五、M1 详细实施步骤

> M1 是本次计划的完整实现范围：纯函数 + 测试 + 接线，约 4 个文件改动，不依赖任何未决事项。

### Task 1 — `core/promotion-gate.ts`（纯函数）

**Files:**

- Create: `apps/cli/src/core/promotion-gate.ts`

**Interfaces:**

- Consumes: 无（纯函数，ledger 写 `~/.mipham/crsi/promotions.jsonl`）
- Produces: `PromotionContext` / `PromotionDecision` / `PromotionRecord` / `evaluatePromotion()` / `appendPromotion()` / `getPromotionHistory()`

**核心逻辑（①不退化 + ②因果归因 + ledger，③④ 留 seam）：**

```typescript
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs'

const PROMOTIONS_FILE = join(homedir(), '.mipham', 'crsi', 'promotions.jsonl')

export function evaluatePromotion(ctx: PromotionContext): PromotionDecision {
  const delta = ctx.postScore - ctx.baselineScore
  const reasons: string[] = []
  const causal = ctx.changeSet.length === 1 // ② 因果归因

  // ① 不退化（fail-closed）
  if (delta < 0) reasons.push(`退化: ${ctx.baselineScore} → ${ctx.postScore} (${delta})`)

  // ③ 最小效应量（M2 seam）：kind==='prose' 且 delta < MIN_EFFECT → reject
  // ④ 误提升预算（M3 seam）：campaign.remainingBudget <= 0 → reject

  const record: PromotionRecord = {
    id: `promotion-${Date.now().toString(36)}`,
    timestamp: new Date().toISOString(),
    changeSet: ctx.changeSet,
    kind: ctx.kind,
    baselineScore: ctx.baselineScore,
    postScore: ctx.postScore,
    delta,
    causal,
    outcome: reasons.length === 0 ? 'approved' : 'rejected',
    reasons,
  }
  appendPromotion(record) // 通过/拒绝都写

  return { approved: reasons.length === 0, causal, reasons, record }
}
```

**验证点**：`delta<0` → `approved:false`；`delta>=0` → `approved:true`；`causal` 随 `changeSet.length` 正确切换。

### Task 2 — `test/core/promotion-gate.test.ts`

**Files:**

- Create: `apps/cli/test/core/promotion-gate.test.ts`

**四个 ground-truth case：**

1. 退化 → reject（`baseline=80, post=78` → `approved:false`）
2. 不退化 → approve（`baseline=80, post=82` → `approved:true`）
3. 单组件 → `causal:true`（`changeSet:['a.ts']`）
4. 多组件 → `causal:false`（`changeSet:['a.ts','b.ts']`）
5. ledger 追加可读回（临时 dir，断言 `promotions.jsonl` 有一行合法 JSON）

**验证点**：`cd apps/cli && pnpm vitest run test/core/promotion-gate.test.ts` 全绿。

### Task 3 — 接线 `crsi-modify.ts`

**Files:**

- Modify: `apps/cli/src/core/crsi-modify.ts`

**把现有这段替换为：**

```typescript
const evalReport = runEval()
const last = getLastEvalScore()
const decision = evaluatePromotion({
  changeSet: proposal.blastRadius ?? [],
  kind: proposal.kind ?? 'lesson', // 透传，见 Task 4
  baselineScore: last ?? evalReport.score,
  postScore: evalReport.score,
})
if (!decision.approved) {
  sandbox.rollback()
  applied.phase = 'failed'
  applied.error = `Promotion rejected: ${decision.reasons.join('; ')}`
  return applied
}
appendEvalScore(evalReport)
```

**验证点**：`pnpm test` 全量通过；手跑 `/crsi modify` 一个退化 proposal 被拒且返回理由。

### Task 4 — `kind` 字段透传（最小改动）

**Files:**

- Modify: `apps/cli/src/core/crsi-modify.ts`（`CrsiProposal` 加 `kind?`）
- Modify: `apps/cli/src/core/crsi-producer.ts`（三条路径标 kind）

**映射**：`produceCrsiProposal → 'lesson'`、`produceRuleProposal → 'managed-rule'`、`produceProseProposal → 'prose'`。

M1 阶段 `kind` 只进 ledger 存档，不参与决策（③④ 是 M2/M3）。

**验证点**：producer 三路径的 `kind` 正确，进 ledger 后可区分。

### Task 5 — 版本对齐 + 全量回归

**验证点**：

- `cd apps/cli && pnpm typecheck` 0 error
- `cd apps/cli && pnpm test` 全绿
- 更新 CLAUDE.md 版本 + 测试数对齐
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`

---

## 六、M2–M4 简纲（后续阶段，不展开）

- **M2 最小效应量**：`kind==='prose'` 时要求 `delta >= MIN_EFFECT`（建议 `MIN_EFFECT = 1 个契约翻转`）。
  **前置依赖**：behavior-task-suite 的第二层「任务表现」（`test-driven`/`bug-fix`）。**关键原因**：现有 21 契约是「机制自检 + 约束行为」，改 skill 散文（prose）**不直接影响这些契约的分数**（delta 恒为 0），因此「最小效应量」在第二层行为任务落地前**无从度量**。
- **M3 误提升预算**：`CampaignState { id, alphaBudget, attempts }`，每次晋升消耗 1 点，耗尽即止；不同 campaign 的预算不相交（块不相交）。
- **M4 原子激活**：`active-promotion.json` 用「写临时文件 + rename」原子替换，读者要么见旧要么见新。

---

## 七、风险与开放问题

1. **【开放】`MIN_EFFECT` 具体阈值**：M2 的最小效应量是「1 个契约翻转」还是「+X 分」？取决于第二层行为任务的契约粒度，需在 M2 启动时定。
2. **【开放】campaign 的 alpha 预算数值**：M3 的预算值（如「每 campaign 5 次晋升」）需要根据实际晋升频率调参。
3. **【已决】`kind` 字段**：三值（lesson/managed-rule/prose）覆盖 producer 三条路径，M1 只存档不决策。
4. **【风险】ledger 增长**：`promotions.jsonl` append-only，长期可能膨胀。参考 `eval-scores.jsonl` 的现状（未清理），暂不引入 GC，后续按需。
5. **【风险】PROTECTED_PATHS 自指**：`promotion-gate.ts` 若不在 `PROTECTED_PATHS` 里，CRSI 自改进可能改它（评估器被改 = Goodhart 元劫持）。**需在实施时把 `promotion-gate.ts` 加入 `PROTECTED_PATHS`**（与 `eval-harness.ts`、`crsi-sandbox.ts` 同级）。

---

## 八、关键约束（务必遵守）

1. **人类手动实施**：`eval-harness.ts` 和 `crsi-modify.ts` 都在 `PROTECTED_PATHS` 里——本计划由人类手动改，不能走 CRSI 自改进（评估器不能被自己改，Goodhart 防护）。
2. **A1 铁律不破**：晋升判定一律确定性布尔表达式，零 LLM 裁判。
3. **blastRadius 不放松**：晋升门复用现有 `blastRadius` 做 `changeSet`，不另造一套变更追踪。
4. **新增 `promotion-gate.ts` 加入 `PROTECTED_PATHS`**（见风险 5）。

---

## Self-Review 记录

- **教训覆盖**：eval-rigor 教训四项（因果归因/误提升预算/最小效应量/原子激活）→ M1（①②）/M2（③）/M3（④之一）/M4（④之二）；①不退化是现状闸门的保留，②因果归因 M1 是记录性、决策性留扩展。
- **非目标边界**：改进率优化目标（borrow-analysis）与 RewardFn 接口（crsi-design）显式排除，避免范围蔓延。
- **依赖诚实标注**：M2 最小效应量**明确依赖** behavior-task-suite M3，不假装可以独立做——这是本计划最重要的「可落地性」判断。
- **占位符扫描**：MIN_EFFECT 阈值、alpha 预算值标为【开放】，未硬编码臆断值。
