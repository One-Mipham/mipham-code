// apps/cli/src/core/task-runner.ts
// CRSI 端到端任务运行器（C-MVP）——行为效果度量基建。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
