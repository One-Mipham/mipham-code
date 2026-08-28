// apps/cli/src/core/task-performance.ts
// CRSI 任务表现评估器：LLM 生成代码 + 冻结测试判定，输出随改动变化的分数。
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tasksFile from './task-performance-tasks.json' with { type: 'json' }
import type { Llm } from '../providers/llm'
import { parseFrontmatter } from '../skills/loader'

export type PerformanceTaskCategory = 'test-driven' | 'bug-fix'

export interface PerformanceTask {
  id: string
  category: PerformanceTaskCategory
  prompt: string
  testCode: string
  skill?: string // 绑定被测 skill 的名字（= skill frontmatter name）
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

/** 剥掉 LLM 可能包裹的 markdown 代码块（```ts ... ```），拿到裸代码。 */
export function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/)
  return (fenced?.[1] ?? text).trim()
}

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

export interface SkillDelta {
  skillName: string
  baseline: TaskPerformanceReport
  post: TaskPerformanceReport
  delta: number
}

/** 路径门：只认内置 skill 文件。 */
function isSkillFile(filePath: string): boolean {
  return (
    filePath.startsWith('apps/cli/skills/') &&
    (filePath.endsWith('.SKILL.md') || filePath.endsWith('.mipham-skill.md'))
  )
}

/**
 * 测一个改 skill 的 proposal 的任务表现 before/after delta。
 * 返回 null：不是 skill 文件 / 无匹配任务集（无可量）。
 * A1 不破：只调 runTaskPerformance（LLM 生成 + 冻结测试判定）。
 */
export async function measureSkillDelta(
  llm: Llm,
  proposal: { filePath: string; originalContent?: string; newContent: string },
): Promise<SkillDelta | null> {
  if (!isSkillFile(proposal.filePath)) return null

  const newParsed = parseFrontmatter(proposal.newContent)
  const skillName = typeof newParsed.data.name === 'string' ? newParsed.data.name : undefined
  if (!skillName) return null

  if (!loadPerformanceTasks().some((t) => t.skill === skillName)) return null

  let baselineText: string
  if (proposal.originalContent !== undefined) {
    baselineText = parseFrontmatter(proposal.originalContent).content
  } else {
    try {
      baselineText = parseFrontmatter(readFileSync(proposal.filePath, 'utf-8')).content
    } catch {
      return null // 旧 skill 不可读 → 无可量
    }
  }

  const baseline = await runTaskPerformance(llm, { skill: { name: skillName, text: baselineText } })
  const post = await runTaskPerformance(llm, {
    skill: { name: skillName, text: newParsed.content },
  })

  return {
    skillName,
    baseline,
    post,
    delta: post.score - baseline.score,
  }
}
