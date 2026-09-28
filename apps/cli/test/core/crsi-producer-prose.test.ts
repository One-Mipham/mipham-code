import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Llm } from '../../src/providers/llm'
import {
  parseProsePrediction,
  selectTargetSkill,
  generateProseContent,
  produceProseProposal,
  collectSkillFiles,
  extractCrsiLessonSummaries,
  selectResidentLessons,
  loadAlwaysOnLessonsBlock,
  formatNetChange,
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

  /**
   * 选目标提示词的**结构**：作者写在行数组里的三个空行分隔符必须真的到达模型。
   *
   * 此前这里用 `.filter(Boolean)` 丢掉那行**条件性**的 `severity`，而它分不清
   * 「条件空串」与「故意的段落分隔符」，把三段式一并吃掉 —— 实测提示词里 `\n\n` 一次都没有。
   * 修法是改用兄弟函数（`buildGenerateProsePrompt`）的 `...(cond ? [x] : [])` 写法。
   */
  describe('提示词结构', () => {
    function capturingLlm(seen: string[]): Llm {
      return {
        chat: async function* (req: Parameters<Llm['chat']>[0]) {
          const last = req.messages.at(-1)
          seen.push(typeof last?.content === 'string' ? last.content : '')
          yield { type: 'text', content: SKILL_FILES[0]! }
          yield { type: 'stop' }
        },
      }
    }

    it('三段之间的空行分隔符到达模型（说明 / 失败信号 / 候选文件）', async () => {
      const seen: string[] = []
      await selectTargetSkill(SIGNAL, capturingLlm(seen), SKILL_FILES)
      expect(seen[0]).toContain('\n\n失败信号：')
      expect(seen[0]).toContain('\n\n候选 skill 文件：\n- ')
    })

    it('负控：severity 缺席时不占行（原 `.filter(Boolean)` 的职责仍成立）', async () => {
      const seen: string[] = []
      const { severity: _drop, ...noSeverity } = SIGNAL
      await selectTargetSkill(noSeverity, capturingLlm(seen), SKILL_FILES)
      expect(seen[0]).not.toContain('severity')
      // 分隔符仍在：缺席的那一行不该把结构一起带走（改前这两条断言里至少一条必红）
      expect(seen[0]).toContain('\n\n失败信号：')
    })

    it('版本号随本笔前进（提示词是版本化资源，改了就必须动版本）', async () => {
      const seen: string[] = []
      await selectTargetSkill(SIGNAL, capturingLlm(seen), SKILL_FILES)
      expect(seen[0]).toContain('producer-prose-select v1.1.0')
    })
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
      '',
    )
    expect(result!.body).toContain('name: memory')
    expect(result!.body).not.toContain('```')
  })

  it('LLM 返回空响应 → null', async () => {
    const llm = textLlm('')
    expect(await generateProseContent(SIGNAL, llm, 'f.md', 'old', '')).toBeNull()
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
    const result = await produceProseProposal(SIGNAL, llm, SKILL_FILES, readSkill, '')
    expect(result).not.toBeNull()
    expect(result!.filePath).toBe(SKILL_FILES[0])
    expect(result!.originalContent).toBe('OLD-CONTENT')
    expect(result!.newContent).toContain('name: memory')
  })

  it('两阶段成功 + ε 预登记 → 提议带上 expectedEffect 与 risk', async () => {
    // 解析（parseProsePrediction）与提议（ProseProposalResult）之间那一步此前零覆盖：
    // 两处条件展开被删掉后，全量 2904 测试仍全绿 —— 因为还没有生产消费者读这两个字段。
    const llm = twoStageLlm(
      SKILL_FILES[0]!,
      '{"expectedDelta": 7, "risk": "可能与 memory 技能重叠"}\n---\nname: memory\ndescription: improved\n---\n\n# New body\n',
    )
    const readSkill = (p: string) => (p === SKILL_FILES[0] ? 'OLD-CONTENT' : '')
    const result = await produceProseProposal(SIGNAL, llm, SKILL_FILES, readSkill, '')
    expect(result).not.toBeNull()
    expect(result!.expectedEffect).toBe(7)
    expect(result!.risk).toBe('可能与 memory 技能重叠')
    // ε 那一行是元数据、不是正文：它必须已被剥掉，不能被写进 skill 文件
    expect(result!.newContent).not.toContain('expectedDelta')
  })

  it('阶段 1 选不到 skill → null', async () => {
    const llm = twoStageLlm('bad-path.md', 'x')
    expect(await produceProseProposal(SIGNAL, llm, SKILL_FILES, () => '', '')).toBeNull()
  })

  it('读原文失败 → null', async () => {
    const llm = twoStageLlm(SKILL_FILES[0]!, 'x')
    const readSkill = () => {
      throw new Error('no file')
    }
    expect(await produceProseProposal(SIGNAL, llm, SKILL_FILES, readSkill, '')).toBeNull()
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

// ── 教训送达生成算子（本笔前：算子收到**零条**教训） ──────────────────────────
//
// 病根是**缺席**：主代理的系统提示里有常驻教训，而真正**改写 skill 散文**的算子
// （`--prose`）拿到的提示词里一条都没有 —— 它写出的散文随后就是主代理要遵守的规则。
// 缺口本身是代码事实（`collectLlmText` 发 `systemPrompt: ''` + 单条 user 消息）；
// **不声称**「已观测到因此产出的坏提案」—— 那条路径至今在本机零次留记录运行。

describe('loadAlwaysOnLessonsBlock', () => {
  it('真教训文件 → 只含常驻条，warning 条在外，且**不带指针**', () => {
    const lessonsPath = join(import.meta.dirname, '..', '..', 'crsi-lessons.md')
    const all = extractCrsiLessonSummaries(readFileSync(lessonsPath, 'utf-8'))
    // 与系统提示那一份共用同一个择点 —— 手搓 filter 的那份会与生产漂移而不自知。
    const { resident, demoted } = selectResidentLessons(all)

    // 正对照：这份文件确实**两种都有**。缺了它，下面两轮断言在「解析全空」
    // 或「全都常驻」时会各自恒真 —— 探针的宇宙选错，红绿都不成证据。
    expect(resident.length).toBeGreaterThan(0)
    expect(demoted.length).toBeGreaterThan(0)

    const block = loadAlwaysOnLessonsBlock(lessonsPath)
    expect(block).not.toBe('')
    // 逐条，不抽样：渲染形状即 `**标题**`，故按渲染形状断言（标题子串可能偶然落在别条的正文里）
    for (const s of resident) expect(block).toContain(`**${s.title}**`)
    for (const s of demoted) expect(block).not.toContain(`**${s.title}**`)
    // 指针是给**有工具的读者**的（让它用 Read/Grep 自取）；算子是无工具的
    // `llm.chat` 单条消息 ⇒ 对它指针等于零，只能内联。块里出现指针文案即为这一半没做到。
    expect(block).not.toContain('未常驻')
  })

  it('文件缺席 → 空串（算子退回「无教训」的旧形状）', () => {
    expect(loadAlwaysOnLessonsBlock(join(tmpdir(), 'no-such-lessons-xyz.md'))).toBe('')
  })
})

describe('生成提示词内联常驻教训', () => {
  /**
   * 记下每次调用真正发出去的那条 user 消息 —— 断言的是**发出去的**，不是我以为发了的。
   *
   * `content` 的类型是 `string | ContentBlock[]`：非字符串时**抛**而不是记空串 ——
   * 记空串会让「探针取错了字段」与「提示词里真没有教训」在读数上同形（两侧都是空串，
   * 断言恒真而整段是空的）。前提先自证，断言才有资格当证据。
   */
  function captureUserMessage(seen: string[], req: Parameters<Llm['chat']>[0]): void {
    const c = req.messages[0]?.content
    if (typeof c !== 'string') {
      throw new Error(`探针前提不成立：首条 user 消息的 content 不是 string（${typeof c}）`)
    }
    seen.push(c)
  }

  function capturingLlm(seen: string[], text: string): Llm {
    return {
      chat: async function* (req: Parameters<Llm['chat']>[0]) {
        captureUserMessage(seen, req)
        yield { type: 'text', content: text }
        yield { type: 'stop' }
      },
    }
  }

  const BLOCK =
    '## CRSI Lessons (Self-Improvement Recall)\n\n1. **未要求的功能是负债**\n   只写解决问题所需的最小改动'

  it('传入的教训块出现在生成提示词里', async () => {
    const seen: string[] = []
    await generateProseContent(SIGNAL, capturingLlm(seen, '# New body\n'), 'f.md', 'old', BLOCK)
    expect(seen[0]).toContain('## CRSI Lessons')
    expect(seen[0]).toContain('只写解决问题所需的最小改动')
  })

  it('无教训（空串）→ 提示词里没有教训段；版本号随本笔前进', async () => {
    const seen: string[] = []
    await generateProseContent(SIGNAL, capturingLlm(seen, '# New body\n'), 'f.md', 'old', '')
    expect(seen[0]).not.toContain('CRSI Lessons')
    // 提示词是版本化资源（CLAUDE.md §十）：改了提示词就必须动版本，否则「哪一版产出的」
    // 在外部读数上不可分。
    expect(seen[0]).toContain('producer-prose-generate v1.2.0')
  })

  it('produceProseProposal 把教训块一路带到生成阶段（不是只到选目标那一步）', async () => {
    const seen: string[] = []
    const llm = twoStageLlm(SKILL_FILES[0]!, '# New body\n')
    // 两阶段共用同一个 llm：包一层，把两次调用都记下来
    const wrapped: Llm = {
      chat: (req) => {
        captureUserMessage(seen, req)
        return llm.chat(req)
      },
    }
    await produceProseProposal(SIGNAL, wrapped, SKILL_FILES, () => 'OLD', BLOCK)
    // 第二次调用才是生成阶段（第一次是选目标）
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toContain('CRSI Lessons') // 选目标只挑路径，教训在那里是噪声
    expect(seen[1]).toContain('只写解决问题所需的最小改动')
  })
})

describe('formatNetChange —— #20「未要求的功能是负债」可机械化的那一半', () => {
  it('三态：增 / 减 / 零', () => {
    expect(formatNetChange('a\nb\nc\n', 'a\nb\nc\nd\ne\n')).toBe(
      '📐 净变化（未判定）: 字符 +4，行 +2',
    )
    expect(formatNetChange('a\nb\nc\n', 'a\n')).toBe('📐 净变化（未判定）: 字符 -4，行 -2')
    expect(formatNetChange('a\n', 'b\n')).toBe('📐 净变化（未判定）: 字符 0，行 0')
  })

  it('行数定义：末尾无换行的非空串也算一行（否则「净行数」不可证伪）', () => {
    expect(formatNetChange('a', 'a\nb')).toBe('📐 净变化（未判定）: 字符 +2，行 +1')
  })

  it('空串是零行', () => {
    expect(formatNetChange('', 'ab')).toBe('📐 净变化（未判定）: 字符 +2，行 +1')
  })
})
