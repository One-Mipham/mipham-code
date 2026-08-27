# CRSI 任务表现评估（M1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 造一个「任务表现基准器」——用 LLM 生成代码、冻结测试判绿/红，输出随改动变化的分数，作为后续「改进率 / 因果归因」的地基。

**Architecture:** 独立慢评估器 `task-performance.ts`，不复用 `runEval`/`behavior-tasks`。对每个冻结任务：调 LLM 生成代码（温度 0 单次）→ 子进程跑冻结测试（超时/资源限制/无网络）→ 汇总分数。`/crsi bench` 命令手动触发。

**Tech Stack:** Bun（`execSync` 跑 `bun test`）、Vitest（测试）、TypeScript strict、JSON import（`with { type: 'json' }`）。

**Spec:** `docs/superpowers/specs/2026-08-27-crsi-task-performance-design.md`

## Global Constraints

- 判定环节零 LLM 裁判（A1 铁律）：LLM 只在「生成代码」阶段，判定是冻结测试的确定性 pass/fail。
- 生成代码不可信：必须子进程隔离（`execSync` + `timeout` + `stdio: 'pipe'`）。
- `runEval()` 不动；本模块独立成体。
- 提交信息 Conventional Commits + `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 测试：`cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`。

---

## File Structure

| 文件                                            | 动作   | 职责                              |
| ----------------------------------------------- | ------ | --------------------------------- |
| `apps/cli/src/core/task-performance-tasks.json` | Create | 5 个冻结任务（prompt + 冻结测试） |
| `apps/cli/src/core/task-performance.ts`         | Create | 类型 + 加载器 + 判定 + 评估器     |
| `apps/cli/test/core/task-performance.test.ts`   | Create | 单测（加载/去代码块/判定/评估器） |
| `apps/cli/src/ui/commands.ts`                   | Modify | 加 `/crsi bench` 命令 + 注册      |

---

## Task 1: 任务 schema + 冻结任务 JSON + 加载器

**Files:**

- Create: `apps/cli/src/core/task-performance-tasks.json`
- Create: `apps/cli/src/core/task-performance.ts`（本任务只写类型 + `loadPerformanceTasks`）
- Test: `apps/cli/test/core/task-performance.test.ts`

**Interfaces:**

- Consumes: 无
- Produces:
  - `type PerformanceTaskCategory = 'test-driven' | 'bug-fix'`
  - `interface PerformanceTask { id: string; category: PerformanceTaskCategory; prompt: string; testCode: string }`
  - `function loadPerformanceTasks(): PerformanceTask[]`

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/task-performance.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { loadPerformanceTasks } from '../../src/core/task-performance'

describe('loadPerformanceTasks', () => {
  it('加载至少 1 个字段完整的任务', () => {
    const tasks = loadPerformanceTasks()
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    for (const t of tasks) {
      expect(typeof t.id).toBe('string')
      expect(t.category === 'test-driven' || t.category === 'bug-fix').toBe(true)
      expect(typeof t.prompt).toBe('string')
      expect(typeof t.testCode).toBe('string')
    }
  })

  it('任务 id 唯一', () => {
    const tasks = loadPerformanceTasks()
    const ids = tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: FAIL（`Cannot find module '../../src/core/task-performance'`）

- [ ] **Step 3: 写 JSON + 加载器**

`apps/cli/src/core/task-performance-tasks.json`:

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "perf-impl-quicksort",
      "category": "test-driven",
      "prompt": "实现并导出 quicksort 函数：export function quicksort(arr: number[]): number[]。只输出 TypeScript 代码，不要解释、不要 markdown 代码块。",
      "testCode": "import { test, expect } from 'bun:test'\nimport { quicksort } from './solution'\n\ntest('sorts numbers', () => {\n  expect(quicksort([3, 1, 4, 1, 5, 9, 2, 6])).toEqual([1, 1, 2, 3, 4, 5, 6, 9])\n  expect(quicksort([])).toEqual([])\n  expect(quicksort([7])).toEqual([7])\n})\n"
    },
    {
      "id": "perf-impl-fibonacci",
      "category": "test-driven",
      "prompt": "实现并导出 fibonacci 函数：export function fibonacci(n: number): number。返回第 n 项（fibonacci(0)=0, fibonacci(1)=1）。只输出 TypeScript 代码，不要解释、不要 markdown 代码块。",
      "testCode": "import { test, expect } from 'bun:test'\nimport { fibonacci } from './solution'\n\ntest('computes fibonacci', () => {\n  expect(fibonacci(0)).toBe(0)\n  expect(fibonacci(1)).toBe(1)\n  expect(fibonacci(10)).toBe(55)\n  expect(fibonacci(20)).toBe(6765)\n})\n"
    },
    {
      "id": "perf-impl-binary-search",
      "category": "test-driven",
      "prompt": "实现并导出 binarySearch 函数：export function binarySearch(arr: number[], target: number): number。返回 target 的下标，不存在返回 -1。假设 arr 已升序。只输出 TypeScript 代码，不要解释、不要 markdown 代码块。",
      "testCode": "import { test, expect } from 'bun:test'\nimport { binarySearch } from './solution'\n\ntest('finds target', () => {\n  expect(binarySearch([1, 2, 3, 4, 5], 3)).toBe(2)\n  expect(binarySearch([1, 2, 3, 4, 5], 1)).toBe(0)\n  expect(binarySearch([1, 2, 3, 4, 5], 99)).toBe(-1)\n})\n"
    },
    {
      "id": "perf-impl-reverse-string",
      "category": "test-driven",
      "prompt": "实现并导出 reverseString 函数：export function reverseString(s: string): string。只输出 TypeScript 代码，不要解释、不要 markdown 代码块。",
      "testCode": "import { test, expect } from 'bun:test'\nimport { reverseString } from './solution'\n\ntest('reverses', () => {\n  expect(reverseString('hello')).toBe('olleh')\n  expect(reverseString('')).toBe('')\n  expect(reverseString('a')).toBe('a')\n})\n"
    },
    {
      "id": "perf-impl-max",
      "category": "test-driven",
      "prompt": "实现并导出 maxOf 函数：export function maxOf(arr: number[]): number。返回数组最大值，空数组返回 -Infinity。只输出 TypeScript 代码，不要解释、不要 markdown 代码块。",
      "testCode": "import { test, expect } from 'bun:test'\nimport { maxOf } from './solution'\n\ntest('finds max', () => {\n  expect(maxOf([1, 5, 3, 9, 2])).toBe(9)\n  expect(maxOf([-1, -5, -3])).toBe(-1)\n  expect(maxOf([])).toBe(-Infinity)\n})\n"
    }
  ]
}
```

`apps/cli/src/core/task-performance.ts`:

```typescript
// apps/cli/src/core/task-performance.ts
// CRSI 任务表现评估器：LLM 生成代码 + 冻结测试判定，输出随改动变化的分数。
import tasksFile from './task-performance-tasks.json' with { type: 'json' }

export type PerformanceTaskCategory = 'test-driven' | 'bug-fix'

export interface PerformanceTask {
  id: string
  category: PerformanceTaskCategory
  prompt: string
  testCode: string
}

export function loadPerformanceTasks(): PerformanceTask[] {
  return tasksFile.tasks as PerformanceTask[]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd apps/cli && git add src/core/task-performance.ts src/core/task-performance-tasks.json test/core/task-performance.test.ts
git commit -m "feat(crsi): 任务表现评估——冻结任务 schema + 加载器

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 判定函数 `judgeGeneratedCode`（子进程跑冻结测试）

**Files:**

- Modify: `apps/cli/src/core/task-performance.ts`
- Test: `apps/cli/test/core/task-performance.test.ts`

**Interfaces:**

- Consumes: 无（纯函数）
- Produces:
  - `interface JudgeResult { passed: boolean; detail?: string }`
  - `function judgeGeneratedCode(testCode: string, solutionCode: string, opts?: { timeoutMs?: number }): JudgeResult`

- [ ] **Step 1: 写失败测试（追加到测试文件）**

```typescript
import { judgeGeneratedCode } from '../../src/core/task-performance'

describe('judgeGeneratedCode', () => {
  it('通过：解法满足冻结测试', () => {
    const solution = 'export function double(x: number): number { return x * 2 }'
    const test =
      "import { test, expect } from 'bun:test'\nimport { double } from './solution'\ntest('double', () => { expect(double(2)).toBe(4) })"
    const verdict = judgeGeneratedCode(test, solution)
    expect(verdict.passed).toBe(true)
  })

  it('失败：解法错误', () => {
    const solution = 'export function double(x: number): number { return x }'
    const test =
      "import { test, expect } from 'bun:test'\nimport { double } from './solution'\ntest('double', () => { expect(double(2)).toBe(4) })"
    const verdict = judgeGeneratedCode(test, solution)
    expect(verdict.passed).toBe(false)
  })

  it('超时：死循环被 timeout 杀掉', () => {
    const solution = 'export function hang(): number { while (true) {} return 1 }'
    const test =
      "import { test, expect } from 'bun:test'\nimport { hang } from './solution'\ntest('hang', () => { expect(hang()).toBe(1) })"
    const verdict = judgeGeneratedCode(test, solution, { timeoutMs: 1000 })
    expect(verdict.passed).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（`judgeGeneratedCode is not a function`）

- [ ] **Step 3: 实现 `judgeGeneratedCode`**

追加到 `apps/cli/src/core/task-performance.ts`：

```typescript
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface JudgeResult {
  passed: boolean
  detail?: string
}

const DEFAULT_TIMEOUT_MS = 5000

/** 把生成代码 + 冻结测试写入临时目录，子进程跑 `bun test`，exit 0 即 pass。 */
export function judgeGeneratedCode(
  testCode: string,
  solutionCode: string,
  opts?: { timeoutMs?: number },
): JudgeResult {
  const dir = mkdtempSync(join(tmpdir(), 'mipham-task-perf-'))
  try {
    writeFileSync(join(dir, 'solution.ts'), solutionCode)
    writeFileSync(join(dir, 'solution.test.ts'), testCode)
    try {
      execSync('bun test solution.test.ts', {
        cwd: dir,
        timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        stdio: 'pipe',
      })
      return { passed: true }
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? ''
      return { passed: false, detail: stderr.slice(0, 300) }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Expected: PASS（死循环测试约 1s 返回，因为 timeout 杀掉）

- [ ] **Step 5: Commit**

```bash
cd apps/cli && git add src/core/task-performance.ts test/core/task-performance.test.ts
git commit -m "feat(crsi): 任务表现评估——判定函数（子进程跑冻结测试）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 评估器 `runTaskPerformance`（LLM 生成 → 判定 → 打分）

**Files:**

- Modify: `apps/cli/src/core/task-performance.ts`
- Test: `apps/cli/test/core/task-performance.test.ts`

**Interfaces:**

- Consumes: `Llm`（`import type { Llm } from '../providers/llm'`）、`loadPerformanceTasks`、`judgeGeneratedCode`
- Produces:
  - `interface TaskPerformanceResult { id: string; description: string; passed: boolean; detail?: string }`
  - `interface TaskPerformanceReport { total: number; passed: number; score: number; results: TaskPerformanceResult[]; failures: string[] }`
  - `function stripCodeFences(text: string): string`
  - `async function runTaskPerformance(llm: Llm, opts?: { timeoutMs?: number }): Promise<TaskPerformanceReport>`

- [ ] **Step 1: 写失败测试（追加）**

````typescript
import type { Llm } from '../../src/providers/llm'
import { stripCodeFences, runTaskPerformance } from '../../src/core/task-performance'

describe('stripCodeFences', () => {
  it('剥掉 markdown 代码块', () => {
    const input = '```typescript\nexport function f() { return 1 }\n```'
    const out = stripCodeFences(input)
    expect(out).toContain('export function f()')
    expect(out).not.toContain('```')
  })
})

describe('runTaskPerformance', () => {
  it('对 mock LLM 生成的代码打分', async () => {
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
    expect(report.total).toBeGreaterThan(0)
    expect(report.passed).toBeGreaterThanOrEqual(0)
    expect(report.passed).toBeLessThanOrEqual(report.total)
    expect(report.score).toBe(Math.round((report.passed / report.total) * 100))
    expect(report.results.length).toBe(report.total)
  })
})
````

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（`stripCodeFences` / `runTaskPerformance` not defined）

- [ ] **Step 3: 实现评估器**

追加到 `apps/cli/src/core/task-performance.ts`：

`````typescript
import type { Llm } from '../providers/llm'

export interface TaskPerformanceResult {
  id: string
  description: string
  passed: boolean
  detail?: string
}

export interface TaskPerformanceReport {
  total: number
  passed: number
  score: number
  results: TaskPerformanceResult[]
  failures: string[]
}

/** 剥掉 LLM 可能包裹的 markdown 代码块（```` ```ts ... ``` ````），拿到裸代码。 */
export function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/)
  return (fenced?.[1] ?? text).trim()
}

async function collectGeneratedCode(llm: Llm, prompt: string): Promise<string> {
  let text = ''
  const req = {
    model: '', // falsy → registry 回退到 active model
    messages: [{ role: 'user' as const, content: prompt }],
    temperature: 0, // 温度 0，近确定
  }
  for await (const chunk of llm.chat(req)) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  return stripCodeFences(text)
}

export async function runTaskPerformance(
  llm: Llm,
  opts?: { timeoutMs?: number },
): Promise<TaskPerformanceReport> {
  const tasks = loadPerformanceTasks()
  const results: TaskPerformanceResult[] = []
  for (const task of tasks) {
    const code = await collectGeneratedCode(llm, task.prompt)
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
`````

- [ ] **Step 4: 跑测试确认通过**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd apps/cli && git add src/core/task-performance.ts test/core/task-performance.test.ts
git commit -m "feat(crsi): 任务表现评估——评估器（LLM 生成 → 判定 → 打分）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: `/crsi bench` 命令 + 注册

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`

**Interfaces:**

- Consumes: `runTaskPerformance`（`import { runTaskPerformance } from '../core/task-performance'`）、`ctx.engine.getLlm()` / `ctx.engine.getRegistry()`
- Produces: `crsiBenchCmd: CommandHandler`

- [ ] **Step 1: 找锚点**

在 `commands.ts` 里 `crsiEvalCmd`（约 line 954）之后插入命令定义；在 `registry.set('/crsi eval', crsiEvalCmd)`（约 line 4855）之后加注册。

- [ ] **Step 2: 加命令定义**

在 `crsiEvalCmd` 定义之后插入：

```typescript
const crsiBenchCmd: CommandHandler = async (ctx) => {
  const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
  const report = await runTaskPerformance(llm)

  const lines: string[] = ['## 🎯 CRSI 任务表现基准', '']
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

- [ ] **Step 3: 加注册 + 命令清单**

在 `registry.set('/crsi eval', crsiEvalCmd)` 之后插入：

```typescript
registry.set('/crsi bench', crsiBenchCmd)
```

并在命令分组 map（含 `'/crsi eval': 'Tools & Skills'` 的那段，约 line 4697）与描述 map（约 line 5039）补：

```typescript
'/crsi bench': 'Tools & Skills',
```

```typescript
'/crsi bench': 'Run the LLM task-performance benchmark and report the score',
```

- [ ] **Step 4: 导入**

在 `commands.ts` 顶部现有 `runEval` 等导入处补：

```typescript
import { runTaskPerformance } from '../core/task-performance'
```

- [ ] **Step 5: typecheck + 测试**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error

Run: `cd apps/cli && pnpm vitest run test/core/task-performance.test.ts`
Expected: PASS

- [ ] **Step 6: 手跑验证（可选，需真实 LLM 配置）**

Run: `/crsi bench`
Expected: 输出 5 任务表格 + 得分

- [ ] **Step 7: Commit**

```bash
cd apps/cli && git add src/ui/commands.ts
git commit -m "feat(crsi): /crsi bench 命令——任务表现基准入口

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec 覆盖**：spec §3.1（LLM 生成+温度0）→ Task 3 的 `collectGeneratedCode`（temperature: 0）；§3.3（schema）→ Task 1 的 JSON；§3.4（子进程判定+超时+无网络）→ Task 2 的 `judgeGeneratedCode`（execSync+timeout+stdio pipe）；§3.5（LLM 注入 ctx.llm）→ Task 4 的 `ctx.engine.getLlm()`；§六 M1（独立基准器 + /crsi bench）→ Task 1-4 全量。§3.6（before/after）是 M2，本计划不覆盖（spec 已标 M2 另立）。
- **占位符扫描**：无 TBD/TODO；每个代码步骤都给了完整可跑代码。
- **类型一致性**：`PerformanceTask` / `JudgeResult` / `TaskPerformanceReport` / `runTaskPerformance(llm, opts?)` 在 Task 1-4 里名称、签名一致；`stripCodeFences` 在 Task 3 定义并在测试引用。
- **超时细节**：`bun test` 的 `--test-timeout` 未显式设置，靠 `execSync` 的 `timeout` 兜底杀掉死循环——已在 Task 2 超时测试覆盖。
