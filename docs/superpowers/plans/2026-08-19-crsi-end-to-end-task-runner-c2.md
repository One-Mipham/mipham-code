# CRSI 端到端任务运行器 C-2 实现计划（改前/改后对比 + 显著性弱判）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 C-MVP 之上加「改前/改后对比」——runTask 支持散文（systemPrompt）注入，加对比纯函数（弱判）与两轮对比流程，让 C 真正能回答「改散文更好吗」。

**Architecture:** 三个增量：① `runTask`/`runTaskN` 的 opts 增加 `systemPrompt`（散文）→ `context.setSystemPrompt`；② `compareRuns`/`isNotDegraded`/`isImproved` 纯函数（弱判）；③ `runBeforeAfter` 跑 baseline + candidate 两轮 + 对比。真实 LLM 仍作参数注入，CI 用 mock Llm。

**Tech Stack:** TypeScript strict ESM、Bun、Vitest、现有 `task-runner.ts`（C-MVP）。

**Spec:** `docs/superpowers/specs/2026-08-19-crsi-end-to-end-task-runner-design.md`（§四数据流、§七.2 显著性弱判）

## Global Constraints

- 判定一律确定性 ground-truth，零 LLM 裁判（A1 铁律）。
- 真实 LLM 只作参数注入，CI 测试用 mock Llm。
- 弱判语义（spec §七.2）：candidate 不退化 = `candidate.passRate >= baseline.passRate && candidate.passed >= 1`。
- **简化边界**：`systemPrompt` 直接注入两段散文（不经过 SkillsLoader），C-2 只验证「对比逻辑」；「从 skill 文件加载散文」是块 1 的事。
- 提交信息遵循 Conventional Commits；每个 task 结束 commit 一次。

---

### Task 5: runTask 支持 systemPrompt 注入

**Files:**

- Modify: `apps/cli/src/core/task-runner.ts`
- Test: `apps/cli/test/core/task-runner.test.ts`

**Interfaces:**

- Produces: `runTask`/`runTaskN` 的 `opts` 增加 `systemPrompt?: string`；`buildEngine` 增加 `systemPrompt` 参数

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/task-runner.test.ts`：

```typescript
import { runTask } from '../../src/core/task-runner'

function makeCaptureLlm(): { llm: Llm; seen: string[] } {
  const seen: string[] = []
  const llm: Llm = {
    chat: async function* (req) {
      seen.push(req.systemPrompt ?? '')
      yield { type: 'stop' }
    },
  }
  return { llm, seen }
}

describe('runTask systemPrompt 注入', () => {
  it('注入的散文进入 LLM 的 systemPrompt', async () => {
    const { llm, seen } = makeCaptureLlm()
    await runTask(loadRunnerTasks()[0]!, llm, { taskDir: RUN_DIR, systemPrompt: 'CUSTOM-PROSE' })
    expect(seen.some((s) => s.includes('CUSTOM-PROSE'))).toBe(true)
  })

  it('未注入时 systemPrompt 为空', async () => {
    const { llm, seen } = makeCaptureLlm()
    await runTask(loadRunnerTasks()[0]!, llm, { taskDir: RUN_DIR })
    expect(seen.some((s) => s.includes('CUSTOM-PROSE'))).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test task-runner`
Expected: FAIL（systemPrompt 未注入，seen 里不含 CUSTOM-PROSE）

- [ ] **Step 3: 写最小实现**

`buildEngine` 签名加 `systemPrompt?: string`，runTask/runTaskN 的 opts 加 `systemPrompt`：

```typescript
function buildEngine(llm: Llm, permission: PermissionLevel, systemPrompt?: string): QueryEngine {
  // ... 现有 registry.register + context 构造 ...
  const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
  if (systemPrompt !== undefined) context.setSystemPrompt(systemPrompt)
  // ...
}

export async function runTask(
  task: RunnerTask,
  llm: Llm,
  opts: { taskDir?: string; permission?: PermissionLevel; systemPrompt?: string } = {},
): Promise<TaskRunResult> {
  // ...
  const engine = buildEngine(llm, permission, opts.systemPrompt)
  // ...
}

export async function runTaskN(
  task: RunnerTask,
  llm: Llm,
  n: number,
  opts: { taskDir?: string; permission?: PermissionLevel; systemPrompt?: string } = {},
): Promise<TaskRunStats> {
  // ... 不变，透传 opts 到 runTask ...
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test task-runner`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/task-runner.ts apps/cli/test/core/task-runner.test.ts
git commit -m "feat(crsi): task-runner systemPrompt injection for prose comparison"
```

---

### Task 6: 对比纯函数 compareRuns / isNotDegraded / isImproved

**Files:**

- Modify: `apps/cli/src/core/task-runner.ts`
- Test: `apps/cli/test/core/task-runner.test.ts`

**Interfaces:**

- Consumes: `TaskRunStats`（Task 4）
- Produces: `RunComparison`、`isNotDegraded(baseline, candidate)`、`isImproved(baseline, candidate)`、`compareRuns(baseline, candidate)`

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/task-runner.test.ts`：

```typescript
import {
  isNotDegraded,
  isImproved,
  compareRuns,
  type TaskRunStats,
} from '../../src/core/task-runner'

const stats = (passed: number, samples = 3): TaskRunStats => ({
  taskId: 't',
  samples,
  passed,
  passRate: samples > 0 ? passed / samples : 0,
})

describe('compareRuns 弱判', () => {
  it('candidate 通过率更高 → 不退化且更好', () => {
    const c = compareRuns(stats(1), stats(2))
    expect(c.notDegraded).toBe(true)
    expect(c.improved).toBe(true)
  })

  it('candidate 退化 → 退化', () => {
    const c = compareRuns(stats(2), stats(1))
    expect(c.notDegraded).toBe(false)
    expect(c.improved).toBe(false)
  })

  it('candidate 全失败 → 退化（即使 passRate 持平）', () => {
    expect(isNotDegraded(stats(0), stats(0))).toBe(false)
  })

  it('candidate 平手但至少 1 次成功 → 不退化、不更好', () => {
    const c = compareRuns(stats(2), stats(2))
    expect(c.notDegraded).toBe(true)
    expect(c.improved).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test task-runner`
Expected: FAIL（compareRuns 未导出）

- [ ] **Step 3: 写最小实现**

追加到 `apps/cli/src/core/task-runner.ts`：

```typescript
export interface RunComparison {
  baseline: TaskRunStats
  candidate: TaskRunStats
  /** 弱判：candidate 不退化（不低于 baseline 且至少 1 次成功） */
  notDegraded: boolean
  /** candidate 严格更好（通过率更高） */
  improved: boolean
}

export function isNotDegraded(baseline: TaskRunStats, candidate: TaskRunStats): boolean {
  return candidate.passRate >= baseline.passRate && candidate.passed >= 1
}

export function isImproved(baseline: TaskRunStats, candidate: TaskRunStats): boolean {
  return candidate.passRate > baseline.passRate
}

export function compareRuns(baseline: TaskRunStats, candidate: TaskRunStats): RunComparison {
  return {
    baseline,
    candidate,
    notDegraded: isNotDegraded(baseline, candidate),
    improved: isImproved(baseline, candidate),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test task-runner`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/task-runner.ts apps/cli/test/core/task-runner.test.ts
git commit -m "feat(crsi): add run comparison (compareRuns / isNotDegraded / isImproved)"
```

---

### Task 7: runBeforeAfter 两轮对比流程

**Files:**

- Modify: `apps/cli/src/core/task-runner.ts`
- Test: `apps/cli/test/core/task-runner.test.ts`

**Interfaces:**

- Consumes: `runTaskN`（Task 4）、`compareRuns`（Task 6）
- Produces: `runBeforeAfter(task, llm, n, opts: { beforePrompt?; afterPrompt?; ... }): Promise<RunComparison>`

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/task-runner.test.ts`：

```typescript
import { runBeforeAfter } from '../../src/core/task-runner'

describe('runBeforeAfter', () => {
  it('跑 baseline + candidate 两轮并对比', async () => {
    const task = loadRunnerTasks()[0]!
    const llm = makeWriterLlm(
      join(RUN_DIR, 'solution.ts'),
      'export function answer(): number { return 42 }\n',
    )
    const c = await runBeforeAfter(task, llm, 2, {
      beforePrompt: 'OLD-PROSE',
      afterPrompt: 'NEW-PROSE',
      taskDir: RUN_DIR,
    })
    expect(c.baseline.samples).toBe(2)
    expect(c.candidate.samples).toBe(2)
    // mock Llm 不区分散文，两轮都写对 → 平手，不退化
    expect(c.notDegraded).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test task-runner`
Expected: FAIL（runBeforeAfter 未导出）

- [ ] **Step 3: 写最小实现**

追加到 `apps/cli/src/core/task-runner.ts`：

```typescript
export async function runBeforeAfter(
  task: RunnerTask,
  llm: Llm,
  n: number,
  opts: {
    beforePrompt?: string
    afterPrompt?: string
    taskDir?: string
    permission?: PermissionLevel
  } = {},
): Promise<RunComparison> {
  const baseline = await runTaskN(task, llm, n, {
    taskDir: opts.taskDir,
    permission: opts.permission,
    systemPrompt: opts.beforePrompt,
  })
  const candidate = await runTaskN(task, llm, n, {
    taskDir: opts.taskDir,
    permission: opts.permission,
    systemPrompt: opts.afterPrompt,
  })
  return compareRuns(baseline, candidate)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test task-runner`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/task-runner.ts apps/cli/test/core/task-runner.test.ts
git commit -m "feat(crsi): add runBeforeAfter two-round prose comparison"
```

---

### 收尾

- [ ] 全量测试 + typecheck + lint + format 全绿
- [ ] 全量测试数对齐（新增 9 个测试）
