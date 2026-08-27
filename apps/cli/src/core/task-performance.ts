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
