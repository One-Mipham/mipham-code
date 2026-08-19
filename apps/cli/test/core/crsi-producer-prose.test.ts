import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import {
  selectTargetSkill,
  generateProseContent,
  produceProseProposal,
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
    expect(result).toContain('name: memory')
    expect(result).not.toContain('```')
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
