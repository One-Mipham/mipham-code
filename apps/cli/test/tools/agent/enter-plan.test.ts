import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionMode, ToolContext } from '../../../src/shared'
import { enterPlanModeTool } from '../../../src/tools/agent/enter-plan'

/**
 * `EnterPlanMode` 的正文承诺了「Plan mode is READ-ONLY：其他工具都需要确认」，
 * 但执行体从前**只写了一份 markdown 模板**，一次都没碰过权限模式。工具返回
 * 「已进入计划模式」，闸门却还停在原来的档位（例如 acceptEdits ⇒ 写文件不问）。
 *
 * 判据落在这里：**调用之后，权限系统的模式真的变了**。以及组织策略把它夹住
 * （比如禁了 plan）时，输出必须说「没切成」，而不是继续宣称只读。
 */

interface FakePermission {
  getMode: () => PermissionMode
  setMode: (m: PermissionMode) => void
}

/** 一个真会记住模式、并可模拟组织夹取（clamp）的替身。 */
function fakePermission(start: PermissionMode, clampTo?: PermissionMode) {
  let mode = start
  const setMode = vi.fn((next: PermissionMode) => {
    mode = clampTo ?? next
  })
  const api: FakePermission = { getMode: () => mode, setMode }
  return { api, setMode }
}

const ctxWith = (cwd: string, permissionSystem?: FakePermission): ToolContext =>
  ({
    cwd,
    sessionId: 'test',
    provider: 'test',
    model: 'test-model',
    permissionSystem,
  }) as unknown as ToolContext

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mipham-enter-plan-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('EnterPlanMode：真的切到 plan', () => {
  it('从 acceptEdits 进来 ⇒ 权限模式变成 plan，且输出宣称只读', async () => {
    const perm = fakePermission('acceptEdits')

    const r = await enterPlanModeTool.execute(
      { description: 'do the thing' },
      ctxWith(dir, perm.api),
    )

    expect(r.success).toBe(true)
    expect(perm.api.getMode()).toBe('plan')
    expect(r.content).toContain('Plan Mode Activated')
    expect(r.content).toContain('READ-ONLY')
    expect(r.content).not.toContain('was NOT applied')
  })

  it('组织策略把模式夹住 ⇒ 明说没切成，不许宣称只读', async () => {
    // 模拟 org 的 maxAllowedMode/forbiddenModes：请求 plan，落地仍是 default。
    const perm = fakePermission('default', 'default')

    const r = await enterPlanModeTool.execute({}, ctxWith(dir, perm.api))

    expect(perm.api.getMode()).toBe('default')
    expect(r.content).toContain('Plan File Created (mode unchanged)')
    expect(r.content).toContain('was NOT applied')
    expect(r.content).toContain('"default"')
    expect(r.content).not.toContain('READ-ONLY')
    // 不许再告诉模型「其他工具都需要确认」—— 它没被切进那个档位。
    expect(r.content).not.toContain('All other tools — require confirmation')
  })

  it('没有权限系统可切（手工构造的 ctx）⇒ 不崩，也不假装切了', async () => {
    const r = await enterPlanModeTool.execute({}, ctxWith(dir))

    expect(r.success).toBe(true)
    expect(r.content).toContain('was NOT applied')
    expect(r.content).not.toContain('READ-ONLY')
  })

  it('计划文件仍然被写出来（这一半本来就是真的）', async () => {
    const perm = fakePermission('default')
    await enterPlanModeTool.execute({ description: 'keep me' }, ctxWith(dir, perm.api))

    const files = readdirSync(join(dir, '.mipham', 'plans'))
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/^plan-.*\.md$/)
  })
})
