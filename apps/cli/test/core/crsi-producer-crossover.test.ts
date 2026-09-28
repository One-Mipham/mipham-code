import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import {
  parseCrossoverResult,
  removeLessonSections,
  produceCrossoverProposal,
  deriveMergedSeverity,
  formatSeverityShift,
} from '../../src/core/crsi-producer'
import { validateMergeConvergence } from '../../src/core/crsi-sandbox'

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
const HEADER_C = 'simplicity: 未要求的功能是负债'

/** 合并段是**追加在末尾**的那一段（newContent = 删二后的原文 + mergedSection）。 */
const lastSection = (md: string) => md.slice(md.lastIndexOf('\n## ') + 1)

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

describe('deriveMergedSeverity', () => {
  // 合并是**降维**：没有依据说产物比两个源更紧急。故取两者中**更严**的那个 —— 单调，
  // 既不可能把 warning 对升进常驻档，也不可能把 critical 洗成按需。
  // 判别力：把实现改成 `a === 'warning' || b === 'warning' ? 'warning' : 'critical'`
  //（取更宽）⇒ 第 2 条变红。
  it('两条 warning → warning（不再静默升进常驻档）', () => {
    expect(deriveMergedSeverity('warning', 'warning')).toBe('warning')
  })

  it('任一 critical → critical（critical 不能被合并洗掉）', () => {
    expect(deriveMergedSeverity('critical', 'warning')).toBe('critical')
    expect(deriveMergedSeverity('warning', 'critical')).toBe('critical')
    expect(deriveMergedSeverity('critical', 'critical')).toBe('critical')
  })
})

describe('formatSeverityShift', () => {
  // 「只呈现、不判定」：这一行报告**实际写进去的**档位（第 3 参），不是按规则应得的档位 ——
  // 报告要报实际用的那个数，否则读数描述的是规则、不是这次渲染。
  // 两个源与产物都已知 ⇒ **恒打**（含无变化），同 formatNetChange 的理由：
  // 「没升档」正是那条可证伪的基线读数，只打有变化的等于让读者看不见基线。
  it('无变化时打 ＝，且两源与产物都在行里', () => {
    const line = formatSeverityShift('warning', 'warning', 'warning')
    expect(line).toBe('＝ 档位（按更严来源派生）: warning + warning → warning')
  })

  it('产物严于更宽的那个源 → ⬆（这正是「合并把一条非常驻的变成了常驻」）', () => {
    expect(formatSeverityShift('critical', 'warning', 'critical')).toContain('⬆')
    expect(formatSeverityShift('warning', 'critical', 'critical')).toContain('⬆')
  })

  it('两源同档 → ＝', () => {
    expect(formatSeverityShift('critical', 'critical', 'critical')).toContain('＝')
  })

  it('档位由第 3 参决定 —— 不是按规则重算的', () => {
    // 若实现用 deriveMergedSeverity(a, b) 重算，这条会打成 critical（等于第二参）。
    expect(formatSeverityShift('warning', 'warning', 'critical')).toContain('⬆')
    expect(formatSeverityShift('warning', 'warning', 'critical')).toContain('→ critical')
  })

  it('收尾不带换行（回执自己加 \n，否则会与前一行粘连）', () => {
    const line = formatSeverityShift('warning', 'warning', 'warning')
    expect(line).not.toMatch(/\n$/)
    expect(line).not.toMatch(/^\n/)
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
    expect(p!.merge).toBe(true)
    // 正控接上闸本身：本用例只调 producer，**不进** runCrsiModification ⇒ 若不断言这一条，
    // 「闸放行合并」就只是假设而非证据（闸在这条路径上根本没被调用）。实测尺子：3 → 2 段。
    // 判别力：把 measureScaffold 的比较方向翻成 `after.lessons < before.lessons` ⇒ 本条变红。
    expect(validateMergeConvergence(p!)).toBeNull()
    expect(p!.filePath).toBe('apps/cli/crsi-lessons.md')
    expect(p!.blastRadius).toEqual(['apps/cli/crsi-lessons.md'])
    expect(p!.originalContent).toBe(LESSONS)
    expect(p!.newContent).not.toContain(HEADER_A)
    expect(p!.newContent).not.toContain(HEADER_B)
    expect(p!.newContent).toContain('读码优先 + 借鉴查许可')
    expect(p!.newContent).toContain('综合证据 1')
    expect(p!.newContent).toContain('CRSI producer (crossover)')
  })

  // 合并契约（提示词第 3 条）只列举 category/title/suggestion/evidence 四个字段，
  // **不提 severity** ⇒ LLM 无从保留它；而 buildLessonContent 此前把 severity 当可选、
  // 缺了就静默落抽取器的 fail-open 档（critical = 常驻）。于是两条 warning 合并出的
  // 产物会**升进常驻档**并吃掉刚加的 3,000 字符预算 —— 实测：常驻 6 条 2,155 字符 → 7 条 2,198。
  // 修法是**不问 LLM**：档位由确定性规则从两个源派生（A1 铁律：LLM 只生成不判定）⇒ 不可伪造。
  // 判别力：把 deriveMergedSeverity 换成「取更宽」或改回读 signal.severity ⇒ 本条变红。
  it('两条 warning 合并 → 产物落 warning（不再静默升进常驻档）', async () => {
    const p = await produceCrossoverProposal(textLlm(JSON_RESULT), LESSONS, '2026-08-28')
    expect(p!.severityA).toBe('warning')
    expect(p!.severityB).toBe('warning')
    expect(p!.mergedSeverity).toBe('warning')
    expect(lastSection(p!.newContent)).toContain('- 严重度: warning')
  })

  it('critical + warning 合并 → 产物落 critical（critical 不被合并洗掉）', async () => {
    const mixed = JSON.stringify({
      titleA: HEADER_C,
      titleB: HEADER_A,
      merged: { category: 'simplicity', title: '合并', suggestion: 's', evidence: [] },
    })
    const p = await produceCrossoverProposal(textLlm(mixed), LESSONS, '2026-08-28')
    expect(p!.severityA).toBe('critical')
    expect(p!.severityB).toBe('warning')
    expect(p!.mergedSeverity).toBe('critical')
    expect(lastSection(p!.newContent)).toContain('- 严重度: critical')
  })

  // 源段缺 `- 建议:` 行 ⇒ 抽取器不产出该条（它要求标题 + 建议同时在场），查不到档位。
  // fail-closed 到 critical —— 与抽取器「未知严重度不倒向『按需』」同一方向。
  it('源段查不到档位 → fail-closed 落 critical', async () => {
    const malformed = [
      '# CRSI Lessons',
      '',
      '## no-suggestion: 只有标题没有建议行',
      '',
      '### 证据',
      '',
      '- e',
      '',
      `## ${HEADER_A}`,
      '',
      '- 建议: 先读码再下结论',
      '- 严重度: warning',
      '',
      '### 证据',
      '',
      '- e',
      '',
    ].join('\n')
    const r = JSON.stringify({
      titleA: 'no-suggestion: 只有标题没有建议行',
      titleB: HEADER_A,
      merged: { category: 'c', title: '合并', suggestion: 's', evidence: [] },
    })
    const p = await produceCrossoverProposal(textLlm(r), malformed, '2026-08-28')
    expect(p!.severityA).toBe('critical')
    expect(p!.mergedSeverity).toBe('critical')
  })

  it('titleA 不在文件 → null（防幻觉）', async () => {
    const bad = JSON.stringify({
      titleA: 'nonexistent: x',
      titleB: HEADER_A,
      merged: { category: 'c', title: 't', suggestion: 's', evidence: [] },
    })
    expect(await produceCrossoverProposal(textLlm(bad), LESSONS, '2026-08-28')).toBeNull()
  })

  it('titleA 是真实标题的前缀 → null（精确匹配，非子串）', async () => {
    const prefix = JSON.stringify({
      titleA: HEADER_A.slice(0, -1),
      titleB: HEADER_B,
      merged: { category: 'c', title: 't', suggestion: 's', evidence: [] },
    })
    expect(await produceCrossoverProposal(textLlm(prefix), LESSONS, '2026-08-28')).toBeNull()
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
