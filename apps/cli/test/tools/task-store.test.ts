/**
 * 任务清单：**每会话、落盘**。
 *
 * 三件事各自是一条判据，缺一条都能让实现看着「已持久化」而其实没有：
 * ① 会话之间互不可见（一个全局 Map 也能让单会话的用例全绿）；
 * ② 进程重来一次还在（只在内存里加个 sessionId 键就做不到）；
 * ③ `/clear` 之后真的没了（只删内存就会在下次启动时又冒出来）。
 *
 * 另外两条常被漏掉的边：换进程之后 **ID 不能与盘上的撞号**；子代理的
 * `sessionId` 是字面量 `'sub-agent'`，它的任务必须记在主会话名下。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolContext } from '../../src/shared'
import { clearTasks, getTasks, setActiveTaskSession, taskTool } from '../../src/tools/exec/task'

// 落盘是真的写 —— 压在 tmpdir 里，别碰用户的 ~/.mipham。
// 全局 setup 的 homedir 是 `mipham-test-home`，那份目录**跨运行保留**：不换成
// 自己的目录，上一趟留下的任务会让这一趟的「第一次」读到一个非空的清单。
const HOME = `${(await import('node:os')).tmpdir()}/mipham-test-task-store`
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-task-store` }
})

function ctxFor(sessionId: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd: '/tmp/test', sessionId, provider: 'test', model: 'test-model', ...extra }
}

/** 落盘路径与实现同构：`~/.mipham/tasks/<sha256(sessionId)[:32]>.json`。 */
function storePath(sessionId: string): string {
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
  return join(HOME, '.mipham', 'tasks', `${name}.json`)
}

describe('Task 存储：每会话 + 落盘', () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true })
  })

  it('会话之间互不可见', async () => {
    await taskTool.execute({ action: 'create', subject: 'only in A' }, ctxFor('sess-A'))

    const inB = await taskTool.execute({ action: 'list' }, ctxFor('sess-B'))
    expect(inB.content).toBe('(no tasks)')

    const inA = await taskTool.execute({ action: 'list' }, ctxFor('sess-A'))
    expect(inA.content).toContain('only in A')
  })

  it('进程重来一次，清单还在', async () => {
    await taskTool.execute({ action: 'create', subject: 'survive restart' }, ctxFor('resume-me'))
    const id = getTasks('resume-me')[0]!.id

    vi.resetModules()
    const fresh = await import('../../src/tools/exec/task')

    expect(fresh.getTasks('resume-me').map((t) => t.subject)).toEqual(['survive restart'])
    // `list` 走的是同一条加载路径 —— 只断言导出函数的话，工具自己没接也看不出来。
    const listed = await fresh.taskTool.execute({ action: 'list' }, ctxFor('resume-me'))
    expect(listed.content).toContain('survive restart')
    expect(getTasks('resume-me')[0]!.id).toBe(id)
  })

  it('重启之后新任务不与盘上的 ID 撞号', async () => {
    const first = await taskTool.execute({ action: 'create', subject: 'one' }, ctxFor('ids'))
    const firstId = Number(first.content.match(/#(\d+)/)?.[1])
    expect(Number.isFinite(firstId)).toBe(true)

    vi.resetModules()
    const fresh = await import('../../src/tools/exec/task')
    const second = await fresh.taskTool.execute({ action: 'create', subject: 'two' }, ctxFor('ids'))
    const secondId = Number(second.content.match(/#(\d+)/)?.[1])

    // 计数器从盘上的最大值续起，否则下一个新任务会复用 #1 并覆盖掉旧的那条。
    expect(secondId).toBe(firstId + 1)
    expect(fresh.getTasks('ids')).toHaveLength(2)
  })

  it('clearTasks 之后内存与盘都是空的（下次启动也不会回来）', async () => {
    await taskTool.execute({ action: 'create', subject: 'discard me' }, ctxFor('cleared'))
    expect(existsSync(storePath('cleared'))).toBe(true)

    clearTasks('cleared')
    expect(getTasks('cleared')).toEqual([])
    expect(existsSync(storePath('cleared'))).toBe(false)

    vi.resetModules()
    const fresh = await import('../../src/tools/exec/task')
    expect(fresh.getTasks('cleared')).toEqual([])
  })

  it('子代理的任务记在主会话名下，不落进共用的 sub-agent 桶', async () => {
    const nested = ctxFor('sub-agent', { isSubAgent: true, parentSessionId: 'parent-1' })
    await taskTool.execute({ action: 'create', subject: 'from a helper' }, nested)

    expect(getTasks('parent-1').map((t) => t.subject)).toEqual(['from a helper'])
    expect(getTasks('sub-agent')).toEqual([])
  })

  it('盘上的文件坏了 ⇒ 当空读，且下一次写入把它修好', async () => {
    const path = storePath('corrupt')
    mkdirSync(join(HOME, '.mipham', 'tasks'), { recursive: true })
    writeFileSync(path, '{ not json', 'utf-8')

    expect(getTasks('corrupt')).toEqual([])
    const created = await taskTool.execute(
      { action: 'create', subject: 'fresh start' },
      ctxFor('corrupt'),
    )
    expect(created.success).toBe(true)
    expect(getTasks('corrupt').map((t) => t.subject)).toEqual(['fresh start'])
  })

  it('不带会话 id 的读者看到的是 setActiveTaskSession 指的那个', async () => {
    await taskTool.execute({ action: 'create', subject: 'in A' }, ctxFor('active-A'))
    await taskTool.execute({ action: 'create', subject: 'in B' }, ctxFor('active-B'))

    setActiveTaskSession('active-A')
    expect(getTasks().map((t) => t.subject)).toEqual(['in A'])
  })
})
