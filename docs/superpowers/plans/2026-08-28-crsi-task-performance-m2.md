# CRSI 任务表现评估 M2（skill 注入 + safe-coding 试点）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给任务表现评估器加 skill 注入能力 + 一个能冻结成确定性测试的 `safe-coding` 试点，独立验证「改 skill → 分数变」的 delta 真实存在（standalone-first，不接 `runCrsiModification`）。

**Architecture:** 扩展 `runTaskPerformance` 支持 `skill: { name, text }` 注入（`text` 走 `ChatRequest.systemPrompt`）+ 按 skill 名过滤任务；新增真实 `safe-coding.SKILL.md`（进产品）+ 一个绑定它的任务；`/crsi bench --skill` 手动入口。

**Tech Stack:** Bun、Vitest、TypeScript strict、JSON import（`with { type: 'json' }`）。

**Spec:** `docs/superpowers/specs/2026-08-28-crsi-task-performance-m2-design.md`

## Global Constraints

- A1 铁律：判定环节零 LLM 裁判——LLM 只在「生成代码」阶段，判定是冻结测试的确定性 pass/fail（`bun test` exit 0）。
- skill 注入走 `ChatRequest.systemPrompt`（skill 是指令，不是用户输入）。
- 无 `skill` 时行为不变（M1 通用基准：5 个算法任务）。
- 新增 skill 必须重新生成 `src/skills/bundled-skills.ts`（`bun run scripts/generate-bundled-skills.ts`）。
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`（项目 `COAUTHOR_TRAILER`）。
- 测试：`cd apps/cli && pnpm vitest run <file>`；typecheck：`cd apps/cli && pnpm typecheck`。

---

## File Structure

| 文件                                            | 动作   | 职责                              |
| ----------------------------------------------- | ------ | --------------------------------- |
| `apps/cli/src/core/task-performance.ts`         | Modify | 类型 + skill 注入 + 任务过滤      |
| `apps/cli/src/core/task-performance-tasks.json` | Modify | 新增 safe-coding 任务             |
| `apps/cli/test/core/task-performance.test.ts`   | Modify | 单测（注入 + 过滤）               |
| `apps/cli/skills/standard/safe-coding.SKILL.md` | Create | safe-coding 真实 skill（进产品）  |
| `apps/cli/src/skills/bundled-skills.ts`         | Modify | 重新生成（脚本产出，勿手编）      |
| `apps/cli/test/tools/skills.test.ts`            | Modify | 内置 skill 计数 26→27、20→21      |
| `apps/cli/src/ui/commands.ts`                   | Modify | `/crsi bench --skill <name>` 入口 |

---

## Task 1: schema 扩展 + safe-coding 任务 JSON

**Files:**

- Modify: `apps/cli/src/core/task-performance.ts`（`PerformanceTask` 加 `skill?`）
- Modify: `apps/cli/src/core/task-performance-tasks.json`（新增 safe-coding 任务）
- Test: `apps/cli/test/core/task-performance.test.ts`

**Interfaces:**

- Consumes: 无（沿用 M1 已建 `PerformanceTask` / `loadPerformanceTasks`）
- Produces:
  - `interface PerformanceTask { id; category; prompt; testCode; skill?: string }`（`skill?` 为本任务新增）
  - `task-performance-tasks.json` 含 6 个任务（5 通用 + 1 safe-coding）

- [ ] **Step 1: 写失败测试**

在 `apps/cli/test/core/task-performance.test.ts` 的 `describe('loadPerformanceTasks')` 内追加：

```typescript
it('safe-coding 任务带 skill 字段', () => {
  const tasks = loadPerformanceTasks()
  const safe = tasks.find((t) => t.id === 'perf-safe-parse-positive')
  expect(safe).toBeDefined()
  expect(safe?.skill).toBe('safe-coding')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: FAIL（`safe` 为 undefined，`expect(safe).toBeDefined()` 失败）

- [ ] **Step 3: 扩展 `PerformanceTask` 类型**

`apps/cli/src/core/task-performance.ts` 的 `PerformanceTask` 接口加一行：

```typescript
export interface PerformanceTask {
  id: string
  category: PerformanceTaskCategory
  prompt: string
  testCode: string
  skill?: string // 绑定被测 skill 的名字（= skill frontmatter name）
}
```

- [ ] **Step 4: 新增 safe-coding 任务到 JSON**

在 `apps/cli/src/core/task-performance-tasks.json` 的 `tasks` 数组末尾追加：

```json
{
  "id": "perf-safe-parse-positive",
  "category": "test-driven",
  "skill": "safe-coding",
  "prompt": "实现并导出 parsePositiveNumber 函数：export function parsePositiveNumber(input: string): number。只输出 TypeScript 代码，不要解释、不要 markdown 代码块。",
  "testCode": "import { test, expect } from 'bun:test'\nimport { parsePositiveNumber } from './solution'\n\ntest('rejects invalid input', () => {\n  expect(() => parsePositiveNumber(null as any)).toThrow(RangeError)\n  expect(() => parsePositiveNumber('')).toThrow(RangeError)\n  expect(() => parsePositiveNumber('abc')).toThrow(RangeError)\n})\ntest('parses valid', () => {\n  expect(parsePositiveNumber('42')).toBe(42)\n})\n"
}
```

（注意：`tasks` 数组最后一个对象后要加逗号分隔。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: PASS（safe-coding 任务带 skill 字段；6 个任务 id 仍唯一）

- [ ] **Step 6: Commit**

```bash
cd apps/cli && git add src/core/task-performance.ts src/core/task-performance-tasks.json test/core/task-performance.test.ts
git commit -m "feat(crsi): 任务表现评估 M2——schema 加 skill 字段 + safe-coding 任务

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 2: skill 注入 + 任务过滤

**Files:**

- Modify: `apps/cli/src/core/task-performance.ts`
- Test: `apps/cli/test/core/task-performance.test.ts`

**Interfaces:**

- Consumes: `PerformanceTask.skill?`（Task 1）、`loadPerformanceTasks`、`collectGeneratedCode`（本文件私有）
- Produces:
  - `runTaskPerformance(llm, opts?: { timeoutMs?: number; skill?: { name: string; text: string } })`
  - 过滤语义：`(t.skill ?? undefined) === opts?.skill?.name`；无 skill 只跑无 skill 字段的任务
  - 注入语义：`skill.text` 作为 `systemPrompt` 传给 `llm.chat`

- [ ] **Step 1: 写失败测试**

在 `apps/cli/test/core/task-performance.test.ts` 追加（`runTaskPerformance` 相关）：

```typescript
describe('runTaskPerformance skill 过滤与注入', () => {
  it('无 skill 只跑通用任务（5 个）', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield {
          type: 'text',
          content:
            'export function quicksort(arr: number[]): number[] { return [...arr].sort((a, b) => a - b) }',
        }
      },
    }
    const report = await runTaskPerformance(mockLlm)
    expect(report.total).toBe(5)
    expect(report.results.some((r) => r.id === 'perf-safe-parse-positive')).toBe(false)
  })

  it('指定 skill 只跑绑定该 skill 的任务', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield {
          type: 'text',
          content:
            'export function parsePositiveNumber(input: string): number { return Number(input) }',
        }
      },
    }
    const report = await runTaskPerformance(mockLlm, {
      skill: { name: 'safe-coding', text: '校验输入' },
    })
    expect(report.total).toBe(1)
    expect(report.results[0]?.id).toBe('perf-safe-parse-positive')
  })

  it('有 skill 时把 skill 正文作为 systemPrompt 注入', async () => {
    let captured: { systemPrompt?: string } | null = null
    const mockLlm: Llm = {
      chat: async function* (req) {
        captured = req
        yield {
          type: 'text',
          content:
            'export function parsePositiveNumber(input: string): number { return Number(input) }',
        }
      },
    }
    await runTaskPerformance(mockLlm, {
      skill: { name: 'safe-coding', text: '必须校验输入' },
    })
    expect(captured?.systemPrompt).toBe('必须校验输入')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: FAIL（`report.total` 是 6 不是 5；`systemPrompt` 为 undefined）

- [ ] **Step 3: 改 `collectGeneratedCode` 支持 systemPrompt**

`apps/cli/src/core/task-performance.ts` 中：

```typescript
async function collectGeneratedCode(
  llm: Llm,
  prompt: string,
  systemPrompt?: string,
): Promise<string> {
  let text = ''
  const req = {
    model: '', // falsy → registry 回退到 active model
    messages: [{ role: 'user' as const, content: prompt }],
    temperature: 0, // 温度 0，近确定
    ...(systemPrompt ? { systemPrompt } : {}),
  }
  for await (const chunk of llm.chat(req)) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  return stripCodeFences(text)
}
```

- [ ] **Step 4: 改 `runTaskPerformance` 加过滤 + 注入**

`apps/cli/src/core/task-performance.ts` 中：

```typescript
export async function runTaskPerformance(
  llm: Llm,
  opts?: { timeoutMs?: number; skill?: { name: string; text: string } },
): Promise<TaskPerformanceReport> {
  const wanted = opts?.skill?.name
  const tasks = loadPerformanceTasks().filter((t) => (t.skill ?? undefined) === wanted)
  const results: TaskPerformanceResult[] = []
  for (const task of tasks) {
    const code = await collectGeneratedCode(llm, task.prompt, opts?.skill?.text)
    if (!code) {
      results.push({
        id: task.id,
        description: task.prompt,
        passed: false,
        detail: 'LLM 未生成代码',
      })
      continue
    }
    const verdict = judgeGeneratedCode(task.testCode, code, opts)
    results.push({
      id: task.id,
      description: task.prompt,
      passed: verdict.passed,
      detail: verdict.detail,
    })
  }
  const passed = results.filter((r) => r.passed).length
  return {
    total: results.length,
    passed,
    score: results.length > 0 ? Math.round((passed / results.length) * 100) : 100,
    results,
    failures: results.filter((r) => !r.passed).map((r) => r.id),
  }
}
```

（改动点：`opts` 类型加 `skill`；`tasks` 换成 `loadPerformanceTasks().filter(...)`；`collectGeneratedCode` 传第三参 `opts?.skill?.text`。其余不变。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: PASS（5 通用 + 1 safe-coding + systemPrompt 注入，全绿）

- [ ] **Step 6: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error

- [ ] **Step 7: Commit**

```bash
cd apps/cli && git add src/core/task-performance.ts test/core/task-performance.test.ts
git commit -m "feat(crsi): 任务表现评估 M2——skill 注入 + 任务过滤

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 3: safe-coding skill 文件 + bundled 重生成 + 计数对齐

**Files:**

- Create: `apps/cli/skills/standard/safe-coding.SKILL.md`
- Modify: `apps/cli/src/skills/bundled-skills.ts`（脚本产出）
- Modify: `apps/cli/test/tools/skills.test.ts`（26→27、20→21）

**Interfaces:**

- Consumes: 无
- Produces: `safe-coding` 内置 skill（`SkillsLoader.get('safe-coding')?.body` 可取正文）

- [ ] **Step 1: 写 safe-coding skill**

`apps/cli/skills/standard/safe-coding.SKILL.md`：

```markdown
---
name: safe-coding
description: Safe coding rules for code generation — validate external/user input before use and throw RangeError on invalid input
version: 1.0.0
---

# Safe Coding

处理外部/用户输入前必须校验：`null`、`undefined`、空字符串、格式非法时，抛出 `RangeError`，消息为 `'invalid input'`。
```

- [ ] **Step 2: 重新生成 bundled-skills.ts**

Run: `cd apps/cli && bun run scripts/generate-bundled-skills.ts`
Expected: `bundled-skills.ts` 里出现 `name: safe-coding` 的条目（脚本输出 `bundled-skills.ts` + `bundled-skill-assets.ts`）

- [ ] **Step 3: 更新内置 skill 计数断言**

`apps/cli/test/tools/skills.test.ts` 的 `Built-in skills` describe 块：

```typescript
const all = loader.list()
expect(all.length).toBe(27) // 21 standard + 6 mipham

const standard = loader.listByType('standard')
expect(standard.length).toBe(21)

const mipham = loader.listByType('mipham')
expect(mipham.length).toBe(6)
```

（只改 `all` 26→27、`standard` 20→21；`mipham` 6 不变。）

- [ ] **Step 4: 跑 skills 测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/tools/skills.test.ts`
Expected: PASS（21 standard + 6 mipham = 27）

- [ ] **Step 5: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error

- [ ] **Step 6: Commit**

```bash
cd apps/cli && git add skills/standard/safe-coding.SKILL.md src/skills/bundled-skills.ts src/skills/bundled-skill-assets.ts test/tools/skills.test.ts
git commit -m "feat(crsi): 任务表现评估 M2——safe-coding 内置 skill

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 4: `/crsi bench --skill <name>` 入口

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`（`crsiBenchCmd`）

**Interfaces:**

- Consumes: `runTaskPerformance`（Task 2）、`ctx.skillsLoader?.get(name)?.body`（`CommandContext.skillsLoader?: SkillsLoader`）
- Produces: `crsiBenchCmd(ctx, args)` 支持 `args` 里的 `--skill <name>`

- [ ] **Step 1: 改 `crsiBenchCmd` 解析 --skill 并注入**

`apps/cli/src/ui/commands.ts` 中（当前 `crsiBenchCmd` 约 line 974）：

```typescript
const crsiBenchCmd: CommandHandler = async (ctx, args) => {
  const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()

  const skillIdx = args.indexOf('--skill')
  const skillName = skillIdx >= 0 ? args[skillIdx + 1] : undefined
  let skill: { name: string; text: string } | undefined
  if (skillName) {
    const body = ctx.skillsLoader?.get(skillName)?.body
    if (!body) {
      return { content: `❌ 未找到 skill: ${skillName}` }
    }
    skill = { name: skillName, text: body }
  }

  const report = await runTaskPerformance(llm, skill ? { skill } : undefined)

  const lines: string[] = [
    '## 🎯 CRSI 任务表现基准' + (skill ? `（skill: ${skill.name}）` : ''),
    '',
  ]
  lines.push(`得分: **${report.score}/100** (${report.passed}/${report.total})`, '')
  lines.push('| 任务 | 结果 |')
  lines.push('|------|------|')
  for (const r of report.results) {
    lines.push(
      `| ${r.description.slice(0, 60)} | ${r.passed ? '✅' : '❌'}${r.detail ? ` — ${r.detail.slice(0, 80)}` : ''} |`,
    )
  }
  if (report.failures.length > 0) {
    lines.push('', `❌ 失败任务: ${report.failures.join(', ')}`)
  }
  return { content: lines.join('\n') }
}
```

（改动点：签名加 `args`；解析 `--skill`；加载 skill body；标题带 skill 名。其余逻辑不变。）

- [ ] **Step 2: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error

- [ ] **Step 3: 手跑验证（需真实 LLM 配置）**

Run: `/crsi bench` → 输出 5 通用任务 + 得分（M1 行为不变）
Run: `/crsi bench --skill safe-coding` → 输出 1 个 safe-coding 任务 + 得分

Expected: 后者标题带 `（skill: safe-coding）`，只跑 1 个任务。

- [ ] **Step 4: Commit**

```bash
cd apps/cli && git add src/ui/commands.ts
git commit -m "feat(crsi): /crsi bench --skill 入口——任务表现基准按 skill 跑

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## 收尾：delta 手动验证（非代码任务）

实现完成后，用真实 LLM 跑一次 delta 验证（确认「弱 skill → fail、强 skill → pass」）：

```
弱版 skill（无校验规则，一次性字符串）  → runTaskPerformance → 期望 fail（低分）
强版 skill（= safe-coding.SKILL.md）    → runTaskPerformance → 期望 pass（高分）
delta = 强 - 弱 > 0  → 机制验证通过
```

若 delta 非零，M2 达标，M2b（接进 `runCrsiModification`）另立计划。

---

## Self-Review

- **Spec 覆盖**：spec §3.1（skill 注入 systemPrompt）→ Task 2 Step 3；§3.2（task skill 字段 + 过滤）→ Task 1 Step 3/4 + Task 2 Step 4；§3.3（safe-coding skill）→ Task 3 Step 1；§3.4（safe-coding 任务）→ Task 1 Step 4；§3.5（bench --skill）→ Task 4；§五 M2 完整范围 → Task 1-4 + 收尾。§六 测试（注入 plumbing/任务过滤/冻结测试正确性/delta）→ Task 2 三测 + 收尾。
- **占位符扫描**：无 TBD/TODO；每步给完整可跑代码/JSON。
- **类型一致性**：`runTaskPerformance(llm, opts?: { timeoutMs?; skill?: { name; text } })` 在 Task 2 Step 4 定义、Task 4 调用处签名一致；`PerformanceTask.skill?` 在 Task 1 定义、Task 2 过滤引用一致；`skill` 名 `'safe-coding'` 在 JSON / skill frontmatter / 过滤 / bench 四处一致。
- **硬断言已对齐**：`skills.test.ts` 26→27、20→21（Task 3 Step 3），否则 CI 红。
- **bundled 重生成**：新增 skill 必跑 `generate-bundled-skills.ts`（Task 3 Step 2），对应 `mipham-code-bundled-skills-embed` 教训。
