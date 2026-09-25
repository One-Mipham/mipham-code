/**
 * `mipham --provider <id>` / `mipham --model <id>` 的进路。
 *
 * 这是同一缺陷形态的**第三次**（前两次：`--resume` 见 `resume-flag.test.ts`，
 * `--permission` 见 `permission-flag.test.ts`）：`RunOptions` 一路都有 `provider?`/`model?`，
 * `index.tsx` 也早就写着 `options.provider || config.defaultProvider` —— 而**没有任何调用点
 * 传过它们**。前两次是靠读代码发现的，这一次是**实测发现的**：
 *
 *     $ mipham --provider deepseek --model deepseek-chat
 *     Unknown command: mipham deepseek        # 怪的是 provider 的**值**
 *     rc=1                                    # CLI 根本起不来
 *
 * 而这两个 flag 不是假想需求 —— 两个**已发布**的 IDE 插件就从自己的设置里拼这条命令
 * （`infrastructure/vscode/extension.js` 的 `buildFlags()`、`MiphamAction.kt` 的
 * `buildCommand()`）。用户在插件设置里填了 provider，换来的是一次「未知命令」。
 *
 * ## 为什么这一段是源码级断言，而不是真跑一条命令
 *
 * 失败路径能真跑（`--provider` 缺值在 `runApp` 之前就 exit 了，见 `arg-validation` 那组），
 * 但**成功路径跑不了**：它会进 Ink，而 Ink 在没有 TTY 时直接抛
 * `Raw mode is not supported on the current process.stdin`（`resume-flag.test.ts`
 * 与 `permission-flag.test.ts` 均已实测记下）。所以退到源码级，并**在此写明它证明不了什么**：
 * 它证明两个 flag 被解析、**同一个变量**既进了注册表又进了 UI 的初值、且 flag **赢过**
 * 合并后的 config；不证明运行期选中的真是那个 provider。
 *
 * **值域不做闭集合校验**（与 `--permission` 有意不同）：provider 可以是用户自定义的
 * （`config/loader.ts` 的 `mergeProviders` 会整只收下不认识的那条），静态白名单必然误拒
 * 合法输入。所以值原样转发，不认识的 id 由 `ProviderRegistry.getActive()` 抛点名错误 ——
 * 与同一个值来自 `config.yml` 时的行为**逐字一致**（一扇门一套语义）。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CLI_ROOT = join(dirname(import.meta.dirname), '..')
const BIN_SRC = readFileSync(join(CLI_ROOT, 'bin', 'mipham.ts'), 'utf-8')
const INDEX_SRC = readFileSync(join(CLI_ROOT, 'src', 'index.tsx'), 'utf-8')
const ARG_SRC = readFileSync(join(CLI_ROOT, 'src', 'shared', 'arg-validation.ts'), 'utf-8')

/** 按花括号配平取一个具名函数的正文（缩进锚会在 prettier 重排时假红）。 */
function fnBody(src: string, header: string): string | null {
  const start = src.indexOf(header)
  if (start === -1) return null
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

const MAIN = fnBody(BIN_SRC, 'async function main()')
const FLAG_VALUE_FN = fnBody(BIN_SRC, 'const flagValue = (name: string)')

describe('提取器本身有判别力', () => {
  it('配平失败时拿到的是 null，不是一整份文件', () => {
    expect(fnBody('const x = () => { y() }', 'const nope = ')).toBeNull()
    expect(MAIN).not.toBeNull()
    expect(MAIN!.length).toBeGreaterThan(2_000)
    expect(MAIN!.length).toBeLessThan(BIN_SRC.length) // 停在函数末尾，没把整份文件吞进来
    expect(FLAG_VALUE_FN, '没抓到 flagValue 的正文').not.toBeNull()
  })

  it('扫描判据本身有判别力（正对照）', () => {
    expect(BIN_SRC.length).toBeGreaterThan(10_000)
    expect(INDEX_SRC.length).toBeGreaterThan(10_000)
    // 三个读进来的文件都得是**那个**文件：任何一条路径拼错（少一层 `..`、多了 `test`）
    // 都会让下面的断言对着不存在的源码空转 —— 这里先钉住读到了东西。
    expect(BIN_SRC).toContain('async function main()')
    expect(INDEX_SRC).toContain('export async function runApp')
    expect(ARG_SRC).toContain('export function detectUnknownArgument')
  })
})

describe('bin 解析 argv 上的这两个 flag，并原样交给 runApp', () => {
  it('两个 flag 都从同一处取（同一条缺值判据，不各写一份）', () => {
    // 各写一份的代价不是重复，是**分叉**：缺值那半只在其中一处被想到时，另一处就
    // 会把 `--model --provider x` 的 `--provider` 当模型名吃下去。
    expect(MAIN, '没抓到 main 的正文').not.toBeNull()
    expect(MAIN!).toContain("flagValue('--provider')")
    expect(MAIN!).toContain("flagValue('--model')")
    expect(MAIN!.match(/const flagValue = \(name: string\)/g), '取了不止一处实现').toHaveLength(1)
  })

  it('缺值 / 值是另一个 flag 时拒绝，不是静默当成没写', () => {
    expect(FLAG_VALUE_FN!).toContain('Usage: mipham ${name} <id>')
    expect(FLAG_VALUE_FN!).toMatch(/value\.startsWith\('-'\)/)
    expect(FLAG_VALUE_FN!).toContain('process.exit(1)')
  })

  it('转发用的是同一对变量名（改名字会在这里红，而不是在运行期静默丢）', () => {
    expect(MAIN!).toMatch(/provider:\s*providerFlag/)
    expect(MAIN!).toMatch(/model:\s*modelFlag/)
  })
})

describe('runApp 侧：flag 赢过 config，且真的进了注册表', () => {
  it('优先级由 `||` 的次序钉住：options 在左', () => {
    // 次序不是风格问题：反过来写（`config.defaultProvider || options.provider`）时
    // 只有 config 为空才轮到 flag —— 对任何**配过** config 的用户，flag 就是写了却
    // 不可达，正是本文件要关的形状。
    expect(INDEX_SRC, 'flag 没有优先于 config').toMatch(
      /const defaultProvider = options\.provider \|\| config\.defaultProvider/,
    )
    expect(INDEX_SRC).toMatch(/const defaultModel = options\.model \|\| config\.defaultModel/)
    expect(INDEX_SRC, 'config 被排到了 flag 左边').not.toMatch(
      /config\.defaultProvider \|\| options\.provider/,
    )
    expect(INDEX_SRC, 'config 被排到了 flag 左边').not.toMatch(
      /config\.defaultModel \|\| options\.model/,
    )
  })

  it('它落进了 provider 注册表，不只是页脚上的一行字', () => {
    // 「按键有反应而世界不变」的判据：这个值必须走到真正决定流量的那一步。
    // 与同一变量一起进 `bootstrapProviders` 才叫接线；只进 App 的初值就只是装饰
    // （页脚显示 deepseek，实际请求发往 config 里那家）。
    expect(INDEX_SRC).toMatch(
      /const registry = bootstrapProviders\(config\.providers, defaultProvider, defaultModel\)/,
    )
    // 负锚：别把 flag 直接塞给注册表而绕过 config 的合并（两套语义从此并存）。
    expect(INDEX_SRC).not.toMatch(/bootstrapProviders\(config\.providers, options\.provider/)
  })
})

describe('arg-validation 认得这两个 flag，且它们是**带值**的', () => {
  it('两张表都有：KNOWN_FLAGS 定「认识」，VALUE_FLAGS 定「值不是命令」', () => {
    // 少 KNOWN_FLAGS 那条 ⇒ 报「未知选项」；少 VALUE_FLAGS 那条 ⇒ 报
    // `Unknown command: mipham deepseek`（**就是那条实测到的报错**）。两条都得在。
    expect(ARG_SRC).toMatch(/KNOWN_FLAGS[\s\S]{0,400}'--provider'[\s\S]{0,80}'--model'/)
    expect(ARG_SRC).toMatch(/VALUE_FLAGS\s*=\s*\[[^\]]*'--provider'[^\]]*'--model'/)
  })

  it('行为面由 arg-validation.test.ts 覆盖（这里只钉表的形状，不重复跑判据）', () => {
    const behavior = readFileSync(
      join(CLI_ROOT, 'test', 'shared', 'arg-validation.test.ts'),
      'utf-8',
    )
    expect(behavior).toContain("detectUnknownArgument(['--provider', 'deepseek', '--model',")
  })
})

describe('广告与实现一致', () => {
  it('--help 的 Flags 段列了这两个 flag（广告的能力必须有落点）', () => {
    const flagsAt = BIN_SRC.indexOf('Flags:')
    expect(flagsAt, '找不到帮助里的 Flags 段').toBeGreaterThan(-1)
    const help = BIN_SRC.slice(flagsAt, flagsAt + 1_500)
    expect(help).toContain('--provider <id>')
    expect(help).toContain('--model <id>')
    // 说明各自覆盖 config.yml —— 用户读到的优先级必须与 `||` 的次序是同一条。
    expect(help).toMatch(/--provider <id>\s+Start on this provider \(overrides config\.yml\)/)
    expect(help).toMatch(/--model <id>\s+Start on this model \(overrides config\.yml\)/)
  })
})
