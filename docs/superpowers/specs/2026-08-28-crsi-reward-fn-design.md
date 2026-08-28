# CRSI RewardFn 接口设计

> **日期**: 2026-08-28
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: reward function = policy→feedback 接口抽象（OpenRSI/Godel 借鉴，仅借概念）；ScoreReport = 奖励函数统一输出的「分数」形状；机制哨兵 = `runEval()`（冻结契约评当前仓库机制代码）；任务表现 = `runTaskPerformance()`（LLM 生成 + 冻结测试）；可插拔 gate = `runCrsiModification` 的「分数不退化」闸接受任意 RewardFn
> **前情**: 承接 [[2026-08-28-crsi-semantic-boundary-design]]（语义边界已落地，剩 RewardFn / Crossover 两真缺口）；教训 `crsi-lessons.md` `crsi-design`（line 121：该抄的是「reward function = policy→feedback」接口抽象 → `/crsi eval` 的 evaluate 抽成 RewardFn 接口）

---

## 一、背景与动机

独立轨 5 项读码核实后，剩 2 真缺口：RewardFn 接口 / Crossover。本 spec 落地 RewardFn。

现状是**三个评估函数各说各话、无统一接口**：

| 评估函数                                              | 形状                                                         | LLM | 目标                             |
| ----------------------------------------------------- | ------------------------------------------------------------ | --- | -------------------------------- |
| `runEval()`（eval-harness.ts:93）                     | `EvalReport{total,passed,score,results,failures}`            | ❌  | 33 冻结契约评当前仓库机制代码    |
| `runTaskPerformance(llm)`（task-performance.ts:97）   | `TaskPerformanceReport{total,passed,score,results,failures}` | ✅  | skill + LLM 编码行为（冻结测试） |
| `buildImprovementReport()`（improvement-track.ts:54） | `ImprovementReport{verdict,deltaMean,...}`                   | ❌  | before/after skill 改进 delta    |

前两者形状**完全一致**（`total/passed/score/results/failures`），却硬编码在两个独立函数里。「分数不退化」闸（crsi-modify.ts:99-110）硬编码调 `runEval()`，无法换用其他奖励源。

教训 `crsi-design`：自改进环的「verify」应抽象为 `reward function = policy→feedback`——把「给一个 policy 打分」抽成统一接口，让循环能对任意奖励源一视同仁地「比分数、判退化」。这是「改进率当优化目标」（OpenRSI 方向）的前置地基：先有可枚举、可替换的 RewardFn，才能谈「优化哪个 reward」。

---

## 二、目标与非目标

**目标**：

1. 定义 `RewardFn` 接口 + `ScoreReport` 统一分数形状（`core/reward-fn.ts`）。
2. `runEval`（机制哨兵）与 `runTaskPerformance`（任务表现）各包成 `RewardFn` conform。
3. 注册表 `listRewardFns()` 可枚举全部奖励函数。
4. `runCrsiModification` 的「分数不退化」闸接受 `RewardFn`（可插拔 gate）。
5. 分数台账按 reward-fn 名键控（防跨尺度误判退化）。
6. `/crsi eval` 变奖励仪表盘（列注册表 + 默认跑机制哨兵 + `--reward` 跑指定）。

**非目标**：

- ❌ 统一 `buildImprovementReport` 进 RewardFn——它是 verdict 形状（`improved/regressed/inconclusive`），是**消费**前两者 delta 的判定器，不是并列的「奖励源」，不强制 conform。
- ❌ 改「改进率当优化目标」（OpenRSI 方向）——本 spec 只铺接口地基，不做 optimize-against-reward 循环。
- ❌ 默认把任务表现接进 gate——任务表现回归已由改进轨的 pending verdict 闸（`shouldBlockApproval`）处理；gate 默认仍是机制哨兵，`rewardFn` 是「留缝可换」的能力。
- ❌ 改 `runEval` 的 33 条契约或 `runTaskPerformance` 的判定逻辑——只包接口，不动实现。

---

## 三、核心设计

### 3.1 接口 `RewardFn` + 统一形状 `ScoreReport`

新增 `apps/cli/src/core/reward-fn.ts`：

```typescript
import type { Llm } from '../providers/llm'
import { runEval } from './eval-harness'
import { runTaskPerformance } from './task-performance'

/** 奖励函数统一输出的「分数」形状——所有 RewardFn 的 evaluate 都产出它。 */
export interface ScoreReport {
  total: number
  passed: number
  score: number // 0-100
  failures: string[]
}

/**
 * 奖励函数（reward function = policy→feedback）：
 * 一个具名、可替换的「打分器」。自改进环的 verify 阶段消费它，
 * 用 `evaluate()` 拿分数、与上次记录比、判退化。
 */
export interface RewardFn {
  name: string // 唯一键，如 'mechanism-sentinel' | 'task-performance'
  description: string
  evaluate(): Promise<ScoreReport> | ScoreReport // 同步（无 LLM）或异步（有 LLM）皆可
}
```

`EvalReport` 与 `TaskPerformanceReport` 都是 `ScoreReport` 的**结构超集**（多了 `results` 明细），无需改形状即可赋值给 `ScoreReport`。接口只保留「分数」最小形状——`results` 是各评估器私有（仪表盘需要明细时直调具体函数，不走接口）。

### 3.2 两个实现 + 注册表

```typescript
/** 机制哨兵：33 冻结契约评当前仓库机制代码（无 LLM，同步）。 */
export function mechanismSentinel(): RewardFn {
  return {
    name: 'mechanism-sentinel',
    description: '冻结契约评当前仓库机制代码（无 LLM）',
    evaluate: () => runEval(),
  }
}

/** 任务表现：LLM 生成代码 + 冻结测试判定（有 LLM，异步）。 */
export function taskPerformanceRewardFn(llm: Llm): RewardFn {
  return {
    name: 'task-performance',
    description: 'LLM 生成 + 冻结测试评 skill/通用任务',
    evaluate: () => runTaskPerformance(llm),
  }
}

/** 可枚举的奖励函数注册表。llm 缺省时只含无 LLM 的机制哨兵。 */
export function listRewardFns(llm?: Llm): RewardFn[] {
  return [mechanismSentinel(), ...(llm ? [taskPerformanceRewardFn(llm)] : [])]
}
```

依赖方向（无运行时环）：

```
reward-fn.ts ──value──▶ eval-harness.ts (runEval)
reward-fn.ts ──value──▶ task-performance.ts (runTaskPerformance)
crsi-modify.ts ──▶ reward-fn.ts (mechanismSentinel, RewardFn)
crsi-modify.ts ──▶ eval-harness.ts (appendEvalScore, getLastEvalScore)
```

`reward-fn.ts` 是「接口 + 工厂 + 注册表」的单一 hub；`eval-harness.ts` 仍是纯「机制哨兵评估器」，不反向 import reward-fn。

### 3.3 可插拔 gate（`crsi-modify.ts`）

`runCrsiModification` 加可选 `opts.rewardFn`，默认 `mechanismSentinel()`。闸从硬编码 `runEval()` 改为 `await rewardFn.evaluate()`：

```typescript
export async function runCrsiModification(
  proposal: CrsiProposal,
  sandbox: CrsiSandbox = new CrsiSandbox(),
  opts?: { rewardFn?: RewardFn },
): Promise<CrsiModificationResult> {
  // blastRadius → worktree → apply → tests（前 4 阶段不变，仍同步）
  // ...

  // Eval harness gate：奖励分数不得低于上次记录（防跨合并退化）。
  const rewardFn = opts?.rewardFn ?? mechanismSentinel()
  const report = await rewardFn.evaluate()
  const last = getLastEvalScore(rewardFn.name)
  if (last !== null && report.score < last) {
    sandbox.rollback()
    applied.phase = 'failed'
    applied.error = `Reward regression (${rewardFn.name}): score ${report.score} < last ${last}`
    return applied
  }
  appendEvalScore(rewardFn.name, report)
  // ...
}
```

**签名代价（本 spec 明确认可）**：`runCrsiModification` 从 sync → **async**。这是「换用任务表现（异步 LLM）」的诚实代价——不 async 就无法把异步奖励源塞进同步 gate。波及：

- `commands.ts` 4 个调用点（crsiModifyCmd + crsiProposeCmd 的 --prose/--rule/教训路径，全在 async handler 内，加 `await`）。
- `crsi-modify.test.ts` 5 个调用点（加 `await` + 测试体 async）。

### 3.4 分数台账按名键控（`eval-harness.ts`）

`appendEvalScore` / `getLastEvalScore` 加 `name` 参数，写入 `{name, timestamp, score, passed, total}`：

```typescript
export function appendEvalScore(
  name: string,
  report: { score: number; passed: number; total: number },
): void {
  /* 写入 {name, timestamp, score, passed, total} */
}

export function getLastEvalScore(name: string): number | null {
  /* 读该 name 最近一条 score */
}
```

**必要性**：机制哨兵（0-100 契约）与任务表现（0-100 编码）分数尺度不同，混在同一台账会把「100→40」误判成退化。键控是「可插拔」的正确性前提，非可选项。

**台账文件不变**（`~/.mipham/crsi/eval-scores.jsonl`），仅记录体多一个 `name` 字段——旧无 name 记录读时 `name` 为 undefined，与任何具名查询都不匹配，自然隔离。

**参数用内联结构类型**（`{score, passed, total}`）而非 import `ScoreReport`——避免 eval-harness → reward-fn 的反向依赖（哪怕是 type-only），保持依赖无环。任何 `ScoreReport`/`EvalReport`/`TaskPerformanceReport` 都结构赋值兼容。

### 3.5 `/crsi eval` 奖励仪表盘（`commands.ts`）

```typescript
const crsiEvalCmd: CommandHandler = async (ctx, args) => {
  const rewardIdx = args.indexOf('--reward')
  const rewardName = rewardIdx >= 0 ? args[rewardIdx + 1] : undefined

  if (rewardName) {
    const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
    const fns = listRewardFns(llm)
    const fn = fns.find((f) => f.name === rewardName)
    if (!fn) {
      return {
        content: `❌ 未知 reward: ${rewardName}。可用: ${fns.map((f) => f.name).join(', ')}`,
      }
    }
    const report = await fn.evaluate()
    appendEvalScore(fn.name, report)
    return {
      content: `得分 **${report.score}/100** (${report.passed}/${report.total})\n失败: ${report.failures.join(', ') || '无'}`,
    }
  }

  // 默认：机制哨兵全量表 + 注册表清单
  const report = runEval()
  appendEvalScore('mechanism-sentinel', report)
  const fns = listRewardFns()
  // … 现有全量结果表不变 …
  // … 追加「奖励函数注册表」段：列出 fns 的 name + description …
}
```

- **默认**：行为与现状一致（机制哨兵全量结果表），额外打印注册表清单（让抽象可见）。
- **`--reward <name>`**：跑指定奖励函数（任务表现 = 通用任务，需 llm）。分数视图（无 per-task 明细——明细在 `/crsi bench`）。

---

## 四、语义边界闭环（关键一致性）

`reward-fn.ts` 是**评估器抽象**（包装 runEval / runTaskPerformance），按语义边界 spec 的原则「新增机制文件必须进保护域」，本 spec 把它加进：

1. `PROTECTED_ROLES.evaluator`（crsi-sandbox.ts 三类清单）。
2. `PROTECTED_CRITICAL_FILES`（金丝雀清单，同文件）。

否则「改掉 reward 抽象 = 改掉评分标准」的 Goodhart 面会漏保护，且 `protection-completeness` 契约的完整性意义被削弱（reward-fn 是 grader，不进金丝雀 = 金丝雀没盯住它）。

---

## 五、A1 铁律边界

本 spec 零 LLM 判定：接口/注册表/gate/台账键控全是类型 + 确定性算术（比较分数、字符串匹配 name）。`runTaskPerformance` 内部仍是「LLM 生成 + 冻结测试判定」，只是被包成 RewardFn——判定者不变（冻结测试），RewardFn 只是换了个调用壳。

---

## 六、里程碑

| 里程碑 | 内容                                                                                      | 交付物             |
| ------ | ----------------------------------------------------------------------------------------- | ------------------ |
| **R1** | `reward-fn.ts`（接口 + 两工厂 + 注册表）+ 进 `PROTECTED_ROLES`/`PROTECTED_CRITICAL_FILES` | 纯新增，build 全绿 |
| **R2** | `runCrsiModification` async + `opts.rewardFn` + 台账键控 + 4 调用点 await                 | gate 可插拔        |
| **R3** | `/crsi eval` 仪表盘（注册表清单 + `--reward`）                                            | 抽象可见可跑       |

R2 依赖 R1（`mechanismSentinel`/`RewardFn` 导出）；R3 依赖 R1（`listRewardFns`）。

---

## 七、测试

- **接口形状**：`mechanismSentinel().evaluate()` 返回的 `score === runEval().score`；`taskPerformanceRewardFn(mockLlm).name === 'task-performance'`。
- **注册表**：`listRewardFns()` 无 llm 只含机制哨兵；有 llm 含两者（mock llm）。
- **conform 类型**：`EvalReport` / `TaskPerformanceReport` 结构赋值给 `ScoreReport`（编译期，隐式测）。
- **gate 可插拔**：注入返回低分的 mock RewardFn → gate rollback（phase failed）；注入高分的 → 通过。默认（不传）仍走机制哨兵。
- **台账键控隔离**：`appendEvalScore('a', 80)` + `appendEvalScore('b', 40)` → `getLastEvalScore('a')===80`、`getLastEvalScore('b')===40`、`getLastEvalScore('c')===null`。
- **语义边界**：`isProtectedPath('apps/cli/src/core/reward-fn.ts')===true`；`PROTECTED_CRITICAL_FILES` 含 reward-fn.ts；`protection-completeness` 契约仍 PASS（eval total 33→不变，因 reward-fn 进的是现有金丝雀，不新增契约条数）。
- **无回归**：现有 1957 测试全绿（R2 的 5 个 crsi-modify 测试 + 2 个 eval-harness 台账测试改签名后仍绿）。

---

## 八、风险与开放问题

1. **【async 波纹】** `runCrsiModification` sync → async 波及 9 处（4 调用点 + 5 测试）。缓解：全在 async handler/测试内，机械加 `await`；typecheck 会抓漏改。**这是「换用异步奖励源」的必然代价，本 spec 明确认可。**
2. **【台账旧数据】** 旧 `eval-scores.jsonl` 记录无 `name` 字段，`getLastEvalScore(name)` 读不到 → 首次跑任何具名查询都返回 null（视为「无基线，不判退化」）。可接受：从零重建基线，无破坏。
3. **【仪表盘与 /crsi bench 重叠】** `--reward task-performance` 与 `/crsi bench` 功能重叠，且前者无 per-task 明细。缓解：仪表盘默认不跑任务表现（只列清单）；`--reward` 是「让插槽可跑」的薄能力，明细仍归 `/crsi bench`。
4. **【buildImprovementReport 不 conform】** 它是 verdict 形状（消费 delta），不是奖励源，故不进 RewardFn。若未来「改进率当优化目标」需要把改进判定也当 reward，再考虑把 verdict 归一成 score 或加 `RewardFn` 变体——本 spec 不做。
5. **【命名】** `appendEvalScore`/`getLastEvalScore` 保留原名（虽加了 name 键），避免改名噪声；「EvalScore」仍指「评估分数」，语义未漂移。

---

## 九、决策记录（岔路口）

| # | 岔路口 | 选项 | 选了 | 为何（否决项理由） | 推迟的 | 回访触发 |
| --- | --- | --- | --- | --- | --- |
| 1 | gate 支持异步 | A async 签名 / B 只支持同步 RewardFn | A | B 无法「换用任务表现」（异步 LLM），违背选项 3 的明确意图；A 是诚实代价，波纹可控 | — | — |
| 2 | 台账键控 | A 按 name 键控 / B 单账不分键 | A | B 会把机制哨兵(契约)与任务表现(编码)分数混比 → 假退化；A 是可插拔的正确性前提 | — | — |
| 3 | 台账参数类型 | A 内联结构 / B import ScoreReport | A | B 造 eval-harness→reward-fn 反向依赖（环）；A 结构兼容、零依赖 | — | — |
| 4 | buildImprovementReport 是否 conform | A 统一 / B 不统一 | B | 它是 verdict 消费器非奖励源；硬统一需把 verdict 归一成 score，过度工程 | 归一 verdict→score | 改进率当优化目标时 |
| 5 | 任务表现默认接 gate | A 默认接 / B 留缝不接 | B | 改进轨 pending verdict 已拦任务表现 regressed；默认接=LLM 双跑；gate 默认机制哨兵，`rewardFn` 是能力非默认 | — | 需要 gate 直接拦任务表现时 |
| 6 | 仪表盘跑全部 reward | A 默认全跑 / B 默认只跑机制哨兵 + 列清单 | B | A 让 /crsi eval 变慢（LLM）且与 /crsi bench 重叠；B 抽象可见又不拖慢 | 全跑 | 需要一次看全 reward 分数时 |

---

## Self-Review 记录

- **接口一致性**：`RewardFn.evaluate(): Promise<ScoreReport> | ScoreReport`（sync/async 皆可）；`mechanismSentinel` 同步、`taskPerformanceRewardFn` 异步，皆结构赋值到返回类型（§3.1）。
- **无运行时环**：reward-fn → eval-harness/task-performance（value），反向仅 crsi-modify/commands（消费者），eval-harness 不 import reward-fn（台账用内联类型）（§3.2/§3.4）。
- **语义边界闭环**：reward-fn.ts 进 `PROTECTED_ROLES.evaluator` + `PROTECTED_CRITICAL_FILES`（§四），不新增 eval 契约条数。
- **A1 不破**：零 LLM 判定，全确定性算术/类型（§五）。
- **诚实边界**：async 波纹是「换用异步奖励源」的代价，明确认可（§八.1）；仪表盘默认不跑 LLM 源（§八.3）；buildImprovementReport 不 conform 是刻意（§八.4）。
- **无占位符**：接口、两工厂、注册表、gate 代码、台账签名、命令行为均给具体实现。
