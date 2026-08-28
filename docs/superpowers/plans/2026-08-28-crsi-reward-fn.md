# CRSI RewardFn 接口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/crsi eval` 的评估抽成 `RewardFn` 接口（reward function = policy→feedback），让 `runEval`/`runTaskPerformance` conform 成可枚举、可替换的奖励函数，并把 `runCrsiModification` 的「分数不退化」闸改成可插拔 gate + 台账按名键控。

**Architecture:** 新增 `core/reward-fn.ts` 作为「接口 + 工厂 + 注册表」单一 hub（import `runEval`/`runTaskPerformance`，不反向被 import）。`runCrsiModification` 从 sync → async，闸 `await rewardFn.evaluate()` 后与 `getLastEvalScore(rewardFn.name)` 比较。台账 `appendEvalScore`/`getLastEvalScore` 加 `name` 键，参数用内联结构类型（避免 eval-harness → reward-fn 反向依赖）。

**Tech Stack:** Bun、Vitest 3、TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-08-28-crsi-reward-fn-design.md`

## Global Constraints

- 依赖无环：`eval-harness.ts` 不 import `reward-fn`（台账参数用内联 `{score, passed, total}`，不用 `ScoreReport`）。
- `runEval` 的 33 条契约不动（eval `report.total` 保持 33，不新增契约条数）。
- `reward-fn.ts` 进 `PROTECTED_ROLES.evaluator` + `PROTECTED_CRITICAL_FILES`（同文件 `crsi-sandbox.ts` 两处一起加）。
- A1 铁律：零 LLM 判定——接口/注册表/gate/台账键控全是类型 + 确定性算术。
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`。
- 测试：`cd apps/cli && pnpm vitest run <file>`；typecheck：`cd apps/cli && pnpm typecheck`；全量：`cd apps/cli && pnpm test`。

## Reconciliation（spec 与现状的出入，实现者必读）

1. **eval 契约数**：spec §七写「eval total 33→不变」——正确。eval-harness 已有 33 条结果，本 plan 不新增契约。`reward-fn.ts` 进金丝雀后 `protection-completeness` 契约仍 PASS（金丝雀 ⊆ 保护域，`isProtectedPath(reward-fn.ts)` 为 true）。
2. **`runEval` 的调用次数**：Task 1 的 reward-fn.test.ts 会用 `runEval()` 做「委托」断言（比 `mechanismSentinel().evaluate()` 的 score/total 是否等于 `runEval()`），`runEval` 是确定性的（隔离组件 + 冻结契约），多次调用无副作用。

---

## File Structure

| 文件                                      | 动作   | 职责                                                                                                   |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `apps/cli/src/core/reward-fn.ts`          | Create | Task 1：`ScoreReport` + `RewardFn` + `mechanismSentinel` + `taskPerformanceRewardFn` + `listRewardFns` |
| `apps/cli/src/core/crsi-sandbox.ts`       | Modify | Task 1：reward-fn.ts 进 `PROTECTED_ROLES.evaluator` + `PROTECTED_CRITICAL_FILES`                       |
| `apps/cli/test/core/reward-fn.test.ts`    | Create | Task 1：接口/注册表/语义保护断言                                                                       |
| `apps/cli/test/core/crsi-sandbox.test.ts` | Modify | Task 1：`newlyProtected` 加 reward-fn.ts                                                               |
| `apps/cli/src/core/eval-harness.ts`       | Modify | Task 2：`appendEvalScore`/`getLastEvalScore` 加 `name` 键                                              |
| `apps/cli/src/core/crsi-modify.ts`        | Modify | Task 2：async + `opts.rewardFn` 可插拔 gate                                                            |
| `apps/cli/src/ui/commands.ts`             | Modify | Task 2：4 调用点 `await`；Task 3：`/crsi eval` 仪表盘                                                  |
| `apps/cli/test/core/crsi-modify.test.ts`  | Modify | Task 2：5 调用点 `await` + 2 个 gate 可插拔测试                                                        |
| `apps/cli/test/core/eval-harness.test.ts` | Modify | Task 2：台账测试签名 + 名键控隔离测试                                                                  |

---

## Task 1: `reward-fn.ts` 接口 + 注册表 + 语义保护注册

**Files:**

- Create: `apps/cli/src/core/reward-fn.ts`
- Modify: `apps/cli/src/core/crsi-sandbox.ts`
- Test: `apps/cli/test/core/reward-fn.test.ts`（新建）
- Test: `apps/cli/test/core/crsi-sandbox.test.ts`

**Interfaces:**

- Consumes: `runEval`（eval-harness.ts）、`runTaskPerformance`（task-performance.ts）、`Llm`（providers/llm.ts）
- Produces:
  - `export interface ScoreReport { total: number; passed: number; score: number; failures: string[] }`
  - `export interface RewardFn { name: string; description: string; evaluate(): Promise<ScoreReport> | ScoreReport }`
  - `export function mechanismSentinel(): RewardFn`
  - `export function taskPerformanceRewardFn(llm: Llm): RewardFn`
  - `export function listRewardFns(llm?: Llm): RewardFn[]`

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/reward-fn.test.ts`（新建）：

```typescript
import { describe, it, expect } from 'vitest'
import { mechanismSentinel, taskPerformanceRewardFn, listRewardFns } from '../../src/core/reward-fn'
import { runEval } from '../../src/core/eval-harness'
import { isProtectedPath, PROTECTED_CRITICAL_FILES } from '../../src/core/crsi-sandbox'
import type { Llm } from '../../src/providers/llm'

describe('reward-fn 接口', () => {
  it('mechanismSentinel 同步评估 = runEval 的分数', async () => {
    const fn = mechanismSentinel()
    expect(fn.name).toBe('mechanism-sentinel')
    const report = await fn.evaluate()
    const expected = runEval()
    expect(report.score).toBe(expected.score)
    expect(report.total).toBe(expected.total)
  })

  it('taskPerformanceRewardFn 具名 task-performance', () => {
    const fn = taskPerformanceRewardFn({} as Llm)
    expect(fn.name).toBe('task-performance')
  })

  it('listRewardFns 无 llm 只含机制哨兵；有 llm 含两者', () => {
    expect(listRewardFns().map((f) => f.name)).toEqual(['mechanism-sentinel'])
    expect(listRewardFns({} as Llm).map((f) => f.name)).toEqual([
      'mechanism-sentinel',
      'task-performance',
    ])
  })

  it('reward-fn.ts 已被语义保护（grader 抽象）', () => {
    expect(isProtectedPath('apps/cli/src/core/reward-fn.ts')).toBe(true)
    expect(PROTECTED_CRITICAL_FILES).toContain('apps/cli/src/core/reward-fn.ts')
  })
})
```

`apps/cli/test/core/crsi-sandbox.test.ts` 的 `newlyProtected` 数组（约 line 358）追加一行：

```typescript
      'apps/cli/src/core/reward-fn.ts',
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/reward-fn.test.ts test/core/crsi-sandbox.test.ts`
Expected: FAIL（`reward-fn` 模块不存在；`isProtectedPath(reward-fn.ts)` 为 false；`PROTECTED_CRITICAL_FILES` 不含 reward-fn.ts）。

- [ ] **Step 3: 实现 `reward-fn.ts`**

`apps/cli/src/core/reward-fn.ts`（新建）：

```typescript
// CRSI RewardFn 接口——reward function = policy→feedback 抽象。
// 统一「给一个 policy 打分」：机制哨兵（runEval）与任务表现（runTaskPerformance）
// 都 conform 成 RewardFn，自改进环的 verify 阶段可对任意奖励源比分数、判退化。
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

/** 奖励函数（reward function = policy→feedback）：一个具名、可替换的打分器。 */
export interface RewardFn {
  name: string
  description: string
  evaluate(): Promise<ScoreReport> | ScoreReport
}

/** 机制哨兵：冻结契约评当前仓库机制代码（无 LLM，同步）。 */
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

- [ ] **Step 4: 注册语义保护（crsi-sandbox.ts 两处）**

`apps/cli/src/core/crsi-sandbox.ts` 的 `PROTECTED_ROLES.evaluator` 数组（约 line 108-116），在 `'apps/cli/src/core/improvement-track.ts'` 之后加一行：

```typescript
    'apps/cli/src/core/reward-fn.ts',
```

`PROTECTED_CRITICAL_FILES` 数组（约 line 145-160），在 `'apps/cli/src/core/improvement-track.ts'` 之后加一行：

```typescript
  'apps/cli/src/core/reward-fn.ts',
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/reward-fn.test.ts test/core/crsi-sandbox.test.ts test/core/eval-harness.test.ts`
Expected: PASS（reward-fn 4 测试绿；crsi-sandbox 语义保护测试绿；eval-harness 仍 total 33 全 PASS）。

- [ ] **Step 6: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error。

- [ ] **Step 7: Commit**

```bash
cd apps/cli && git add src/core/reward-fn.ts src/core/crsi-sandbox.ts test/core/reward-fn.test.ts test/core/crsi-sandbox.test.ts
git commit -m "feat(crsi): RewardFn 接口——ScoreReport/RewardFn + 两工厂 + 注册表 + 语义保护

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 2: 可插拔 gate（async）+ 台账按名键控

**Files:**

- Modify: `apps/cli/src/core/eval-harness.ts`
- Modify: `apps/cli/src/core/crsi-modify.ts`
- Modify: `apps/cli/src/ui/commands.ts`
- Test: `apps/cli/test/core/eval-harness.test.ts`
- Test: `apps/cli/test/core/crsi-modify.test.ts`

**Interfaces:**

- Consumes: `mechanismSentinel`、`RewardFn`（reward-fn.ts，Task 1 产出）
- Produces:
  - `runCrsiModification(proposal, sandbox?, opts?: { rewardFn?: RewardFn }): Promise<CrsiModificationResult>`（async）
  - `appendEvalScore(name: string, report: { score: number; passed: number; total: number }): void`
  - `getLastEvalScore(name: string): number | null`

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/eval-harness.test.ts` 的 `rewards log` describe（约 line 70-79）改为：

```typescript
describe('rewards log', () => {
  it('getLastEvalScore returns null before any record', () => {
    expect(getLastEvalScore('mechanism-sentinel')).toBeNull()
  })

  it('appendEvalScore then getLastEvalScore round-trips the score', () => {
    appendEvalScore('mechanism-sentinel', { total: 10, passed: 8, score: 80 })
    expect(getLastEvalScore('mechanism-sentinel')).toBe(80)
  })

  it('ledger keyed by name isolates scores', () => {
    appendEvalScore('a', { score: 80, passed: 8, total: 10 })
    appendEvalScore('b', { score: 40, passed: 4, total: 10 })
    expect(getLastEvalScore('a')).toBe(80)
    expect(getLastEvalScore('b')).toBe(40)
    expect(getLastEvalScore('c')).toBeNull()
  })
})
```

`apps/cli/test/core/crsi-modify.test.ts`：顶部 import 加 `appendEvalScore`，5 个 `runCrsiModification` 调用加 `await`、`it` 回调解包 async，并追加两个 gate 可插拔测试（见 Step 3 完整代码）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts test/core/crsi-modify.test.ts`
Expected: FAIL（`getLastEvalScore` 不接 name；`appendEvalScore` 不接 name；crsi-modify 测试 `runCrsiModification` 返回 Promise 但断言 `.phase` 报错）。

- [ ] **Step 3: 实现**

**3a. `apps/cli/src/core/eval-harness.ts`** —— 替换 `appendEvalScore`（约 line 50-66）与 `getLastEvalScore`（约 line 69-79）：

```typescript
/** 追加一次评估分数到 rewards 日志（按奖励函数名键控）。 */
export function appendEvalScore(
  name: string,
  report: { score: number; passed: number; total: number },
): void {
  try {
    mkdirSync(join(homedir(), '.mipham', 'crsi'), { recursive: true })
    appendFileSync(
      SCORES_FILE,
      JSON.stringify({
        name,
        timestamp: new Date().toISOString(),
        score: report.score,
        passed: report.passed,
        total: report.total,
      }) + '\n',
      'utf-8',
    )
  } catch {
    // rewards 日志是非关键的——失败不影响评估本身
  }
}

/** 读取某奖励函数最近一次分数（无记录时返回 null）。旧无 name 记录自然跳过。 */
export function getLastEvalScore(name: string): number | null {
  try {
    if (!existsSync(SCORES_FILE)) return null
    const lines = readFileSync(SCORES_FILE, 'utf-8').trim().split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]!) as { name?: string; score?: number }
      if (rec.name === name && typeof rec.score === 'number') return rec.score
    }
    return null
  } catch {
    return null
  }
}
```

**3b. `apps/cli/src/core/crsi-modify.ts`**：

- import（line 18）改为：

```typescript
import { appendEvalScore, getLastEvalScore } from './eval-harness'
import { mechanismSentinel, type RewardFn } from './reward-fn'
```

- 函数签名（line 48-51）改为：

```typescript
export async function runCrsiModification(
  proposal: CrsiProposal,
  sandbox: CrsiSandbox = new CrsiSandbox(),
  opts?: { rewardFn?: RewardFn },
): Promise<CrsiModificationResult> {
```

- gate 段（约 line 99-110，注释 + `const evalReport = runEval()` 到 `appendEvalScore(evalReport)`）替换为：

```typescript
// Reward gate：奖励分数不得低于上次记录（防跨合并退化）。
// 默认机制哨兵；可插拔——调用方传 opts.rewardFn 换用其他奖励源（如任务表现）。
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
```

**3c. `apps/cli/src/ui/commands.ts`** —— 4 个 `runCrsiModification(` 调用（约 line 813 / 921 / 964 / 992）各加 `await` 前缀：

```typescript
const result = await runCrsiModification({
// ...
const result = await runCrsiModification({
// ...
const result = await runCrsiModification(proposal)
// ...
const result = await runCrsiModification(proposal)
```

**3d. `apps/cli/test/core/crsi-modify.test.ts`** 全量改 async + 追加两个测试：

- import 加：`import { appendEvalScore } from '../../src/core/eval-harness'`
- 5 个 `const result = runCrsiModification(...)` → `const result = await runCrsiModification(...)`；5 个 `it('...', () => {` → `it('...', async () => {`。

追加到 `describe('runCrsiModification', ...)` 末尾：

```typescript
it('custom rewardFn low score → gate rolls back (regression)', async () => {
  const sandbox = new CrsiSandbox()
  vi.spyOn(sandbox, 'runTests').mockReturnValue({
    passed: true,
    totalTests: 0,
    failedTests: 0,
    output: '',
  })
  appendEvalScore('custom-reward', { score: 90, passed: 9, total: 10 })
  const result = await runCrsiModification(
    {
      description: 'regress',
      filePath: WORKTREE_FILE,
      newContent: '{}',
      blastRadius: [WORKTREE_FILE],
    },
    sandbox,
    {
      rewardFn: {
        name: 'custom-reward',
        description: 'test',
        evaluate: () => ({ total: 10, passed: 0, score: 0, failures: ['all'] }),
      },
    },
  )
  expect(result.phase).toBe('failed')
  expect(result.error).toContain('Reward regression')
  expect(hasPending()).toBe(false)
})

it('custom rewardFn score >= last → passes (no regression)', async () => {
  const sandbox = new CrsiSandbox()
  vi.spyOn(sandbox, 'runTests').mockReturnValue({
    passed: true,
    totalTests: 0,
    failedTests: 0,
    output: '',
  })
  appendEvalScore('custom-reward', { score: 50, passed: 5, total: 10 })
  const result = await runCrsiModification(
    {
      description: 'good',
      filePath: WORKTREE_FILE,
      newContent: '{}',
      blastRadius: [WORKTREE_FILE],
    },
    sandbox,
    {
      rewardFn: {
        name: 'custom-reward',
        description: 'test',
        evaluate: () => ({ total: 10, passed: 8, score: 80, failures: ['a', 'b'] }),
      },
    },
  )
  expect(result.phase).toBe('passed')
  expect(hasPending()).toBe(true)
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts test/core/crsi-modify.test.ts`
Expected: PASS（台账键控 3 测试绿；crsi-modify 7 测试绿：5 原 + 2 gate 可插拔）。

- [ ] **Step 5: typecheck + 全量**

Run: `cd apps/cli && pnpm typecheck` → 0 error
Run: `cd apps/cli && pnpm test` → 全绿（无回归）。

- [ ] **Step 6: Commit**

```bash
cd apps/cli && git add src/core/eval-harness.ts src/core/crsi-modify.ts src/ui/commands.ts test/core/eval-harness.test.ts test/core/crsi-modify.test.ts
git commit -m "feat(crsi): 可插拔 gate——runCrsiModification async + opts.rewardFn + 台账按名键控

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 3: `/crsi eval` 奖励仪表盘

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`

**Interfaces:**

- Consumes: `listRewardFns`（reward-fn.ts）、`appendEvalScore`（eval-harness.ts，Task 2 键控版）
- Produces: `/crsi eval` 输出注册表清单 + 默认机制哨兵全量表；`--reward <name>` 跑指定奖励函数

- [ ] **Step 1: 改 import（line 31）**

```typescript
import { runEval, appendEvalScore } from '../core/eval-harness'
import { listRewardFns } from '../core/reward-fn'
```

- [ ] **Step 2: 重写 `crsiEvalCmd`（约 line 1004-1021）**

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

  const report = runEval()
  appendEvalScore('mechanism-sentinel', report)

  const lines: string[] = ['## 🧪 CRSI Eval Harness', '']
  lines.push(`得分: **${report.score}/100** (${report.passed}/${report.total})`, '')
  lines.push('| 任务 | 结果 |')
  lines.push('|------|------|')
  for (const r of report.results) {
    lines.push(
      `| ${r.description} | ${r.passed ? '✅' : '❌'}${r.detail ? ` — ${r.detail}` : ''} |`,
    )
  }
  if (report.failures.length > 0) {
    lines.push('', `❌ 失败任务: ${report.failures.join(', ')}`)
  }

  // 奖励函数注册表（reward function = policy→feedback 抽象可见）
  const fns = listRewardFns()
  lines.push('', '## 🎁 奖励函数注册表', '')
  for (const f of fns) {
    lines.push(`- **${f.name}** — ${f.description}`)
  }
  lines.push('', '`/crsi eval --reward <name>` 跑指定奖励函数')

  return { content: lines.join('\n') }
}
```

- [ ] **Step 3: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error（`CommandHandler` 已支持 `(ctx, args)` 参数，与 `crsiBenchCmd` 同形）。

- [ ] **Step 4: 全量回归**

Run: `cd apps/cli && pnpm test`
Expected: 全绿（无新的单元测试——仪表盘是薄渲染层，`listRewardFns` 已在 Task 1 测过）。

- [ ] **Step 5: Commit**

```bash
cd apps/cli && git add src/ui/commands.ts
git commit -m "feat(crsi): /crsi eval 奖励仪表盘——注册表清单 + --reward 跑指定奖励函数

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Self-Review

- **Spec 覆盖**：§3.1（接口）→ Task 1 Step 3；§3.2（两工厂 + 注册表）→ Task 1 Step 3；§四（语义保护）→ Task 1 Step 4；§3.4（台账键控）→ Task 2 Step 3a；§3.3（可插拔 gate + async）→ Task 2 Step 3b/3c；§3.5（仪表盘）→ Task 3 Step 2；§六/七（测试）→ 各 Task Step 1。
- **占位符扫描**：无 TBD/TODO；每步给完整可跑代码。
- **类型一致性**：`RewardFn`/`ScoreReport`/`mechanismSentinel`/`listRewardFns` 在 Task 1 定义，Task 2/3 消费同名同形；`appendEvalScore`/`getLastEvalScore` 在 Task 2 改签名，Task 3 与测试一致用 `(name, report)`。
- **依赖无环**：reward-fn → eval-harness/task-performance（value）；eval-harness 不 import reward-fn（台账用内联 `{score,passed,total}`）；crsi-modify/commands 仅消费（§Global Constraints）。
- **语义边界**：reward-fn.ts 进 `PROTECTED_ROLES.evaluator` + `PROTECTED_CRITICAL_FILES`（Task 1 Step 4），`protection-completeness` 契约仍 PASS（eval total 33 不变）。
- **Reconciliation 落实**：eval 契约数 33 不变；reward-fn.test 用 `runEval()` 做确定性委托断言（§Reconciliation）。
