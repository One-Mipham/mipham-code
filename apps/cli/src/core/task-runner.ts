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
