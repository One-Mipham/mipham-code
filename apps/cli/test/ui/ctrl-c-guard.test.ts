/**
 * Ctrl+C 守卫的**接线层**测试。
 *
 * 修的缺陷：会话里弹出对话框（密钥提示 / 模型选择器）或正在跑一个回合时，
 * 误按一次 Ctrl+C 就把整个 CLI 带走 —— 输入框里的半句话、未提交的会话一起没。
 *
 * 这条链上有三段，**任何一段断了，另外两段照样全绿**：
 *
 *   ① `render(..., { exitOnCtrlC: false })` —— Ink 的开关。默认 true 时
 *      `App.js:151` 在按键**到达任何 handler 之前**就退进程；而且
 *      `hooks/use-input.js:104` 的 `if (input === 'c' && key.ctrl && internal_exitOnCtrlC) return`
 *      会**跳过全部监听器**。⇒ 少了这一段，我们写的 Ctrl+C 分支是**死代码**：
 *      字符串在、分支永不执行。这不是推理，下面第 ① 组用真 ink `render` 实测。
 *   ② 「再按一次才退」那个窗口本身（`ui/ctrl-c-confirm.ts`，两个入口共用）。
 *   ③ 看板 `AgentViewDashboard` 那一支（它有自己的一条 render 调用点）。
 *   ④ 真调用点的形状：三处 `render(` 都带开关；主界面那一支的**次序**
 *      （先关最上面一层 → 判 isArmed → 才 exit）。
 *
 * 为什么第 ① 组不能用 `ink-testing-library` 测：它自己的 `render` 就写死了
 * `exitOnCtrlC: false`（`ink-testing-library/build/index.js`）—— 用它测这一格，
 * **改前改后都是绿的**。所以第 ① 组手搓 stdin/stdout 直接调 ink 的 `render`。
 *
 * 主界面 `App` 起不来（整条 engine / provider 链 + 挂载期 IO），所以它的分支
 * 只能做**形状**断言 —— 行为那一半由 ②（共用窗口）与 ③（看板）覆盖。
 * 两组扫描器都自带正负对照，免得退化成「永远绿的正则」。
 */

import React from 'react'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Box, Text, render as inkRender, useInput } from 'ink'
import { render } from 'ink-testing-library'
import { AgentViewDashboard } from '../../src/agent-view/dashboard'
import { AgentViewManager } from '../../src/agent-view/agent-view-manager'
import { useCtrlCConfirm } from '../../src/ui/ctrl-c-confirm'

/** 真终端里 Ctrl+C 发出的那个字节（ETX）。 */
const CTRL_C = '\x03'

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ═══════════════════════════════════════════
// ① `exitOnCtrlC` 是这条链的开关（真 ink render，非 testing-library）
// ═══════════════════════════════════════════

class FakeOut extends EventEmitter {
  columns = 100
  write = (): void => {}
}
class FakeIn extends EventEmitter {
  isTTY = true
  data: string | null = null
  write = (d: string): void => {
    this.data = d
    this.emit('readable')
    this.emit('data', d)
  }
  setEncoding = (): void => {}
  setRawMode = (): void => {}
  resume = (): void => {}
  pause = (): void => {}
  ref = (): void => {}
  unref = (): void => {}
  read = (): string | null => {
    const d = this.data
    this.data = null
    return d
  }
}

/** 只做一件事：把 `useInput` 收到的按键记下来。 */
function KeyProbe({ onKey }: { onKey: (input: string, ctrl: boolean) => void }) {
  useInput((input, key) => onKey(input, !!key.ctrl))
  return React.createElement(Box, null, React.createElement(Text, null, 'probe'))
}

/**
 * 用真 `render` 起一个探针。`ink` 的 `render` 第二参是选项，这里显式透传 ——
 * 传 `{}`（即不传 `exitOnCtrlC`）复现的正是**修复前**那三处调用点。
 */
function rawRender(inkOptions: Record<string, unknown>, onKey: (i: string, c: boolean) => void) {
  const stdout = new FakeOut()
  const stderr = new FakeOut()
  const stdin = new FakeIn()
  const instance = inkRender(React.createElement(KeyProbe, { onKey }), {
    stdout,
    stderr,
    stdin,
    debug: true,
    patchConsole: false,
    ...inkOptions,
  } as never)
  return { instance, stdin }
}

describe('exitOnCtrlC 是 Ctrl+C 分支的开关（真 render）', () => {
  it('修复前：不传该选项 ⇒ handler 一次都收不到 Ctrl+C（分支是死的）', async () => {
    const onKey = vi.fn()
    const { stdin, instance } = rawRender({}, onKey)

    stdin.write(CTRL_C)
    await settle()

    // 这就是「字符串在、接线断」的现场：分支写得再对，这里也是空的。
    expect(onKey).not.toHaveBeenCalled()
    instance.unmount()
  })

  it('修复后：`exitOnCtrlC: false` ⇒ handler 收到 ("c", ctrl=true)', async () => {
    const onKey = vi.fn()
    const { stdin, instance } = rawRender({ exitOnCtrlC: false }, onKey)

    stdin.write(CTRL_C)
    await settle()

    // 断言的是**归一化后**的形状 —— 这也正是 ink 自己的判据写法
    // （`use-input.js:104` 用的就是 `input === 'c' && key.ctrl`），
    // 两边必须一致，否则我们的分支在真机上永不成立。
    expect(onKey).toHaveBeenCalledWith('c', true)
    instance.unmount()
  })

  it('（对照）普通按键两种设置下都照样送达 —— 开关只掐 Ctrl+C', async () => {
    const onKey = vi.fn()
    const { stdin, instance } = rawRender({}, onKey)

    stdin.write('j')
    await settle()

    expect(onKey).toHaveBeenCalledWith('j', false)
    instance.unmount()
  })
})

// ═══════════════════════════════════════════
// ② 「再按一次才退」的窗口本身（两个入口共用这一份）
// ═══════════════════════════════════════════

/**
 * 主界面 `App` 起不来（要整条 engine / provider 链），所以它的 Ctrl+C 分支
 * 只能靠**共用机制**这个层来覆盖 —— 这正是把窗口抽成 hook 的理由：
 * 下面这几条测的就是 `ui/app.tsx` 与看板共用的那一份判定。
 */
interface ProbeRead {
  /** `pre` 在按键当刻、`post-arm-same-tick` 在 `arm()` 之后立刻。 */
  phase: 'pre' | 'post-arm-same-tick'
  /** 渲染用那一路（state）。 */
  armed: boolean
  /** 判据那一路（ref）。 */
  isArmed: boolean
}

function CtrlCProbe({ windowMs, onRead }: { windowMs: number; onRead: (r: ProbeRead) => void }) {
  const ctrlC = useCtrlCConfirm(windowMs)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onRead({ phase: 'pre', armed: ctrlC.armed, isArmed: ctrlC.isArmed() })
      if (ctrlC.isArmed()) return
      ctrlC.arm()
      // 同一 tick 内立刻回读 —— 这一格是 state 那一路给不出的答案
      onRead({ phase: 'post-arm-same-tick', armed: ctrlC.armed, isArmed: ctrlC.isArmed() })
      return
    }
    if (key.escape) ctrlC.reset()
  })
  return React.createElement(Text, null, ctrlC.armed ? 'ARMED' : 'idle')
}

describe('useCtrlCConfirm 的窗口语义', () => {
  it('判据走 ref：arm() 之后**同一个 tick** 的 isArmed() 就是 true', async () => {
    const reads: ProbeRead[] = []
    const { stdin } = render(
      React.createElement(CtrlCProbe, { windowMs: 5000, onRead: (r) => reads.push(r) }),
    )

    stdin.write(CTRL_C)
    await settle()

    const sameTick = reads.find((r) => r.phase === 'post-arm-same-tick')
    expect(sameTick?.isArmed).toBe(true)
    // 同一刻 state 那一路还是 false —— 这就是「判据别走 state」的全部理由：
    // 走 state 的话第二次按键读到的仍是 false，于是永远退不出去。
    expect(sameTick?.armed).toBe(false)
  })

  it('两次按键：第一次的 pre 是「没上膛」，第二次的 pre 是「已上膛」', async () => {
    const reads: ProbeRead[] = []
    const { stdin } = render(
      React.createElement(CtrlCProbe, { windowMs: 5000, onRead: (r) => reads.push(r) }),
    )

    stdin.write(CTRL_C)
    await settle()
    stdin.write(CTRL_C)
    await settle()

    const pres = reads.filter((r) => r.phase === 'pre')
    expect(pres.map((r) => r.isArmed)).toEqual([false, true])
  })

  it('arm() 之后 `armed` 渲染成 true（页脚那句提示靠它）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(CtrlCProbe, { windowMs: 5000, onRead: () => {} }),
    )

    expect(lastFrame()).toContain('idle')

    stdin.write(CTRL_C)
    await settle()

    expect(lastFrame()).toContain('ARMED')
  })

  it('窗口到点自动撤（用短窗口跑，不等 2 秒）', async () => {
    const reads: ProbeRead[] = []
    const { stdin, lastFrame } = render(
      React.createElement(CtrlCProbe, { windowMs: 80, onRead: (r) => reads.push(r) }),
    )

    stdin.write(CTRL_C)
    await settle()
    expect(lastFrame()).toContain('ARMED')

    await settle(150)

    expect(lastFrame()).toContain('idle')

    // 窗口过期后判据也要跟着回落 —— 只看渲染会漏掉「ref 忘了清」这一半
    stdin.write(CTRL_C)
    await settle()
    const afterExpiry = reads.filter((r) => r.phase === 'pre').pop()
    expect(afterExpiry?.isArmed).toBe(false)
  })

  it('reset() 当场撤，不等窗口到点', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(CtrlCProbe, { windowMs: 5000, onRead: () => {} }),
    )

    stdin.write(CTRL_C)
    await settle()
    expect(lastFrame()).toContain('ARMED')

    stdin.write('\u001B') // Esc → reset()
    await settle()

    expect(lastFrame()).toContain('idle')
  })

  it('（对照）两个实例不共享窗口 —— 上面几条不是「全局单例」的巧合', async () => {
    const a = render(React.createElement(CtrlCProbe, { windowMs: 5000, onRead: () => {} }))
    const b = render(React.createElement(CtrlCProbe, { windowMs: 5000, onRead: () => {} }))
    a.stdin.write(CTRL_C)
    await settle()

    expect(a.lastFrame()).toContain('ARMED')
    expect(b.lastFrame()).toContain('idle')
  })
})

// ═══════════════════════════════════════════
// ③ 看板里的「再按一次才退」
// ═══════════════════════════════════════════

function renderDashboard(sessions = 1) {
  const manager = new AgentViewManager()
  for (let i = 0; i < sessions; i++) {
    manager.create(`Task ${i}`, `Do task ${i}`)
  }
  const onExit = vi.fn()
  const utils = render(React.createElement(AgentViewDashboard, { manager, onExit }))
  return { ...utils, onExit }
}

describe('AgentViewDashboard 的 Ctrl+C', () => {
  it('按一次**不退出**（这正是缺陷本身）', async () => {
    const { stdin, onExit, lastFrame } = renderDashboard()

    stdin.write(CTRL_C)
    await settle()

    expect(onExit).not.toHaveBeenCalled()
    // 而且要让用户看得见「还差一下」
    expect(lastFrame()).toContain('Ctrl+C again to exit')
  })

  it('连着按两次才退出，且只退一次', async () => {
    const { stdin, onExit } = renderDashboard()

    stdin.write(CTRL_C)
    await settle()
    expect(onExit).not.toHaveBeenCalled()

    stdin.write(CTRL_C)
    await settle()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('（对照）连按两次别的键从不退出 —— 上面那条绿不是「按两次就退」', async () => {
    const { stdin, onExit } = renderDashboard()

    stdin.write('j')
    await settle()
    stdin.write('j')
    await settle()

    expect(onExit).not.toHaveBeenCalled()
  })

  it('peek 打开时第一次 Ctrl+C 只关 peek，不退出', async () => {
    const { stdin, onExit, lastFrame } = renderDashboard()

    stdin.write(' ')
    await settle()
    // 只认面板自己的标题栏字面量 —— 页脚的 `Space peek` 是小写、不会撞上
    expect(lastFrame()).toContain('Peek:')

    stdin.write(CTRL_C)
    await settle()
    expect(onExit).not.toHaveBeenCalled()
    expect(lastFrame()).not.toContain('Peek:')
  })

  it('被 peek 消费掉的那一次 Ctrl+C 会把「待确认」撤掉（不是白送一次退出）', async () => {
    const { stdin, onExit } = renderDashboard()

    stdin.write(CTRL_C) // ① 上膛
    await settle()
    stdin.write(' ') // ② 开 peek
    await settle()
    stdin.write(CTRL_C) // ③ peek 开着 ⇒ 只关 peek，并撤膛
    await settle()
    stdin.write(CTRL_C) // ④ 撤销膛了 ⇒ 这里应当**重新上膛**，不是退出
    await settle()

    // 少了 ③ 里的 reset()，这一串会在 ④ 直接退出 —— 用户的「停」被吃成了「退」
    expect(onExit).not.toHaveBeenCalled()
  })

  it('两次按键隔开 2 秒 ⇒ 第一次的「待确认」已过期，不退出', async () => {
    const { stdin, onExit } = renderDashboard()

    stdin.write(CTRL_C)
    await settle()
    // 比 arm 窗口（2000ms）长 —— 这一条是「计时器真的会撤」的唯一证据；
    // 去掉计时器它才红。
    await settle(2100)

    stdin.write(CTRL_C)
    await settle()
    expect(onExit).not.toHaveBeenCalled()
  }, 10_000)
})

// ═══════════════════════════════════════════
// ④ 真调用点：src/ 里每个 ink `render(` 都带上那个开关
//     + 主界面那一支的顺序（App 起不来，只能对形状下断言）
// ═══════════════════════════════════════════

/**
 * 找出 `render(...)` 调用，返回每个调用**从 `(` 到配对 `)`** 的原文。
 *
 * 按括号配对切、不按行切：选项对象跨多行（`index.tsx` 里就是），按行切会把
 * `exitOnCtrlC` 漏在窗口外 —— 那种守卫是**永远绿**的。
 */
function renderCallSpans(source: string): string[] {
  const spans: string[] = []
  const re = /(?:^|[^.\w$])render\s*\(/g
  let match: RegExpExecArray | null

  while ((match = re.exec(source)) !== null) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let quote: string | null = null
    let i = open

    for (; i < source.length; i++) {
      const ch = source[i]!
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
    }
    spans.push(source.slice(open, i + 1))
  }
  return spans
}

/** 带开关的调用点 ⇒ []，否则返回缺开关的那些（好让失败信息能指出是谁）。 */
function missingExitOnCtrlC(source: string): string[] {
  return renderCallSpans(source).filter((span) => !/exitOnCtrlC\s*:\s*false/.test(span))
}

describe('src/index.tsx 的每个 ink render 调用点', () => {
  const source = readFileSync('src/index.tsx', 'utf8')

  it('扫描器本身可失败：缺开关 / 开关写成 true 都会被点出来', () => {
    // 正对照：真源码里确实找得到调用点（否则下面那条就是「零命中」）
    expect(renderCallSpans(source).length).toBeGreaterThanOrEqual(3)

    // 负对照 1：不带第二参 —— 正是修复前的样子
    expect(missingExitOnCtrlC(`const x = render(a, b)`)).toHaveLength(1)
    // 负对照 2：带了开关但是 `true`（比缺更隐蔽）
    expect(missingExitOnCtrlC(`const x = render(el,\n  { exitOnCtrlC: true },\n)`)).toHaveLength(1)
    // 负对照 3：跨行的正确写法**不许**被误报
    expect(missingExitOnCtrlC(`const x = render(el,\n  { exitOnCtrlC: false },\n)`)).toHaveLength(0)
  })

  it('每一处都传了 `exitOnCtrlC: false`（三处：远程会话 / 看板 / 主界面）', () => {
    expect(missingExitOnCtrlC(source)).toEqual([])
    expect(renderCallSpans(source)).toHaveLength(3)
  })
})

/**
 * 从 `openBraceIndex` 那个 `{` 起，按花括号配对切出整块（跳过字符串/模板串）。
 */
function sliceBlock(source: string, openBraceIndex: number): string | null {
  if (source[openBraceIndex] !== '{') return null
  let depth = 0
  let quote: string | null = null

  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(openBraceIndex, i + 1)
    }
  }
  return null
}

/** `key.ctrl && input === 'c'` 那一支的整块源码；找不到 ⇒ null。 */
function ctrlCBranchOf(source: string): string | null {
  const at = source.indexOf("key.ctrl && input === 'c'")
  if (at < 0) return null
  const brace = source.indexOf('{', at)
  return brace < 0 ? null : sliceBlock(source, brace)
}

/**
 * 这一支的顺序必须是：**先关最上面一层 → 再判 isArmed() → 最后才 process.exit**。
 *
 * 顺序就是缺陷本身：修复前是「上来就退」，于是对话框里一次误按带走整个会话。
 * 拿 `indexOf` 的相对次序而不是「包不包含」——「包含」那种断言在
 * 「先 exit 再 isArmed」的写法上照样绿。
 */
function ctrlCBranchIsSafe(branch: string): boolean {
  const dismiss = branch.indexOf('dismissTopmost()')
  const armed = branch.indexOf('isArmed()')
  const exit = branch.indexOf('process.exit')
  const arm = branch.indexOf('.arm()')
  return (
    dismiss >= 0 &&
    armed >= 0 &&
    exit >= 0 &&
    arm >= 0 &&
    dismiss < armed &&
    armed < exit &&
    // `arm()` 必须**在**退出判断之后：`arm()` 是同步置 ref 的，写在判断之前
    // 会让 `isArmed()` 当场读到 true ⇒ 又变成「一次就退」。
    exit < arm
  )
}

/**
 * 主界面 `App` 起不来（整条 engine / provider 链 + 一堆挂载期 IO），所以它的
 * Ctrl+C 这一支只能做**形状**断言。行为那一半由 ② 组（共用窗口）与 ③ 组
 * （看板那一支）覆盖 —— 三组凑起来才是完整的一条链，单看任何一组都有缺口。
 */
describe('src/ui/app.tsx 的 Ctrl+C 分支顺序', () => {
  const source = readFileSync('src/ui/app.tsx', 'utf8')

  it('扫描器本身可失败：把 exit 提到最前面就判不安全', () => {
    expect(ctrlCBranchIsSafe(`if (key.ctrl && input === 'c') {\n  process.exit(0)\n}`)).toBe(false)
    expect(
      ctrlCBranchIsSafe(
        `if (key.ctrl && input === 'c') {\n  if (ctrlC.isArmed()) process.exit(0)\n  ctrlC.arm()\n}`,
      ),
    ).toBe(false) // 少了「先关最上面一层」
    expect(
      ctrlCBranchIsSafe(
        `if (key.ctrl && input === 'c') {\n  if (dismissTopmost()) { return }\n  ctrlC.arm()\n}`,
      ),
    ).toBe(false) // 少了 isArmed 这一格 ⇒ 永远退不出去
    expect(
      ctrlCBranchIsSafe(
        `if (key.ctrl && input === 'c') {\n  if (dismissTopmost()) { return }\n  ctrlC.arm()\n  if (ctrlC.isArmed()) process.exit(0)\n}`,
      ),
    ).toBe(false) // arm() 写在判断之前 ⇒ 同步置位后当场读到 true，一次就退
    expect(ctrlCBranchOf('const x = 1')).toBeNull()
  })

  it('真分支：关最上面一层 → 判 isArmed → 才 process.exit', () => {
    const branch = ctrlCBranchOf(source)
    expect(branch).not.toBeNull()
    expect(ctrlCBranchIsSafe(branch!)).toBe(true)
  })
})
