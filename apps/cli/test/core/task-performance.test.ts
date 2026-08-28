import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import type { ChatRequest } from '../../src/providers/registry'
import {
  loadPerformanceTasks,
  judgeGeneratedCode,
  stripCodeFences,
  runTaskPerformance,
  measureSkillDelta,
  measureSkillDeltaRepeated,
} from '../../src/core/task-performance'

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

  it('safe-coding 任务带 skill 字段', () => {
    const tasks = loadPerformanceTasks()
    const safe = tasks.find((t) => t.id === 'perf-safe-parse-positive')
    expect(safe).toBeDefined()
    expect(safe?.skill).toBe('safe-coding')
  })
})

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

describe('runTaskPerformance skill 过滤与注入', () => {
  it('无 skill 只跑通用任务（5 个）', async () => {
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
    expect(report.total).toBe(5)
    expect(report.results.some((r) => r.id === 'perf-safe-parse-positive')).toBe(false)
  })

  it('指定 skill 只跑绑定该 skill 的任务', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield {
          type: 'text',
          content:
            'export function parsePositiveNumber(input: string): number { return Number(input) }',
        }
      },
    }
    const report = await runTaskPerformance(mockLlm, {
      skill: { name: 'safe-coding', text: '校验输入' },
    })
    expect(report.total).toBe(1)
    expect(report.results[0]?.id).toBe('perf-safe-parse-positive')
  })

  it('有 skill 时把 skill 正文作为 systemPrompt 注入', async () => {
    let captured: { systemPrompt?: string } | null = null
    const mockLlm: Llm = {
      chat: async function* (req: ChatRequest) {
        captured = req
        yield {
          type: 'text',
          content:
            'export function parsePositiveNumber(input: string): number { return Number(input) }',
        }
      },
    }
    await runTaskPerformance(mockLlm, {
      skill: { name: 'safe-coding', text: '必须校验输入' },
    })
    expect(captured!.systemPrompt).toBe('必须校验输入')
  })
})

describe('measureSkillDelta', () => {
  const skillFile = 'apps/cli/skills/standard/safe-coding.SKILL.md'

  it('非 skill 文件 → null', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const delta = await measureSkillDelta(mockLlm, {
      filePath: 'apps/cli/src/foo.ts',
      originalContent: 'x',
      newContent: 'y',
    })
    expect(delta).toBeNull()
  })

  it('skill 文件但无绑定任务 → null', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const content = '---\nname: no-such-task-skill\ndescription: x\n---\nbody'
    const delta = await measureSkillDelta(mockLlm, {
      filePath: 'apps/cli/skills/standard/no-such-task-skill.SKILL.md',
      newContent: content,
    })
    expect(delta).toBeNull()
  })

  it('safe-coding 强 skill → delta > 0', async () => {
    const mockLlm: Llm = {
      chat: async function* (req) {
        const sp = (req.systemPrompt ?? '') as string
        if (sp.includes('校验')) {
          yield {
            type: 'text',
            content:
              'export function parsePositiveNumber(input: string): number { if (input == null || input === "" || isNaN(Number(input))) throw new RangeError("invalid input"); return Number(input) }',
          }
        } else {
          yield {
            type: 'text',
            content:
              'export function parsePositiveNumber(input: string): number { return Number(input) }',
          }
        }
      },
    }
    const strong =
      "---\nname: safe-coding\ndescription: x\n---\n处理外部/用户输入前必须校验：null、undefined、空字符串、格式非法时，抛出 RangeError，消息为 'invalid input'。"
    const weak =
      '---\nname: safe-coding\ndescription: x\n---\n你是一个编码智能体，尽力完成任务即可。'
    const delta = await measureSkillDelta(mockLlm, {
      filePath: skillFile,
      originalContent: weak,
      newContent: strong,
    })
    expect(delta).not.toBeNull()
    expect(delta!.skillName).toBe('safe-coding')
    expect(delta!.delta).toBeGreaterThan(0)
  })

  it('旧 skill 文件不可读 → null（不抛异常）', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const delta = await measureSkillDelta(mockLlm, {
      filePath: 'apps/cli/skills/standard/ghost-does-not-exist.SKILL.md',
      newContent: '---\nname: safe-coding\ndescription: x\n---\nbody',
    })
    expect(delta).toBeNull()
  })
})

describe('measureSkillDeltaRepeated', () => {
  it('非 skill 文件 → null', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const s = await measureSkillDeltaRepeated(mockLlm, {
      filePath: 'apps/cli/src/foo.ts',
      originalContent: 'x',
      newContent: 'y',
    })
    expect(s).toBeNull()
  })

  it('skill 文件但无绑定任务 → null', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: '' }
      },
    }
    const s = await measureSkillDeltaRepeated(mockLlm, {
      filePath: 'apps/cli/skills/standard/no-such-task-skill.SKILL.md',
      newContent: '---\nname: no-such-task-skill\ndescription: x\n---\nbody',
    })
    expect(s).toBeNull()
  })

  it('safe-coding 强 skill → K 次采样分数数组正确（k=2）', async () => {
    const mockLlm: Llm = {
      chat: async function* (req) {
        const sp = (req.systemPrompt ?? '') as string
        if (sp.includes('校验')) {
          yield {
            type: 'text',
            content:
              'export function parsePositiveNumber(input: string): number { if (input == null || input === "" || isNaN(Number(input))) throw new RangeError("invalid input"); return Number(input) }',
          }
        } else {
          yield {
            type: 'text',
            content:
              'export function parsePositiveNumber(input: string): number { return Number(input) }',
          }
        }
      },
    }
    const strong =
      "---\nname: safe-coding\ndescription: x\n---\n处理外部/用户输入前必须校验：null、undefined、空字符串、格式非法时，抛出 RangeError，消息为 'invalid input'。"
    const weak =
      '---\nname: safe-coding\ndescription: x\n---\n你是一个编码智能体，尽力完成任务即可。'
    const s = await measureSkillDeltaRepeated(
      mockLlm,
      {
        filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
        originalContent: weak,
        newContent: strong,
      },
      { k: 2 },
    )
    expect(s).not.toBeNull()
    expect(s!.skillName).toBe('safe-coding')
    expect(s!.baselineScores).toEqual([0, 0])
    expect(s!.postScores).toEqual([100, 100])
  })
})
