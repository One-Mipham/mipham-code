/**
 * P3 — 页脚的状态必须与执行**同源**。
 *
 * 页脚那行 `⏵⏵ <模式>` 是用户判断「我现在有什么权限」的唯一读数，而它此前读的是
 * **本地猜的值**：初始值写死 `'default'`，Shift+Tab 之后存的是**请求的那一档** ——
 * 两者都不等于引擎实际所在的模式。组织级限制（`maxAllowedMode` / `forbiddenModes`）
 * 会**静默改写**你请求的那一档，于是页脚报的恰好是那个「更宽」的值：说放行、实际审批，
 * 或者反过来说审批、实际放行。这与仓库里反复出现的那族缺陷同形 ——
 * **判据拿的是近似的替身，不是真对象**。
 *
 * 这里测的是页脚唯一的两个入口（`livePermissionMode` / `cyclePermissionMode`）本身，
 * 而**接线**（页脚确实调用它们）由 `test/integrity/permission-status-parity.test.ts`
 * 从源码侧断 —— 单入口的行为用例看不见「页脚压根没接上」。
 */

import { describe, it, expect } from 'vitest'
import { livePermissionMode, cyclePermissionMode } from '../../src/ui/app'
import { PermissionSystem } from '../../src/core/permission'

describe('P3 — 页脚状态与执行同源', () => {
  it('初始值取自 live 权限系统，而不是本地字面量（上限把 default 压成了 plan）', () => {
    const ps = new PermissionSystem('default')
    ps.setRestrictions({ maxAllowedMode: 'plan' })

    expect(livePermissionMode(ps)).toBe('plan')
  })

  it('对照组：没有限制时取到的就是引擎当前模式（本项不动默认行为）', () => {
    const ps = new PermissionSystem('acceptEdits')

    expect(livePermissionMode(ps)).toBe('acceptEdits')
  })

  it('Shift+Tab 之后页脚显示的是**钳制后**的模式，不是请求的那一档', () => {
    const ps = new PermissionSystem('default')
    ps.setRestrictions({ maxAllowedMode: 'default' }) // 只留 plan + default

    // 循环上的下一档是 acceptEdits，上限把它压回 default
    const shown = cyclePermissionMode(ps, 'default')

    expect(shown).toBe('default')
    // 两个读数必须逐字相同 —— 这就是「同源」的定义
    expect(ps.getMode()).toBe(shown)
  })

  it('对照组：没有限制时循环逐位不变', () => {
    const ps = new PermissionSystem('default')

    expect(cyclePermissionMode(ps, 'default')).toBe('acceptEdits')
    expect(cyclePermissionMode(ps, 'acceptEdits')).toBe('plan')
    expect(ps.getMode()).toBe('plan')
  })
})
