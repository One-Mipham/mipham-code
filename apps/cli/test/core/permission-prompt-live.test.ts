/**
 * 缺口 1 的行为回归：**系统提示的权限段跟着权限档切**。
 *
 * 缺陷形状是「**采样一次、用一整会话**」：模式在组装系统提示那一刻被读走、烘进字符串。
 * Shift+Tab 之后闸门与页脚都变了，模型手里还是旧指令 —— 往窄切是自纠正的（模型比闸门更
 * 保守，最多少做点事），**往宽切**则让它拒绝做它已经被允许做的事，而且界面上没有任何东西
 * 会说这件事。
 *
 * 这里的断言全部走**真对象**：真 `ContextManager` + 真 `PermissionSystem` + 真
 * `InstructionsLoader`，接线方式与 `index.tsx` 逐字相同（那是唯一的施加点）。判据是
 * 「**改档后同一次读**换了答案」，不是「读了两个不同的字符串」：
 * - 断言 `default` → `acceptEdits` 后旧档的句子**消失**（只断「新句子出现」的话，
 *   把旧段与新段一起拼上去也能过）；
 * - 断言读的是**生效档**而非**请求档**（组织级 `maxAllowedMode` 钳过之后仍报钳后的值）。
 *
 * 与之配对的源码侧守卫在 `test/integrity/permission-status-parity.test.ts`（P5）：那边断
 * 「接线行在场」，这边断「接上之后真的会动」。两边都要 —— 源码守卫挡不住一个接错对象
 * 的接线，行为用例看不见 `index.tsx` 里那一行被删。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ContextManager } from '../../src/core/context'
import { PermissionSystem } from '../../src/core/permission'
import { InstructionsLoader } from '../../src/core/instructions'

const BASE = '# BASE PROMPT\n\n- 一条不涉及权限的指令'

/** 与 `index.tsx` 的接线行同形：读时取 live `PermissionSystem.getMode()`。 */
function wire(context: ContextManager, loader: InstructionsLoader, permission: PermissionSystem) {
  context.setPermissionContextSource(() => loader.buildPermissionBlock(permission.getMode()))
}

describe('系统提示的权限段随权限档切换（读时派生）', () => {
  let context: ContextManager
  let loader: InstructionsLoader
  let permission: PermissionSystem

  beforeEach(() => {
    context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
    loader = new InstructionsLoader()
    permission = new PermissionSystem('default')
    context.setSystemPrompt(BASE)
  })

  it('正对照：转盘转到的那两档都真能生成文字（否则下面的断言是空串上的空话）', () => {
    expect(loader.buildPermissionBlock('default')).not.toBe('')
    expect(loader.buildPermissionBlock('acceptEdits')).not.toBe('')
  })

  it('**核心**：改档之后同一次 `getSystemPrompt()` 就换了答案，旧档的句子消失', () => {
    wire(context, loader, permission)

    const before = context.getSystemPrompt()
    expect(before).toContain('You are in **default** mode')
    expect(before, 'base 里不该已经含有权限段').toContain(BASE)

    // 这就是 Shift+Tab 按下去之后发生的事（页脚走的也是 `setMode`）。
    permission.setMode('acceptEdits')

    const after = context.getSystemPrompt()
    expect(after).toContain('You are in **acceptEdits** mode')
    // 关键的一半：旧指令必须**消失**。模型同时拿到「工具会被挡」与「编辑已允许」时，
    // 它按更保守的那句行事 —— 正是本缺口要关掉的形状。
    expect(after, '旧档的指令还在 ⇒ 只是又拼了一段上去').not.toContain(
      'You are in **default** mode',
    )
    // 往宽切是咬人的方向：闸门开了，指令必须跟着说「可以编辑了」。
    expect(after).toContain('File reads and edits are allowed')
  })

  it('未接线时系统提示就是 base —— 不留下悬空的分隔符', () => {
    expect(context.getSystemPrompt()).toBe(BASE)
  })

  it('空块不产生空段（模式拼错时提示里干脆不提权限，而不是吐一段空标题）', () => {
    // 真走 `buildPermissionBlock` 的空路径：未知模式返回 `''`。
    expect(loader.buildPermissionBlock('bypass')).toBe('')
    context.setPermissionContextSource(() => loader.buildPermissionBlock('bypass'))
    expect(context.getSystemPrompt()).toBe(BASE)
  })

  it('传 `null` 撤销接线', () => {
    wire(context, loader, permission)
    expect(context.getSystemPrompt()).not.toBe(BASE)
    context.setPermissionContextSource(null)
    expect(context.getSystemPrompt()).toBe(BASE)
  })

  it('报的是**生效档**：组织级上限把模式钳走之后，提示跟着钳后的值', () => {
    // `setMode` 内部走 `clampMode`，故 `getMode()` 返回的是真正会被执行的档。
    // 提示若报请求档，模型会以为自己处在 `bypassPermissions`（读到的权限比实际**宽**），
    // 与 P5 的旧缺陷同族、方向也相同。
    permission.setRestrictions({ maxAllowedMode: 'plan' })
    permission.setMode('bypassPermissions')
    wire(context, loader, permission)

    const prompt = context.getSystemPrompt()
    expect(permission.getMode()).toBe('plan')
    expect(prompt).toContain('You are in **plan** mode')
    expect(prompt).not.toContain('bypassPermissions** mode')
  })
})
