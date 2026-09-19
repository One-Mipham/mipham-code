import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SessionStore } from '../../src/core/session-store'

/**
 * `mipham --resume "<name>"` 的进路。
 *
 * 缺陷形态不是「没写」，而是**写了却不可达**：`runApp(options.resume)` 从一开始就实现
 * 完整（`src/index.tsx:485` 起恢复会话日志 + chdir 到日志里记的 cwd），
 * 而**没有任何调用点传过这个选项**，同时 `--resume` 也不在 `arg-validation` 的
 * KNOWN_FLAGS 里 ⇒ 文档里那条命令实际打不通。所以这里的断言盯的是**链路接通**
 * （argv → runApp → context.restoreLog），不是「某个函数存在」。
 *
 * ## 为什么这一段是源码级断言，而不是真跑一条命令
 *
 * 错误路径（缺值 / 会话名不存在）能真跑（`--resume` 那段在 `runApp` 之前就 exit 了），
 * 但**成功路径跑不了**：它会进 Ink，而 Ink 在没有 TTY 时直接抛
 * `Raw mode is not supported on the current process.stdin`（本机实测：stdin 接
 * `/dev/null` 时 stdout 里只有这条报错，banner 与 cwd 都不渲染）。
 * 于是「恢复成功」这件事在无终端环境里没有可观察面 —— 与其伪造一个假绿，
 * 这里退到源码级，并**在此写明它证明不了什么**：它证明调用点存在且搬的是同一个名字，
 * 不证明运行期真的恢复了。恢复本身由 `test/core/context.test.ts` 的 `restoreLog`
 * 用例（sets log as source without re-appending）+ 本仓库 2026-09-19 那次带插桩的
 * 实测（`[PROBE] resume=session-… events=1643 messages=170`，不带旗标时 0 行）覆盖。
 *
 * 本仓库对**入口脚本**的源码级断言已有先例：`test/daemon/launch.test.ts` 的
 * 「`__daemon` 分支可达」。
 */

const CLI_ROOT = join(dirname(import.meta.dirname), '..')
const BIN_SRC = readFileSync(join(CLI_ROOT, 'bin', 'mipham.ts'), 'utf-8')
const INDEX_SRC = readFileSync(join(CLI_ROOT, 'src', 'index.tsx'), 'utf-8')
const ARG_SRC = readFileSync(join(CLI_ROOT, 'src', 'shared', 'arg-validation.ts'), 'utf-8')

describe('mipham --resume 的进路是接通的', () => {
  it('bin 解析 argv 上的 --resume，并把名字交给 runApp', () => {
    // 三件事缺一不可：读 argv、拿到名字、传进去。只断言其中一条，
    // 「读了但没传」或「传的是别的东西」都能溜过去。
    expect(BIN_SRC).toContain("process.argv.indexOf('--resume')")
    expect(BIN_SRC).toContain('resumeName = process.argv[resumeIdx + 1]')
    expect(BIN_SRC).toContain('resume: resumeName')
  })

  it('arg-validation 认得 --resume，否则它会被当成未知选项拦下', () => {
    // 这里读的是那个**表**本身。行为面（`detectUnknownArgument(['--resume', 'x'])`
    // 为 null、且不会把值当命令）由 `test/shared/arg-validation.test.ts` 覆盖。
    expect(ARG_SRC).toMatch(/KNOWN_FLAGS[\s\S]{0,400}'--resume'/)
    expect(ARG_SRC).toMatch(/VALUE_FLAGS\s*=\s*\[[^\]]*'--resume'/)
  })

  it('runApp 侧的 resume 选项确实接到 context.restoreLog', () => {
    // 链路末端：`--resume` 若不真的灌进上下文，就只是打印一行「已恢复」的装饰。
    const at = INDEX_SRC.indexOf('if (options.resume)')
    expect(at, 'RunOptions.resume 的分支不见了').toBeGreaterThan(-1)
    const branch = INDEX_SRC.slice(at, at + 900)
    expect(branch).toContain('SessionStore.loadLog(options.resume)')
    expect(branch).toContain('context.restoreLog(log)')
  })

  it('扫描判据本身有判别力（正对照）', () => {
    // 上面三条都是 `toContain` —— 若源码读成了空串（路径错、文件被删），
    // 它们会「零命中」但看起来与「源码里没有」同形。先钉住这一点。
    expect(BIN_SRC.length).toBeGreaterThan(10_000)
    expect(BIN_SRC).not.toContain('noSuchSymbolZzzForControl')
  })
})

describe('bin 的未知会话名守卫有前提', () => {
  it('loadLog 对不存在的名字返回空日志 —— 这正是「必须自己拦」的理由', () => {
    // bin 里的注释断言了这件事：空日志会被启动路径读成「没东西可恢复」，
    // 于是静静开一个新会话，而用户以为自己在继续旧会话。这条把那个前提变成机器判据。
    // 只读、不写：查的是一个几乎不可能存在的名字。
    const log = SessionStore.loadLog('no-such-session-zzz-0123456789abcdef')
    expect(log.events()).toEqual([])
  })
})

/**
 * `t()` 把**没给的**占位符替换成空串（`i18n-core/t.ts` 的 `params[k] ?? ''`）——
 * 于是「文案里加了 `{name}`、调用点没跟上」不会报错，只会静默印出
 * `mipham --resume ""`。2026-09-19 那次订正就往 `restored_full_footer` 里加了
 * `{name}`，正是这个形状，所以在此钉住。
 */
describe('resume 文案里的占位符，调用点都真的给了', () => {
  const EN = JSON.parse(
    readFileSync(join(CLI_ROOT, 'src', 'i18n-core', 'locales', 'en-US.json'), 'utf-8'),
  ) as { commands: { resume: Record<string, string> } }

  /**
   * 扫**全部** src/ + bin/ 源码，而不是只扫 `commands.ts`。
   * 第一版只扫了 commands.ts，于是 `not_found` 被判成「找不到调用点」——
   * 那其实是**这条判据的适用范围**在说话，不是文案的问题。窄了的扫描会给出
   * 「调用点不在我读的文件里」与「根本没接」同形的结论（本仓库的老坑）。
   */
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p)
    }
    return out
  }
  const SOURCES = [...walk(join(CLI_ROOT, 'src')), ...walk(join(CLI_ROOT, 'bin'))]
  const ALL_SRC = SOURCES.map((f) => readFileSync(f, 'utf-8')).join('\n')

  /**
   * 取参数对象的键名。只认**顶层**键：
   * - `name: expr` → `name`
   * - `date,`      → `date`（ES6 简写，第一版只认 `\w+\s*:`，把简写漏成了假红
   *                   —— `restored_content` 的 `date` 就是这么被误判成「没给」）
   * - 其它形态（展开 `...rest`、动态键、认不出）→ 返回 `'unknown'`，
   *   **不当成「已给」**：判不了就说判不了，不能默认放行。
   */
  function topLevelKeys(body: string): string[] | 'unknown' {
    // 先摘掉行注释：参数对象里夹注释是允许的（`restored_full_footer` 的调用点就有一条），
    // 而注释里的 `//` 会让「按逗号切、取开头标识符」认不出键。
    // 摘注释**偏严**：万一某个值里带 `//`（如 URL），会把它后面的键一起吃掉 —— 结果是
    // 假红而不是假绿，符合此处想要的失败方向。
    const parts: string[] = []
    let depth = 0
    let cur = ''
    for (const ch of body.replace(/\/\/[^\n]*/g, '')) {
      if ('{(['.includes(ch)) depth++
      if ('})]'.includes(ch)) depth--
      if (ch === ',' && depth === 0) {
        parts.push(cur)
        cur = ''
      } else cur += ch
    }
    parts.push(cur)
    const keys: string[] = []
    for (const part of parts) {
      const s = part.trim()
      if (!s) continue
      const m = s.match(/^(\w+)\s*(?::|$)/)
      if (!m) return 'unknown'
      keys.push(m[1]!)
    }
    return keys
  }

  /** 从 `commands.resume.<key>'` 起，取紧随其后的那个参数对象的键名；无调用点则 null。 */
  function providedParams(key: string): string[] | 'unknown' | null {
    const at = ALL_SRC.indexOf(`commands.resume.${key}'`)
    if (at === -1) return null
    const open = ALL_SRC.indexOf('{', at)
    if (open === -1) return null
    let depth = 0
    for (let i = open; i < ALL_SRC.length; i++) {
      if (ALL_SRC[i] === '{') depth++
      else if (ALL_SRC[i] === '}') {
        depth--
        if (depth === 0) return topLevelKeys(ALL_SRC.slice(open + 1, i))
      }
    }
    return null
  }

  it('restored_full_footer 的 {name} 确实被传入（否则静默印成空串）', () => {
    const provided = providedParams('restored_full_footer')
    expect(provided, '找不到 restored_full_footer 的调用点').not.toBeNull()
    expect(provided).toContain('loaded')
    expect(provided).toContain('name')
  })

  it('所有**有调用点**的 resume 文案，占位符都被给全了', () => {
    expect(Object.keys(EN.commands.resume).length).toBeGreaterThan(15) // 空转守卫
    expect(SOURCES.length).toBeGreaterThan(100) // 扫描确实读到了源码
    let checked = 0
    const uncalled: string[] = []
    for (const [key, value] of Object.entries(EN.commands.resume)) {
      const placeholders = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)
      if (placeholders.length === 0) continue
      const provided = providedParams(key)
      expect(
        provided,
        `${key}: 参数对象形态认不出来（展开/动态键），本判据判不了，别默认放行`,
      ).not.toBe('unknown')
      if (provided === null) {
        // 没人调的文案渲染不出来，因此没有「静默空串」面 —— 跳过，但记下名字。
        // （`not_found` 就是这种：`commands.ts:4104` 把等价英文硬编码在代码里，
        //  这条 i18n 键从没被用过。这不属于本次订正的范围，只如实记下。）
        uncalled.push(key)
        continue
      }
      for (const p of placeholders) {
        expect(provided, `commands.resume.${key} 的 {${p}} 调用点没给`).toContain(p)
      }
      checked++
    }
    expect(uncalled).toEqual(['not_found'])
    // 判别力：必须真的扫到并校过带占位符的键，否则这条零次通过。
    expect(checked).toBeGreaterThanOrEqual(4)
  })
})
