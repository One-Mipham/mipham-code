# CRSI 评估治理三件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 CRSI 的验证补上「上界（捕获率）」「留出集（sealed）」「上线后可追回（probation）」三格治理能力。

**Architecture:** 先把任务电池从 6 题扩到 15 题并为每题加手写参考解，据此算 `(on−off)/(100−off)`；sealed 题池通过 `loadPerformanceTasks` 的缺省值隔离在选择路径之外；probation 作为独立模块，只在有随机信号的 skill 合并上开窗，裁定只打印不执行。

**Tech Stack:** TypeScript 5.5（strict）/ Bun / Vitest 5；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-20-crsi-eval-governance-design.md`

## Global Constraints

- **A1 铁律**：所有判定必须机器可判（冻结测试 / 确定性算术），**不得引入 LLM 裁判**。
- **破坏性 git 永不自动执行**：probation 只打印 `git revert <sha>`。
- **sealed 永不进入任何裁定**：既不进 `/crsi modify` 的闸，也不进 probation 的 verdict。
- **测试数同批回填**：任何新增测试的提交必须同批更新 `TEST_COUNT` 的**三份落盘副本**
  （`packages/shared/package-info.json`、`packages/shared/src/package-info.ts`、
  `apps/cli/src/shared/package-info.ts`）与 `CLAUDE.md` 中的对应写法，然后跑
  `test/integrity/published-counts.test.ts` 证明一致。
- **测试与 typecheck 在 `apps/cli/` 下执行**（`--root apps/cli` 不够：MCP 测试 spawn 子进程继承 cwd）；
  `lint` / `format:check` 只在**仓库根**有脚本。
- **所有 `git` 命令在仓库根执行**（`cd "$(git rev-parse --show-toplevel)"`）—— 计划里的文件路径
  都是相对仓库根的。
- 提交信息遵循 Conventional Commits；不新增依赖；注释沿用仓库的中文注释风格。

## Review Focus

1. **Provider 零文本且零 usage** —— 上层会把它读成「模型答错」，而它其实是上游/仪器故障；症状是 `off` 臂凭空掉分、捕获率分母被污染。→ 测试在 Task 1。
2. **某题的 `oracleCode` 过不了自己的 `testCode`** —— 上界不是 100，分母 `100−off` 悄悄变成一个错的数。→ 测试在 Task 2。
3. **`on` 臂有截断而 `off` 臂没有** —— 不配对比较会让捕获率虚高。→ 测试在 Task 4。
4. **skill 合并后进程退出、bench 未跑** —— 观察窗从未开启，且没有任何读数显示它是开着的。→ 测试在 Task 6。
5. **会话中途删掉一条教训** —— `InstructionsLoader` 用启动时缓存的摘要，系统提示里那条依旧在。→ 测试在 Task 8。

---

### Task 1: `uncertain` 三态（仪器故障 ≠ 答错）

**Files:**

- Modify: `apps/cli/src/core/task-performance.ts:58-69`（`TaskPerformanceResult`）、`:158-215`（`runTaskPerformance`）
- Test: `apps/cli/test/core/task-performance-uncertain.test.ts`（新建）

**Interfaces:**

- Produces: `TaskPerformanceResult.uncertain?: boolean`；`TaskPerformanceReport.uncertain: number`
- 规则：`零文本 + 无 usage ⇒ uncertain`（不进 score）；`零文本 + 有 usage ⇒ fail`（进 score）；
  `truncated` 保持既有语义（不进 score）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/cli/test/core/task-performance-uncertain.test.ts
import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import { runTaskPerformance } from '../../src/core/task-performance'

const silentLlm: Llm = {
  chat: async function* () {
    yield { type: 'stop' }
  },
}
const toastedLlm: Llm = {
  chat: async function* () {
    yield { type: 'usage', inputTokens: 7, outputTokens: 0 }
    yield { type: 'stop' }
  },
}

describe('uncertain：仪器故障与答错不同形', () => {
  it('零文本 + 无 usage ⇒ 每题 uncertain，且不计入分数', async () => {
    const r = await runTaskPerformance(silentLlm)
    expect(r.uncertain).toBe(r.total)
    expect(r.score).toBe(100) // 没有可评分的题 ⇒ 不是 0
    expect(r.results.every((x) => x.uncertain === true && x.passed === false)).toBe(true)
  })

  it('零文本 + 有 usage ⇒ 记 fail，不算 uncertain', async () => {
    const r = await runTaskPerformance(toastedLlm)
    expect(r.uncertain).toBe(0)
    expect(r.score).toBe(0)
    expect(r.results.some((x) => x.passed === false)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance-uncertain.test.ts`
Expected: FAIL —— `r.uncertain` 是 `undefined`。

- [ ] **Step 3: 实现**

`TaskPerformanceResult` 增加 `uncertain?: boolean`；`TaskPerformanceReport` 增加 `uncertain: number`。
在 `runTaskPerformance` 的 `!code` 分支里：`usageReported` 为 false 时标 `uncertain: true` 并 `continue`（不 push `passed:false` 的计分项）；
分数分母 `scored` 改为同时排除 `truncated` 与 `uncertain`；`uncertain` 计数与 `truncated` 并列返回。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance-uncertain.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: 回填计数并提交**

Run: `cd apps/cli && pnpm test 2>&1 | tail -5`，记下 passed 总数，改三份 `TEST_COUNT` 与 `CLAUDE.md`；
`pnpm vitest run test/integrity/published-counts.test.ts` 绿后：

```bash
git add apps/cli/src/core/task-performance.ts apps/cli/test/core/task-performance-uncertain.test.ts \
  packages/shared/package-info.json packages/shared/src/package-info.ts apps/cli/src/shared/package-info.ts CLAUDE.md
git commit -m "feat(crsi): 任务表现测量区分 uncertain 与 fail"
```

---

### Task 2: 题库扩到 15 题 + `oracleCode` + 完整性守卫

**Files:**

- Modify: `apps/cli/src/core/task-performance.ts:13-19`（`PerformanceTask`）
- Modify: `apps/cli/src/core/task-performance-tasks.json`（6 → 15 题）
- Test: `apps/cli/test/integrity/task-battery.test.ts`（新建）
- Modify: `apps/cli/test/core/task-performance.test.ts`（`total` 断言）

**Interfaces:**

- Produces: `PerformanceTask.oracleCode: string`（必填）

题库（15 题，`id` 固定）：

| 组               | 题 id                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 无标签（既有 5） | `perf-impl-quicksort` · `perf-impl-fibonacci` · `perf-impl-binary-search` · `perf-impl-reverse-string` · `perf-impl-max`    |
| `safe-coding`    | `perf-safe-parse-positive`（既有）+ `perf-safe-parse-int` · `perf-safe-clamp` · `perf-safe-divide` · `perf-safe-parse-bool` |
| `tdd`            | `perf-tdd-stack` · `perf-tdd-queue` · `perf-tdd-lru` · `perf-tdd-range` · `perf-tdd-chunk`                                  |

每题必须：`prompt` 只描述接口不給算法；`testCode` 覆盖至少 3 个断言（含 1 个边界）；
`oracleCode` 是**手写参考解**，必须能让该题的 `testCode` 全绿。

- [ ] **Step 1: 写失败测试**

```ts
// apps/cli/test/integrity/task-battery.test.ts
import { describe, it, expect } from 'vitest'
import { loadPerformanceTasks, judgeGeneratedCode } from '../../src/core/task-performance'

describe('任务电池完整性', () => {
  const tasks = loadPerformanceTasks() // Task 3 起改为 { pool: 'all' }

  it('共 15 题，id 唯一', () => {
    expect(tasks).toHaveLength(15)
    expect(new Set(tasks.map((t) => t.id)).size).toBe(15)
  })

  it('每题都带 oracleCode，且参考解能过自己的冻结测试', () => {
    for (const t of tasks) {
      expect(typeof t.oracleCode, t.id).toBe('string')
      expect(judgeGeneratedCode(t.testCode, t.oracleCode).passed, t.id).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/integrity/task-battery.test.ts`
Expected: FAIL —— `loadPerformanceTasks` 不接受参数 / `oracleCode` 为 `undefined` / 题数 6。

- [ ] **Step 3: 实现**

`PerformanceTask` 增加 `oracleCode: string`；`loadPerformanceTasks()` 保留无参调用（Task 3 再加 `pool`）。
按上表补齐 15 题，每题写 `oracleCode`。同步把 `test/core/task-performance.test.ts` 里
「无 skill 只跑通用任务（5 个）」的断言保持不变（无标签组仍是 5 题）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/integrity/task-battery.test.ts test/core/task-performance.test.ts`
Expected: PASS

- [ ] **Step 5: 回填计数并提交**

同 Task 1 Step 5，提交信息 `feat(crsi): 任务电池扩到 15 题并为每题加参考解`。

---

### Task 3: sealed 池（缺省 gate）

**Files:**

- Modify: `apps/cli/src/core/task-performance.ts:11-23`
- Modify: `apps/cli/test/integrity/task-battery.test.ts`
- Modify: `apps/cli/test/core/task-performance.test.ts`

**Interfaces:**

- Produces: `export type TaskPool = 'gate' | 'sealed'`
  `export function loadPerformanceTasks(opts?: { pool?: TaskPool | 'all' }): PerformanceTask[]`
  —— **缺省 `'gate'`**；`'all'` 仅测试与守卫使用。

- [ ] **Step 1: 写失败测试**

```ts
it('缺省只返回 gate 池；sealed 不在其中', () => {
  const gate = loadPerformanceTasks()
  const sealed = loadPerformanceTasks({ pool: 'sealed' })
  expect(sealed.length).toBeGreaterThanOrEqual(1)
  const gateIds = new Set(gate.map((t) => t.id))
  expect(sealed.some((t) => gateIds.has(t.id))).toBe(false)
})

it('每组 4 gate + 1 sealed', () => {
  for (const group of [undefined, 'safe-coding', 'tdd']) {
    const gate = loadPerformanceTasks().filter((t) => t.skill === group)
    const sealed = loadPerformanceTasks({ pool: 'sealed' }).filter((t) => t.skill === group)
    expect(gate).toHaveLength(4)
    expect(sealed).toHaveLength(1)
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: FAIL —— `pool` 参数被忽略，sealed 与 gate 混在一起。

- [ ] **Step 3: 实现**

在 JSON 为每组各标 1 题 `"split": "sealed"`（其余省略＝gate）；`loadPerformanceTasks` 按 `opts.pool` 过滤，缺省 `'gate'`。
`runTaskPerformance` 无参路径改用 `loadPerformanceTasks()`，因此**从不**碰到 sealed。
**同批**把 `test/integrity/task-battery.test.ts` 的取题改成 `loadPerformanceTasks({ pool: 'all' })`，
否则「共 15 题」会在缺省变为 gate 后变成 12。

- [ ] **Step 4: 跑测试**

Run: `cd apps/cli && pnpm vitest run test/integrity/task-battery.test.ts test/core/task-performance.test.ts`
Expected: PASS

- [ ] **Step 5: 回填计数并提交**

提交信息 `feat(crsi): 任务电池分 gate / sealed 两池，缺省 gate`。

---

### Task 4: `capture-rate` 纯模块

**Files:**

- Create: `apps/cli/src/core/capture-rate.ts`
- Test: `apps/cli/test/core/capture-rate.test.ts`（新建）

**Interfaces:**

```ts
export interface ArmValue {
  taskId: string
  value: number | null
} // null = 该臂无合格采样（配对剔除）

export interface CaptureInput {
  off: ArmValue[]
  on: ArmValue[]
  /** 组内题数 M（含被剔除的），用于报告 "over N of M tasks"。 */
  total: number
}

export interface CaptureResult {
  numerator: number
  denominator: number
  /** null ⇒ 无 headroom 题，**没有率**（不是 0，也不是 1）。 */
  rate: number | null
  tasksUsed: number
  tasksTotal: number
  noHeadroom: string[]
  dropped: string[]
  ci: { lo: number; hi: number } | null
}

export function computeCapture(
  input: CaptureInput,
  opts?: { resamples?: number; seed?: number },
): CaptureResult

/** 把 k 次判定的结果折成每题 0–100 的通过率；样本全被截断/uncertain ⇒ null。 */
export function perTaskValue(
  results: { id: string; passed: boolean; truncated?: boolean; uncertain?: boolean }[],
  k: number,
): Map<string, number | null>
```

规则：`h = 100 − off`；`h <= 0` ⇒ `noHeadroom`；任一侧 `value === null` ⇒ `dropped`（配对剔除）；
`numerator = Σ(on−off)`、`denominator = Σ(100−off)`，只在留下的题上；`denominator === 0` ⇒ `rate: null, ci: null`。

- [ ] **Step 1: 写失败测试**

覆盖五格：正常率、无 headroom ⇒ `null`、一侧 null ⇒ `dropped` 且率不变、
区间只在有率时出现且 `lo <= rate <= hi`、**配对剔除不得抬高率**
（`off=[100,20] on=[100,60]` 与 `off=[20] on=[60]` 得同一个率）；
外加**正对照**：`computeCapture({ off: X, on: X })` 在 X 有 headroom 时必须得 `rate === 0`
—— 这是这套仪器唯一能自我证伪的一条。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/capture-rate.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

按任务重采样 1,000 次（缺省），用固定种子的 mulberry32；每次重采样内**重新判定 headroom 与配对**。
`perTaskValue` 只数非 `truncated` 且非 `uncertain` 的样本，除以 k 后 ×100。

- [ ] **Step 4: 跑测试**

Run: `cd apps/cli && pnpm vitest run test/core/capture-rate.test.ts`
Expected: PASS

- [ ] **Step 5: 回填计数并提交**

提交信息 `feat(crsi): 捕获率计算模块（含配对剔除与重采样区间）`。

---

### Task 5: 接线 `/crsi bench --capture`

**Files:**

- Create: `apps/cli/src/core/capture-measure.ts`（编排层；`capture-rate.ts` 保持纯函数）
- Modify: `apps/cli/src/core/task-performance.ts:158-163`（解耦选择与注入）
- Modify: `apps/cli/src/ui/commands.ts:1642-1675`（`crsiBenchCmd`）
- Test: `apps/cli/test/core/capture-measure.test.ts`（新建）

**Interfaces:**

- `runTaskPerformance(llm, opts?: { tasks?: PerformanceTask[]; skillText?: string; skill?: { name: string; text: string }; timeoutMs?: number })`
  —— `tasks` 决定**跑哪些题**，`skillText` 决定**注入什么**；旧 `skill` 参数保持不变。
- `measureCapture(llm, opts: { skillName: string; skillText: string; k?: number }): Promise<{ off: TaskPerformanceReport; on: TaskPerformanceReport; capture: CaptureResult; oraclePassed: boolean }>`
  —— 用 `loadPerformanceTasks()`（gate）按 `skillName` 取题；oracle 臂用 `judgeGeneratedCode` 本地跑。

- [ ] **Step 1: 写失败测试**

用一个「无论 prompt 是什么都返回同一段代码」的假 Llm，断言：
`measureCapture` 返回的 `off.total === on.total === 4`（safe-coding 的 gate 题数）；
`oraclePassed === true`；`capture.tasksTotal === 4`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/capture-measure.test.ts`
Expected: FAIL —— `measureCapture` 不存在。

- [ ] **Step 3: 实现**

`runTaskPerformance` 加 `tasks` / `skillText`；旧 `skill` 走同一条路（`tasks = 按 name 过滤`，`skillText = skill.text`）。
`measureCapture` 跑 off（无注入）与 on（注入）各 `k` 次，用 `perTaskValue` 折叠，再 `computeCapture`。
`crsiBenchCmd` 解析 `--capture`：跑 `measureCapture`，打印
`rate = 分子/分母 over N of M tasks; 95% CI a–b`，并**单独**打印 RSI Tax token 合计。

- [ ] **Step 4: 跑测试**

Run: `cd apps/cli && pnpm vitest run test/core/capture-measure.test.ts`
Expected: PASS

- [ ] **Step 5: 回填计数并提交**

提交信息 `feat(crsi): /crsi bench --capture 报告捕获率`。

---

### Task 6: `probation` 模块

**Files:**

- Create: `apps/cli/src/core/probation.ts`
- Modify: `apps/cli/src/core/improvement-track.ts:66-68`（`computeMinEffect` 加 floor 参数）
- Test: `apps/cli/test/core/probation.test.ts`（新建）

**Interfaces:**

```ts
export const PROBATION_WINDOW = 3

export interface ProbationRecord {
  id: string
  filePath: string
  skillName: string
  commitHash: string
  baselineScores: number[]
  checks: number[]
  verdict?: ImprovementVerdict
  timestamp: string
}

export function probationPath(): string // ~/.mipham/crsi/probation.jsonl
export function openProbation(
  rec: Omit<ProbationRecord, 'id' | 'checks' | 'verdict' | 'timestamp'>,
): void
export function settleProbation(skillName: string, score: number): ProbationRecord | null
export function readProbations(): ProbationRecord[]
export function formatProbationLines(): string[]
export function probationMinEffect(baseline: number[], checks: number[], poolSize: number): number
// = Math.max(2 * (100 / poolSize), 2 * stdDev(concatenated))
```

`computeMinEffect(noise: number, floor?: number): number`，缺省 floor 保持 `MIN_EFFECT_FLOOR`（既有调用点零改动）。

- [ ] **Step 1: 写失败测试**

注入临时 `MIPHAM_HOME`；断言：开窗后 `checks` 为空且 `verdict` **缺席**（`'verdict' in rec === false`）；
**未结窗口必须出现在 `formatProbationLines()` 里并显示 `0/3`** —— 否则「从未开窗」与
「已开窗但没读数」在 stats 上同形（Review Focus #4）；追加 3 次同分 ⇒ `verdict === 'inconclusive'`；
3 次里两次掉 50 分（4 题池）⇒ `'regressed'`；一次掉 25 分 ⇒ 仍是 `'inconclusive'`（单题翻转不判退化）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/probation.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

落盘格式与 `appendImprovement` 同款（整账本读-改-写 + `atomicWriteFileSync`）；
`settleProbation` 只结算**最近一条未结**的该 skill 记录；窗口满 3 才写 verdict。
**不得**调用任何 git 命令。

- [ ] **Step 4: 跑测试**

Run: `cd apps/cli && pnpm vitest run test/core/probation.test.ts test/core/improvement-track.test.ts`
Expected: PASS（既有改进轨测试不受 floor 参数影响）

- [ ] **Step 5: 回填计数并提交**

提交信息 `feat(crsi): 试用期模块（观察窗 3 次，噪声自适应地板）`。

---

### Task 7: 接线 approve / stats / commitHash

**Files:**

- Modify: `apps/cli/src/core/crsi-sandbox.ts:595-641`（`merge()` 返回 `commitHash?`）
- Modify: `apps/cli/src/core/crsi-modify.ts:71-259`
- Modify: `apps/cli/src/ui/commands.ts:1108-1150`（`measureModification`）、`:969-1021`（`crsiStatsCmd`）、`:1642`（bench 结算）
- Test: `apps/cli/test/core/probation-wiring.test.ts`（新建）

**Interfaces:**

- `CrsiSandbox.merge(): { success: boolean; message: string; commitHash?: string }`
- `runCrsiModification(proposal, sandbox?, opts?: { rewardFn?: RewardFn; probation?: { skillName: string; baselineScores: number[] } })`
- `approvePending(): { success: boolean; message: string; probationOpened?: boolean }`
- `cn` 侧：`measureModification` 把 `sample.postScores` 经 `opts.probation` 传入 `runCrsiModification`。

- [ ] **Step 1: 写失败测试**

用假 sandbox（`merge()` 返回 `commitHash: 'deadbeef'`）走 `runCrsiModification` → `approvePending`，
断言 probation 台账多出一条 `commitHash === 'deadbeef'` 的记录；再跑 `settleProbation` 三次，
断言 `formatProbationLines()` 含该 skill 与 verdict。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/probation-wiring.test.ts`
Expected: FAIL —— `approvePending()` 不返回 `probationOpened`，台账为空。

- [ ] **Step 3: 实现**

`merge()` 把已有的 `commitHash` 一并返回；`crsi-modify` 增加模块级 `pendingProbation`
（生命周期与 `pendingSandbox` 一致），`approvePending` 成功后 `openProbation`。
`crsiStatsCmd` 追加 `formatProbationLines()`；bench 完成且 `k >= 3` 时 `settleProbation`。

- [ ] **Step 4: 跑测试**

Run: `cd apps/cli && pnpm vitest run test/core/probation-wiring.test.ts test/ui/commands.test.ts`
Expected: PASS

- [ ] **Step 5: 回填计数并提交**

提交信息 `feat(crsi): 合并后开启试用期，stats 显示裁定与回退命令`。

---

### Task 8: 教训墓碑（删除必须立刻生效）

**Files:**

- Modify: `apps/cli/src/core/instructions.ts:344-376, 582-591`
- Test: `apps/cli/test/core/lessons-tombstone.test.ts`（新建）

**Interfaces:**

- `InstructionsLoader.crsiLessonsText()` 改为**每次调用**从 `this.root` 重新读教训文件
  （复用 `private loadCrsiLessons(root)`），不再使用 `loadAll` 时缓存进
  `this.crsiLessonSummaries` 的那份；`loadCrsiLessons` 的 catch 分支要同时把
  `this.lessonsPath = null`（文件被删后指针不能再指向它）。`sizeReport` 仍走同一投影。
- 测试走**公开接口** `buildSystemPrompt()`（`crsiLessonsText()` 是 private）。

- [ ] **Step 1: 写失败测试**

```ts
it('删掉一条教训后，下一次投影里不再出现它', () => {
  // 造临时 git 仓库（git init）并写 apps/cli/crsi-lessons.md，含 'lesson-alpha'
  // loader.loadAll(tmp)
  // expect(loader.buildSystemPrompt()).toContain('lesson-alpha')
  // 从文件里删掉该条
  // expect(loader.buildSystemPrompt()).not.toContain('lesson-alpha')   // ← 今天会红（缓存）
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/lessons-tombstone.test.ts`
Expected: FAIL —— 第二次断言里旧教训仍在。

- [ ] **Step 3: 实现**

`crsiLessonsText()` 与 `crsiLessonNudgeText()` 改为读当前文件；文件缺席 ⇒ 空串（与
`loadAlwaysOnLessonsBlock` 同语义）。

- [ ] **Step 4: 跑测试**

Run: `cd apps/cli && pnpm vitest run test/core/lessons-tombstone.test.ts test/core/instructions`
Expected: PASS

- [ ] **Step 5: 回填计数并提交**

提交信息 `fix(crsi): 教训投影改为每次读盘，删除即时生效`。

---

### Task 9: 全量验证与文档回填

**Files:**

- Modify: `CLAUDE.md`（头部「测试：…」行、测试表 `core` 行与 `合计` 行、版本号与日期）
- Modify: `docs/superpowers/specs/2026-11-20-crsi-eval-governance-design.md`（状态改「已实现」）

- [ ] **Step 1: 全量验证**

```bash
cd apps/cli && pnpm typecheck && pnpm vitest run
```

Expected: typecheck 无错；全绿（0 失败）。

- [ ] **Step 2: 仓库级检查**

```bash
cd "$(git rev-parse --show-toplevel)" && pnpm lint && pnpm format:check
```

Expected: 均退出 0。

- [ ] **Step 3: 回填文档**

按实际读数更新 `CLAUDE.md` 的三处测试计数与表行；更新设计文档状态。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-11-20-crsi-eval-governance-design.md
git commit -m "docs(crsi): 回填评估治理三件的测试计数与设计状态"
```
