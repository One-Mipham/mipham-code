// apps/cli/src/core/behavior-tasks.ts
// CRSI 行为任务集：人类冻结的、带确定性 ground-truth 的约束行为任务。
import { readFileSync } from 'node:fs'

export type BehaviorTaskLayer = 'constraint' | 'performance'
export type BehaviorTaskCategory = 'param-fix' | 'content-safety' | 'test-driven' | 'bug-fix'
export type BehaviorTaskExpect = 'warn-or-fix' | 'masked-or-blocked' | 'tests-pass' | 'red-to-green'

export interface BehaviorTask {
  id: string
  layer: BehaviorTaskLayer
  category: BehaviorTaskCategory
  description: string
  /** param-fix 类：模拟一次工具调用 */
  tool?: string
  params?: Record<string, unknown>
  /** content-safety 类：模拟一段生成内容 */
  content?: string
  expect: BehaviorTaskExpect
}

interface BehaviorTasksFile {
  version: number
  tasks: BehaviorTask[]
}

const TASKS_FILE = new URL('./behavior-tasks.json', import.meta.url)

export function loadBehaviorTasks(): BehaviorTask[] {
  const raw = readFileSync(TASKS_FILE, 'utf-8')
  const parsed = JSON.parse(raw) as BehaviorTasksFile
  return parsed.tasks
}
