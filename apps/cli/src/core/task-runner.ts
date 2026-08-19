// apps/cli/src/core/task-runner.ts
// CRSI 端到端任务运行器（C-MVP）——行为效果度量基建。
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import tasksFile from './task-runner-tasks.json' with { type: 'json' }
import { QueryEngine } from './engine'
import { ContextManager } from './context'
import { PermissionSystem } from './permission'
import { ProviderRegistry } from '../providers/registry'
import type { Llm } from '../providers/llm'
import { createToolRegistry } from '../tools'
import type { PermissionLevel } from '../shared'

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

export interface TaskRunResult {
  taskId: string
  passed: boolean
  detail?: string
}

const TASK_DIR_PLACEHOLDER = '<taskDir>'

function buildEngine(llm: Llm, permission: PermissionLevel, systemPrompt?: string): QueryEngine {
  const registry = new ProviderRegistry([], 'test', 'test-model')
  // 注册一个永不 chat 的占位 provider——llm 被 setLlm 覆盖，但 process() 内部
  // 多处调用 registry.getActive().config.id 记录 provider id，必须能取到。
  registry.register('test', {
    config: { id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] },
    chat: async function* () {
      yield { type: 'stop' }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
  if (systemPrompt !== undefined) context.setSystemPrompt(systemPrompt)
  const tools = createToolRegistry()
  const engine = new QueryEngine(registry, context, tools, new PermissionSystem(permission))
  engine.setLlm(llm)
  return engine
}

export async function runTask(
  task: RunnerTask,
  llm: Llm,
  opts: { taskDir?: string; permission?: PermissionLevel; systemPrompt?: string } = {},
): Promise<TaskRunResult> {
  const taskDir = opts.taskDir ?? join(process.cwd(), '.mipham', 'task-runner')
  const permission = opts.permission ?? 'bypassPermissions'

  rmSync(taskDir, { recursive: true, force: true })
  mkdirSync(taskDir, { recursive: true })

  const instruction = task.instruction.replaceAll(TASK_DIR_PLACEHOLDER, taskDir)
  const engine = buildEngine(llm, permission, opts.systemPrompt)

  for await (const _ of engine.process(instruction)) {
    /* drain agentic loop */
  }

  const verdict = judgeTask(task, taskDir)
  return { taskId: task.id, passed: verdict.passed, detail: verdict.detail }
}

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
  opts: { taskDir?: string; permission?: PermissionLevel; systemPrompt?: string } = {},
): Promise<TaskRunStats> {
  let passed = 0
  for (let i = 0; i < n; i++) {
    const result = await runTask(task, llm, opts)
    if (result.passed) passed++
  }
  return { taskId: task.id, samples: n, passed, passRate: n > 0 ? passed / n : 0 }
}
