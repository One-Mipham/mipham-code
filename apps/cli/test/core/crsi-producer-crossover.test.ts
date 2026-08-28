import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import {
  parseCrossoverResult,
  removeLessonSections,
  produceCrossoverProposal,
} from '../../src/core/crsi-producer'

function textLlm(text: string): Llm {
  return {
    chat: async function* () {
      yield { type: 'text', content: text }
      yield { type: 'stop' }
    },
  }
}

const LESSONS = `# CRSI Lessons

本文件由 CRSI producer 自动追加教训。

<!-- CRSI lessons are appended below this line. -->

## research: 调研判断必须先读自身代码库再下结论

- 建议: 先读码再下结论
- 严重度: warning

### 证据

- 证据 A

## borrow-analysis: 借鉴外部项目必须查许可

- 建议: 借鉴要查许可+边界
- 严重度: warning

### 证据

- 证据 B

## simplicity: 未要求的功能是负债

- 建议: 不添加未要求的功能
- 严重度: critical

### 证据

- 证据 C
`

const HEADER_A = 'research: 调研判断必须先读自身代码库再下结论'
const HEADER_B = 'borrow-analysis: 借鉴外部项目必须查许可'

describe('parseCrossoverResult', () => {
  it('合法 JSON 解析成功', () => {
    const r = parseCrossoverResult(
      JSON.stringify({
        titleA: HEADER_A,
        titleB: HEADER_B,
        merged: { category: 'research', title: '合并', suggestion: '建议', evidence: ['e1', 'e2'] },
      }),
    )
    expect(r).not.toBeNull()
    expect(r!.titleA).toBe(HEADER_A)
    expect(r!.merged.evidence).toEqual(['e1', 'e2'])
  })

  it('带 ```json 围栏也解析', () => {
    const inner = JSON.stringify({
      titleA: 'a',
      titleB: 'b',
      merged: { category: 'c', title: 't', suggestion: 's', evidence: [] },
    })
    expect(parseCrossoverResult('```json\n' + inner + '\n```')).not.toBeNull()
  })

  it('字段缺失 → null', () => {
    expect(parseCrossoverResult('{"titleA":"a"}')).toBeNull()
    expect(
      parseCrossoverResult('{"titleA":"a","titleB":"b","merged":{"category":"c","title":"t"}}'),
    ).toBeNull()
  })

  it('非 JSON → null', () => {
    expect(parseCrossoverResult('not json')).toBeNull()
  })
})

describe('removeLessonSections', () => {
  it('移除两条教训，其余与 preamble 完好', () => {
    const out = removeLessonSections(LESSONS, [`## ${HEADER_A}`, `## ${HEADER_B}`])
    expect(out).not.toContain(HEADER_A)
    expect(out).not.toContain(HEADER_B)
    expect(out).toContain('simplicity: 未要求的功能是负债')
    expect(out).toContain('# CRSI Lessons')
    expect(out).toContain('<!-- CRSI lessons are appended below this line. -->')
  })

  it('移除不存在的 header 无副作用', () => {
    expect(removeLessonSections(LESSONS, ['## nonexistent: x'])).toBe(LESSONS)
  })
})

describe('produceCrossoverProposal', () => {
  const JSON_RESULT = JSON.stringify({
    titleA: HEADER_A,
    titleB: HEADER_B,
    merged: {
      category: 'research',
      title: '读码优先 + 借鉴查许可',
      suggestion: '先读码再下结论，借鉴要查许可',
      evidence: ['综合证据 1', '综合证据 2'],
    },
  })

  it('产出删二增一的教训变更候选', async () => {
    const p = await produceCrossoverProposal(textLlm(JSON_RESULT), LESSONS, '2026-08-28')
    expect(p).not.toBeNull()
    expect(p!.filePath).toBe('apps/cli/crsi-lessons.md')
    expect(p!.blastRadius).toEqual(['apps/cli/crsi-lessons.md'])
    expect(p!.originalContent).toBe(LESSONS)
    expect(p!.newContent).not.toContain(HEADER_A)
    expect(p!.newContent).not.toContain(HEADER_B)
    expect(p!.newContent).toContain('读码优先 + 借鉴查许可')
    expect(p!.newContent).toContain('综合证据 1')
    expect(p!.newContent).toContain('CRSI producer (crossover)')
  })

  it('titleA 不在文件 → null（防幻觉）', async () => {
    const bad = JSON.stringify({
      titleA: 'nonexistent: x',
      titleB: HEADER_A,
      merged: { category: 'c', title: 't', suggestion: 's', evidence: [] },
    })
    expect(await produceCrossoverProposal(textLlm(bad), LESSONS, '2026-08-28')).toBeNull()
  })

  it('titleA === titleB → null', async () => {
    const same = JSON.stringify({
      titleA: HEADER_A,
      titleB: HEADER_A,
      merged: { category: 'c', title: 't', suggestion: 's', evidence: [] },
    })
    expect(await produceCrossoverProposal(textLlm(same), LESSONS, '2026-08-28')).toBeNull()
  })

  it('LLM 返回空 → null', async () => {
    expect(await produceCrossoverProposal(textLlm(''), LESSONS, '2026-08-28')).toBeNull()
  })
})
