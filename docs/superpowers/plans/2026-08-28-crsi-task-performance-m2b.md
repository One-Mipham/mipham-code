# CRSI 任务表现评估 M2b（before/after 接线）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 造 `measureSkillDelta`（给定改 skill 的 proposal，自动测 before/after 任务表现 delta），并接进 `/crsi modify` 命令，让每次 skill 自改进都附带改进信号。

**Architecture:** 独立 async 函数 `measureSkillDelta`（加到 `task-performance.ts`），复用 `loader.ts` 的 `parseFrontmatter`；`runCrsiModification` **零改动**，delta 测量在命令层（`/crsi modify`）独立完成。

**Tech Stack:** Bun、Vitest、TypeScript strict、JSON import。

**Spec:** `docs/superpowers/specs/2026-08-28-crsi-task-performance-m2b-design.md`

## Global Constraints

- A1 铁律：判定环节零 LLM 裁判——`measureSkillDelta` 只调 `runTaskPerformance`（LLM 生成 + 冻结测试判定）。
- `runCrsiModification` 零改动（保持同步、无 LLM 依赖）。
- 路径门只认内置 `apps/cli/skills/`；frontmatter 解析复用 `loader.ts` 的 `parseFrontmatter`。
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`。
- 测试：`cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`；typecheck：`cd apps/cli && pnpm typecheck`。

---

## File Structure

| 文件                                          | 动作   | 职责                               |
| --------------------------------------------- | ------ | ---------------------------------- |
| `apps/cli/src/skills/loader.ts`               | Modify | 导出 `parseFrontmatter`（现私有）  |
| `apps/cli/src/core/task-performance.ts`       | Modify | `SkillDelta` + `measureSkillDelta` |
| `apps/cli/test/core/task-performance.test.ts` | Modify | 单测（路径门/嗅/guard/delta）      |
| `apps/cli/src/ui/commands.ts`                 | Modify | `/crsi modify` 接线 delta 显示     |

---

## Task 1: `measureSkillDelta` 函数 + frontmatter 导出

**Files:**

- Modify: `apps/cli/src/skills/loader.ts`（导出 `parseFrontmatter`）
- Modify: `apps/cli/src/core/task-performance.ts`（`SkillDelta` + `measureSkillDelta`）
- Test: `apps/cli/test/core/task-performance.test.ts`

**Interfaces:**

- Consumes: `runTaskPerformance` / `loadPerformanceTasks`（同文件）、`parseFrontmatter`（loader.ts）
- Produces:
  - `interface SkillDelta { skillName: string; baseline: TaskPerformanceReport; post: TaskPerformanceReport; delta: number }`
  - `async function measureSkillDelta(llm, proposal: { filePath; originalContent?; newContent }): Promise<SkillDelta | null>`

- [ ] **Step 1: 导出 `parseFrontmatter`**

`apps/cli/src/skills/loader.ts` 的 `parseFrontmatter`（约 line 15）：

```typescript
// 改前：
function parseFrontmatter(raw: string): FrontmatterResult {
// 改后：
export function parseFrontmatter(raw: string): FrontmatterResult {
```

- [ ] **Step 2: 写失败测试**

在 `apps/cli/test/core/task-performance.test.ts` 追加：

```typescript
import { measureSkillDelta } from '../../src/core/task-performance'

describe('measureSkillDelta', () => {
  const skillFile = 'apps/cli/skills/standard/safe-coding.SKILL.md'

  it('非 skill 文件 → null', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const delta = await measureSkillDelta(mockLlm, {
      filePath: 'apps/cli/src/foo.ts',
      originalContent: 'x',
      newContent: 'y',
    })
    expect(delta).toBeNull()
  })

  it('skill 文件但无绑定任务 → null', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const content = '---\nname: no-such-task-skill\ndescription: x\n---\nbody'
    const delta = await measureSkillDelta(mockLlm, {
      filePath: 'apps/cli/skills/standard/no-such-task-skill.SKILL.md',
      newContent: content,
    })
    expect(delta).toBeNull()
  })

  it('safe-coding 强 skill → delta > 0', async () => {
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
    const delta = await measureSkillDelta(mockLlm, {
      filePath: skillFile,
      originalContent: weak,
      newContent: strong,
    })
    expect(delta).not.toBeNull()
    expect(delta!.skillName).toBe('safe-coding')
    expect(delta!.delta).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: FAIL（`measureSkillDelta is not a function`）

- [ ] **Step 4: 实现 `measureSkillDelta`**

在 `apps/cli/src/core/task-performance.ts` 顶部加 import + 文件末尾加实现：

```typescript
import { readFileSync } from 'node:fs'
import { parseFrontmatter } from '../skills/loader'
```

```typescript
export interface SkillDelta {
  skillName: string
  baseline: TaskPerformanceReport
  post: TaskPerformanceReport
  delta: number
}

/** 路径门：只认内置 skill 文件。 */
function isSkillFile(filePath: string): boolean {
  return (
    filePath.startsWith('apps/cli/skills/') &&
    (filePath.endsWith('.SKILL.md') || filePath.endsWith('.mipham-skill.md'))
  )
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
  if (!isSkillFile(proposal.filePath)) return null

  const newParsed = parseFrontmatter(proposal.newContent)
  const skillName = typeof newParsed.data.name === 'string' ? newParsed.data.name : undefined
  if (!skillName) return null

  if (!loadPerformanceTasks().some((t) => t.skill === skillName)) return null

  const baselineText = proposal.originalContent
    ? parseFrontmatter(proposal.originalContent).content
    : parseFrontmatter(readFileSync(proposal.filePath, 'utf-8')).content

  const baseline = await runTaskPerformance(llm, { skill: { name: skillName, text: baselineText } })
  const post = await runTaskPerformance(llm, {
    skill: { name: skillName, text: newParsed.content },
  })

  return {
    skillName,
    baseline,
    post,
    delta: post.score - baseline.score,
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: PASS（3 个 measureSkillDelta 测试绿）

- [ ] **Step 6: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error

- [ ] **Step 7: Commit**

```bash
cd apps/cli && git add src/skills/loader.ts src/core/task-performance.ts test/core/task-performance.test.ts
git commit -m "feat(crsi): 任务表现评估 M2b——measureSkillDelta（before/after 测量）

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 2: `/crsi modify` 接线 delta 显示

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`（`crsiModifyCmd`）

**Interfaces:**

- Consumes: `measureSkillDelta`（Task 1）、`ctx.engine.getLlm() ?? ctx.engine.getRegistry()`
- Produces: `crsiModifyCmd` 在结果里附带 delta（非 null 时）

- [ ] **Step 1: 在 `crsiModifyCmd` 里加 delta 测量**

`apps/cli/src/ui/commands.ts` 的 `crsiModifyCmd`（约 line 763）。在 `const result = runCrsiModification(...)` 之前插入：

```typescript
const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
const delta = await measureSkillDelta(llm, { filePath, originalContent, newContent })
```

并在成功返回（`✅ 测试通过` 那段）里，当 `delta` 非 null 时追加一行：

```typescript
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

（注意：`deltaLine` 为 null 时为空字符串，输出格式对非 skill proposal 不变。）

- [ ] **Step 2: 顶部导入 `measureSkillDelta`**

`commands.ts` 顶部 `import { runTaskPerformance } from '../core/task-performance'` 那行改为：

```typescript
import { runTaskPerformance, measureSkillDelta } from '../core/task-performance'
```

- [ ] **Step 3: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error

- [ ] **Step 4: 手跑验证（可选，需真实 LLM）**

Run: `/crsi modify <desc> apps/cli/skills/standard/safe-coding.SKILL.md <newContent>`
Expected: 结果里出现「📈 改进信号 delta」行（对 safe-coding proposal）。

（对非 skill proposal，无 delta 行——行为与 M2b 前一致。）

- [ ] **Step 5: Commit**

```bash
cd apps/cli && git add src/ui/commands.ts
git commit -m "feat(crsi): /crsi modify 接线 measureSkillDelta——skill 自改进附带 delta

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Self-Review

- **Spec 覆盖**：spec §3.1（`SkillDelta` + `measureSkillDelta`）→ Task 1 Step 4；§3.2（路径门 + frontmatter 嗅 + 复用 parseFrontmatter）→ Task 1 Step 1/4；§3.3（before/after + guard）→ Task 1 Step 4；§3.4（`/crsi modify` 接线）→ Task 2；§六 测试 → Task 1 Step 2。
- **占位符扫描**：无 TBD/TODO；每步给完整可跑代码。
- **类型一致性**：`measureSkillDelta(llm, { filePath, originalContent?, newContent })` 在 Task 1 Step 4 定义、Task 2 调用处签名一致；`SkillDelta` 字段 `skillName/baseline/post/delta` 一致。
- **runCrsiModification 零改动**：Task 1/2 均未碰 `crsi-modify.ts`（符合 spec 非目标）。
