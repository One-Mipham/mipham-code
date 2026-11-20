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
  countEmptySolutionPasses,
  runNullModelCheck,
} from '../../src/core/task-performance'

/** 按请求里的 prompt 返回该题的手写参考解 —— 让「答对全部题」与电池大小解耦。 */
function oracleForRequest(req: ChatRequest): string {
  const prompt = String(req.messages[0]?.content ?? '')
  return loadPerformanceTasks().find((t) => t.prompt === prompt)?.oracleCode ?? ''
}

const SAFE_COUNT = loadPerformanceTasks().filter((t) => t.skill === 'safe-coding').length
const UNTAGGED_COUNT = loadPerformanceTasks().filter((t) => t.skill === undefined).length

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

describe('RSI Tax：测量 token 的捕获', () => {
  const code =
    'export function quicksort(arr: number[]): number[] { return [...arr].sort((a, b) => a - b) }'

  it('provider 报 usage → 整个 run 的 token 求和', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 }
        yield { type: 'text', content: code }
        yield { type: 'stop' }
      },
    }
    const report = await runTaskPerformance(mockLlm)
    expect(report.tokensUsed).toBe(report.total * 15)
  })

  it('provider 没报 usage → 键缺席，不是 0（0 会被读成免费）', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield { type: 'text', content: code }
      },
    }
    const report = await runTaskPerformance(mockLlm)
    expect('tokensUsed' in report).toBe(false)
  })
})

describe('runTaskPerformance skill 过滤与注入', () => {
  it('无 skill 只跑无标签的 gate 题', async () => {
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
    expect(report.total).toBe(UNTAGGED_COUNT)
    expect(report.results.some((r) => r.id === 'perf-safe-parse-positive')).toBe(false)
  })

  it('指定 skill 只跑绑定该 skill 的任务', async () => {
    const mockLlm: Llm = {
      chat: async function* (req) {
        yield { type: 'text', content: oracleForRequest(req) }
      },
    }
    const report = await runTaskPerformance(mockLlm, {
      skill: { name: 'safe-coding', text: '校验输入' },
    })
    expect(report.total).toBe(SAFE_COUNT)
    expect(report.results.every((r) => r.id.startsWith('perf-safe-'))).toBe(true)
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
  it('k 次采样全部报 usage → 前/后 token 数组逐项对齐', async () => {
    const mockLlm: Llm = {
      chat: async function* (req) {
        yield { type: 'usage', inputTokens: 100, outputTokens: 20 }
        yield { type: 'text', content: oracleForRequest(req) }
      },
    }
    const s = await measureSkillDeltaRepeated(
      mockLlm,
      {
        filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
        originalContent: '---\nname: safe-coding\ndescription: x\n---\nweak',
        newContent: '---\nname: safe-coding\ndescription: x\n---\nstrong',
      },
      { k: 1 },
    )
    expect(s).not.toBeNull()
    expect(s!.baselineTokens).toEqual([SAFE_COUNT * 120])
    expect(s!.postTokens).toEqual([SAFE_COUNT * 120])
  })

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
          yield { type: 'text', content: oracleForRequest(req) }
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

  it('代价维：K 次采样各自记时，耗时数组与分数数组等长', async () => {
    // B2：分数持平但耗时翻倍的改动，在判定里与白捡的胜利同形 —— 除非代价被记下来。
    // 这里只钉「记下来了、形状与分数对齐」，不钉任何阈值（代价不进闸）。
    const mockLlm: Llm = {
      chat: async function* (req) {
        const sp = (req.systemPrompt ?? '') as string
        yield {
          type: 'text',
          content: sp.includes('校验')
            ? 'export function parsePositiveNumber(input: string): number { if (input == null || input === "" || isNaN(Number(input))) throw new RangeError("invalid input"); return Number(input) }'
            : 'export function parsePositiveNumber(input: string): number { return Number(input) }',
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
    // 与分数数组同长：耗时的第 i 项就是产出分数第 i 项的那次采样。
    expect(s!.baselineDurations).toHaveLength(s!.baselineScores.length)
    expect(s!.postDurations).toHaveLength(s!.postScores.length)
    expect(s!.baselineDurations!.every((d) => d >= 0)).toBe(true)
    expect(s!.postDurations!.every((d) => d >= 0)).toBe(true)
  })
})

describe('runTaskPerformance 的代价维（B2）', () => {
  it('整轮耗时记在报告上', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield {
          type: 'text',
          content:
            'export function parsePositiveNumber(input: string): number { if (input == null || input === "" || isNaN(Number(input))) throw new RangeError("invalid input"); return Number(input) }',
        }
      },
    }
    const r = await runTaskPerformance(mockLlm, { skill: { name: 'safe-coding', text: '校验' } })
    expect(typeof r.durationMs).toBe('number')
    expect(r.durationMs!).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================
// 截断信号（`truncated`）要进打分，而不是被丢掉。
//
// 两个 provider 都在 stop chunk 上产这个字段（`anthropic.ts:306,330`、
// `openai-compat.ts:221`），而 `collectGeneratedCode` 从前只收 `text` 块 ⇒
// 信号**产出来、没落点**。后果不是「少个字段」，是**读数错**：被输出上限截断的
// 生成按构造就是残的，把它的失败并进均值，让分数（以及由分数派生的
// improved/regressed 判定）由**输出上限**决定，而不是由做得好不好决定。
//
// 判据两头：① 截断的**不参与**打分（且被计数点名）；② 没截断的**照旧**参与
// —— 否则「分数永远 100」也能让第 ① 条过。
// ============================================================

/** 每次调用都产出垃圾代码；可切换是否在 stop chunk 上带 `truncated`。 */
const brokenLlm = (truncated: boolean): Llm => ({
  chat: async function* () {
    yield { type: 'text', content: 'export function nope(): number { return 1 }' }
    yield truncated ? { type: 'stop', truncated: true } : { type: 'stop' }
  },
})

describe('runTaskPerformance：被输出上限截断的生成不进打分', () => {
  it('全被截断 ⇒ 分数不该被这些失败拉低（分母为 0 时按 100），但计数点名', async () => {
    const r = await runTaskPerformance(brokenLlm(true))
    expect(r.total).toBeGreaterThan(0)
    expect(r.passed).toBe(0) // 全都没通过 —— 只是「没通过」不再是评分依据
    expect(r.truncated).toBe(r.total)
    expect(r.score).toBe(100)
    expect(r.results.every((x) => x.truncated === true)).toBe(true)
  })

  it('反方向：没截断的照旧参与打分（垃圾代码就是 0 分）', async () => {
    const r = await runTaskPerformance(brokenLlm(false))
    expect(r.truncated).toBe(0)
    expect(r.passed).toBe(0)
    expect(r.score).toBe(0)
    expect(r.results.every((x) => x.truncated === undefined)).toBe(true)
  })

  it('单个 skill 题集上逐字边界：全被截断 ⇒ 分母为 0、计数点名', async () => {
    const r = await runTaskPerformance(brokenLlm(true), {
      skill: { name: 'safe-coding', text: '校验' },
    })
    expect(r.total).toBe(SAFE_COUNT)
    expect(r.results.every((x) => x.truncated === true)).toBe(true)
    expect(r.truncated).toBe(SAFE_COUNT)
    expect(r.score).toBe(100)
    expect(r.failures.length).toBe(SAFE_COUNT) // 仍然是「失败」——只是不进分母
  })
})

// ============================================================
// 空模型闸（null-model ablation）
//
// 自改进最容易被「指标赢了、目标没动」骗过去：一个**什么都不产出**的空程序
// 若能通过冻结测试，那这道题测的就不是模型能力。判据必须能双向：合成一个
// 真空题（断言恒真）要判它通过，真题目要判它失败。
// ============================================================

describe('countEmptySolutionPasses', () => {
  it('真空题（空程序也过）与真题（空程序不过）能分开', () => {
    const vacuous = {
      id: 'vacuous',
      category: 'test-driven' as const,
      prompt: 'always true',
      testCode:
        "import { test, expect } from 'bun:test'\ntest('always', () => { expect(1).toBe(1) })",
      oracleCode: '',
    }
    const real = {
      id: 'real',
      category: 'test-driven' as const,
      prompt: 'add',
      testCode:
        "import { test, expect } from 'bun:test'\nimport { add } from './solution'\ntest('add', () => { expect(add(1, 2)).toBe(3) })",
      oracleCode: 'export function add(a: number, b: number): number { return a + b }',
    }

    const result = countEmptySolutionPasses([vacuous, real])

    expect(result.total).toBe(2)
    expect(result.passed).toBe(1)
    expect(result.failures).toEqual(['vacuous'])
  })
})

describe('runNullModelCheck', () => {
  it('内置 safe-coding 题集不是真空题：空程序 0 通过', () => {
    const result = runNullModelCheck('safe-coding')
    expect(result.total).toBeGreaterThan(0)
    expect(result.passed).toBe(0)
  })

  it('没有绑定任务的 skill → total 0（闸是空转，不是通过）', () => {
    const result = runNullModelCheck('no-such-skill')
    expect(result).toEqual({ total: 0, passed: 0, failures: [] })
  })
})

describe('measureSkillDeltaRepeated — 空模型读数', () => {
  it('样本带上空模型闸的分子/分母', async () => {
    // 必须交**可判**的代码（哪怕全错）：一言不发的模型是「没测到」，
    // `measureSkillDeltaRepeated` 对不可测的轮次返回 null，样本根本不存在。
    const llm: Llm = {
      async *chat() {
        yield { type: 'text' as const, content: 'export function nope(): number { return 1 }' }
      },
    }
    const sample = await measureSkillDeltaRepeated(
      llm,
      {
        filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
        originalContent: '---\nname: safe-coding\n---\nold',
        newContent: '---\nname: safe-coding\n---\nnew',
      },
      { k: 1 },
    )

    expect(sample).not.toBeNull()
    expect(sample?.nullModelTotal).toBe(SAFE_COUNT)
    expect(sample?.nullModelPassed).toBe(0)
  })
})
