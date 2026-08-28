# CRSI Crossover 算子 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 producer 第 4 个原子算子 `produceCrossoverProposal`（LLM 选两条重叠教训 + 生成合并版 → 「删二增一」教训变更候选）+ `/crsi propose --crossover` 命令接线。

**Architecture:** 在 `crsi-producer.ts` 追加 crossover 段（复用 `buildLessonContent`/`collectLlmText`/`CrsiSignal`/`LESSONS_FILE`）。LLM 只生成（选对 + 合并版 JSON），确定性 guard（`parseCrossoverResult` + 标题存在性 `includes`）防幻觉；`removeLessonSections` 确定性删段；产出走 `runCrsiModification` 沙箱 gate（blastRadius + 测试 + RewardFn 闸 + 人审）。

**Tech Stack:** Bun、Vitest 3、TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-08-28-crsi-crossover-design.md`

## Global Constraints

- A1 铁律：LLM 只生成（选对 + 合并版），判定全走确定性 guard + 沙箱 gate，零 LLM 自评。
- `buildLessonContent` 加可选 `source` 参数（默认 `'CRSI producer (autoApplicable)'`），crossover 传 `'CRSI producer (crossover)'`——避免「来源: autoApplicable」doc-drift。现有调用零改动。
- 幂等从简：不加 crossover ledger（`hasPending()` + 合并后标题消失的自然 guard）。
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`。
- 测试：`cd apps/cli && pnpm vitest run <file>`；typecheck：`cd apps/cli && pnpm typecheck`；全量：`cd apps/cli && pnpm test`。

## Reconciliation（spec 与现状的出入，实现者必读）

1. **`buildLessonContent` 来源漂移**：spec §3.1 说「复用现有模板」，但现有模板把「来源」硬编码为 `CRSI producer (autoApplicable)`——crossover 合并的教训标 autoApplicable 是 doc-drift（`doc-drift` 教训）。本 plan 给 `buildLessonContent` 加可选 `source` 参数（默认 autoApplicable，向后兼容），crossover 传 `crossover`。现有 `buildLessonContent` 测试（crsi-producer.test.ts:74-91）只断言 `toContain`，不碰「来源」行，零破坏。
2. **`collectLlmText` 的 `model: 'prose'`**：该 helper 硬编码 `model: 'prose'`（producer 的生成层）。crossover 复用它，model 仍为 'prose'——语义上 crossover 非散文，但 'prose' 是 producer 既有的生成 tier，功能正确（mock llm 忽略 model）。spec §3.1「复用 collectLlmText」一致，不做改动。

---

## File Structure

| 文件                                                 | 动作   | 职责                                                                                                            |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/core/crsi-producer.ts`                 | Modify | Task 1：`buildLessonContent` 加 `source` 参数 + 追加 crossover 段（prompt/stripJsonFence/parse/remove/produce） |
| `apps/cli/test/core/crsi-producer-crossover.test.ts` | Create | Task 1：parse/remove/produce 四态 + guard 测试                                                                  |
| `apps/cli/src/ui/commands.ts`                        | Modify | Task 2：import `produceCrossoverProposal` + `--crossover` 分支                                                  |

---

## Task 1: `produceCrossoverProposal` 算子 + `buildLessonContent` source 参数

**Files:**

- Modify: `apps/cli/src/core/crsi-producer.ts`
- Test: `apps/cli/test/core/crsi-producer-crossover.test.ts`（新建）

**Interfaces:**

- Consumes: `buildLessonContent` / `collectLlmText` / `CrsiSignal` / `LESSONS_FILE`（同文件已有）
- Produces:
  - `export interface CrossoverResult { titleA: string; titleB: string; merged: CrsiSignal }`
  - `export function parseCrossoverResult(text: string): CrossoverResult | null`
  - `export function removeLessonSections(content: string, headers: string[]): string`
  - `export async function produceCrossoverProposal(llm, currentLessons, timestamp): Promise<{description,filePath,newContent,originalContent,blastRadius} | null>`
  - `buildLessonContent(signal, timestamp, source = 'CRSI producer (autoApplicable)')`（签名加可选参数）

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/crsi-producer-crossover.test.ts`（新建）：

````typescript
import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import {
  parseCrossoverResult,
  removeLessonSections,
  produceCrossoverProposal,
} from '../../src/core/crsi-producer'

function textLlm(text: string): Llm {
  return {
    chat: async function* () {
      yield { type: 'text', content: text }
      yield { type: 'stop' }
    },
  }
}

const LESSONS = `# CRSI Lessons

本文件由 CRSI producer 自动追加教训。

<!-- CRSI lessons are appended below this line. -->

## research: 调研判断必须先读自身代码库再下结论

- 建议: 先读码再下结论
- 严重度: warning

### 证据

- 证据 A

## borrow-analysis: 借鉴外部项目必须查许可

- 建议: 借鉴要查许可+边界
- 严重度: warning

### 证据

- 证据 B

## simplicity: 未要求的功能是负债

- 建议: 不添加未要求的功能
- 严重度: critical

### 证据

- 证据 C
`

const HEADER_A = 'research: 调研判断必须先读自身代码库再下结论'
const HEADER_B = 'borrow-analysis: 借鉴外部项目必须查许可'

describe('parseCrossoverResult', () => {
  it('合法 JSON 解析成功', () => {
    const r = parseCrossoverResult(
      JSON.stringify({
        titleA: HEADER_A,
        titleB: HEADER_B,
        merged: { category: 'research', title: '合并', suggestion: '建议', evidence: ['e1', 'e2'] },
      }),
    )
    expect(r).not.toBeNull()
    expect(r!.titleA).toBe(HEADER_A)
    expect(r!.merged.evidence).toEqual(['e1', 'e2'])
  })

  it('带 ```json 围栏也解析', () => {
    const inner = JSON.stringify({
      titleA: 'a',
      titleB: 'b',
      merged: { category: 'c', title: 't', suggestion: 's', evidence: [] },
    })
    expect(parseCrossoverResult('```json\n' + inner + '\n```')).not.toBeNull()
  })

  it('字段缺失 → null', () => {
    expect(parseCrossoverResult('{"titleA":"a"}')).toBeNull()
    expect(
      parseCrossoverResult('{"titleA":"a","titleB":"b","merged":{"category":"c","title":"t"}}'),
    ).toBeNull()
  })

  it('非 JSON → null', () => {
    expect(parseCrossoverResult('not json')).toBeNull()
  })
})

describe('removeLessonSections', () => {
  it('移除两条教训，其余与 preamble 完好', () => {
    const out = removeLessonSections(LESSONS, [`## ${HEADER_A}`, `## ${HEADER_B}`])
    expect(out).not.toContain(HEADER_A)
    expect(out).not.toContain(HEADER_B)
    expect(out).toContain('simplicity: 未要求的功能是负债')
    expect(out).toContain('# CRSI Lessons')
    expect(out).toContain('<!-- CRSI lessons are appended below this line. -->')
  })

  it('移除不存在的 header 无副作用', () => {
    expect(removeLessonSections(LESSONS, ['## nonexistent: x'])).toBe(LESSONS)
  })
})

describe('produceCrossoverProposal', () => {
  const JSON_RESULT = JSON.stringify({
    titleA: HEADER_A,
    titleB: HEADER_B,
    merged: {
      category: 'research',
      title: '读码优先 + 借鉴查许可',
      suggestion: '先读码再下结论，借鉴要查许可',
      evidence: ['综合证据 1', '综合证据 2'],
    },
  })

  it('产出删二增一的教训变更候选', async () => {
    const p = await produceCrossoverProposal(textLlm(JSON_RESULT), LESSONS, '2026-08-28')
    expect(p).not.toBeNull()
    expect(p!.filePath).toBe('apps/cli/crsi-lessons.md')
    expect(p!.blastRadius).toEqual(['apps/cli/crsi-lessons.md'])
    expect(p!.originalContent).toBe(LESSONS)
    expect(p!.newContent).not.toContain(HEADER_A)
    expect(p!.newContent).not.toContain(HEADER_B)
    expect(p!.newContent).toContain('读码优先 + 借鉴查许可')
    expect(p!.newContent).toContain('综合证据 1')
    expect(p!.newContent).toContain('CRSI producer (crossover)')
  })

  it('titleA 不在文件 → null（防幻觉）', async () => {
    const bad = JSON.stringify({
      titleA: 'nonexistent: x',
      titleB: HEADER_A,
      merged: { category: 'c', title: 't', suggestion: 's', evidence: [] },
    })
    expect(await produceCrossoverProposal(textLlm(bad), LESSONS, '2026-08-28')).toBeNull()
  })

  it('titleA === titleB → null', async () => {
    const same = JSON.stringify({
      titleA: HEADER_A,
      titleB: HEADER_A,
      merged: { category: 'c', title: 't', suggestion: 's', evidence: [] },
    })
    expect(await produceCrossoverProposal(textLlm(same), LESSONS, '2026-08-28')).toBeNull()
  })

  it('LLM 返回空 → null', async () => {
    expect(await produceCrossoverProposal(textLlm(''), LESSONS, '2026-08-28')).toBeNull()
  })
})
````

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/crsi-producer-crossover.test.ts`
Expected: FAIL（`parseCrossoverResult` / `removeLessonSections` / `produceCrossoverProposal` 未导出；`buildLessonContent` 无 `source` 参数）。

- [ ] **Step 3: 改 `buildLessonContent` 加 `source` 参数**

`apps/cli/src/core/crsi-producer.ts` 的 `buildLessonContent`（约 line 70-81）改为：

```typescript
export function buildLessonContent(
  signal: CrsiSignal,
  timestamp: string,
  source = 'CRSI producer (autoApplicable)',
): string {
  const lines: string[] = [
    `## ${signal.category}: ${signal.title}`,
    '',
    `- 建议: ${signal.suggestion}`,
  ]
  if (signal.severity) lines.push(`- 严重度: ${signal.severity}`)
  lines.push(`- 生成时间: ${timestamp}`, `- 来源: ${source}`, '', '### 证据')
  for (const e of signal.evidence) lines.push(`- ${e}`)
  lines.push('')
  return lines.join('\n')
}
```

- [ ] **Step 4: 追加 crossover 段到 `crsi-producer.ts` 末尾**

在文件末尾（`clearProseProposals` 之后）追加：

````typescript
// ── Producer Crossover（第 4 原子算子）：合并两条重叠教训 ──
// LLM 只生成（选对 + 合并版），判定全走确定性 guard + 沙箱 gate。A1 不破：无 LLM 自评。

const CROSSOVER_PROMPT_VERSION = '1.0.0'

function buildCrossoverPrompt(currentLessons: string): string {
  return [
    `你是 CRSI producer（producer-crossover v${CROSSOVER_PROMPT_VERSION}）。给定当前教训文件，找出两条主题重叠、可合并的教训，生成一条综合教训。`,
    '',
    '当前教训文件：',
    currentLessons,
    '',
    '要求：',
    '1. 找两条「主题重叠」的教训（例如都讲「读码优先」、都讲「隔离」），不要选主题无关的两条。',
    '2. titleA / titleB 必须是文件中 `## ` 行的**完整文本**（含 category 前缀，逐字复制，不要改写）。',
    '3. merged 是合并后的综合教训：category 沿用其中一个、title 概括两者、suggestion 综合两条的核心建议、evidence 综合两条的证据要点。',
    '4. 只返回裸 JSON（不要 markdown 围栏、不要其他文字），格式：',
    '{"titleA":"<完整 ## 行1>","titleB":"<完整 ## 行2>","merged":{"category":"...","title":"...","suggestion":"...","evidence":["...","..."]}}',
  ].join('\n')
}

/** 剥 ```json 围栏（LLM 可能加）。 */
function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/)
  return match ? match[1]! : text
}

/** Crossover 结果：两条教训的完整 ## 行 + 合并版。 */
export interface CrossoverResult {
  titleA: string
  titleB: string
  merged: CrsiSignal
}

/** 解析 crossover 结果；非法 / 字段缺失 → null。 */
export function parseCrossoverResult(text: string): CrossoverResult | null {
  try {
    const obj = JSON.parse(stripJsonFence(text))
    if (typeof obj.titleA !== 'string' || typeof obj.titleB !== 'string') return null
    if (
      !obj.merged ||
      typeof obj.merged.category !== 'string' ||
      typeof obj.merged.title !== 'string' ||
      typeof obj.merged.suggestion !== 'string'
    )
      return null
    const evidence = Array.isArray(obj.merged.evidence)
      ? obj.merged.evidence.filter((e: unknown) => typeof e === 'string')
      : []
    return {
      titleA: obj.titleA,
      titleB: obj.titleB,
      merged: {
        category: obj.merged.category,
        title: obj.merged.title,
        suggestion: obj.merged.suggestion,
        evidence,
      },
    }
  } catch {
    return null
  }
}

/** 从教训文件移除若干 `## ` 段（header 须是 `## ` 行完整文本）。preamble 与其余教训不动。 */
export function removeLessonSections(content: string, headers: string[]): string {
  const lines = content.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      skipping = headers.includes(line.trim())
      if (skipping) continue
    }
    if (skipping) continue
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Crossover：合并两条重叠教训 → 「删二增一」的教训文件变更候选。
 * LLM 只生成（选对 + 合并版），guard 校验所选教训真实存在（fail-closed 防幻觉）。
 */
export async function produceCrossoverProposal(
  llm: Llm,
  currentLessons: string,
  timestamp: string,
): Promise<{
  description: string
  filePath: string
  newContent: string
  originalContent: string
  blastRadius: string[]
} | null> {
  const response = await collectLlmText(llm, buildCrossoverPrompt(currentLessons))
  if (!response) return null

  const parsed = parseCrossoverResult(response)
  if (!parsed) return null

  const headerA = `## ${parsed.titleA}`
  const headerB = `## ${parsed.titleB}`
  if (parsed.titleA === parsed.titleB) return null
  if (!currentLessons.includes(headerA) || !currentLessons.includes(headerB)) return null

  const withoutTwo = removeLessonSections(currentLessons, [headerA, headerB])
  const mergedSection = buildLessonContent(parsed.merged, timestamp, 'CRSI producer (crossover)')
  const newContent = `${withoutTwo.trimEnd()}\n\n${mergedSection}\n`

  return {
    description: `CRSI crossover: ${parsed.titleA} + ${parsed.titleB}`,
    filePath: LESSONS_FILE,
    newContent,
    originalContent: currentLessons,
    blastRadius: [LESSONS_FILE],
  }
}
````

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/crsi-producer-crossover.test.ts test/core/crsi-producer.test.ts`
Expected: PASS（crossover 10 测试绿 + 现有 producer 测试仍绿——`buildLessonContent` 加可选参数零破坏）。

- [ ] **Step 6: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error。

- [ ] **Step 7: Commit**

```bash
cd apps/cli && git add src/core/crsi-producer.ts test/core/crsi-producer-crossover.test.ts
git commit -m "feat(crsi): Crossover 算子——LLM 选重叠教训 + 确定性合并（第 4 原子算子）

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 2: `/crsi propose --crossover` 命令接线

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`

**Interfaces:**

- Consumes: `produceCrossoverProposal`（crsi-producer.ts，Task 1 产出）、`LESSONS_FILE`（已 import）、`runCrsiModification`（已 import）
- Produces: `/crsi propose --crossover` 入口

- [ ] **Step 1: import 加 `produceCrossoverProposal`**

`commands.ts` 顶部 crsi-producer import（约 line 18-29），在 `produceProseProposal` 之后加：

```typescript
  produceCrossoverProposal,
```

- [ ] **Step 2: 加 `--crossover` 分支**

`crsiProposeCmd` 内，在 `--rule` 分支结束（约 line 974）之后、默认教训路径（`// ── 教训路径（默认）` 约 line 976）之前插入：

```typescript
// ── Crossover 路径：/crsi propose --crossover 合并两条重叠教训 ──
if (args[0] === '--crossover') {
  const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
  let current = ''
  try {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    current = readFileSync(join(root, LESSONS_FILE), 'utf-8')
  } catch {
    current = ''
  }
  if (!current) {
    return { content: '教训文件为空，无可合并。' }
  }

  const proposal = await produceCrossoverProposal(llm, current, new Date().toISOString())
  if (!proposal) {
    return { content: '没有找到可合并的重叠教训对。' }
  }

  const result = await runCrsiModification(proposal)
  if (!result.applied || result.phase === 'failed') {
    return { content: `❌ 合并失败（phase: ${result.phase}）。\n${result.error ?? ''}` }
  }

  return {
    content:
      `✅ 已生成合并教训并跑过测试。审阅 diff：\n\n${result.diff}\n\n` +
      '/crsi modify --approve 合并 | /crsi modify --reject 丢弃',
  }
}
```

- [ ] **Step 3: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error（`runCrsiModification` 已 async，`await` 已加；`produceCrossoverProposal` 签名匹配）。

- [ ] **Step 4: 全量回归**

Run: `cd apps/cli && pnpm test`
Expected: 全绿（无新增单元测试——命令是薄接线层，算子已在 Task 1 测过）。

- [ ] **Step 5: Commit**

```bash
cd apps/cli && git add src/ui/commands.ts
git commit -m "feat(crsi): /crsi propose --crossover 命令——合并两条重叠教训

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Self-Review

- **Spec 覆盖**：§3.1（算子签名/流程）→ Task 1 Step 4；§3.2（prompt）→ Task 1 Step 4 `buildCrossoverPrompt`；§3.3（纯函数）→ Task 1 Step 4 `stripJsonFence`/`parseCrossoverResult`/`removeLessonSections`；§3.4（命令）→ Task 2 Step 2；§六（测试）→ Task 1 Step 1。
- **占位符扫描**：无 TBD/TODO；每步给完整可跑代码。
- **类型一致性**：`CrossoverResult`/`parseCrossoverResult`/`removeLessonSections`/`produceCrossoverProposal` 在 Task 1 定义，Task 2 与测试消费同名同形；`buildLessonContent` 加可选 `source` 参数（默认 autoApplicable），现有调用零改动。
- **A1 不破**：LLM 只生成，guard（parse + includes）+ 沙箱 gate 判定（§Global Constraints）。
- **Reconciliation 落实**：`buildLessonContent` 加 `source` 参数（§Reconciliation #1）；`collectLlmText` 复用 `model:'prose'` 不改（§Reconciliation #2）。
