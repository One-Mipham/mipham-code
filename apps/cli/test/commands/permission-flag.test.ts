/**
 * `mipham --permission <mode>` 的进路。
 *
 * 缺陷形态与 `--resume` 那次**逐字相同**（`resume-flag.test.ts`）：`runApp` 一路都有
 * `options.permission`，而**没有任何调用点传过它** —— `RunOptions` 里那个字段声明成
 * `string`、零读点，`arg-validation` 的 KNOWN_FLAGS 里也没有 `--permission`。于是
 * 「写了却不可达」，而唯一的选档途径只剩 `config.yml`、启动后 Shift+Tab、daemon 的 env。
 *
 * 本项新增的第四扇门是**值域**这件事的第四处：同一个集合从 `config.yml`、这个 flag、
 * attach 协议三条路进来，取值集合必须是**同一份** `ALL_MODES`（daemon 的 `set_mode`
 * 白名单，由 `permission-status-parity.test.ts` P7e 钉住相等）。所以这里的断言盯的是
 * **链路接通**（argv → parsePermissionFlag → runApp → 权限系统），以及**列表派生**
 * （帮助与报错都不许手写第二份模式表）。
 *
 * ## 为什么这一段是源码级断言，而不是真跑一条命令
 *
 * 错误路径能真跑（`--permission nonsense` 在 `runApp` 之前就 exit 了），但**成功路径跑不了**：
 * 它会进 Ink，而 Ink 在没有 TTY 时直接抛 `Raw mode is not supported on the current
 * process.stdin`（同 `resume-flag.test.ts` 实测）。退到源码级，并**在此写明它证明不了什么**：
 * 它证明调用点存在、搬的是同一个名字、且施加在 live 权限系统上，不证明运行期真的变了档。
 * 值域那一半**有**行为用例（`test/shared/arg-validation.test.ts` 的 `parsePermissionFlag`
 * 一组），attach 那半边**有**帧级用例（`test/daemon/remote-engine.test.ts`）。
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

/** bin 把解析结果交给 `runApp` 的那一行（两条路径各一份，形状必须相同）。 */
const FORWARD_RE =
  /permission:\s*permissionFlag\.kind === 'ok'[\s\S]{0,10}?\?\s*permissionFlag\.mode[\s\S]{0,10}?:\s*undefined/

const MAIN = fnBody(BIN_SRC, 'async function main()')
const ATTACH = fnBody(BIN_SRC, 'async function runAttachCLI()')

describe('提取器本身有判别力', () => {
  it('配平失败时拿到的是 null，不是一整份文件（否则下面几条断的是别的东西）', () => {
    expect(fnBody('const x = () => { y() }', 'const nope = ')).toBeNull()
    const body = fnBody(BIN_SRC, 'async function main()')
    expect(body).not.toBeNull()
    expect(body!.length).toBeGreaterThan(2_000)
    expect(body!.length).toBeLessThan(BIN_SRC.length) // 停在函数末尾，没把整份文件吞进来
    expect(fnBody(BIN_SRC, 'async function runAttachCLI()')).toContain('parsePermissionFlag')
  })

  it('扫描判据本身有判别力（正对照）', () => {
    expect(BIN_SRC.length).toBeGreaterThan(10_000)
    expect(INDEX_SRC.length).toBeGreaterThan(10_000)
    expect(BIN_SRC).not.toContain('noSuchSymbolZzzForControl')
    // 两处转发缺一不可：少了 attach 那条，`mipham attach --permission plan` 会静默按
    // 未知选项处理（attach 在未知参数扫描**之前**就返回了），也就是本文件要关掉的形状。
    expect(BIN_SRC.match(FORWARD_RE)).not.toBeNull()
  })
})

describe('mipham --permission 的进路是接通的', () => {
  it('bin 解析 argv 上的 --permission，并交给 runApp', () => {
    expect(MAIN, '没抓到 main 的正文').not.toBeNull()
    expect(MAIN!).toContain('parsePermissionFlag(process.argv.slice(2))')
    expect(MAIN!).toMatch(FORWARD_RE)
  })

  it('值不合法就报错退出，**不**回退到更宽的 default', () => {
    // 静默回退是「说放行、实际审批」那条老缺陷的形状（P7b 同族）。判别点在 kind：
    // 只断言「调用了 parsePermissionFlag」的话，`permissionFlag.mode` 直接取用也能过。
    expect(MAIN!).toContain("permissionFlag.kind === 'error'")
    expect(MAIN!).toContain('console.error(permissionFlag.message)')
    expect(MAIN!).toContain('process.exit(1)')
  })

  it('attach 也认这个 flag —— 同一扇门，只是闸门在网的另一头', () => {
    // 这条同时是两个缺口的守卫：① 少了它，flag 在 attach 下被当成未知参数;
    // ② 会话 id 的取法必须跳过 flag 的**值**（`mipham attach --permission plan <id>`
    //    下 `args[1]` 是 `--permission`，旧写法会静默落到会话列表）。
    expect(ATTACH, '没抓到 attach 的正文').not.toBeNull()
    expect(ATTACH!).toContain('parsePermissionFlag(args)')
    expect(ATTACH!).toMatch(FORWARD_RE)
    expect(ATTACH!).toContain('firstPositional(args.slice(1))')
    expect(ATTACH!, '又退回按字面位置取会话 id').not.toMatch(/args\[1\]\s*&&\s*!args\[1\]/)
  })

  it('arg-validation 认得 --permission，且它是**带值**的 flag', () => {
    // 读的是那两张**表**本身（行为面由 `test/shared/arg-validation.test.ts` 覆盖）。
    // VALUE_FLAGS 那条不是锦上添花：漏了它，`--permission plan` 里的 `plan` 会被当成
    // 位置参数，也就是「Unknown command: plan」。
    expect(ARG_SRC).toMatch(/KNOWN_FLAGS[\s\S]{0,400}'--permission'/)
    expect(ARG_SRC).toMatch(/VALUE_FLAGS\s*=\s*\[[^\]]*'--permission'/)
  })
})

describe('runApp 侧的两条路都真的施加了这个档', () => {
  it('本地：经过 `setDefaultLevel`（与 config.yml 同一道缝、同一处钳制）', () => {
    // 三个点缺一不可：读 options.permission、它**优先于** config（`??` 的顺序就是优先级）、
    // 走 setDefaultLevel 而不是自己往对象里塞字段（塞字段会绕过 org 级 restrictions
    // 与「不认识的拼法」告警 —— 同一个 flag 从此有两套语义）。
    expect(INDEX_SRC, 'flag 没有优先于 config').toMatch(
      /const configuredMode = options\.permission \?\? config\.permission/,
    )
    expect(INDEX_SRC).toMatch(/permission\.setDefaultLevel\(configuredMode as PermissionLevel\)/)
    expect(INDEX_SRC, '把 flag 的值直接塞进权限系统 ⇒ 绕过钳制与告警').not.toMatch(
      /permission\.setMode\(options\.permission\)/,
    )
  })

  it('attach：作为 `set_mode` 请求发出去，权威仍在 daemon', () => {
    // 远端那半边不能走 `setDefaultLevel` —— 它是**请求**，不是赋值：daemon 会钳制，
    // 答复走 `onPermissionModeChange` 回到页脚（`app.tsx` 的订阅，见 P7d）。
    expect(INDEX_SRC).toMatch(/if \(options\.permission\) engine\.getPermission\(\)\.setMode\(/)
  })
})

describe('模式表只有一份：帮助与报错都从 ALL_MODES 派生', () => {
  it('--help 里的模式清单是 join 出来的，不是手写的第二份表', () => {
    // 锚在帮助块的 `Flags:` 段上，不锚 `--permission <mode>` 的**首次出现** ——
    // bin 里那串字面量还出现在两处**注释**里（attach 分支、main 分支），
    // 按首次出现切片会切到注释上，于是这条断言读的根本不是帮助。
    const flagsAt = BIN_SRC.indexOf('Flags:')
    expect(flagsAt, '找不到帮助里的 Flags 段').toBeGreaterThan(-1)
    const help = BIN_SRC.slice(flagsAt, flagsAt + 1_500)
    expect(help, '帮助里没有这个 flag').toContain('--permission <mode>')
    expect(help, '帮助里的模式清单不是派生值').toContain('${ALL_MODES.join(')
    // 负锚：手写一份就会在加档那天与报错信息、与 daemon 的白名单分叉 ——
    // 帮助广告一个 flag 随后拒绝的模式，是本仓库记过的「广告的能力没有落点」。
    expect(help).not.toMatch(/default\|acceptEdits/)
  })

  it('报错信息里的清单也是派生的（同一份地图，不是第二张）', () => {
    expect(ARG_SRC).toMatch(/Usage: mipham --permission <\$\{ALL_MODES\.join\('\|'\)\}>/)
    expect(ARG_SRC).toMatch(/Valid modes: \$\{ALL_MODES\.join\(', '\)\}/)
    expect(ARG_SRC, 'arg-validation 里出现了写死的模式清单').not.toMatch(/'default', 'acceptEdits'/)
  })
})
