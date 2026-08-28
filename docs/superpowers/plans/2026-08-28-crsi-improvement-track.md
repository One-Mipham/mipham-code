# CRSI 改进轨（Improvement Track）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 造一个噪声自适应的改进判定器（多次采样 → verdict），接进 `/crsi modify`「倒退才拦」，建 append-only 台账产出改进率。

**Architecture:** 复用 M2b 的「async 命令层测量」模式——`runCrsiModification` 零改动；新增 `core/improvement-track.ts`（verdict 分类 + Wilson + 台账 + pending 闸），`task-performance.ts` 加 `measureSkillDeltaRepeated`（多次采样）。四项改进轨（因果归因/最小效应量/误提升预算/改进率）在此落地。

**Tech Stack:** Bun、Vitest 3、TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-08-28-crsi-improvement-track-design.md`

## Global Constraints

- A1 铁律：verdict / minEffect / 改进率全部确定性算术（均值/标准差/阈值/Wilson），LLM 只作被测试对象（生成代码 → 冻结测试判定），零 LLM 裁判。
- `runCrsiModification` **零改动**（保持 sync/纯/无 LLM）；测量/判定都在 async 命令层。
- 常量默认值：`SAMPLE_K=3`、`MIN_EFFECT_FLOOR=20`、`NOISE_K=2`、`FALSE_POSITIVE_BASELINE=0.05`。
- 台账 `~/.mipham/crsi/improvements.jsonl`（append-only，同 `eval-scores.jsonl` 风格）；路径用 `homedir()`，测试 mock homedir 到 tmpdir（照抄 `eval-harness.test.ts` 模式）。
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`。
- 测试：`cd apps/cli && pnpm vitest run <file>`；typecheck：`cd apps/cli && pnpm typecheck`。

---

## File Structure

| 文件                                           | 动作       | 职责                                                         |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------ |
| `apps/cli/src/ui/commands.ts`                  | Modify     | Task 1 前提修复（blastRadius）+ Task 4 接线                  |
| `apps/cli/src/core/task-performance.ts`        | Modify     | Task 2：`resolveSkillProposal` + `measureSkillDeltaRepeated` |
| `apps/cli/test/core/task-performance.test.ts`  | Modify     | Task 2：`measureSkillDeltaRepeated` 测试                     |
| `apps/cli/src/core/improvement-track.ts`       | **Create** | Task 3：verdict + Wilson + 台账 + pending 闸                 |
| `apps/cli/test/core/improvement-track.test.ts` | **Create** | Task 3：纯函数 + 台账 + 闸测试                               |

---

## Task 1: 前提修复——补 `blastRadius: [filePath]`

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`

**Interfaces:**

- Consumes: `runCrsiModification`（现有，已要求非空 `blastRadius`）
- Produces: 无新接口——只让两处调用通过 blast-radius 闸

**背景**：`validateBlastRadius` 要求 proposal 声明非空 `blastRadius`（且覆盖 filePath），但 `crsiModifyCmd` 与 `/crsi propose --prose` 两处调 `runCrsiModification` 未传，导致这两条命令第一步就被「blast radius 未声明」拒绝。单文件修改的完整覆盖就是它自己。

- [ ] **Step 1: 改 `crsiModifyCmd` 调用（约 line 801）**

改前：

```typescript
const result = runCrsiModification({ description, filePath, newContent, originalContent })
```

改后：

```typescript
const result = runCrsiModification({
  description,
  filePath,
  newContent,
  originalContent,
  blastRadius: [filePath],
})
```

- [ ] **Step 2: 改 `/crsi propose --prose` 调用（约 line 881）**

改前：

```typescript
const result = runCrsiModification({
  description: proposal.description,
  filePath: proposal.filePath,
  newContent: proposal.newContent,
  originalContent: proposal.originalContent,
})
```

改后：

```typescript
const result = runCrsiModification({
  description: proposal.description,
  filePath: proposal.filePath,
  newContent: proposal.newContent,
  originalContent: proposal.originalContent,
  blastRadius: [proposal.filePath],
})
```

- [ ] **Step 3: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error（`blastRadius` 已在 `CrsiProposal` 类型里，可选字段，无需改类型）。

- [ ] **Step 4: Commit**

```bash
cd apps/cli && git add src/ui/commands.ts
git commit -m "fix(crsi): /crsi modify 与 propose --prose 补 blastRadius——过完整覆盖闸

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 2: `measureSkillDeltaRepeated` + `resolveSkillProposal` 抽取

**Files:**

- Modify: `apps/cli/src/core/task-performance.ts`
- Test: `apps/cli/test/core/task-performance.test.ts`

**Interfaces:**

- Consumes: `runTaskPerformance` / `loadPerformanceTasks` / `parseFrontmatter`（同文件 / loader）
- Produces:
  - `interface SkillDeltaSample { skillName: string; baselineScores: number[]; postScores: number[] }`
  - `async function measureSkillDeltaRepeated(llm, proposal, opts?: { k?: number }): Promise<SkillDeltaSample | null>`

- [ ] **Step 1: 写失败测试**

在 `apps/cli/test/core/task-performance.test.ts` 顶部 import 加 `measureSkillDeltaRepeated`：

```typescript
import { measureSkillDelta, measureSkillDeltaRepeated } from '../../src/core/task-performance'
```

（当前该文件已 import `measureSkillDelta`；若无，按现有 import 行扩展。）

追加 describe：

```typescript
describe('measureSkillDeltaRepeated', () => {
  it('非 skill 文件 → null', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const s = await measureSkillDeltaRepeated(mockLlm, {
      filePath: 'apps/cli/src/foo.ts',
      originalContent: 'x',
      newContent: 'y',
    })
    expect(s).toBeNull()
  })

  it('skill 文件但无绑定任务 → null', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const s = await measureSkillDeltaRepeated(mockLlm, {
      filePath: 'apps/cli/skills/standard/no-such-task-skill.SKILL.md',
      newContent: '---\nname: no-such-task-skill\ndescription: x\n---\nbody',
    })
    expect(s).toBeNull()
  })

  it('safe-coding 强 skill → K 次采样分数数组正确（k=2）', async () => {
    const mockLlm: Llm = {
      chat: async function* (req) {
        const sp = (req.systemPrompt ?? '') as string
        if (sp.includes('校验')) {
          yield {
            type: 'text',
            content:
              'export function parsePositiveNumber(input: string): number { if (input == null || input === "" || isNaN(Number(input))) throw new RangeError("invalid input"); return Number(input) }',
          }
        } else {
          yield {
            type: 'text',
            content:
              'export function parsePositiveNumber(input: string): number { return Number(input) }',
          }
        }
      },
    }
    const strong =
      "---\nname: safe-coding\ndescription: x\n---\n处理外部/用户输入前必须校验：null、undefined、空字符串、格式非法时，抛出 RangeError，消息为 'invalid input'。"
    const weak =
      '---\nname: safe-coding\ndescription: x\n---\n你是一个编码智能体，尽力完成任务即可。'
    const s = await measureSkillDeltaRepeated(
      mockLlm,
      {
        filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
        originalContent: weak,
        newContent: strong,
      },
      { k: 2 },
    )
    expect(s).not.toBeNull()
    expect(s!.skillName).toBe('safe-coding')
    expect(s!.baselineScores).toEqual([0, 0])
    expect(s!.postScores).toEqual([100, 100])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: FAIL（`measureSkillDeltaRepeated is not a function`）。

- [ ] **Step 3: 抽 `resolveSkillProposal` + 实现 `measureSkillDeltaRepeated`**

`apps/cli/src/core/task-performance.ts`：把现有 `measureSkillDelta` 里的「路径门 + frontmatter 嗅 + 任务集 guard + baseline 解析」抽成私有 `resolveSkillProposal`，并加 `SkillDeltaSample` + `measureSkillDeltaRepeated`。

在 `export interface SkillDelta { ... }`（约 line 133）之后、`isSkillFile` 之前插入：

```typescript
interface ResolvedSkillProposal {
  skillName: string
  baselineText: string
  postText: string
}
```

把 `measureSkillDelta`（约 line 153-187）整段替换为：

```typescript
/** 解析改 skill 的 proposal → 名字 + 旧/新 body；非 skill / 无任务集 / 旧不可读 → null。 */
function resolveSkillProposal(proposal: {
  filePath: string
  originalContent?: string
  newContent: string
}): ResolvedSkillProposal | null {
  if (!isSkillFile(proposal.filePath)) return null

  const newParsed = parseFrontmatter(proposal.newContent)
  const skillName = typeof newParsed.data.name === 'string' ? newParsed.data.name : undefined
  if (!skillName) return null

  if (!loadPerformanceTasks().some((t) => t.skill === skillName)) return null

  let baselineText: string
  if (proposal.originalContent !== undefined) {
    baselineText = parseFrontmatter(proposal.originalContent).content
  } else {
    try {
      baselineText = parseFrontmatter(readFileSync(proposal.filePath, 'utf-8')).content
    } catch {
      return null // 旧 skill 不可读 → 无可量
    }
  }

  return { skillName, baselineText, postText: newParsed.content }
}

/**
 * 测一个改 skill 的 proposal 的任务表现 before/after delta。
 * 返回 null：不是 skill 文件 / 无匹配任务集（无可量）。
 * A1 不破：只调 runTaskPerformance（LLM 生成 + 冻结测试判定）。
 */
export async function measureSkillDelta(
  llm: Llm,
  proposal: { filePath: string; originalContent?: string; newContent: string },
): Promise<SkillDelta | null> {
  const resolved = resolveSkillProposal(proposal)
  if (!resolved) return null

  const baseline = await runTaskPerformance(llm, {
    skill: { name: resolved.skillName, text: resolved.baselineText },
  })
  const post = await runTaskPerformance(llm, {
    skill: { name: resolved.skillName, text: resolved.postText },
  })

  return {
    skillName: resolved.skillName,
    baseline,
    post,
    delta: post.score - baseline.score,
  }
}

export interface SkillDeltaSample {
  skillName: string
  baselineScores: number[]
  postScores: number[]
}

/**
 * 多次采样 before/after（每次都是「LLM 生成 → 冻结测试判定」），供改进轨估噪声。
 * 返回 null 门与 measureSkillDelta 相同。k 默认 3。
 */
export async function measureSkillDeltaRepeated(
  llm: Llm,
  proposal: { filePath: string; originalContent?: string; newContent: string },
  opts?: { k?: number },
): Promise<SkillDeltaSample | null> {
  const resolved = resolveSkillProposal(proposal)
  if (!resolved) return null

  const k = opts?.k ?? 3
  const baselineScores: number[] = []
  const postScores: number[] = []
  for (let i = 0; i < k; i++) {
    const r = await runTaskPerformance(llm, {
      skill: { name: resolved.skillName, text: resolved.baselineText },
    })
    baselineScores.push(r.score)
  }
  for (let i = 0; i < k; i++) {
    const r = await runTaskPerformance(llm, {
      skill: { name: resolved.skillName, text: resolved.postText },
    })
    postScores.push(r.score)
  }

  return { skillName: resolved.skillName, baselineScores, postScores }
}
```

（`isSkillFile` 保持不变，仍为模块私有——`resolveSkillProposal` 在同文件内调用它。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: PASS（新增 3 个 `measureSkillDeltaRepeated` 测试绿，且原 `measureSkillDelta` 测试仍绿——抽取未改行为）。

- [ ] **Step 5: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error。

- [ ] **Step 6: Commit**

```bash
cd apps/cli && git add src/core/task-performance.ts test/core/task-performance.test.ts
git commit -m "feat(crsi): 改进轨 I2a——measureSkillDeltaRepeated 多次采样（抽 resolveSkillProposal）

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 3: `improvement-track.ts`（verdict + Wilson + 台账 + pending 闸）

**Files:**

- Create: `apps/cli/src/core/improvement-track.ts`
- Test: `apps/cli/test/core/improvement-track.test.ts`

**Interfaces:**

- Consumes: `SkillDeltaSample`（Task 2）
- Produces: `ImprovementVerdict` / `ImprovementReport` / `ImprovementRecord` / `computeMinEffect` / `classifyDelta` / `buildImprovementReport` / `wilsonInterval` / `improvementRate` / `improvementSignalStrong` / `appendImprovement` / `readImprovements` / `setPendingVerdict` / `getPendingVerdict` / `shouldBlockApproval`

- [ ] **Step 1: 写失败测试**

Create `apps/cli/test/core/improvement-track.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-improvement-track` }
})

import {
  computeMinEffect,
  classifyDelta,
  buildImprovementReport,
  wilsonInterval,
  improvementRate,
  improvementSignalStrong,
  appendImprovement,
  readImprovements,
  setPendingVerdict,
  getPendingVerdict,
  shouldBlockApproval,
  MIN_EFFECT_FLOOR,
  NOISE_K,
} from '../../src/core/improvement-track'
import type { ImprovementRecord } from '../../src/core/improvement-track'

beforeEach(() => {
  rmSync(join(homedir(), '.mipham', 'crsi', 'improvements.jsonl'), { force: true })
  setPendingVerdict(null)
})

describe('computeMinEffect', () => {
  it('噪声 0 → 固定下限', () => {
    expect(computeMinEffect(0)).toBe(MIN_EFFECT_FLOOR)
  })
  it('噪声大 → NOISE_K × noise', () => {
    expect(computeMinEffect(50)).toBe(NOISE_K * 50)
  })
})

describe('classifyDelta', () => {
  it('三分支边界（含等号）', () => {
    expect(classifyDelta(-21, 20)).toBe('regressed')
    expect(classifyDelta(-20, 20)).toBe('regressed')
    expect(classifyDelta(0, 20)).toBe('inconclusive')
    expect(classifyDelta(19, 20)).toBe('inconclusive')
    expect(classifyDelta(20, 20)).toBe('improved')
    expect(classifyDelta(30, 20)).toBe('improved')
  })
})

describe('buildImprovementReport', () => {
  it('强 skill 单组件 → delta 正、improved、causal true', () => {
    const report = buildImprovementReport(
      { skillName: 'safe-coding', baselineScores: [0, 0, 0], postScores: [100, 100, 100] },
      ['apps/cli/skills/standard/safe-coding.SKILL.md'],
    )
    expect(report.deltaMean).toBe(100)
    expect(report.noise).toBe(0)
    expect(report.minEffect).toBe(MIN_EFFECT_FLOOR)
    expect(report.verdict).toBe('improved')
    expect(report.causal).toBe(true)
  })
  it('多组件 → causal false；零位移 → inconclusive', () => {
    const report = buildImprovementReport(
      { skillName: 'safe-coding', baselineScores: [50, 50, 50], postScores: [50, 50, 50] },
      ['apps/cli/skills/standard/safe-coding.SKILL.md', 'apps/cli/src/foo.ts'],
    )
    expect(report.causal).toBe(false)
    expect(report.verdict).toBe('inconclusive')
  })
})

describe('wilsonInterval', () => {
  it('n=0 → 不除零，返回 0', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 0 })
  })
  it('全 improved → lo > 0', () => {
    const { lo, hi } = wilsonInterval(5, 5)
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeGreaterThanOrEqual(lo)
  })
})

describe('improvementRate / improvementSignalStrong', () => {
  it('空台账 → total 0', () => {
    expect(improvementRate([]).total).toBe(0)
  })
  it('全 inconclusive → signal 弱', () => {
    expect(improvementSignalStrong([mkRecord('inconclusive'), mkRecord('inconclusive')])).toBe(
      false,
    )
  })
  it('全 improved → signal 强', () => {
    expect(
      improvementSignalStrong([mkRecord('improved'), mkRecord('improved'), mkRecord('improved')]),
    ).toBe(true)
  })
})

describe('台账 append/read', () => {
  it('append → read 往返一致', () => {
    const rec = mkRecord('improved')
    appendImprovement(rec)
    const all = readImprovements()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(rec.id)
    expect(all[0].verdict).toBe('improved')
  })
  it('append-only：追加后旧记录不变', () => {
    const r1 = mkRecord('improved')
    appendImprovement(r1)
    appendImprovement(mkRecord('regressed'))
    const all = readImprovements()
    expect(all).toHaveLength(2)
    expect(all[0].id).toBe(r1.id)
  })
})

describe('pending 闸', () => {
  it('set → get 往返', () => {
    setPendingVerdict('regressed')
    expect(getPendingVerdict()).toBe('regressed')
  })
  it('shouldBlockApproval 只拦 regressed', () => {
    expect(shouldBlockApproval('regressed')).toBe(true)
    expect(shouldBlockApproval('improved')).toBe(false)
    expect(shouldBlockApproval('inconclusive')).toBe(false)
  })
})

function mkRecord(verdict: ImprovementRecord['verdict']): ImprovementRecord {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    skillName: 'safe-coding',
    changeSet: ['apps/cli/skills/standard/safe-coding.SKILL.md'],
    causal: true,
    baselineScores: [0, 0, 0],
    postScores: [100, 100, 100],
    deltaMean: 100,
    noise: 0,
    minEffect: 20,
    verdict,
  }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/improvement-track.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `improvement-track.ts`**

Create `apps/cli/src/core/improvement-track.ts`：

```typescript
// CRSI 改进轨：噪声自适应改进判定 + 台账 + pending verdict 闸。
// A1 不破：verdict / minEffect / 改进率全是确定性算术（均值/标准差/阈值/Wilson），无 LLM 裁判。
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SkillDeltaSample } from './task-performance'

export type ImprovementVerdict = 'improved' | 'regressed' | 'inconclusive'

export const MIN_EFFECT_FLOOR = 20
export const NOISE_K = 2
export const FALSE_POSITIVE_BASELINE = 0.05

export interface ImprovementReport {
  skillName: string
  changeSet: string[]
  causal: boolean
  baselineScores: number[]
  postScores: number[]
  deltaMean: number
  noise: number
  minEffect: number
  verdict: ImprovementVerdict
}

export interface ImprovementRecord extends ImprovementReport {
  id: string
  timestamp: string
}

// ── 纯函数 ──

export function computeMinEffect(noise: number): number {
  return Math.max(MIN_EFFECT_FLOOR, NOISE_K * noise)
}

export function classifyDelta(deltaMean: number, minEffect: number): ImprovementVerdict {
  if (deltaMean <= -minEffect) return 'regressed'
  if (deltaMean >= minEffect) return 'improved'
  return 'inconclusive'
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(variance)
}

export function buildImprovementReport(
  sample: SkillDeltaSample,
  changeSet: string[],
): ImprovementReport {
  const deltaMean = mean(sample.postScores) - mean(sample.baselineScores)
  const noise = stdDev(sample.baselineScores)
  const minEffect = computeMinEffect(noise)
  const verdict = classifyDelta(deltaMean, minEffect)
  return {
    skillName: sample.skillName,
    changeSet,
    causal: changeSet.length === 1,
    baselineScores: sample.baselineScores,
    postScores: sample.postScores,
    deltaMean,
    noise,
    minEffect,
    verdict,
  }
}

/** Wilson score 区间（z 默认 1.96 = 95%）。n=0 → {0,0}。 */
export function wilsonInterval(
  improved: number,
  total: number,
  z = 1.96,
): { lo: number; hi: number } {
  if (total === 0) return { lo: 0, hi: 0 }
  const p = improved / total
  const n = total
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { lo: center - half, hi: center + half }
}

export function improvementRate(records: ImprovementRecord[]): {
  total: number
  improved: number
  rate: number
  lo: number
  hi: number
} {
  const total = records.length
  const improved = records.filter((r) => r.verdict === 'improved').length
  const { lo, hi } = wilsonInterval(improved, total)
  return { total, improved, rate: total === 0 ? 0 : improved / total, lo, hi }
}

/** 循环有效性：改进率 Wilson 95% CI 下界 > 假阳性基线（默认 5%）。 */
export function improvementSignalStrong(records: ImprovementRecord[]): boolean {
  const { lo } = improvementRate(records)
  return records.length > 0 && lo > FALSE_POSITIVE_BASELINE
}

// ── 台账 ──

export function improvementPath(): string {
  return join(homedir(), '.mipham', 'crsi', 'improvements.jsonl')
}

export function appendImprovement(record: ImprovementRecord): void {
  const file = improvementPath()
  mkdirSync(join(homedir(), '.mipham', 'crsi'), { recursive: true })
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8')
}

export function readImprovements(): ImprovementRecord[] {
  const file = improvementPath()
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ImprovementRecord)
}

// ── pending verdict 闸（倒退才拦） ──

let pendingVerdict: ImprovementVerdict | null = null

export function setPendingVerdict(v: ImprovementVerdict | null): void {
  pendingVerdict = v
}

export function getPendingVerdict(): ImprovementVerdict | null {
  return pendingVerdict
}

export function shouldBlockApproval(v: ImprovementVerdict): boolean {
  return v === 'regressed'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/improvement-track.test.ts`
Expected: PASS（全部 describe 绿）。

- [ ] **Step 5: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error。

- [ ] **Step 6: Commit**

```bash
cd apps/cli && git add src/core/improvement-track.ts test/core/improvement-track.test.ts
git commit -m "feat(crsi): 改进轨 I2b——improvement-track（verdict + Wilson + 台账 + pending 闸）

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 4: `/crsi modify` 接线（测量 + 倒退才拦 + 改进率显示）

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`

**Interfaces:**

- Consumes: `measureSkillDeltaRepeated`（Task 2）、`buildImprovementReport` / `appendImprovement` / `readImprovements` / `improvementRate` / `setPendingVerdict` / `getPendingVerdict` / `shouldBlockApproval`（Task 3）、`randomUUID`
- Produces: `crsiModifyCmd` 结果里显示改进判定 + 改进率；`--approve` 拦 regressed

- [ ] **Step 1: 顶部 import**

`commands.ts` 顶部：

- 现有 line 32 `import { runTaskPerformance, measureSkillDelta } from '../core/task-performance'` 改为：

```typescript
import { runTaskPerformance, measureSkillDeltaRepeated } from '../core/task-performance'
```

- 新增（放在 `../core/...` import 群旁，`node:crypto` 若无则加）：

```typescript
import { randomUUID } from 'node:crypto'
import {
  buildImprovementReport,
  appendImprovement,
  readImprovements,
  improvementRate,
  setPendingVerdict,
  getPendingVerdict,
  shouldBlockApproval,
} from '../core/improvement-track'
```

> 注意：`measureSkillDelta` 移除 import 后，若无其他引用会触发 lint unused——本 task 已把 crsiModifyCmd 改用 `measureSkillDeltaRepeated`。`runTaskPerformance` 仍被 `crsiBenchCmd`（line 996）使用，保留。

- [ ] **Step 2: 改 `crsiModifyCmd` 的 `--approve` / `--reject` 分支**

改前（约 line 764-771）：

```typescript
if (args[0] === '--approve') {
  const r = approvePending()
  return { content: r.success ? `✅ ${r.message}` : `⚠️ ${r.message}` }
}
if (args[0] === '--reject') {
  const r = rejectPending()
  return { content: r.success ? `✅ ${r.message}` : `⚠️ ${r.message}` }
}
```

改后：

```typescript
if (args[0] === '--approve') {
  if (shouldBlockApproval(getPendingVerdict() ?? 'inconclusive')) {
    return { content: '❌ 任务表现倒退，禁止固化。请 /crsi modify --reject 丢弃，或改进后再试。' }
  }
  const r = approvePending()
  setPendingVerdict(null)
  return { content: r.success ? `✅ ${r.message}` : `⚠️ ${r.message}` }
}
if (args[0] === '--reject') {
  const r = rejectPending()
  setPendingVerdict(null)
  return { content: r.success ? `✅ ${r.message}` : `⚠️ ${r.message}` }
}
```

- [ ] **Step 3: 改 `crsiModifyCmd` 主流程（测量后置 + verdict 显示）**

改前（约 line 798-817）：

```typescript
const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
const delta = await measureSkillDelta(llm, { filePath, originalContent, newContent })

const result = runCrsiModification({
  description,
  filePath,
  newContent,
  originalContent,
  blastRadius: [filePath],
})
if (!result.applied || result.phase === 'failed') {
  return {
    content: `❌ 修改未通过（phase: ${result.phase}）。\n${result.error ?? ''}`,
  }
}

const deltaLine = delta
  ? `\n📈 改进信号 delta: ${delta.delta >= 0 ? '+' : ''}${delta.delta} (baseline ${delta.baseline.score} → post ${delta.post.score})`
  : ''

return {
  content:
    `✅ 测试通过。审阅下方 diff：\n\n${result.diff}\n\n` +
    deltaLine +
    '\n/crsi modify --approve  合并\n/crsi modify --reject   丢弃',
}
```

改后：

```typescript
const result = runCrsiModification({
  description,
  filePath,
  newContent,
  originalContent,
  blastRadius: [filePath],
})
if (!result.applied || result.phase === 'failed') {
  return {
    content: `❌ 修改未通过（phase: ${result.phase}）。\n${result.error ?? ''}`,
  }
}

// 测量在 runCrsiModification 成功后进行（避免 failed proposal 白跑 6 次 LLM 调用）。
const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
let improvementLine = ''
try {
  const sample = await measureSkillDeltaRepeated(llm, { filePath, originalContent, newContent })
  if (sample) {
    const report = buildImprovementReport(sample, [filePath])
    setPendingVerdict(report.verdict)
    appendImprovement({ ...report, id: randomUUID(), timestamp: new Date().toISOString() })
    const rate = improvementRate(readImprovements())
    const label =
      report.verdict === 'improved'
        ? 'improved ✅'
        : report.verdict === 'regressed'
          ? 'regressed ⚠️'
          : 'inconclusive'
    const sign = report.deltaMean >= 0 ? '+' : ''
    improvementLine =
      `\n📊 改进判定: ${label} (delta ${sign}${report.deltaMean.toFixed(1)}, 噪声 ${report.noise.toFixed(1)}, 阈值 ${report.minEffect.toFixed(1)})` +
      `\n   改进率: ${rate.improved}/${rate.total} (${(rate.rate * 100).toFixed(0)}%, Wilson 95% [${(rate.lo * 100).toFixed(0)}%, ${(rate.hi * 100).toFixed(0)}%])` +
      (report.verdict === 'regressed' ? '\n   ⚠️ 任务表现倒退：--approve 将被拒绝。' : '')
  }
} catch {
  // 测量失败（LLM 不可用等）不阻断 modify 流程——改进信号是可选的。
}

return {
  content:
    `✅ 测试通过。审阅下方 diff：\n\n${result.diff}\n` +
    improvementLine +
    '\n/crsi modify --approve  合并\n/crsi modify --reject   丢弃',
}
```

> 说明：`blastRadius: [filePath]` 在 Task 1 已补；此处保留（同一调用）。非 skill 提案 `measureSkillDeltaRepeated` 返回 null → 无 verdict、无闸（改进轨对非 skill 提案无意见）。

- [ ] **Step 4: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error。

- [ ] **Step 5: 跑全量测试**

Run: `cd apps/cli && pnpm test`
Expected: 全绿（1936 + 新增 ≈ 1960 个；无回归）。

- [ ] **Step 6: Commit**

```bash
cd apps/cli && git add src/ui/commands.ts
git commit -m "feat(crsi): 改进轨 I3——/crsi modify 接线测量 + 倒退才拦 + 改进率显示

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Self-Review

- **Spec 覆盖**：§3.3（采样+verdict）→ Task 2 + Task 3（`measureSkillDeltaRepeated` + `computeMinEffect`/`classifyDelta`/`buildImprovementReport`）；§3.4（接口契约）→ Task 2（`SkillDeltaSample`）+ Task 3（improvement-track 全套）；§3.5（接线 + 前提修复）→ Task 1（blastRadius）+ Task 4（`--approve` 闸 + 显示）；§七（测试）→ Task 2/3 测试 + Task 4 全量回归。
- **占位符扫描**：无 TBD/TODO；每个 code step 给完整可跑代码。
- **类型一致性**：`measureSkillDeltaRepeated(llm, proposal, opts?)` 签名 Task 2 定义、Task 4 调用一致；`buildImprovementReport(sample, changeSet)` / `shouldBlockApproval(v)` / `improvementRate(records)` 在 Task 3 定义、Task 4 调用一致。
- **runCrsiModification 零改动**：Task 1/4 只改调用处的入参（补 blastRadius），未碰 `crsi-modify.ts` 内部逻辑。
- **A1 不破**：Task 3 的 verdict/台账无任何 LLM 调用；Task 2 的采样仍是 `runTaskPerformance`（LLM 生成 → 冻结测试判定）。
