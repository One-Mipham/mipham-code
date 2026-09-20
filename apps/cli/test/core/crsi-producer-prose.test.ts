import { describe, it, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Llm } from '../../src/providers/llm'
import {
  parseProsePrediction,
  selectTargetSkill,
  generateProseContent,
  produceProseProposal,
  collectSkillFiles,
  type CrsiSignal,
} from '../../src/core/crsi-producer'

const SIGNAL: CrsiSignal = {
  category: 'timeout',
  title: 'npm install 超时过低',
  severity: 'warning',
  suggestion: '增加 timeout',
  evidence: ['npm install 超时'],
}

const SKILL_FILES = [
  'apps/cli/skills/standard/memory.SKILL.md',
  'apps/cli/skills/standard/implement.SKILL.md',
]

function textLlm(text: string): Llm {
  return {
    chat: async function* () {
      yield { type: 'text', content: text }
      yield { type: 'stop' }
    },
  }
}

describe('selectTargetSkill', () => {
  it('LLM 返回的 filePath 在候选列表内 → 选中', async () => {
    const filePath = await selectTargetSkill(SIGNAL, textLlm(SKILL_FILES[0]!), SKILL_FILES)
    expect(filePath).toBe(SKILL_FILES[0])
  })

  it('LLM 返回带多余文字的响应 → 仍能提取', async () => {
    const llm = textLlm(`我选 ${SKILL_FILES[1]}\n因为相关`)
    expect(await selectTargetSkill(SIGNAL, llm, SKILL_FILES)).toBe(SKILL_FILES[1])
  })

  it('LLM 返回不在列表内的路径 → null', async () => {
    const llm = textLlm('apps/cli/skills/standard/nonexistent.SKILL.md')
    expect(await selectTargetSkill(SIGNAL, llm, SKILL_FILES)).toBeNull()
  })
})

describe('parseProsePrediction', () => {
  it('首行是带 expectedDelta 的 JSON → 剥除该行，产出 ε', () => {
    const r = parseProsePrediction('{"expectedDelta": 12, "risk": "可能变慢"}\n\n# Body\n')
    expect(r.body).toBe('# Body\n')
    expect(r.expectedEffect).toBe(12)
    expect(r.risk).toBe('可能变慢')
  })

  it('整份响应被围栏包住 → 先剥围栏，JSON 仍被认出', () => {
    // 这是「必须先归一化再嗅探」的那条路径：stripMarkdownFence 的正则锚在串首，
    // 若先手工剥首行围栏，正文尾部的 ``` 就再没有东西去剥它。
    const raw = '```markdown\n{"expectedDelta": 7}\n\n# Body\n```'
    const r = parseProsePrediction(raw)
    expect(r.expectedEffect).toBe(7)
    // 尾换行被 stripMarkdownFence 吃掉（正则里的 `\n` 字面量紧邻闭合围栏，不属捕获组 1）
    // ⇒ 围栏路径的正文末尾没有换行；这是该函数既有性质，非本次改动引入。
    expect(r.body).toBe('# Body')
    expect(r.body).not.toContain('```')
  })

  it('expectedDelta 为 null → 剥行但不产生预测', () => {
    const r = parseProsePrediction('{"expectedDelta": null}\n\n# Body\n')
    expect(r.body).toBe('# Body\n')
    expect('expectedEffect' in r).toBe(false)
  })

  it('首行不是 JSON → 正文一字不改（N9 的判据）', () => {
    const raw = '# Body\n{"expectedDelta": 5}\n'
    const r = parseProsePrediction(raw)
    expect(r.body).toBe(raw)
    expect('expectedEffect' in r).toBe(false)
  })

  it('首行是 JSON 但无 expectedDelta 键 → 不吃掉它', () => {
    const raw = '{"note": "hi"}\n\n# Body\n'
    const r = parseProsePrediction(raw)
    expect(r.body).toBe(raw)
  })

  it('首行是裸标量 / 数组 → 不吃', () => {
    expect(parseProsePrediction('42\n\n# Body\n').body).toBe('42\n\n# Body\n')
    expect(parseProsePrediction('["a"]\n\n# Body\n').body).toBe('["a"]\n\n# Body\n')
  })

  it('expectedDelta 是字符串 → 剥行但不产生预测', () => {
    const r = parseProsePrediction('{"expectedDelta": "12"}\n\n# Body\n')
    expect(r.body).toBe('# Body\n')
    expect('expectedEffect' in r).toBe(false)
  })
})

describe('generateProseContent', () => {
  it('LLM 返回新内容 → 返回（去 markdown 包裹）', async () => {
    const llm = textLlm(
      '```markdown\n---\nname: memory\ndescription: improved\n---\n\n# Improved\n```',
    )
    const result = await generateProseContent(
      SIGNAL,
      llm,
      'apps/cli/skills/standard/memory.SKILL.md',
      'old',
    )
    expect(result!.body).toContain('name: memory')
    expect(result!.body).not.toContain('```')
  })

  it('LLM 返回空响应 → null', async () => {
    const llm = textLlm('')
    expect(await generateProseContent(SIGNAL, llm, 'f.md', 'old')).toBeNull()
  })
})

function twoStageLlm(filePath: string, newContent: string): Llm {
  let calls = 0
  return {
    chat: async function* () {
      calls++
      if (calls === 1) yield { type: 'text', content: filePath }
      else yield { type: 'text', content: newContent }
      yield { type: 'stop' }
    },
  }
}

describe('produceProseProposal', () => {
  it('两阶段成功 → 返回提议', async () => {
    const llm = twoStageLlm(
      SKILL_FILES[0]!,
      '---\nname: memory\ndescription: improved\n---\n\n# New body\n',
    )
    const readSkill = (p: string) => (p === SKILL_FILES[0] ? 'OLD-CONTENT' : '')
    const result = await produceProseProposal(SIGNAL, llm, SKILL_FILES, readSkill)
    expect(result).not.toBeNull()
    expect(result!.filePath).toBe(SKILL_FILES[0])
    expect(result!.originalContent).toBe('OLD-CONTENT')
    expect(result!.newContent).toContain('name: memory')
  })

  it('阶段 1 选不到 skill → null', async () => {
    const llm = twoStageLlm('bad-path.md', 'x')
    expect(await produceProseProposal(SIGNAL, llm, SKILL_FILES, () => '')).toBeNull()
  })

  it('读原文失败 → null', async () => {
    const llm = twoStageLlm(SKILL_FILES[0]!, 'x')
    const readSkill = () => {
      throw new Error('no file')
    }
    expect(await produceProseProposal(SIGNAL, llm, SKILL_FILES, readSkill)).toBeNull()
  })
})

describe('collectSkillFiles', () => {
  it('收集 standard + mipham 的 skill 文件（相对仓库根路径）', () => {
    const root = join(tmpdir(), 'crsi-collect-test')
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'apps', 'cli', 'skills', 'standard'), { recursive: true })
    mkdirSync(join(root, 'apps', 'cli', 'skills', 'mipham'), { recursive: true })
    writeFileSync(join(root, 'apps', 'cli', 'skills', 'standard', 'a.SKILL.md'), 'x')
    writeFileSync(join(root, 'apps', 'cli', 'skills', 'standard', 'b.SKILL.md'), 'x')
    writeFileSync(join(root, 'apps', 'cli', 'skills', 'mipham', 'c.mipham-skill.md'), 'x')

    const files = collectSkillFiles(root)
    expect(files).toContain('apps/cli/skills/standard/a.SKILL.md')
    expect(files).toContain('apps/cli/skills/standard/b.SKILL.md')
    expect(files).toContain('apps/cli/skills/mipham/c.mipham-skill.md')
    expect(files).toHaveLength(3)
  })

  it('目录不存在 → 空数组', () => {
    expect(collectSkillFiles(join(tmpdir(), 'nonexistent-root-xyz'))).toEqual([])
  })
})
