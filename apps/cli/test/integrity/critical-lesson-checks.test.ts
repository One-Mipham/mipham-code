/**
 * 每条 **critical** 教训必须指向一条真实存在的机械检查。
 *
 * 为什么：`crsi-lessons.md` 里 warning 教训可以有几十条，critical 是「有人判定
 * 它必须每次在场」的那一档；但一条教训只要没有检查，它的执行力就等于「下一次
 * 有人想起来」。本守卫把「想起来」换成引用完整性 —— 教训在、检查就必须在。
 *
 * **它能证明什么、不能证明什么**（别把绿读成「教训被遵守了」）：
 * - 能：这个 critical 教训映射的测试文件与测试名真实存在；教训新增而未映射 ⇒ 红；
 *   映射指向的测试被改名/删除 ⇒ 红；注册表里有教训文件里没有的条目 ⇒ 红。
 * - 不能：测试本身是否足够强。检查的内容仍需人工复核 —— 本守卫只保证**链接**不断。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLI_DIR = join(import.meta.dirname, '..', '..')
const LESSONS_FILE = join(CLI_DIR, 'crsi-lessons.md')

interface CriticalLesson {
  id: string
  title: string
}

/** `## <id>: <title>` + `- 严重度: critical` 组成一条 critical 教训。 */
export function parseCriticalLessons(markdown: string): CriticalLesson[] {
  const out: CriticalLesson[] = []
  let current: { id: string; title: string; critical: boolean } | null = null
  const flush = () => {
    if (current?.critical) out.push({ id: current.id, title: current.title })
    current = null
  }
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+([^:\s]+):\s*(.*)$/.exec(line)
    if (heading) {
      flush()
      current = { id: heading[1]!, title: heading[2]!, critical: false }
      continue
    }
    if (current && /^-\s*严重度:\s*critical\s*$/.test(line)) current.critical = true
  }
  flush()
  return out
}

interface TestCheck {
  /** 相对 apps/cli 的测试文件路径。 */
  file: string
  /** 该文件里的 `it('<name>'`。 */
  name: string
}

interface LessonAudit {
  problems: string[]
  /** 已确认可解析的映射（教训 id）。 */
  checked: string[]
}

/** 纯函数便于负控：文件内容由 `read` 提供，`null` 表示文件不存在。 */
export function auditLessonChecks(
  lessons: CriticalLesson[],
  checks: Record<string, TestCheck>,
  read: (relativePath: string) => string | null,
): LessonAudit {
  const problems: string[] = []
  const checked: string[] = []

  const counts = new Map<string, number>()
  for (const lesson of lessons) counts.set(lesson.id, (counts.get(lesson.id) ?? 0) + 1)
  for (const [id, n] of counts) {
    if (n > 1) problems.push(`critical 教训 id 重复：${id} ×${n} —— 映射会有歧义`)
  }

  for (const lesson of lessons) {
    const check = checks[lesson.id]
    if (!check) {
      problems.push(`${lesson.id}: critical 教训没有机械检查`)
      continue
    }
    const source = read(check.file)
    if (source === null) {
      problems.push(`${lesson.id}: 指向的测试文件不存在（${check.file}）`)
      continue
    }
    if (!source.includes(`it('${check.name}'`) && !source.includes(`it("${check.name}"`)) {
      problems.push(`${lesson.id}: ${check.file} 里找不到测试「${check.name}」`)
      continue
    }
    checked.push(lesson.id)
  }

  const lessonIds = new Set(lessons.map((l) => l.id))
  for (const id of Object.keys(checks)) {
    if (!lessonIds.has(id)) {
      // 教训被删/降级而注册表没跟上 —— 链接的另一端断了，必须红。
      problems.push(`注册表里的「${id}」不是 critical 教训（陈旧条目）`)
    }
  }

  return { problems, checked }
}

/**
 * critical 教训 → 机械检查。
 *
 * `code-review-gate` 映射的是「评审机制还在」而不是「评审判过」：能否证明一次
 * review 真的跑过，静态检查做不到；它至少保证 `/code-review` 没有在无人注意时
 * 从构建里消失。触发时机由 CLAUDE.md 的评审策略（solo 例外）约束。
 */
const LESSON_CHECKS: Record<string, TestCheck> = {
  'read-first': {
    file: 'test/core/instructions.test.ts',
    name: '先读代码铁律把 graft 说成 CLI，而不是并列在自家工具里',
  },
  'signal-discrimination': {
    file: 'test/core/capability-inventory.test.ts',
    name: 'stamps every live number with its in-process source',
  },
  simplicity: {
    file: 'test/ui/command-reachability.test.ts',
    name: 'every multi-word command has a registered parent handler',
  },
  'verify-before-build': {
    file: 'test/core/permission-rules.test.ts',
    name: 'does not match `npm run build` under a Read(./**/build/**) rule',
  },
  'failure-is-not-rollback': {
    file: 'test/core/crsi-modify.test.ts',
    name: 'tests fail → phase failed + auto-rollback (no pending)',
  },
  'code-review-gate': {
    file: 'test/integrity/critical-lesson-checks.test.ts',
    name: '`/code-review` 技能同时在磁盘与内嵌清单里（评审机制随构建一起发）',
  },
}

const readRepoFile = (relativePath: string): string | null => {
  const path = join(CLI_DIR, relativePath)
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

// ── 判据自身的负控：五种断链形态必须各自变红 ──

const syntheticLesson = (id: string): CriticalLesson => ({ id, title: id })

describe('auditLessonChecks 能失败的形态', () => {
  const files: Record<string, string> = {
    'a.test.ts': "it('keeps working', () => {})",
  }
  const read = (p: string) => files[p] ?? null

  it('positive control：映射齐全时零问题', () => {
    const audit = auditLessonChecks(
      [syntheticLesson('a')],
      { a: { file: 'a.test.ts', name: 'keeps working' } },
      read,
    )
    expect(audit.problems).toEqual([])
    expect(audit.checked).toEqual(['a'])
  })

  it('critical 教训没有映射 ⇒ 红', () => {
    const audit = auditLessonChecks([syntheticLesson('a')], {}, read)
    expect(audit.problems.join('\n')).toContain('a: critical 教训没有机械检查')
  })

  it('映射指向的文件不存在 ⇒ 红', () => {
    const audit = auditLessonChecks(
      [syntheticLesson('a')],
      { a: { file: 'missing.test.ts', name: 'x' } },
      read,
    )
    expect(audit.problems.join('\n')).toContain('测试文件不存在')
  })

  it('文件在但测试名不存在（被改名/删除）⇒ 红', () => {
    const audit = auditLessonChecks(
      [syntheticLesson('a')],
      { a: { file: 'a.test.ts', name: 'renamed away' } },
      read,
    )
    expect(audit.problems.join('\n')).toContain('找不到测试「renamed away」')
  })

  it('注册表里有、教训文件里没有 ⇒ 红（陈旧条目）', () => {
    const audit = auditLessonChecks(
      [syntheticLesson('a')],
      {
        a: { file: 'a.test.ts', name: 'keeps working' },
        stale: { file: 'a.test.ts', name: 'keeps working' },
      },
      read,
    )
    expect(audit.problems.join('\n')).toContain('「stale」不是 critical 教训')
  })

  it('两条 critical 教训共用一个 id ⇒ 红（映射歧义）', () => {
    const audit = auditLessonChecks(
      [syntheticLesson('a'), syntheticLesson('a')],
      { a: { file: 'a.test.ts', name: 'keeps working' } },
      read,
    )
    expect(audit.problems.join('\n')).toContain('id 重复')
  })
})

describe('parseCriticalLessons', () => {
  it('只取 critical，且不把 warning 带进来', () => {
    const md = [
      '## alpha: 甲',
      '- 严重度: critical',
      '## beta: 乙',
      '- 严重度: warning',
      '## gamma: 丙',
      '- 严重度: critical',
    ].join('\n')
    expect(parseCriticalLessons(md).map((l) => l.id)).toEqual(['alpha', 'gamma'])
  })

  it('不接受「critical」以外的写法（含前后缀）', () => {
    const md = ['## a: x', '- 严重度: critical-ish', '## b: y', '- 严重度:  critical'].join('\n')
    expect(parseCriticalLessons(md).map((l) => l.id)).toEqual(['b'])
  })
})

// ── 仓库本体 ──

describe('crsi-lessons.md 的 critical 教训', () => {
  const lessons = parseCriticalLessons(readFileSync(LESSONS_FILE, 'utf-8'))

  it('判据的前提：确实解析到了 critical 教训', () => {
    // 空集合会让下面的断言零次通过 —— 先钉住这一点。
    expect(lessons.length).toBeGreaterThan(0)
    expect(lessons.map((l) => l.id)).toContain('signal-discrimination')
  })

  it('每一条都指向一条真实存在的机械检查', () => {
    const audit = auditLessonChecks(lessons, LESSON_CHECKS, readRepoFile)
    expect(audit.problems).toEqual([])
    expect(audit.checked).toHaveLength(lessons.length)
  })
})

describe('review 机制在位', () => {
  it('`/code-review` 技能同时在磁盘与内嵌清单里（评审机制随构建一起发）', () => {
    expect(existsSync(join(CLI_DIR, 'skills/standard/code-review.SKILL.md'))).toBe(true)
    expect(readFileSync(join(CLI_DIR, 'src/skills/bundled-skills.ts'), 'utf-8')).toContain(
      'name: code-review',
    )
  })
})
