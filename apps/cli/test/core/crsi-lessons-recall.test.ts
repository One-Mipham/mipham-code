import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  extractCrsiLessonSummaries,
  buildCrsiLessonsBlock,
  buildCrsiLessonsPointer,
  buildLessonRevisitNudge,
  selectResidentLessons,
  loadAlwaysOnLessonsBlock,
  buildResidentLessonReport,
  isAlwaysOnLesson,
  RESIDENT_LESSONS_BUDGET,
  LESSONS_FILE,
  type CrsiLessonSummary,
} from '../../src/core/crsi-producer'
import { InstructionsLoader } from '../../src/core/instructions'

const SAMPLE = `# CRSI Lessons

本文件由 CRSI producer 自动追加教训。

<!-- CRSI lessons are appended below this line. -->

## security-rule: 命令替换 $() 的 blanket 拦截是误伤

- 建议: 安全规则只拦「具体危险内容」，不拦「合法语法本身」。
- 严重度: warning
- 生成时间: 2026-08-24
- 来源: 会话复盘

### 证据

- \`bash.ts\` 的 \`/\$\(/\` blanket 拦了 \`echo $(pwd)\` 等合法命令

## simplicity: 未要求的功能是负债（违反简洁优先）

- 建议: 不添加未被真实用户要求的功能。
- 严重度: critical
- 生成时间: 2026-08-24
- 来源: 会话复盘

### 证据

- vim 模式无真实用户需求
`

describe('extractCrsiLessonSummaries', () => {
  it('extracts title + suggestion for each lesson, ignoring evidence bullets', () => {
    const out = extractCrsiLessonSummaries(SAMPLE)
    expect(out).toEqual([
      {
        title: 'security-rule: 命令替换 $() 的 blanket 拦截是误伤',
        suggestion: '安全规则只拦「具体危险内容」，不拦「合法语法本身」。',
        severity: 'warning',
      },
      {
        title: 'simplicity: 未要求的功能是负债（违反简洁优先）',
        suggestion: '不添加未被真实用户要求的功能。',
        severity: 'critical',
      },
    ])
  })

  it('returns [] for empty content', () => {
    expect(extractCrsiLessonSummaries('')).toEqual([])
  })

  it('skips a lesson that has a heading but no 建议 line', () => {
    const md = '## orphan: 没有建议\n\n- 严重度: warning\n'
    expect(extractCrsiLessonSummaries(md)).toEqual([])
  })

  it('缺 严重度 时默认 critical —— fail-open 到常驻，不静默降级为按需', () => {
    const md = '## no-severity: 没写严重度\n\n- 建议: 照常召回。\n'
    expect(extractCrsiLessonSummaries(md)).toEqual([
      { title: 'no-severity: 没写严重度', suggestion: '照常召回。', severity: 'critical' },
    ])
  })

  it('未知 严重度 取值也按 critical 处理（闭集外的值不倒向按需）', () => {
    const md = '## weird: 严重度写错\n\n- 建议: 照常召回。\n- 严重度: blocker\n'
    expect(extractCrsiLessonSummaries(md)[0]!.severity).toBe('critical')
  })

  it('严重度 行写在 建议 之前也能读到（块级累积，不依赖行序）', () => {
    const md = '## pre: 顺序颠倒\n\n- 严重度: warning\n- 建议: 仍在一条里。\n'
    expect(extractCrsiLessonSummaries(md)).toEqual([
      { title: 'pre: 顺序颠倒', suggestion: '仍在一条里。', severity: 'warning' },
    ])
  })
})

describe('buildCrsiLessonsBlock', () => {
  it('returns an empty string for no lessons', () => {
    expect(buildCrsiLessonsBlock([])).toBe('')
  })

  it('renders a numbered recall block with title + suggestion', () => {
    const summaries: CrsiLessonSummary[] = [
      {
        title: 'simplicity: 未要求的功能是负债',
        suggestion: '不添加未被要求的功能。',
        severity: 'critical',
      },
    ]
    const block = buildCrsiLessonsBlock(summaries)
    expect(block).toContain('CRSI Lessons')
    expect(block).toContain('simplicity: 未要求的功能是负债')
    expect(block).toContain('不添加未被要求的功能。')
  })

  it('只渲染 critical —— warning 级不进常驻块', () => {
    const summaries: CrsiLessonSummary[] = [
      { title: 'c: 常驻', suggestion: '常驻建议。', severity: 'critical' },
      { title: 'w: 按需', suggestion: '按需建议。', severity: 'warning' },
    ]
    // 走**生产那条择点**，不手搓 filter —— 手搓的那份会与生产漂移而不自知。
    const block = buildCrsiLessonsBlock(selectResidentLessons(summaries).resident)
    expect(block).toContain('c: 常驻')
    expect(block).not.toContain('w: 按需')
  })
})

describe('isAlwaysOnLesson', () => {
  it('critical 常驻、warning 不常驻', () => {
    expect(isAlwaysOnLesson({ title: 't', suggestion: 's', severity: 'critical' })).toBe(true)
    expect(isAlwaysOnLesson({ title: 't', suggestion: 's', severity: 'warning' })).toBe(false)
  })
})

// 造一条长度确定的 critical：`suggestion` 用定长填充，长度即渲染成本的唯一变量。
const mkCritical = (i: number, len: number): CrsiLessonSummary => ({
  title: `c${i}: 第 ${i} 条`,
  suggestion: 'x'.repeat(len),
  severity: 'critical',
})

/** 三条各 400 字符的 critical，共 1,200 —— 恰好够测「挤掉一条」。 */
const THREE = [mkCritical(1, 400), mkCritical(2, 400), mkCritical(3, 400)]

describe('selectResidentLessons（常驻档预算）', () => {
  it('预算充足时全部常驻、一条不挤出 —— 真文件当前即此，故本次改动对它是 no-op', () => {
    const all = [mkCritical(1, 20), mkCritical(2, 20)]
    const sel = selectResidentLessons(all)
    expect(sel.resident).toEqual(all)
    expect(sel.overBudget).toEqual([])
    expect(sel.demoted).toEqual([])
  })

  it('不传预算时用默认值，且结果里如实带上「这一次用的」那个数', () => {
    expect(selectResidentLessons([]).budget).toBe(RESIDENT_LESSONS_BUDGET)
    expect(selectResidentLessons([], 7).budget).toBe(7)
  })

  it('超预算的 critical 进 demoted/overBudget —— 不丢弃', () => {
    const sel = selectResidentLessons(THREE, buildCrsiLessonsBlock(THREE).length - 1)
    expect(sel.resident).toHaveLength(2)
    expect(sel.overBudget).toHaveLength(1)
    expect(sel.demoted).toHaveLength(1)
    // 守恒：三条的去处之和仍是三条
    expect(sel.resident.length + sel.demoted.length).toBe(THREE.length)
  })

  it('择优方向：留下新的（文件尾），挤出旧的（文件头）', () => {
    const sel = selectResidentLessons(THREE, buildCrsiLessonsBlock(THREE).length - 1)
    expect(sel.resident.map((s) => s.title)).toEqual([THREE[1]!.title, THREE[2]!.title])
    expect(sel.overBudget.map((s) => s.title)).toEqual([THREE[0]!.title])
    expect(sel.demoted.map((s) => s.title)).toEqual([THREE[0]!.title])
  })

  it('渲染序恒为文件序 —— 择优方向不倒灌进正文', () => {
    const sel = selectResidentLessons(THREE, buildCrsiLessonsBlock(THREE).length - 1)
    const block = buildCrsiLessonsBlock(sel.resident)
    expect(block.indexOf(THREE[1]!.title)).toBeLessThan(block.indexOf(THREE[2]!.title))
  })

  it('边界取 ≤：预算恰好等于渲染长度时全留，少一个字符就挤出', () => {
    const all = [mkCritical(1, 100), mkCritical(2, 100)]
    const exact = buildCrsiLessonsBlock(all).length
    expect(selectResidentLessons(all, exact).resident).toHaveLength(2)
    expect(selectResidentLessons(all, exact - 1).overBudget).toHaveLength(1)
  })

  it('不变量：常驻块渲染出来永不超预算（扫一遍各种预算）', () => {
    const all = [mkCritical(1, 300), mkCritical(2, 200), mkCritical(3, 500), mkCritical(4, 50)]
    // 前提先自证：这一组在预算充裕时**真的**渲染得出来（否则下面全在断言空串）
    expect(buildCrsiLessonsBlock(selectResidentLessons(all).resident).length).toBeGreaterThan(0)
    for (const budget of [0, 100, 400, 800, 1600, RESIDENT_LESSONS_BUDGET]) {
      const block = buildCrsiLessonsBlock(selectResidentLessons(all, budget).resident)
      expect(block.length).toBeLessThanOrEqual(budget)
    }
  })

  it('单条自身就超预算时它自己出局 —— 最长的单条没有豁免权', () => {
    const huge = mkCritical(1, 4000)
    const small = mkCritical(2, 20)
    const sel = selectResidentLessons([huge, small], RESIDENT_LESSONS_BUDGET)
    expect(sel.resident.map((s) => s.title)).toEqual([small.title])
    expect(sel.overBudget.map((s) => s.title)).toEqual([huge.title])
  })

  it('warning 永不进常驻，与预算多大无关', () => {
    const warn: CrsiLessonSummary = { title: 'w: 按需', suggestion: '按需。', severity: 'warning' }
    const crit = mkCritical(1, 20)
    const sel = selectResidentLessons([warn, crit], 1_000_000)
    expect(sel.resident.map((s) => s.title)).toEqual([crit.title])
    expect(sel.demoted.map((s) => s.title)).toEqual([warn.title])
    expect(sel.overBudget).toEqual([]) // 它是 warning，不是「被预算挤出」
  })
})

describe('buildCrsiLessonsPointer', () => {
  const mixed: CrsiLessonSummary[] = [
    { title: 'c: 常驻', suggestion: '常驻建议。', severity: 'critical' },
    { title: 'w1: 按需', suggestion: '按需建议一。', severity: 'warning' },
    { title: 'w2: 按需', suggestion: '按需建议二。', severity: 'warning' },
  ]

  it('报出未常驻条数与文件路径，使模型有真实召回入口', () => {
    const pointer = buildCrsiLessonsPointer(
      selectResidentLessons(mixed),
      '/repo/apps/cli/crsi-lessons.md',
    )
    expect(pointer).toContain('2')
    expect(pointer).toContain('/repo/apps/cli/crsi-lessons.md')
  })

  it('全部常驻时返回空串（不产生悬空指针）', () => {
    const onlyCritical = mixed.filter(isAlwaysOnLesson)
    expect(
      buildCrsiLessonsPointer(
        selectResidentLessons(onlyCritical),
        '/repo/apps/cli/crsi-lessons.md',
      ),
    ).toBe('')
  })

  it('没有 critical 时仍报指针 —— 否则 33 条 warning 会无声消失', () => {
    const onlyWarning = mixed.filter((s) => !isAlwaysOnLesson(s))
    const pointer = buildCrsiLessonsPointer(
      selectResidentLessons(onlyWarning),
      '/repo/apps/cli/crsi-lessons.md',
    )
    expect(pointer).toContain('2')
    expect(pointer).toContain('/repo/apps/cli/crsi-lessons.md')
  })

  it('无教训时返回空串', () => {
    expect(
      buildCrsiLessonsPointer(selectResidentLessons([]), '/repo/apps/cli/crsi-lessons.md'),
    ).toBe('')
  })

  it('把「被预算挤出」与「本来就是 warning」分开说，并点名被挤出的那条', () => {
    const budget = buildCrsiLessonsBlock(THREE).length - 1
    const pointer = buildCrsiLessonsPointer(
      selectResidentLessons(THREE, budget),
      '/repo/apps/cli/crsi-lessons.md',
    )
    expect(pointer).toContain('critical') // 说清挤出的是哪一档
    expect(pointer).toContain(String(budget)) // 报出**这一次**的预算，读者才知道杠杆在哪
    expect(pointer).not.toContain(String(RESIDENT_LESSONS_BUDGET)) // 不能报常量了事
    expect(pointer).toContain(THREE[0]!.title) // 被挤出的那条被点名
    expect(pointer).not.toContain(THREE[2]!.title) // 常驻的那条不点名（指针不重复正文）
  })

  it('指针不得再声称未常驻的都是 warning 级 —— 分档加预算后这话已经不成立', () => {
    const budget = buildCrsiLessonsBlock(THREE).length - 1
    const pointer = buildCrsiLessonsPointer(
      selectResidentLessons(THREE, budget),
      '/repo/apps/cli/crsi-lessons.md',
    )
    expect(pointer).not.toContain('warning 级')
  })

  it('点名有上限（3 条），其余折成「等 N 条」—— 否则指针自己成了无界常驻成本', () => {
    const many = [1, 2, 3, 4, 5].map((i) => mkCritical(i, 400))
    // 只留得下一条 ⇒ 挤出四条，超过点名上限
    const budget = buildCrsiLessonsBlock([many[4]!]).length
    const sel = selectResidentLessons(many, budget)
    expect(sel.overBudget).toHaveLength(4) // 正对照：确实超过了上限
    const pointer = buildCrsiLessonsPointer(sel, '/repo/apps/cli/crsi-lessons.md')
    for (const s of sel.overBudget.slice(0, 3)) expect(pointer).toContain(s.title)
    expect(pointer).not.toContain(sel.overBudget[3]!.title) // 第 4 条只计数、不点名
    expect(pointer).toContain('等 4 条')
  })
})

describe('buildLessonRevisitNudge', () => {
  const mixed: CrsiLessonSummary[] = [
    { title: 'c: 常驻', suggestion: '常驻建议。', severity: 'critical' },
    { title: 'w1: 按需', suggestion: '按需建议一。', severity: 'warning' },
    { title: 'w2: 按需', suggestion: '按需建议二。', severity: 'warning' },
  ]
  const PATH = '/repo/apps/cli/crsi-lessons.md'

  it('有未常驻教训时给出路径 —— 否则扳机响了却无处可去', () => {
    const nudge = buildLessonRevisitNudge(selectResidentLessons(mixed), PATH)
    expect(nudge).toContain(PATH)
    expect(nudge.length).toBeGreaterThan(0)
  })

  it('**非指令式**：不点名、不读、不摘要任何一条教训的标题', () => {
    const nudge = buildLessonRevisitNudge(selectResidentLessons(mixed), PATH)
    for (const s of mixed) expect(nudge).not.toContain(s.title)
    // 正文也没被抄进来
    for (const s of mixed) expect(nudge).not.toContain(s.suggestion)
  })

  it('全部常驻时返回空串（没有指针就没有扳机）', () => {
    const onlyCritical = mixed.filter(isAlwaysOnLesson)
    expect(selectResidentLessons(onlyCritical).demoted).toHaveLength(0) // 前提自证
    expect(buildLessonRevisitNudge(selectResidentLessons(onlyCritical), PATH)).toBe('')
  })

  it('无教训时返回空串', () => {
    expect(buildLessonRevisitNudge(selectResidentLessons([]), PATH)).toBe('')
  })

  it('与指针**同条件**：同一批输入下，指针非空 ⟺ 扳机非空（防两处漂移）', () => {
    // 一声哨说「有 33 条未常驻」、另一声说「没有」，读者不知道信哪个。
    const cases: CrsiLessonSummary[][] = [
      mixed,
      mixed.filter(isAlwaysOnLesson),
      mixed.filter((s) => !isAlwaysOnLesson(s)),
      [],
    ]
    for (const summaries of cases) {
      const sel = selectResidentLessons(summaries)
      const pointerEmpty = buildCrsiLessonsPointer(sel, PATH) === ''
      const nudgeEmpty = buildLessonRevisitNudge(sel, PATH) === ''
      expect(nudgeEmpty, `指针空=${pointerEmpty} 而扳机空=${nudgeEmpty}`).toBe(pointerEmpty)
    }
  })
})

describe('InstructionsLoader.crsiLessonNudgeText（真文件）', () => {
  it('真文件里确实有未常驻教训（负控：否则本组整体空转报绿）', () => {
    const loader = new InstructionsLoader()
    loader.loadAll(process.cwd())
    expect(loader.crsiLessonNudgeText().length).toBeGreaterThan(0)
  })

  it('未 loadAll 的装载器：空串，不指向任何文件', () => {
    expect(new InstructionsLoader().crsiLessonNudgeText()).toBe('')
  })
})

describe('InstructionsLoader CRSI lessons recall (integration)', () => {
  it('injects the CRSI Lessons block after loadAll reads crsi-lessons.md', () => {
    const loader = new InstructionsLoader()
    loader.loadAll(process.cwd())
    expect(loader.buildSystemPrompt()).toContain('CRSI Lessons')
  })
})

// 分档后的**注入面**：真文件进真装载器，验「常驻的是哪一份」。
// 每条都带负控（真文件里确实有该档教训），否则严重度解析坏掉时本组会整体空转报绿。
describe('InstructionsLoader 注入的是分档后的一份（真文件）', () => {
  const real = readFileSync(resolve(__dirname, '../../crsi-lessons.md'), 'utf-8')
  const all = extractCrsiLessonSummaries(real)
  const sel = selectResidentLessons(all)
  const warn = all.filter((s) => !isAlwaysOnLesson(s))

  const load = () => {
    const loader = new InstructionsLoader()
    loader.loadAll(process.cwd())
    return loader
  }

  it('负控：真文件里 critical 与 warning 两档都非空', () => {
    expect(all.filter(isAlwaysOnLesson).length).toBeGreaterThan(0)
    expect(warn.length).toBeGreaterThan(0)
  })

  it('常驻的那些正文进系统提示（按择点算，不按「severity 是 critical」算）', () => {
    const prompt = load().buildSystemPrompt()
    expect(sel.resident.length).toBeGreaterThan(0) // 正对照：不是空集全绿
    for (const c of sel.resident) expect(prompt).toContain(c.suggestion)
  })

  it('未常驻的那些正文不进系统提示', () => {
    const prompt = load().buildSystemPrompt()
    expect(sel.demoted.length).toBeGreaterThan(0) // 正对照
    for (const d of sel.demoted) expect(prompt).not.toContain(d.suggestion)
  })

  it('指针给出未常驻条数与文件路径 —— 否则 33 条被无声丢弃', () => {
    const prompt = load().buildSystemPrompt()
    expect(prompt).toContain(String(sel.demoted.length))
    expect(prompt).toContain('crsi-lessons.md')
  })

  it('sizeReport 报的字符数 == 实际注入的那一份（含指针），不是整个文件', () => {
    const loader = load()
    const entry = loader.sizeReport().files.find((f) => f.path.endsWith('crsi-lessons.md'))
    expect(entry).toBeDefined()
    const expected = [
      buildCrsiLessonsBlock(sel.resident),
      buildCrsiLessonsPointer(sel, entry!.path),
    ].filter(Boolean)
    expect(entry!.chars).toBe(expected.join('\n\n').length)
    // 正对照：全量那一份明显更大 —— 证明这里比的是「分档后」而不是「照旧全量」。
    expect(entry!.chars).toBeLessThan(buildCrsiLessonsBlock(all).length)
  })

  it('**两个读者**渲染的是同一个常驻集（「两条渲染路径只接一条」的守卫）', () => {
    const lessonsPath = resolve(__dirname, '../../crsi-lessons.md')
    // 读者一：生成算子（--prose）那一份，不带指针
    const operatorBlock = loadAlwaysOnLessonsBlock(lessonsPath)
    expect(operatorBlock).not.toBe('') // 正对照：否则下面比的是两个空集
    const inOperator = all
      .filter((s) => operatorBlock.includes(`**${s.title}**`))
      .map((s) => s.title)

    // 读者二：系统提示那一份（经 InstructionsLoader → crsiLessonsText）
    const prompt = load().buildSystemPrompt()
    const inPrompt = all.filter((s) => prompt.includes(`**${s.title}**`)).map((s) => s.title)

    expect(inOperator.length).toBeGreaterThan(0)
    expect(inPrompt).toEqual(inOperator)
  })
})

// 真文件当前 0 条被挤出 ⇒ 上面那条双读者一致性对**预算路径**是空转的。
// 这组造一份会超预算的教训文件，把预算路径整个跑起来，两个读者都验。
describe('超预算时两个读者仍指向同一个常驻集（合成真文件）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mipham-lessons-budget-'))
  // `LESSONS_FILE` 是**仓库相对**路径（`apps/cli/crsi-lessons.md`）：`loadAll` 传的是
  // `gitRoot(cwd)` ⇒ 合成根必须照仓库的形状摆，否则装载器读到的路径不存在、
  // 而「读不到」与「没有教训」在系统提示上同形（都只是少了那一段）。
  mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
  const lessonsPath = join(root, LESSONS_FILE)
  // 8 条各 400 字符的 critical：渲染出来 ~3.5k，必然越过 3,000 的预算。
  const md =
    '# CRSI Lessons\n\n' +
    Array.from(
      { length: 8 },
      // 建议**逐条唯一**（前缀带序号）：若八条同文，「被挤出的那条正文不在提示里」
      // 这个断言分辨不出对象 —— 探针的宇宙选错，红绿都不成证据。
      (_, i) =>
        `## zzz-probe-${i}: 合成第 ${i} 条\n\n- 建议: p${i}-${'x'.repeat(400)}\n- 严重度: critical\n`,
    ).join('\n')
  writeFileSync(lessonsPath, md, 'utf-8')

  const load = () => {
    const loader = new InstructionsLoader()
    loader.loadAll(root)
    return loader
  }

  it('常驻块被压到预算内，且确实挤出了人（正对照：不是「本来就没超」）', () => {
    const { resident, overBudget } = selectResidentLessons(extractCrsiLessonSummaries(md))
    expect(buildCrsiLessonsBlock(resident).length).toBeLessThanOrEqual(RESIDENT_LESSONS_BUDGET)
    expect(overBudget.length).toBeGreaterThan(0)
    expect(resident.length + overBudget.length).toBe(8)
  })

  it('被挤出的那条在系统提示里**被点名**，且它的建议正文不在系统提示里', () => {
    const sel = selectResidentLessons(extractCrsiLessonSummaries(md))
    const prompt = load().buildSystemPrompt()
    expect(prompt).toContain(sel.overBudget[0]!.title) // 点名
    expect(prompt).not.toContain(sel.overBudget[0]!.suggestion) // 但正文不常驻
    expect(prompt).toContain(`常驻档预算（${RESIDENT_LESSONS_BUDGET} 字符）`)
  })

  it('两个读者渲染的是同一个常驻集 —— 即便有挤出', () => {
    const all = extractCrsiLessonSummaries(md)
    const operatorBlock = loadAlwaysOnLessonsBlock(lessonsPath)
    expect(operatorBlock).not.toBe('')
    const inOperator = all
      .filter((s) => operatorBlock.includes(`**${s.title}**`))
      .map((s) => s.title)
    const prompt = load().buildSystemPrompt()
    const inPrompt = all.filter((s) => prompt.includes(`**${s.title}**`)).map((s) => s.title)
    expect(inOperator.length).toBeGreaterThan(0)
    expect(inOperator.length).toBeLessThan(all.length) // 正对照：确实少了几条，不是「全都在」
    expect(inPrompt).toEqual(inOperator)
  })
})

// 真账本的**完整性**：抽取器会静默丢弃「有标题但 建议 行缺失/格式漂移」的块
// （见上方 'skips a lesson that has a heading but no 建议 line'）—— 而上面那条集成测试
// 只断言 block「存在」、不钉条数，报不出「某条没进去」。此处按「每个 ## 块都必须被抽出」
// 断言，**不钉条数**（钉了以后每加一条就红）。
describe('crsi-lessons.md 真文件完整性（不钉条数）', () => {
  const real = readFileSync(resolve(__dirname, '../../crsi-lessons.md'), 'utf-8')
  const blocks = real.split(/^## /m).slice(1)

  it('每个 ## 块都产出一条非空建议 —— 无一被静默丢弃', () => {
    const got = extractCrsiLessonSummaries(real)
    const orphans = blocks
      .map((b) => (b.split('\n')[0] ?? '').trim())
      .filter((t) => !got.some((s) => s.title === t))
    expect(orphans).toEqual([])
    expect(got).toHaveLength(blocks.length)
  })

  it('负对照：伪造标题在真账本里报未命中', () => {
    const titles = new Set(extractCrsiLessonSummaries(real).map((s) => s.title))
    expect(titles.has('不存在的轴: 这条标题是伪造的')).toBe(false)
  })
})

/**
 * 常驻档名册 —— `selectResidentLessons` 的**第三个读者**，也是唯一给人看的那个。
 *
 * 前两个读者（系统提示 / `--prose` 算子）的输出都只进模型的上下文；而常驻档的成本是
 * **人**在付（每条 critical 都随每次请求发出去），能动手降档、缩短的也只有人。所以
 * 这组测试的重点不是「渲染得好看」，而是**它报的就是真正注入的那一份** —— 报告与对象
 * 脱节，人就会照着一份错的材料去做降档决定（那比没有材料更坏）。
 */
describe('buildResidentLessonReport（常驻档名册，唯一给人看的读者）', () => {
  const PATH = '/repo/apps/cli/crsi-lessons.md'
  const mkWarning = (title: string, len: number): CrsiLessonSummary => ({
    title,
    suggestion: 'y'.repeat(len),
    severity: 'warning',
  })

  /** 取报告里印出来的「合计 N」/「X **N** 条」。**取不到就抛** —— 否则比对会静默恒真。 */
  const printedTotal = (report: string): number => {
    const m = report.match(/^合计 ([\d,]+) =/m)
    if (!m) throw new Error('报告里没有「合计 N =」这一行')
    return Number(m[1]!.replace(/,/g, ''))
  }
  const printedCount = (report: string, label: string): number => {
    const m = report.match(new RegExp(`^${label} \\*\\*(\\d+)\\*\\* 条`, 'm'))
    if (!m) throw new Error(`报告里没有行首的「${label} N 条」`)
    return Number(m[1])
  }

  it('报的常驻集 == 真正注入的那一份（走同一个择点，不是另算一份）', () => {
    const sel = selectResidentLessons([
      mkCritical(1, 400),
      mkCritical(2, 400),
      mkWarning('w: 按需的', 50),
    ])
    const report = buildResidentLessonReport(sel, PATH)

    // 正对照：确实分了档，否则下面比的是「全都在」这种平凡情形
    expect(sel.resident.length).toBeGreaterThan(0)
    expect(sel.demoted.length).toBeGreaterThan(0)

    for (const s of sel.resident) expect(report).toContain(s.title)
    // 未常驻的那条**不进逐条清单** —— 它只该出现在计数里
    expect(report).not.toContain('w: 按需的')
    // 合计 == 真渲染器量出来的那个数（改这里若另算一份，长度对不上）
    expect(printedTotal(report)).toBe(buildCrsiLessonsBlock(sel.resident).length)
    expect(printedCount(report, '常驻')).toBe(sel.resident.length)
    expect(printedCount(report, '未常驻')).toBe(sel.demoted.length)
  })

  it('报预算用的是 selection.budget（这一次的值），不是默认常量', () => {
    const sel = selectResidentLessons([mkCritical(1, 100), mkCritical(2, 100)], 2500)
    expect(sel.budget).toBe(2500) // 前提自证
    const report = buildResidentLessonReport(sel, PATH)

    expect(report).toContain('预算 2,500')
    expect(report).not.toContain(`预算 ${RESIDENT_LESSONS_BUDGET.toLocaleString('en-US')}`)
    const headroom = 2500 - buildCrsiLessonsBlock(sel.resident).length
    expect(report).toContain(`余量 ${headroom.toLocaleString('en-US')}`)
  })

  it('加法自证：表头 + 逐条 + 分隔 == 渲染器实测，且当场验算', () => {
    const sel = selectResidentLessons([mkCritical(1, 300), mkCritical(2, 300)])
    const report = buildResidentLessonReport(sel, PATH)
    // 逐条和必然大于合计（表头是共担的）—— 与其让人去猜差额，算式必须印出来并且对得上
    expect(report).toContain('表头')
    expect(report).toContain('分隔')
    expect(report).toContain('相符')
    expect(report).not.toContain('不符')
  })

  it('指针字符**单列**，并明说不含在预算内 —— 免得拿总额去对预算', () => {
    const sel = selectResidentLessons([
      mkCritical(1, 300),
      mkCritical(2, 300),
      mkWarning('w: 按需的', 20),
    ])
    const ptr = buildCrsiLessonsPointer(sel, PATH)
    expect(ptr.length).toBeGreaterThan(0) // 正对照：否则下面断的是一个空指针
    const report = buildResidentLessonReport(sel, PATH)
    expect(report).toContain(`指针另有 ${ptr.length.toLocaleString('en-US')} 字符`)
    expect(report).toContain('不含在预算内')
  })

  it('有 critical 被预算挤出时**点名**它们 —— 人要知道该动哪一条', () => {
    const sel = selectResidentLessons(THREE, buildCrsiLessonsBlock(THREE).length - 1)
    expect(sel.overBudget).toHaveLength(1) // 正对照
    const report = buildResidentLessonReport(sel, PATH)
    expect(report).toContain(sel.overBudget[0]!.title)
    expect(report).toContain('因预算被挤出')
  })

  it('单条自身超预算：不崩、常驻 0 条、那条被点名', () => {
    const huge = mkCritical(1, 5000)
    const sel = selectResidentLessons([huge])
    expect(sel.resident).toHaveLength(0) // 正对照：确实是「单条超预算」这一格
    expect(sel.overBudget).toHaveLength(1)
    const report = buildResidentLessonReport(sel, PATH)
    expect(report).toContain(huge.title)
    expect(printedCount(report, '常驻')).toBe(0)
    expect(report).not.toMatch(/NaN|Infinity/)
  })

  it('预算为 0：不产生 NaN/Infinity 百分比', () => {
    const sel = selectResidentLessons([mkCritical(1, 100)], 0)
    const report = buildResidentLessonReport(sel, PATH)
    expect(report).not.toMatch(/NaN|Infinity/)
    expect(report).toContain('已用 —%')
  })

  it('全 warning（无 critical）：常驻 0 条，仍报出未常驻条数', () => {
    const sel = selectResidentLessons([mkWarning('w1', 10), mkWarning('w2', 10)])
    const report = buildResidentLessonReport(sel, PATH)
    expect(printedCount(report, '常驻')).toBe(0)
    expect(printedCount(report, '未常驻')).toBe(2)
  })

  it('空教训集：给一句话，不崩、不抛', () => {
    const report = buildResidentLessonReport(selectResidentLessons([]), PATH)
    expect(report).toContain('没有可召回的教训')
    expect(report).toContain(PATH)
  })

  it('真文件：名册报的常驻条数 == 择点选出的条数（不钉死数字）', () => {
    const real = readFileSync(resolve(__dirname, '../../crsi-lessons.md'), 'utf-8')
    const sel = selectResidentLessons(extractCrsiLessonSummaries(real))
    expect(sel.resident.length).toBeGreaterThan(0) // 前提自证
    const report = buildResidentLessonReport(sel, resolve(__dirname, '../../crsi-lessons.md'))
    expect(printedCount(report, '常驻')).toBe(sel.resident.length)
    expect(printedTotal(report)).toBe(buildCrsiLessonsBlock(sel.resident).length)
  })
})
