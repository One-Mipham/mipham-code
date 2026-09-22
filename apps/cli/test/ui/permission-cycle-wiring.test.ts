/**
 * Shift+Tab 循环的**接线层**测试。
 *
 * 为什么需要这一层：`cyclePermissionMode` 是纯函数、`test/ui/permission-mode.test.ts`
 * 已经把它逐条钉住 —— 但那条链上有两段纯函数测试看不见：
 *
 *   ① **按键那一跳**：`\x1b[Z` → `key.shift && key.tab` → `onCyclePermission()`
 *      （`input.tsx:404`）。此前只有 `test/integrity/permission-status-parity.test.ts`
 *      从**源码字符串**侧断言 `toContain('onCyclePermission')` —— 字符串在、接线断，
 *      它照样绿。这与 D7 记的形态同族（[[纯函数绿/源码字符串绿 不能推出功能可用]]）。
 *   ② **每一档的语义各自是真的**：转盘能转 ≠ 四档有不同的行为。
 *      用户的要求是「可以切换的四模式要有实际的接线，不能有死代码/空代码」——
 *      那需要拿**真的** `PermissionSystem` 逐档读出 `check()` 的答案，而不是看转盘数组。
 *
 * ink 的按键走的是 raw 序列（与真终端同一条路径，不是直接调 handler）。
 * shift+tab 在真终端发的是 `\x1b[Z`；ink 的 `parse-keypress.js` 把 `[Z` 同时列进
 * `keyName`（→ `tab`）**和** `isShiftKey`（→ `shift: true`）——两者缺一，下面第一条
 * 用例里的分支在真机上就永远不成立，所以这一跳值得单独钉住。
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InputBar } from '../../src/ui/input'
import { PermissionSystem } from '../../src/core/permission'
import { cyclePermissionMode, livePermissionMode } from '../../src/ui/app'
import { MODE_CYCLE } from '../../src/core/permission-config'
import type { PermissionLevel, PermissionMode, ToolDefinition } from '../../src/shared'

/** 真终端里 Shift+Tab 发出的那串。 */
const SHIFT_TAB = '\u001B[Z'
/** 裸 Tab（`shift` 为 false）—— 用来证明上面那条判据真的在分辨什么。 */
const TAB = '\t'
const UP = '\u001B[A'

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

function makeTool(
  name: string,
  permission: ToolDefinition['permission'] = 'self',
  category: ToolDefinition['category'] = 'file',
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    category,
    permission,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true, content: '' }),
  }
}

function renderBar(onCyclePermission: () => void) {
  return render(
    React.createElement(InputBar, {
      onSubmit: () => {},
      isLoading: false,
      history: [],
      onHistoryAppend: () => {},
      onCyclePermission,
    }),
  )
}

// ═══════════════════════════════════════════
// ① 按键那一跳
// ═══════════════════════════════════════════

describe('Shift+Tab → onCyclePermission（接线层）', () => {
  it('真终端那串 `\\x1b[Z` 会触发一次循环', async () => {
    const onCyclePermission = vi.fn()
    const { stdin } = renderBar(onCyclePermission)

    stdin.write(SHIFT_TAB)
    await settle()

    expect(onCyclePermission).toHaveBeenCalledTimes(1)
  })

  // 负对照：证明上面那条的绿不是「任何按键都会调」。两个探针各自覆盖一半条件 ——
  // 裸 Tab 有 `key.tab` 但缺 `key.shift`，↑ 两个都没有。分开写是因为
  // `key.shift && key.tab` 里任一被写成恒真，都必须有一条当场红。
  it('（对照）裸 Tab 不触发 —— 缺 `shift`', async () => {
    const onCyclePermission = vi.fn()
    const { stdin } = renderBar(onCyclePermission)

    stdin.write(TAB)
    await settle()

    expect(onCyclePermission).not.toHaveBeenCalled()
  })

  it('（对照）↑ 不触发 —— 两个条件都不满足', async () => {
    const onCyclePermission = vi.fn()
    const { stdin } = renderBar(onCyclePermission)

    stdin.write(UP)
    await settle()

    expect(onCyclePermission).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════
// ② 转盘走完整圈，且页脚与引擎同源
// ═══════════════════════════════════════════

describe('连按 Shift+Tab 走完整圈（真 PermissionSystem）', () => {
  it('依次经过 MODE_CYCLE 的每一档，第四下回到起点', () => {
    const ps = new PermissionSystem('default')
    const visited: PermissionMode[] = [livePermissionMode(ps)]

    for (let i = 0; i < MODE_CYCLE.length; i++) {
      const shown = cyclePermissionMode(ps, visited[visited.length - 1]!)
      // 页脚读数与引擎实际状态**逐字相同**（P3 的同源定义，这里在真对象上复核）
      expect(ps.getMode()).toBe(shown)
      visited.push(shown)
    }

    expect(visited).toEqual([...MODE_CYCLE, MODE_CYCLE[0]])
    // 转盘到不了 `bypassPermissions`（`ALL_MODES ⊋ MODE_CYCLE`）—— 这一档是**合法但不可循环**
    expect(visited).not.toContain('bypassPermissions')

    // 上面那条锚在 `MODE_CYCLE` 上 ⇒ **重排转盘它照样绿**。这一条把**用户看到的那一圈**
    // 钉成字面量：次序变了必须是一次有人签字的改动，而不是纯函数测试里的一次静默漂移。
    // （这不是第二份真源 —— 生产侧仍然只有 `MODE_CYCLE` 一处；这里是**规格**，不是镜像。）
    expect(visited).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'default'])
  })
})

// ═══════════════════════════════════════════
// ③ 四档各自的语义是真的（不是别名 / 不是空壳）
// ═══════════════════════════════════════════

describe('四档的可观测行为各不相同（无死代码）', () => {
  // `isReadOnlyTool` 要 **大写** 的 `Read`/`Grep`/`Glob`（`permission.ts:33`）——
  // 小写 fixture 会静默地**不是**只读工具，那样 plan / auto 的读数就换了对象。
  const READ = makeTool('Read', 'self', 'file')
  const WRITE = makeTool('Write', 'ask', 'file')
  const BASH = makeTool('Bash', 'ask', 'exec')

  const levelsAt = (
    mode: Parameters<PermissionSystem['setMode']>[0],
  ): { read: PermissionLevel; write: PermissionLevel; bash: PermissionLevel } => {
    const ps = new PermissionSystem(mode)
    return {
      read: ps.check(READ, {}),
      write: ps.check(WRITE, {}),
      bash: ps.check(BASH, {}),
    }
  }

  it('plan 是只读档：读放行、写要问', () => {
    const plan = levelsAt('plan')

    expect(plan.read).toBe('bypass')
    expect(plan.write).toBe('ask')
  })

  it('acceptEdits 与 plan 的分界就在「写」这一格上', () => {
    const plan = levelsAt('plan')
    const accept = levelsAt('acceptEdits')

    expect(accept.write).toBe('bypass')
    // 这是两个档位真正不同的地方 —— 若 `modeBaseline` 把两者的分支写成同一个，
    // 转盘仍能转、纯函数仍全绿，而两个档位是同一个东西。
    expect(accept.write).not.toBe(plan.write)
  })

  it('default 不自动放行写（要问），与 acceptEdits 分得开', () => {
    const def = levelsAt('default')
    const accept = levelsAt('acceptEdits')

    expect(def.write).toBe('ask')
    expect(def.write).not.toBe(accept.write)
  })

  it('auto 读免费、写交给分类器 —— 无分类器时 fail-closed 为 ask，不是放行', () => {
    const auto = levelsAt('auto')

    expect(auto.read).toBe('bypass')
    // fail-closed 是这个档位的安全契约：没挂分类器时它**不比 default 更宽**
    expect(auto.write).toBe('ask')
  })

  it('auto 不是 bypassPermissions 的别名', () => {
    const auto = levelsAt('auto')
    const bypass = levelsAt('bypassPermissions')

    expect(bypass.write).toBe('bypass')
    expect(auto.write).not.toBe(bypass.write)
  })
})
