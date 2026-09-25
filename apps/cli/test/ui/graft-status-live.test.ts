/**
 * 页脚广告的是一个**状态**，不是一个**快照** —— 它必须跟着磁盘变。
 *
 * 缺陷形状：`const [stats] = useState(() => findGraftStats(cwd))` 的初始化函数**只跑一次**。
 * 启动那一刻若 graft 正重建索引（`syncing: true`），这个值就被冻住，之后索引建完多久都不再
 * 重读 ⇒ 页脚永远显示 `syncing…`。磁盘实测 `"syncing": false` / `syncedAt` 有值而 UI 说还在
 * 同步 —— 读者手里的读数与没人读的那个对象**不一致**。
 *
 * 判据落在**渲染出来的那一行**上，不是「组件有没有重读文件」：
 * ① 正对照 —— 磁盘说 `syncing: true` 时那一行真的显示 `syncing…`（没有这一格，下面全绿
 *    可能只是因为压根没渲染出这行）；
 * ② 核心 —— 把磁盘改成 `syncing: false`、**不重新挂载**，等一拍之后同一棵树上那一行必须
 *    自己变成 `✓ synced`。
 */

import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { render } from 'ink-testing-library'
import { GraftStatusLine } from '../../src/ui/graft-status'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graft-footer-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeStats(fields: Record<string, unknown>): void {
  const cacheDir = join(dir, 'graft', '.cache')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'stats.json'), JSON.stringify({ nodeCount: 3, ...fields }))
}

/** ink-testing-library 无 act 包装，交还事件循环让 effect / state 落定。 */
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('页脚的 graft 新鲜度：磁盘变了它就得变', () => {
  it('正对照：磁盘说 syncing 时那一行显示 `syncing…`', () => {
    writeStats({ syncing: true, dirty: false, staleCount: 0 })
    const { lastFrame, unmount } = render(React.createElement(GraftStatusLine, { cwd: dir }))
    expect(lastFrame() ?? '').toContain('syncing…')
    unmount()
  })

  it('**核心**：同一次挂载内，磁盘从 syncing 变成 synced ⇒ 那一行必须跟着变', async () => {
    writeStats({ syncing: true, dirty: false, staleCount: 0 })
    const { lastFrame, unmount } = render(React.createElement(GraftStatusLine, { cwd: dir }))
    expect(lastFrame() ?? '', '前提：挂载时确实读到了 syncing').toContain('syncing…')

    // 索引建完了 —— 页脚该自己知道，不必等用户敲键盘、也不必重启。
    writeStats({ syncing: false, dirty: false, staleCount: 0, syncedAt: new Date().toISOString() })
    await settle(1400)

    const frame = lastFrame() ?? ''
    expect(frame, '页脚把启动那一拍的状态冻死了 —— 磁盘早已 synced').toContain('✓ synced')
    expect(frame).not.toContain('syncing…')
    unmount()
  })

  it('这个目录没有 graft 图时不渲染这一行（边界不变）', () => {
    const { lastFrame, unmount } = render(React.createElement(GraftStatusLine, { cwd: dir }))
    expect(lastFrame() ?? '').not.toContain('graft')
    unmount()
  })
})
