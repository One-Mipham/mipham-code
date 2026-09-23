/**
 * 状态文件**写侧**的族守卫 —— 非原子写为什么值得一份守卫，而不是一次清扫。
 *
 * 这一族的形状是「**非原子写 + 读侧把读不动兜成空**」：`writeFileSync` 写到一半被杀
 * （SIGKILL、断电、`timeout` 到点）会留下半截 JSON，而读侧那半句 `catch { /* corrupt
 * — start fresh *\/ }` 会把它当成「文件损坏」直接清空 —— 一次崩溃赔上**全部**规则 /
 * 签名 / 统计 / 记忆，不是丢一条。清扫能修当天的成员，修不了**复发**：同一形状的成员
 * 本来就散布在两种写法之间（`atomicWriteFileSync` 早有调用点，`writeFileSync` 也一直
 * 有人新写），没有任何东西会在**新成员**出现时变红 —— 这正是它反复复发的那条机制。
 *
 * 所以判据是**清单式两向断言**（同 `unwired-disposition.test.ts` 的形状）：
 * - 出现裸写、却不在清单里 ⇒ 红（新成员必须被看见、被分类）
 * - 在清单里、实际数量对不上 ⇒ 红（清单陈旧 = 已经没人维护了）
 * 两向合起来，清单才既拦得住新成员、又不会悄悄腐烂。
 *
 * **扫描范围只有 `src/**\/*.ts`**：本文件里的散文（包括上面这段里的字面量）不在其中 ——
 * 守卫把自己的说明文档当成真声明的坑，本仓库已经踩过（见 `unwired-disposition` 的同族
 * 教训）。下面那条 fixture 自检是**故意**让扫描器在池子里能红：一个恒为空的扫描器会让
 * 整份守卫变成仪式。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..', 'src')

/** 两个助手自己就是实现方（一个走 rename、一个开 O_APPEND）。 */
const HELPERS = ['shared/atomic-write.ts', 'shared/regular-file.ts']

/** 裸写（`writeFileSync(` / `appendFileSync(`），不匹配两个助手的名字。 */
const BARE = /(?<![A-Za-z])(writeFileSync|appendFileSync)\(/g

/**
 * 允许保留裸写的文件 —— 每一条都写清**为什么这一处不是那一族**。
 *
 * 分三类（都要求：写的是**用户要的产物**或**首次创建**，不是「读回来当状态用、
 * 读不动兜成空」的文件）：
 *   A. 用户指定路径 / 用户可见产物（plan、artifact、导出、安装、脚手架、截图脚本）
 *   B. 首次创建、没有旧内容可丢（`flag: 'wx'` 的密钥写、脚手架）
 *   C. 写的是**已打开的 fd**，不是路径（`writeFileNoFollow`）—— 原子写要路径，换不了
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  'commands/loop-scaffold.ts': { count: 1, reason: 'A 脚手架模板写入用户目录' },
  'commands/project.ts': { count: 1, reason: 'A `/init` 生成项目文件（首次创建）' },
  'config/credential-crypto.ts': {
    count: 1,
    reason: "C+B 密钥写用 flag:'wx' —— 「已存在就失败」的语义与 rename 覆盖互斥",
  },
  'core/crsi-sandbox.ts': { count: 1, reason: 'A 自修改提案写进 worktree（由 diff/测试判定）' },
  'core/project-scaffold.ts': { count: 1, reason: 'A 项目脚手架写入用户目录' },
  'core/task-performance.ts': { count: 2, reason: 'A 评测夹具：临时目录里生成解与测试' },
  'plugin/plugin-manager.ts': { count: 2, reason: 'A 插件安装到用户目录' },
  'security/fd.ts': { count: 1, reason: 'C 写已打开的 fd（no-follow 打开），不是路径' },
  'skills/bundled-skill-assets.ts': {
    count: 2,
    reason: '文本命中：嵌入式资产（CDP proxy 脚本正文）里的字面量，不是本模块的写点',
  },
  'skills/registry.ts': { count: 3, reason: 'A skill 安装到用户目录' },
  'skills/skill-assets.ts': { count: 1, reason: 'A 技能资产解包到用户目录' },
  'tools/agent/enter-plan.ts': { count: 1, reason: 'A 计划文件（交给用户审阅的产物）' },
  'tools/agent/plan.ts': { count: 1, reason: 'A 计划文件（交给用户审阅的产物）' },
  'tools/artifact/artifact.ts': { count: 1, reason: 'A artifact 工具写用户指定路径' },
  'tools/computer/screenshot.ts': { count: 1, reason: 'A 临时 PowerShell 脚本' },
  'ui/commands.ts': {
    count: 6,
    reason: 'A /export、/workflow save、/feedback、marketplace 安装的写回调（用户产物）',
  },
}

/**
 * 已收口的族成员：这里必须见得到助手调用，且见不到裸写。
 * 「有定义、无施加点」是本仓库的惯犯 —— 只查「没裸写」会漏掉「根本没写」，
 * 所以两个方向都断。
 */
const SWEPT: Array<{ file: string; helper: 'atomicWriteFileSync' | 'appendRegularFileSync' }> = [
  { file: 'agent/agent-experience.ts', helper: 'atomicWriteFileSync' },
  { file: 'agent/cross-session/discovery.ts', helper: 'atomicWriteFileSync' },
  { file: 'agent/cross-session/file-inbox.ts', helper: 'atomicWriteFileSync' },
  { file: 'agent/effectiveness-tracker.ts', helper: 'atomicWriteFileSync' },
  { file: 'commands/autoloop-journal.ts', helper: 'atomicWriteFileSync' },
  { file: 'commands/environment.ts', helper: 'atomicWriteFileSync' },
  { file: 'config/keys-manager.ts', helper: 'atomicWriteFileSync' },
  { file: 'core/constitution-loader.ts', helper: 'atomicWriteFileSync' },
  { file: 'core/dream-engine.ts', helper: 'atomicWriteFileSync' },
  { file: 'core/error-signature-db.ts', helper: 'atomicWriteFileSync' },
  { file: 'core/eval-harness.ts', helper: 'appendRegularFileSync' },
  { file: 'core/memory/memory-manager.ts', helper: 'atomicWriteFileSync' },
  { file: 'core/permission-audit.ts', helper: 'appendRegularFileSync' },
  { file: 'core/crsi-producer.ts', helper: 'appendRegularFileSync' },
  { file: 'core/rule-engine.ts', helper: 'atomicWriteFileSync' },
  { file: 'core/session-log.ts', helper: 'appendRegularFileSync' },
  { file: 'core/session-store.ts', helper: 'atomicWriteFileSync' },
  { file: 'daemon/auth.ts', helper: 'atomicWriteFileSync' },
  { file: 'daemon/index.ts', helper: 'atomicWriteFileSync' },
  { file: 'mcp/token-store.ts', helper: 'atomicWriteFileSync' },
  { file: 'tools/agent/memory.ts', helper: 'atomicWriteFileSync' },
  { file: 'tools/agent/workflow.ts', helper: 'atomicWriteFileSync' },
  { file: 'tools/scheduling/cron.ts', helper: 'atomicWriteFileSync' },
  { file: 'ui/commands.ts', helper: 'atomicWriteFileSync' },
  { file: 'workflow/journal.ts', helper: 'appendRegularFileSync' },
]

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name), `${prefix}${e.name}/`)
      : e.name.endsWith('.ts')
        ? [`${prefix}${e.name}`]
        : [],
  )
}

/** 计数（不改全局正则的 lastIndex，`g` 标志下复用同一个实例会漏数）。 */
function countBare(text: string): number {
  return text.match(BARE)?.length ?? 0
}

describe('状态文件写侧：裸写清单两向一致', () => {
  const files = walk(SRC).filter((f) => !HELPERS.includes(f))

  it('扫描器本身能红（fixture 自检 + 两个助手的名字不算命中）', () => {
    expect(countBare('writeFileSync(p, c)\nappendFileSync(p, c)')).toBe(2)
    expect(countBare('atomicWriteFileSync(p, c)\nappendRegularFileSync(p, c)')).toBe(0)
    // 池子里确实有命中 —— 恒为 0 的扫描器会让下面每一条都变成仪式。
    const total = files.reduce((n, f) => n + countBare(readFileSync(join(SRC, f), 'utf-8')), 0)
    expect(total).toBeGreaterThan(0)
  })

  it('每个裸写的文件都在清单里，且数量逐字相符', () => {
    const offenders: string[] = []
    for (const f of files) {
      const n = countBare(readFileSync(join(SRC, f), 'utf-8'))
      if (n === 0) continue
      const entry = ALLOWED[f]
      if (!entry) offenders.push(`${f} 有 ${n} 处裸写，不在清单里（新成员？请分类并写明理由）`)
      else if (entry.count !== n) offenders.push(`${f} 清单写 ${entry.count} 处，实际 ${n} 处`)
    }
    expect(offenders).toEqual([])
  })

  it('清单里没有陈旧条目（文件已改/已删却还留着豁免）', () => {
    const stale: string[] = []
    for (const [f, entry] of Object.entries(ALLOWED)) {
      let text: string
      try {
        text = readFileSync(join(SRC, f), 'utf-8')
      } catch {
        stale.push(`${f} 不存在了`)
        continue
      }
      const n = countBare(text)
      if (n !== entry.count) stale.push(`${f} 豁免写的是 ${entry.count} 处，实际 ${n} 处`)
      if (!entry.reason) stale.push(`${f} 没有理由`)
    }
    expect(stale).toEqual([])
  })

  it('已收口的成员：见得到助手调用，裸写数量与清单逐字相符（缺席即 0）', () => {
    const bad: string[] = []
    for (const { file, helper } of SWEPT) {
      const text = readFileSync(join(SRC, file), 'utf-8')
      if (!text.includes(`${helper}(`)) bad.push(`${file} 里没有 ${helper}( —— 接线断了？`)
      // 清单里那几处是**有意**留下的用户产物写（见 ALLOWED）；其余必须为 0。
      const expected = ALLOWED[file]?.count ?? 0
      const actual = countBare(text)
      if (actual !== expected) bad.push(`${file} 裸写 ${actual} 处，应为 ${expected} 处`)
    }
    expect(bad).toEqual([])
  })

  it('清单里列的文件都真实存在（写错路径也要红）', () => {
    const missing = Object.keys(ALLOWED).filter((f) => {
      try {
        return !statSync(join(SRC, f)).isFile()
      } catch {
        return true
      }
    })
    expect(missing).toEqual([])
  })
})
