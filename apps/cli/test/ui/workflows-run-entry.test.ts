/**
 * `/workflows` 的列表输出必须把用户指向**真的** run 入口。
 *
 * 缺陷形状（对标档 280 · 022 附带）：列表命令在收尾时教用户敲
 * `/workflows <name>` 去「跑某个 workflow」，而 `/workflows` 只列不跑 ——
 * 真入口是 `/workflow run <name>`。更刺眼的是**同一个命令自己的 usage 文本**
 * 里就写着 `/workflow run <name>` 与「`/workflows` — list all saved scripts」，
 * 两处自相矛盾。与 277-278 ⑨ 的 `--resume` 同族：广告了一个做不到的动作。
 *
 * 这条断言是行为级的（真建工作区、真调 handler），不是对源码文案的字符串比对。
 */

import { describe, it, expect, afterEach, vi, type MockInstance } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// /workflows 会 import SessionStore；不 mock 会让测试去碰真实会话目录。
vi.mock('../../src/core/session-store', () => ({
  SessionStore: {
    getLatest: vi.fn(() => null),
    load: vi.fn(() => null),
    list: vi.fn(() => []),
    delete: vi.fn(() => false),
  },
}))

const { getCommand } = await import('../../src/ui/commands')

let workdir: string | null = null
let cwdSpy: MockInstance | undefined

afterEach(() => {
  cwdSpy?.mockRestore()
  cwdSpy = undefined
  if (workdir) {
    rmSync(workdir, { recursive: true, force: true })
    workdir = null
  }
})

/** 造一个真的工作区，里面有一个能被列出来的 workflow 脚本。 */
function makeWorkspaceWithOneWorkflow(): void {
  workdir = mkdtempSync(join(tmpdir(), 'mipham-workflows-'))
  const dir = join(workdir, '.mipham', 'workflows')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'demo.js'),
    "export const meta = { name: 'demo', description: 'a demo workflow' }\n",
  )
  // `/workflows` 从 `process.cwd()` 推导脚本目录。不用 `process.chdir()`：Stryker 的
  // vitest-runner 把测试跑在 worker 线程里（`pool: 'threads'` 在它源码里写死、无覆盖
  // 入口），线程里 chdir 直接抛 "process.chdir() is not supported in workers" ——
  // 后果不是这一个文件红，而是整个变异测试的干跑失败。spy 只改返回值，两种跑池下一致
  // （同 test/commands/init-providers.test.ts 的既定做法）。
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workdir)
}

describe('/workflows 列表输出的 run 指引', () => {
  it('指向真入口 /workflow run，且不再广告 /workflows <name>', async () => {
    makeWorkspaceWithOneWorkflow()

    const handler = getCommand('/workflows')
    expect(handler).toBeDefined()

    const result = await handler!({} as never, [])

    // 前置：确实走到了「找到了脚本」那一支（否则这条断言什么也没验到）
    expect(result.content).toContain('1 workflow(s) found')

    expect(result.content).toContain('/workflow run')
    expect(result.content).not.toContain('/workflows <name>')
  })
})
