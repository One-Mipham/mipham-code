// apps/cli/src/core/task-performance.ts
// CRSI 任务表现评估器：LLM 生成代码 + 冻结测试判定，输出随改动变化的分数。
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
