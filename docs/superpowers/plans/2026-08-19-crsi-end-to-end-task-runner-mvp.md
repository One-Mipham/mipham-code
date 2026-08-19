# CRSI 端到端任务运行器 C-MVP 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一个最小任务运行器，验证「端到端行为效果度量」这条链跑得通——冻结任务 + headless 驱动 engine + 确定性判定 + 统计层。

**Architecture:** `task-runner.ts` 提供 `runTask(task, llm, opts)`（构造 engine → `setLlm(llm)` → 喂任务指令 → `process()` 完整 agentic loop → 确定性判定）+ `runTaskN`（N 次采样统计）。真实 LLM 作为参数注入，测试用 mock Llm，CI 零真实 LLM 依赖。

**Tech Stack:** TypeScript strict ESM、Bun、Vitest、现有 `QueryEngine` / `createToolRegistry` / `llm-replay`。

**Spec:** `docs/superpowers/specs/2026-08-19-crsi-end-to-end-task-runner-design.md`

## Global Constraints

- 判定一律确定性 ground-truth，零 LLM 裁判（A1 铁律）。
- 冻结任务存为源码内 JSON（`import ... with { type: 'json' }`，binary-safe——同 `constitution-loader.ts` 模式，禁止 `readFileSync(new URL(...))`）。
- 任务产物写 cwd 内 git-ignored 目录（`.mipham/task-runner`），绝不碰真实仓库源文件（隔离）。**架构约束**：Write 工具 `resolveSafe` 强制写文件在 `process.cwd()` 内，系统 tmpdir 会被拒。
- 真实 LLM 只作**参数注入**，CI 测试用 mock Llm，不触发 provider 调用。
- 提交信息遵循 Conventional Commits；每个 task 结束 commit 一次。

---

### Task 1: 冻结任务 JSON + 类型 + 加载器

**Files:**

- Create: `apps/cli/src/core/task-runner-tasks.json`
- Create: `apps/cli/src/core/task-runner.ts`（类型 + `loadRunnerTasks`，后续 task 增量扩展此文件）
- Test: `apps/cli/test/core/task-runner.test.ts`

**Interfaces:**

- Produces: `RunnerTask`（`{ id, instruction, groundTruth }`）、`RunnerGroundTruth`（`{ kind: 'file-contains'; file: string; contains: string[] }`）、`loadRunnerTasks(): RunnerTask[]`

- [ ] **Step 1: 写失败的测试**

`apps/cli/test/core/task-runner.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { loadRunnerTasks } from '../../src/core/task-runner'

describe('loadRunnerTasks', () => {
  it('加载冻结任务集且结构合法', () => {
    const tasks = loadRunnerTasks()
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    const t = tasks[0]!
    expect(typeof t.id).toBe('string')
    expect(typeof t.instruction).toBe('string')
    expect(t.groundTruth.kind).toBe('file-contains')
    expect(typeof t.groundTruth.file).toBe('string')
    expect(Array.isArray(t.groundTruth.contains)).toBe(true)
  })

  it('任务 id 唯一', () => {
    const tasks = loadRunnerTasks()
    const ids = tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test task-runner`
Expected: FAIL（`task-runner.ts` 不存在）

- [ ] **Step 3: 写最小实现**

`apps/cli/src/core/task-runner-tasks.json`：

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "task-answer-fn",
      "instruction": "用 Write 工具在 <taskDir>/solution.ts 写入一个 TypeScript 文件，导出 `export function answer(): number { return 42 }`。",
      "groundTruth": {
        "kind": "file-contains",
        "file": "solution.ts",
        "contains": ["export function answer", "42"]
      }
    }
  ]
}
```

`apps/cli/src/core/task-runner.ts`：

```typescript
// apps/cli/src/core/task-runner.ts
// CRSI 端到端任务运行器（C-MVP）——行为效果度量基建。
import tasksFile from './task-runner-tasks.json' with { type: 'json' }

export type RunnerGroundTruth = { kind: 'file-contains'; file: string; contains: string[] }

export interface RunnerTask {
  id: string
  instruction: string
  groundTruth: RunnerGroundTruth
}

export function loadRunnerTasks(): RunnerTask[] {
  return tasksFile.tasks as unknown as RunnerTask[]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test task-runner`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/task-runner-tasks.json apps/cli/src/core/task-runner.ts apps/cli/test/core/task-runner.test.ts
git commit -m "feat(crsi): add task-runner task set loader + frozen task JSON"
```

---

### Task 2: 判定器 judgeTask

**Files:**

- Modify: `apps/cli/src/core/task-runner.ts`
- Test: `apps/cli/test/core/task-runner.test.ts`

**Interfaces:**

- Consumes: `RunnerTask`（Task 1）
- Produces: `judgeTask(task: RunnerTask, taskDir: string): { passed: boolean; detail?: string }`

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/task-runner.test.ts`：

```typescript
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRunnerTasks, judgeTask } from '../../src/core/task-runner'

const JUDGE_DIR = join(tmpdir(), 'mipham-task-runner-judge')

beforeEach(() => {
  rmSync(JUDGE_DIR, { recursive: true, force: true })
  mkdirSync(JUDGE_DIR, { recursive: true })
})

describe('judgeTask', () => {
  it('命中所有子串则通过', () => {
    writeFileSync(
      join(JUDGE_DIR, 'solution.ts'),
      'export function answer(): number { return 42 }\n',
    )
    const task = loadRunnerTasks()[0]!
    expect(judgeTask(task, JUDGE_DIR).passed).toBe(true)
  })

  it('缺失子串则失败', () => {
    writeFileSync(join(JUDGE_DIR, 'solution.ts'), 'export const x = 1\n')
    const task = loadRunnerTasks()[0]!
    const v = judgeTask(task, JUDGE_DIR)
    expect(v.passed).toBe(false)
  })

  it('文件不存在则失败', () => {
    const task = loadRunnerTasks()[0]!
    const v = judgeTask(task, JUDGE_DIR)
    expect(v.passed).toBe(false)
    expect(v.detail).toContain('not found')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test task-runner`
Expected: FAIL（`judgeTask` 未导出）

- [ ] **Step 3: 写最小实现**

追加到 `apps/cli/src/core/task-runner.ts`：

```typescript
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function judgeTask(task: RunnerTask, taskDir: string): { passed: boolean; detail?: string } {
  if (task.groundTruth.kind !== 'file-contains') {
    return { passed: false, detail: `unsupported groundTruth kind: ${task.groundTruth.kind}` }
  }
  const filePath = join(taskDir, task.groundTruth.file)
  if (!existsSync(filePath)) {
    return { passed: false, detail: `file not found: ${task.groundTruth.file}` }
  }
  const content = readFileSync(filePath, 'utf-8')
  for (const needle of task.groundTruth.contains) {
    if (!content.includes(needle)) {
      return { passed: false, detail: `missing substring: ${needle}` }
    }
  }
  return { passed: true }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test task-runner`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/task-runner.ts apps/cli/test/core/task-runner.test.ts
git commit -m "feat(crsi): add task-runner deterministic judge (file-contains)"
```

---

### Task 3: runner runTask（端到端）

**Files:**

- Modify: `apps/cli/src/core/task-runner.ts`
- Test: `apps/cli/test/core/task-runner.test.ts`

**Interfaces:**

- Consumes: `RunnerTask`（Task 1）、`judgeTask`（Task 2）
- Produces: `TaskRunResult`、`runTask(task: RunnerTask, llm: Llm, opts?: { taskDir?: string; permission?: string }): Promise<TaskRunResult>`

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/task-runner.test.ts`：

```typescript
import type { Llm } from '../../src/providers/llm'
import { runTask } from '../../src/core/task-runner'

const RUN_DIR = join(tmpdir(), 'mipham-task-runner-run')

function makeWriterLlm(targetFile: string, content: string): Llm {
  let calls = 0
  return {
    chat: async function* () {
      calls++
      if (calls === 1) {
        yield {
          type: 'tool_use',
          toolUse: {
            type: 'tool_use',
            id: 'call_1',
            name: 'Write',
            input: { file_path: targetFile, content },
          },
        }
      }
      yield { type: 'stop' }
    },
  }
}

describe('runTask', () => {
  it('mock Llm 写正确内容则通过', async () => {
    rmSync(RUN_DIR, { recursive: true, force: true })
    const task = loadRunnerTasks()[0]!
    const llm = makeWriterLlm(
      join(RUN_DIR, 'solution.ts'),
      'export function answer(): number { return 42 }\n',
    )
    const result = await runTask(task, llm, { taskDir: RUN_DIR })
    expect(result.passed).toBe(true)
  })

  it('mock Llm 写错误内容则失败', async () => {
    rmSync(RUN_DIR, { recursive: true, force: true })
    const task = loadRunnerTasks()[0]!
    const llm = makeWriterLlm(join(RUN_DIR, 'solution.ts'), 'export const x = 1\n')
    const result = await runTask(task, llm, { taskDir: RUN_DIR })
    expect(result.passed).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test task-runner`
Expected: FAIL（`runTask` 未导出）

- [ ] **Step 3: 写最小实现**

追加到 `apps/cli/src/core/task-runner.ts`：

```typescript
import { mkdirSync, rmSync } from 'node:fs'
import { QueryEngine } from './engine'
import { ContextManager } from './context'
import { PermissionSystem } from './permission'
import { ProviderRegistry } from '../providers/registry'
import type { Llm } from '../providers/llm'
import { createToolRegistry } from '../tools'

export interface TaskRunResult {
  taskId: string
  passed: boolean
  detail?: string
}

const TASK_DIR_PLACEHOLDER = '<taskDir>'

function buildEngine(llm: Llm, permission: string): QueryEngine {
  const registry = new ProviderRegistry(
    [{ id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] }],
    'test',
    'test-model',
  )
  const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
  const tools = createToolRegistry()
  const engine = new QueryEngine(registry, context, tools, new PermissionSystem(permission))
  engine.setLlm(llm)
  return engine
}

export async function runTask(
  task: RunnerTask,
  llm: Llm,
  opts: { taskDir?: string; permission?: string } = {},
): Promise<TaskRunResult> {
  const taskDir = opts.taskDir ?? join(tmpdir(), 'mipham-task-runner')
  const permission = opts.permission ?? 'bypassPermissions'

  rmSync(taskDir, { recursive: true, force: true })
  mkdirSync(taskDir, { recursive: true })

  const instruction = task.instruction.replaceAll(TASK_DIR_PLACEHOLDER, taskDir)
  const engine = buildEngine(llm, permission)

  for await (const _ of engine.process(instruction)) {
    /* drain agentic loop */
  }

  const verdict = judgeTask(task, taskDir)
  return { taskId: task.id, passed: verdict.passed, detail: verdict.detail }
}
```

（`tmpdir` import 已在 Task 2 加入，若未则补 `import { tmpdir } from 'node:os'`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test task-runner`
Expected: PASS。若 Write 工具因 `ctx.cwd` 报错，则 `buildEngine` 里给 vajra context provide cwd 后再查；见下「实现注意」。

**实现注意**：`Write` 工具 `resolveSafe(ctx.cwd, file_path)` 依赖 vajra context 的 `cwd`。`createToolRegistry()` 用 `defaultVajraContext()`（未设 cwd）。若 `runTask` 里 Write 写绝对路径失败，改为 `createToolRegistry(ctxWithCwd)`，其中 `ctxWithCwd = new Context(); ctxWithCwd.provide('cwd', process.cwd())`。**先按默认跑，失败再补，勿预加。**

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/task-runner.ts apps/cli/test/core/task-runner.test.ts
git commit -m "feat(crsi): add task-runner end-to-end runTask (engine + setLlm)"
```

---

### Task 4: 统计层 runTaskN

**Files:**

- Modify: `apps/cli/src/core/task-runner.ts`
- Test: `apps/cli/test/core/task-runner.test.ts`

**Interfaces:**

- Consumes: `runTask`（Task 3）
- Produces: `TaskRunStats`、`runTaskN(task: RunnerTask, llm: Llm, n: number, opts?): Promise<TaskRunStats>`

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/task-runner.test.ts`：

```typescript
import { runTaskN } from '../../src/core/task-runner'

describe('runTaskN', () => {
  it('统计 n 次采样的通过率', async () => {
    const task = loadRunnerTasks()[0]!
    const llm = makeWriterLlm(
      join(RUN_DIR, 'solution.ts'),
      'export function answer(): number { return 42 }\n',
    )
    const stats = await runTaskN(task, llm, 2, { taskDir: RUN_DIR })
    expect(stats.samples).toBe(2)
    expect(stats.passed).toBe(2)
    expect(stats.passRate).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test task-runner`
Expected: FAIL（`runTaskN` 未导出）

- [ ] **Step 3: 写最小实现**

追加到 `apps/cli/src/core/task-runner.ts`：

```typescript
export interface TaskRunStats {
  taskId: string
  samples: number
  passed: number
  /** 0-1 */
  passRate: number
}

export async function runTaskN(
  task: RunnerTask,
  llm: Llm,
  n: number,
  opts: { taskDir?: string; permission?: string } = {},
): Promise<TaskRunStats> {
  let passed = 0
  for (let i = 0; i < n; i++) {
    const result = await runTask(task, llm, opts)
    if (result.passed) passed++
  }
  return { taskId: task.id, samples: n, passed, passRate: n > 0 ? passed / n : 0 }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test task-runner`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/task-runner.ts apps/cli/test/core/task-runner.test.ts
git commit -m "feat(crsi): add task-runner statistical sampling (runTaskN)"
```

---

### 收尾

- [ ] 全量测试 + typecheck + lint：`pnpm test && pnpm typecheck && pnpm lint`（全绿）
- [ ] 全量测试数对齐（新增 7 个测试）
