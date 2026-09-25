import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * `apps/web` 的文案面守卫（D15 剩余那半的收口，2026-09-25）。
 *
 * **这道守卫守的是一个「已经不存在的关系」，而不是把旧关系按住** —— 这句话是本文件
 * 存在的理由，先说清楚：
 *
 * 从前这对副本（`packages/shared/src/i18n/locales/*` ↔ `apps/cli/src/i18n-core/locales/*`）
 * 是典型的 vendored pair，两侧各 596 / 831 键、共有 586。实测**每份都带着对方的命名空间
 * 当死重**：shared 的 504 个非 `web.*` 键**一个消费者都没有**（`apps/web` 只读 `web.*`），
 * CLI 的 86 个 `web.*` 键 **CLI 一行都不读**。590 / 1427 = 41% 是死的。
 *
 * 那 41% 不是无害的：共有的 586 键里**已经漂出 8 个值不同**（`commands.hooks.no_hooks`、
 * `commands.stats.tokens` 等），而它们**没有一个**被 `apps/web` 读 —— 漂移正是长在
 * 没有消费者的地方，所以没人发现。D15 因此提过「共有键的值必须相等」这条判据。
 *
 * **这里刻意不施加那条判据**，理由有两条，都在实测上：
 *   1. 施加到全量 586 键 ⇒ 那 8 条**死文案**要被永久按住同步：CLI 每改一次 hooks /
 *      快捷键文案，就得手改 shared 一份**没人渲染**的文案。守卫的成本要花在有消费者的
 *      地方才叫守卫，花在没消费者的地方叫维护税。
 *   2. 它**抓不到本笔真正的错值** —— `web.features.slash_commands.title` 曾写「85」
 *      （真值 137），而**两份当时写的是同一个错值**，值相等的守卫只会全绿。抓到它的是
 *      `published-counts.test.ts` 里那条**真值**判据。**「两份相等」证的是两份一致，
 *      不是两份对。**
 *
 * 故落点改成**按构造消除重复**：两份副本各删掉对方的命名空间，此后**共有键为 0**，
 * 「共有键值必须相等」无对象可言 —— 不是被守卫按住，是**不存在了**。
 * 本文件钉住的就是这个新形状的两条：① shared 副本只含 `web.*`、CLI 副本不含 `web.*`；
 * ② `apps/web` 读到的每个键都真的在（缺键 ⇒ 页面把原始 key 渲染上屏）。
 *
 * 本文件自足（自带 `findRepoRoot`），与同族守卫同一约定：守卫之间不抽公共模块。
 */
function findRepoRoot(from: string): string {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`未能在 ${from} 之上找到仓库根（pnpm-workspace.yaml）`)
    dir = parent
  }
}

const CLI_DIR = join(import.meta.dirname, '..', '..')
const REPO_ROOT = findRepoRoot(CLI_DIR)

const WEB_SRC = join(REPO_ROOT, 'apps', 'web', 'src')
const LOCALES = {
  shared: join(REPO_ROOT, 'packages', 'shared', 'src', 'i18n', 'locales'),
  cli: join(CLI_DIR, 'src', 'i18n-core', 'locales'),
}

/** 把嵌套的 locale 对象压成点分键。 */
function flatten(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else if (v && typeof v === 'object') for (const [kk, vv] of flatten(v, key)) out.set(kk, vv)
  }
  return out
}

function readLocale(side: keyof typeof LOCALES, locale: string): Map<string, string> {
  const file = join(LOCALES[side], `${locale}.json`)
  if (!existsSync(file)) throw new Error(`locale 文件不存在：${file}`)
  return flatten(JSON.parse(readFileSync(file, 'utf-8')))
}

/** 递归枚举 `apps/web/src` 下的 .ts/.tsx。 */
function webSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return webSources(p)
    return e.isFile() && /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/**
 * `apps/web` 里所有的 `t(...)` 调用，**逐个分类**。
 *
 * **为什么必须分类而不是「用正则把键抠出来」**：正则抠键的守卫有个致命退化 ——
 * 换一种调用写法（模板串、变量、`t(` 后面接表达式），正则静默不匹配 ⇒ 那些调用点
 * **一个键都不进集合** ⇒ 断言在越来越小的集合上恒真。本函数把这个退化变成红：
 * 认不出的形式进 `unhandled`，下面的用例断言它为空。
 *
 * 模板串（`web.features.${f.key}.title`）**不靠猜**：它的取值来源是同一文件里那张
 * `key: '...'` 列表，故按「同文件内的 `key:` 字面量」展开；展开不出来就进 `unhandled`。
 */
function extractWebKeys(files: string[]): {
  keys: Set<string>
  unhandled: string[]
  callSites: number
} {
  const keys = new Set<string>()
  const unhandled: string[] = []
  let callSites = 0

  for (const file of files) {
    const src = readFileSync(file, 'utf-8')
    const rel = file.slice(REPO_ROOT.length + 1)

    // 同一文件里 `key: '...'` 字面量（features 那类列表驱动渲染的来源）
    const listKeys = [...src.matchAll(/\bkey:\s*'([^']+)'/g)].map((m) => m[1]!)

    for (const m of src.matchAll(/\bt\(/g)) {
      const at = m.index + m[0].length
      const line = src.slice(0, m.index).split('\n').length
      const rest = src.slice(at).replace(/^\s+/, '')
      callSites++

      const quoted = /^(['"])([^'"]+)\1/.exec(rest)
      if (quoted) {
        keys.add(quoted[2]!)
        continue
      }

      const tmpl = /^`([^`]*)`/.exec(rest)
      if (tmpl) {
        const body = tmpl[1]!
        // 模板串：把 `${...}` 按同文件的 key 列表展开；没有插值就是静态键。
        const parts = body.split(/\$\{[^}]*\}/)
        if (parts.length === 1) {
          keys.add(body)
        } else if (/^\$\{[^}]*\}$/.test(body.split(/(\$\{[^}]*\})/).filter(Boolean)[1] ?? '')) {
          for (const k of listKeys) keys.add(body.replace(/\$\{[^}]*\}/g, k))
        } else {
          unhandled.push(`${rel}:${line} 模板串形式认不出：\`${body}\``)
        }
        continue
      }

      // 引号/模板串都不是 ⇒ 动态表达式（变量、函数调用…）。**必须红**：机器抽不出它查的键。
      unhandled.push(
        `${rel}:${line} 动态调用（键无法静态得知）：${rest.split('\n')[0]!.slice(0, 60)}`,
      )
    }
  }

  return { keys, unhandled, callSites }
}

const WEB_FILES = webSources(WEB_SRC)
const EXTRACTED = extractWebKeys(WEB_FILES)

describe('apps/web 的文案面：读到的键必须真的在', () => {
  it('正对照：扫描与抽取都真的发生了（否则下面的断言在空集上恒真）', () => {
    expect(WEB_FILES.length, '一个 apps/web 源文件都没扫到 —— 路径写错了').toBeGreaterThan(10)
    expect(EXTRACTED.callSites, '一个 t( 调用点都没找到 —— 抽取器已与代码脱节').toBeGreaterThan(50)
    // 模板串那两处（features.tsx）必须被展开出键，而不是被当作零命中静默跳过。
    expect(
      [...EXTRACTED.keys].filter((k) => k.startsWith('web.features.')).length,
      'template 串一个键都没展开出 —— features 那类列表驱动渲染逃出了守卫',
    ).toBeGreaterThan(3)
  })

  it('每个 t( 调用点都被分类了（认不出的形式即红，不静默漏掉）', () => {
    expect(
      EXTRACTED.unhandled.join('\n'),
      `有 t( 调用点无法静态取键 —— 要么改用字面量，要么把该形式加进 extractWebKeys：\n` +
        EXTRACTED.unhandled.join('\n'),
    ).toBe('')
  })

  it('apps/web 读到的键在两个语言里都存在（缺键 ⇒ 页面把原始 key 渲染上屏）', () => {
    const problems: string[] = []
    let comparisons = 0
    for (const locale of ['en-US', 'zh-CN']) {
      const map = readLocale('shared', locale)
      for (const key of EXTRACTED.keys) {
        comparisons++
        if (!map.has(key)) problems.push(`  ${locale} 缺 ${key}`)
      }
    }
    expect(comparisons, '零次比对 —— 抽取集是空的').toBe(EXTRACTED.keys.size * 2)
    expect(problems.join('\n')).toBe('')
  })

  it('shared 的两个语言键集相同（否则 zh 侧静默回落英文）', () => {
    const en = readLocale('shared', 'en-US')
    const zh = readLocale('shared', 'zh-CN')
    const onlyEn = [...en.keys()].filter((k) => !zh.has(k))
    const onlyZh = [...zh.keys()].filter((k) => !en.has(k))
    expect({ onlyEn, onlyZh }).toEqual({ onlyEn: [], onlyZh: [] })
  })
})

/**
 * 钉住「按构造消除重复」这个决定本身。
 *
 * 没有这两条，下次有人往 shared 副本里粘一段 CLI 文案，重复就悄悄回来了 ——
 * 而那正是 41% 死重与 8 条分歧的成因。守卫要钉的是一个**决定**，不是当下的数据。
 */
describe('两份副本按命名空间分工（重复按构造为 0）', () => {
  it('shared 副本只含 web.* —— 它唯一的消费者是 apps/web', () => {
    for (const locale of ['en-US', 'zh-CN']) {
      const stray = [...readLocale('shared', locale).keys()].filter((k) => !k.startsWith('web.'))
      expect(stray, `shared 副本的 ${locale} 里混进了非 web.* 的键`).toEqual([])
    }
  })

  it('CLI 副本不含 web.* —— CLI 一行都不读它', () => {
    for (const locale of ['en-US', 'zh-CN']) {
      const stray = [...readLocale('cli', locale).keys()].filter((k) => k.startsWith('web.'))
      expect(stray, `CLI 副本的 ${locale} 里混进了 web.* 的键`).toEqual([])
    }
  })

  it('两份副本共有键为 0（这条是上面两条的推论，单独钉住是因为它才是重点）', () => {
    for (const locale of ['en-US', 'zh-CN']) {
      const shared = readLocale('shared', locale)
      const cli = readLocale('cli', locale)
      const common = [...shared.keys()].filter((k) => cli.has(k))
      expect(common, '两份副本又开始有共有键了 —— 重复回来了').toEqual([])
    }
  })
})
